import type { ApprovalView, TranscriptBlockView } from '../core/view.js'
import { relativeTime, runStatusLabels, threadIndicator, threadIndicatorLabels } from './state.js'
import type { DisplayItem, ThreadGroup, ThreadLike } from './state.js'
import { renderMarkdown } from './markdown.js'

type Child = Node | string | null | undefined | false
/** Small element helper: fixed tags, text nodes and attributes only; no HTML strings. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue
    if (name === 'class') node.className = String(value)
    else if (name === 'text') node.textContent = String(value)
    else if (value === true) node.setAttribute(name, '')
    else node.setAttribute(name, value)
  }
  for (const child of children) if (child) node.append(child)
  return node
}
const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2) ?? 'null' } catch { return String(value) } }
/** Assistant Markdown uses fixed DOM elements only, including while a fence is streaming. */
export function renderText(text: string, streaming: boolean): HTMLElement {
  const wrapper = renderMarkdown(text)
  if (streaming) wrapper.className += ' ca-streaming'
  return wrapper
}
interface ToolSummary { readonly name: string; readonly preview: string }
const previewText = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 180)
const toolSummary = (block: Extract<TranscriptBlockView, { kind: 'tool_use' }>): ToolSummary => {
  const input = block.input !== null && typeof block.input === 'object' ? block.input as Record<string, unknown> : undefined
  const candidate = input && ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description'].map(key => input[key]).find(value => typeof value === 'string' && value.trim())
  return { name: block.name || '工具', preview: typeof candidate === 'string' ? previewText(candidate) : '' }
}
const summaryLine = (info: ToolSummary, status: string): HTMLElement => el('summary', { class: 'ca-tool-summary' },
  el('span', { class: 'ca-tool-name', text: info.name }), info.preview ? el('code', { class: 'ca-tool-preview', text: info.preview, title: info.preview }) : null,
  el('span', { class: 'ca-tool-status', text: status }))
export function renderBlock(block: TranscriptBlockView, streaming: boolean, tools: ReadonlyMap<string, ToolSummary> = new Map()): HTMLElement {
  switch (block.kind) {
    case 'text': return renderText(block.text + (block.truncated ? '\n…（已截断）' : ''), streaming)
    case 'thinking': {
      const details = el('details', { class: 'ca-thinking' }, el('summary', { text: streaming ? '思考中…' : '思考摘要' }), el('p', { text: block.text + (block.truncated ? '\n…（已截断）' : '') }))
      return details
    }
    case 'tool_use': {
      const node=el('details', { class: 'ca-tool', 'data-disclosure-key': `tool_use:${block.toolUseId}` }, summaryLine(toolSummary(block), streaming ? '调用中' : '调用'),
        el('div', { class: 'ca-tool-body' }, el('small', { class: 'ca-tool-id', text: `调用 ID：${block.toolUseId}` }),
          el('pre', { class: 'ca-tool-input', tabindex: '0', text: block.input === null ? (streaming ? '…' : '') : pretty(block.input) + (block.inputTruncated ? '\n…（已截断）' : '') })))
      const input=block.input&&typeof block.input==='object'?block.input as Record<string,unknown>:undefined,path=input?.file_path??input?.path
      if(typeof path==='string'&&path.length<=4096){const open=el('button',{type:'button',text:'预览文件'});open.addEventListener('click',()=>node.dispatchEvent(new CustomEvent('claude-preview-file',{bubbles:true,detail:{path}})));node.append(open)}
      if(typeof input?.old_string==='string'&&typeof input?.new_string==='string')node.append(el('details',{class:'ca-edit-diff'},el('summary',{text:'查看此次编辑差异'}),el('pre',{class:'ca-diff-before',text:input.old_string.slice(0,32768)}),el('pre',{class:'ca-diff-after',text:input.new_string.slice(0,32768)})))
      return node
    }
    case 'tool_result': return el('details', { class: `ca-tool-result${block.isError ? ' ca-error' : ''}`, open: block.isError, 'data-disclosure-key': `tool_result:${block.toolUseId}` },
      summaryLine(tools.get(block.toolUseId) ?? { name: '工具结果', preview: '' }, block.isError ? '出错' : '已返回'),
      el('div', { class: 'ca-tool-body' }, el('small', { class: 'ca-tool-id', text: `调用 ID：${block.toolUseId}` }),
        el('pre', { tabindex: '0', text: block.text + (block.truncated ? '\n…（已截断）' : '') })))
    case 'attachment': return el('p',{class:'ca-attachment-card',text:`附件 · ${block.name} · ${block.mime}`})
    case 'unsupported': return el('p', { class: 'ca-unsupported', text: `［未显示的内容：${block.type}］` })
  }
}
export function renderItem(item: DisplayItem, tools: ReadonlyMap<string, ToolSummary> = new Map()): HTMLElement {
  const hasText = item.blocks.some(block => block.kind === 'text')
  const thinkingOnly = item.blocks.length > 0 && item.blocks.every(block => block.kind === 'thinking')
  const article = el('article', { class: `ca-item ca-${item.role}${!hasText ? thinkingOnly ? ' ca-item-thinking' : ' ca-item-tools' : ''}`, 'data-item-id': item.id })
  if (hasText) article.append(el('span', { class: 'ca-role', text: item.role === 'user' ? '你' : 'Claude' }))
  let thinkingIndex = 0
  for (const block of item.blocks) {
    const node = item.role === 'user' && block.kind === 'text'
      ? el('div', { class: 'ca-text-block' }, el('p', { class: 'ca-text', text: block.text + (block.truncated ? '\n…（已截断）' : '') }))
      : renderBlock(block, item.streaming, tools)
    if (block.kind === 'thinking') node.dataset.disclosureKey = `thinking:${item.id.replace(/^live:/, '')}:${thinkingIndex++}`
    article.append(node)
  }
  return article
}
export interface ApprovalHandlers { decide(approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>): void }
export function renderApproval(approval: ApprovalView, handlers: ApprovalHandlers, domId: (local: string) => string): HTMLElement {
  const card = el('section', { class: 'ca-approval', 'data-approval-id': approval.id, 'aria-labelledby': domId(`approval-${approval.id}`) })
  const heading = el('h3', { id: domId(`approval-${approval.id}`), text: approval.title ?? (approval.kind === 'question' ? 'Claude 需要你的回答' : `允许使用 ${approval.toolName}？`) })
  card.append(heading)
  if (approval.description) card.append(el('p', { class: 'ca-approval-description', text: approval.description }))
  const actions = el('div', { class: 'ca-approval-actions' })
  if (approval.kind === 'question' && approval.questions) {
    const form = el('form', { class: 'ca-questions' })
    approval.questions.forEach((question, index) => {
      const group = el('fieldset', {}, el('legend', {}, el('span', { class: 'ca-question-header', text: question.header }), ' ', question.question))
      question.options.forEach(option => {
        const input = el('input', { type: question.multiSelect ? 'checkbox' : 'radio', name: `q${index}`, value: option.label })
        group.append(el('label', { class: 'ca-option' }, input, el('span', { class: 'ca-option-label', text: option.label }), option.description ? el('small', { text: option.description }) : null))
      })
      form.append(group)
    })
    const answer = el('button', { type: 'submit', class: 'primary-button', text: '提交回答' })
    const decline = el('button', { type: 'button', text: '不回答并拒绝' })
    decline.addEventListener('click', () => handlers.decide(approval, 'deny'))
    form.addEventListener('submit', event => {
      event.preventDefault()
      const answers: Record<string, string> = {}
      approval.questions!.forEach((question, index) => {
        const chosen = [...form.querySelectorAll<HTMLInputElement>(`input[name="q${index}"]:checked`)].map(input => input.value)
        if (chosen.length) answers[question.question] = chosen.join(', ')
      })
      if (Object.keys(answers).length !== approval.questions!.length) { form.querySelector<HTMLElement>('.ca-approval-hint')?.remove(); form.append(el('p', { class: 'ca-approval-hint notice', text: '每个问题都需要选择一项。' })); return }
      handlers.decide(approval, 'allow', answers)
    })
    actions.append(answer, decline); form.append(actions); card.append(form)
    return card
  }
  card.append(el('pre', { class: 'ca-approval-input', text: pretty(approval.input) + (approval.inputTruncated ? '\n…（已截断）' : '') }))
  const why = !approval.reason ? 'Claude 的权限检查要求确认；已有规则只匹配指定的工具、命令或路径。'
    : /obfuscat|expansion|brace with quote/i.test(approval.reason) ? '命令含有复杂的引号或展开语法，Claude 无法可靠匹配已有规则，因此再次询问。'
      : '当前权限规则未直接允许此操作，Claude 要求再次确认。'
  card.append(el('p', { class: 'ca-approval-reason', text: `为什么询问：${why}` }))
  if (approval.blockedPath) card.append(el('p', { class: 'ca-approval-scope', text: `涉及路径：${approval.blockedPath}` }))
  if (approval.reason) card.append(el('details', { class: 'ca-approval-raw' }, el('summary', { text: 'Claude 返回的原始原因' }), el('p', { text: approval.reason })))
  if (approval.allowSessionAvailable) card.append(el('details', { class: 'ca-approval-rules', open: true }, el('summary', { text: '记住的规则与有效期' }),
    el('p', { text: '保存到当前会话，后续消息和重新打开此会话时继续有效；不影响其他会话。未覆盖的操作和 Claude 强制确认的操作仍会询问。可在“权限模式 → 查看会话授权”中撤销。' }),
    el('ul', {}, ...(approval.rememberRules ?? []).map(rule => el('li', {}, el('code', { text: rule }))))))
  else card.append(el('p', { class: 'ca-approval-scope', text: approval.rememberUnavailableReason ?? '此次批准仅适用于这一个调用，Claude 未提供可记住的规则。' }))
  const allow = el('button', { type: 'button', class: 'primary-button', text: '仅允许这次' })
  allow.addEventListener('click', () => handlers.decide(approval, 'allow'))
  const deny = el('button', { type: 'button', text: '拒绝' })
  deny.addEventListener('click', () => handlers.decide(approval, 'deny'))
  actions.append(allow)
  if (approval.allowSessionAvailable) { const session = el('button', { type: 'button', text: '本次会话始终允许' }); session.addEventListener('click', () => handlers.decide(approval, 'allow-session')); actions.append(session) }
  actions.append(deny)
  card.append(actions)
  if (approval.defaultToNo) card.dataset.defaultToNo = 'true'
  return card
}
const transcriptFrames = new WeakMap<HTMLElement, string>()
/** Keep user disclosures while replacing changed frames, including live-to-history reconciliation. */
export function syncTranscript(container: HTMLElement, items: readonly DisplayItem[]): void {
  const existing = new Map<string, HTMLElement>(), disclosures = new Map<string, boolean>(), tools = new Map<string, ToolSummary>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-item-id]')) existing.set(node.dataset.itemId!, node)
  for (const details of container.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]')) disclosures.set(details.dataset.disclosureKey!, details.open)
  for (const item of items) for (const block of item.blocks) if (block.kind === 'tool_use') tools.set(block.toolUseId, toolSummary(block))
  const next = items.map(item => {
    const current = existing.get(item.id)
    const frame = JSON.stringify([item, item.blocks.map(block => block.kind === 'tool_result' ? tools.get(block.toolUseId) : null)])
    if (current && transcriptFrames.get(current) === frame) return current
    const node = renderItem(item, tools); node.dataset.streaming = String(item.streaming)
    for (const details of node.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]')) {
      const open = disclosures.get(details.dataset.disclosureKey!)
      if (open !== undefined) details.open = open
    }
    transcriptFrames.set(node, frame)
    return node
  })
  container.replaceChildren(...next)
}
export interface ThreadGroupHandlers { open(threadId: string): void; create(path: string): void; toggle(path: string): void }
export interface ThreadGroupOptions { readonly currentThreadId?: string; readonly selectedPath?: string; readonly collapsed: ReadonlySet<string>; readonly now: number }
/** One list item per project directory: a toggle naming the directory, a per-project "new thread" button and the threads newest first. */
export function renderThreadGroups<Thread extends ThreadLike>(groups: readonly ThreadGroup<Thread>[], options: ThreadGroupOptions, handlers: ThreadGroupHandlers): HTMLElement[] {
  return groups.map(group => {
    const expanded = !options.collapsed.has(group.path)
    const toggle = el('button', { type: 'button', class: 'ca-group-toggle', 'aria-expanded': String(expanded), title: group.path },
      el('span', { class: 'ca-group-chevron', 'aria-hidden': 'true' }), el('span', { class: 'ca-group-name', text: group.name }), el('small', { class: 'ca-group-count', text: String(group.threads.length) }))
    toggle.addEventListener('click', () => handlers.toggle(group.path))
    const create = el('button', { type: 'button', class: 'ca-group-new', title: `在 ${group.name} 新建线程`, 'aria-label': `在 ${group.name} 新建线程`, text: '＋' })
    create.addEventListener('click', () => handlers.create(group.path))
    const selected = options.selectedPath === group.path && !options.currentThreadId
    const list = el('ul', { class: 'ca-group-threads', hidden: !expanded }, ...group.threads.map(thread => {
      const indicator = threadIndicator(thread)
      const status = thread.lastRun ? runStatusLabels[thread.lastRun.status] ?? thread.lastRun.status : '尚未执行'
      const button = el('button', { type: 'button', 'data-thread-id': thread.id, 'aria-current': thread.id === options.currentThreadId ? 'true' : 'false', title: thread.title },
        el('span', { class: 'ca-thread-dot', 'data-indicator': indicator ?? '', title: indicator ? threadIndicatorLabels[indicator] : undefined, 'aria-hidden': indicator ? undefined : 'true' }),
        el('span', { class: 'ca-thread-text' }, el('span', { class: 'ca-thread-name', text: thread.title }),
          el('small', { text: `${relativeTime(thread.updatedAt, options.now)} · ${indicator === 'approval' ? threadIndicatorLabels.approval : status}` })))
      if (indicator) button.setAttribute('aria-label', `${thread.title}，${threadIndicatorLabels[indicator]}`)
      button.addEventListener('click', () => handlers.open(thread.id))
      return el('li', {}, button)
    }))
    return el('li', { class: 'ca-thread-group', 'data-path': group.path, 'data-selected': selected ? 'true' : undefined }, el('div', { class: 'ca-group-head' }, toggle, create), list)
  })
}

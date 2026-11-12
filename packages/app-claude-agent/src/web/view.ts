import type { ApprovalView, TranscriptBlockView } from '../core/view.js'
import { relativeTime, runStatusLabel, threadIndicator, indicatorLabel } from './state.js'
import type { DisplayItem, ThreadGroup, ThreadLike } from './state.js'
import { renderMarkdown } from './markdown.js'

export { el } from './i18n.js'
import { sourceI18n } from './i18n.js'
import type { ClaudeI18n } from './i18n.js'

const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2) ?? 'null' } catch { return String(value) } }
/** Assistant Markdown uses fixed DOM elements only, including while a fence is streaming. */
export function renderText(text: string, streaming: boolean, i18n: ClaudeI18n = sourceI18n): HTMLElement {
  const wrapper = renderMarkdown(text, i18n)
  if (streaming) wrapper.className += ' ca-streaming'
  return wrapper
}
interface ToolSummary { readonly name: string; readonly preview: string }
const previewText = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 180)
const toolSummary = (block: Extract<TranscriptBlockView, { kind: 'tool_use' }>): ToolSummary => {
  const input = block.input !== null && typeof block.input === 'object' ? block.input as Record<string, unknown> : undefined
  const candidate = input && ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description'].map(key => input[key]).find(value => typeof value === 'string' && value.trim())
  return { name: block.name || '', preview: typeof candidate === 'string' ? previewText(candidate) : '' }
}
const summaryLine = (info: ToolSummary, status: () => string, i18n: ClaudeI18n, fallback: 'transcript.tool' | 'transcript.toolResult' = 'transcript.tool'): HTMLElement => i18n.element('summary', { class: 'ca-tool-summary' },
  i18n.element('span', { class: 'ca-tool-name', text: () => info.name || i18n.t(fallback) }), info.preview ? i18n.element('code', { class: 'ca-tool-preview', text: info.preview, title: info.preview }) : null,
  i18n.element('span', { class: 'ca-tool-status', text: status }))
export function renderBlock(block: TranscriptBlockView, streaming: boolean, tools: ReadonlyMap<string, ToolSummary> = new Map(), i18n: ClaudeI18n = sourceI18n): HTMLElement {
  const { t, element: el } = i18n
  switch (block.kind) {
    case 'text': { const content = renderText(block.text, streaming, i18n); if (block.truncated) content.append(el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') })); return content }
    case 'thinking': {
      const details = el('details', { class: 'ca-thinking' }, el('summary', { text: () => streaming ? t('transcript.thinking') : t('transcript.thinkingSummary') }), el('p', {}, block.text, block.truncated ? el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') }) : null))
      return details
    }
    case 'tool_use': {
      const node=el('details', { class: 'ca-tool', 'data-disclosure-key': `tool_use:${block.toolUseId}` }, summaryLine(toolSummary(block), () => streaming ? t('transcript.calling') : t('transcript.call'), i18n),
        el('div', { class: 'ca-tool-body' }, el('small', { class: 'ca-tool-id', text: () => t('transcript.callId', { id: block.toolUseId }) }),
          el('pre', { class: 'ca-tool-input', tabindex: '0' }, block.input === null ? (streaming ? '…' : '') : pretty(block.input), block.inputTruncated ? el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') }) : null)))
      const input=block.input&&typeof block.input==='object'?block.input as Record<string,unknown>:undefined,path=input?.file_path??input?.path
      if(typeof path==='string'&&path.length<=4096){const open=el('button',{type:'button',text:() => t('transcript.preview')});open.addEventListener('click',()=>node.dispatchEvent(new CustomEvent('claude-preview-file',{bubbles:true,detail:{path}})));node.append(open)}
      if(typeof input?.old_string==='string'&&typeof input?.new_string==='string')node.append(el('details',{class:'ca-edit-diff'},el('summary',{text:() => t('transcript.editDiff')}),el('pre',{class:'ca-diff-before',text:input.old_string.slice(0,32768)}),el('pre',{class:'ca-diff-after',text:input.new_string.slice(0,32768)})))
      return node
    }
    case 'tool_result': return el('details', { class: `ca-tool-result${block.isError ? ' ca-error' : ''}`, open: block.isError, 'data-disclosure-key': `tool_result:${block.toolUseId}` },
      summaryLine(tools.get(block.toolUseId) ?? { name: '', preview: '' }, () => block.isError ? t('common.failed') : t('transcript.returned'), i18n, 'transcript.toolResult'),
      el('div', { class: 'ca-tool-body' }, el('small', { class: 'ca-tool-id', text: () => t('transcript.callId', { id: block.toolUseId }) }),
        el('pre', { tabindex: '0' }, block.text, block.truncated ? el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') }) : null)))
    case 'attachment': return el('p',{class:'ca-attachment-card',text:() => t('transcript.attachment', { name: block.name, mime: block.mime })})
    case 'unsupported': return el('p', { class: 'ca-unsupported', text: () => t('transcript.unsupported', { type: block.type }) })
  }
}
export function renderItem(item: DisplayItem, tools: ReadonlyMap<string, ToolSummary> = new Map(), i18n: ClaudeI18n = sourceI18n): HTMLElement {
  const { t, element: el } = i18n
  const hasText = item.blocks.some(block => block.kind === 'text')
  const thinkingOnly = item.blocks.length > 0 && item.blocks.every(block => block.kind === 'thinking')
  const article = el('article', { class: `ca-item ca-${item.role}${!hasText ? thinkingOnly ? ' ca-item-thinking' : ' ca-item-tools' : ''}`, 'data-item-id': item.id })
  if (hasText) article.append(el('span', { class: 'ca-role', text: () => item.role === 'user' ? t('transcript.you') : 'Claude' }))
  let thinkingIndex = 0
  for (const block of item.blocks) {
    const node = item.role === 'user' && block.kind === 'text'
      ? el('div', { class: 'ca-text-block' }, el('p', { class: 'ca-text' }, block.text, block.truncated ? el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') }) : null))
      : renderBlock(block, item.streaming, tools, i18n)
    if (block.kind === 'thinking') node.dataset.disclosureKey = `thinking:${item.id.replace(/^live:/, '')}:${thinkingIndex++}`
    article.append(node)
  }
  return article
}
export interface ApprovalHandlers { decide(approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>): void }
export function renderApproval(approval: ApprovalView, handlers: ApprovalHandlers, domId: (local: string) => string, i18n: ClaudeI18n = sourceI18n): HTMLElement {
  const { t, element: el } = i18n
  const card = el('section', { class: 'ca-approval', 'data-approval-id': approval.id, 'aria-labelledby': domId(`approval-${approval.id}`) })
  const heading = el('h3', { id: domId(`approval-${approval.id}`), text: () => approval.title ?? (approval.kind === 'question' ? t('approval.question') : t('approval.allowTool', { tool: approval.toolName })) })
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
    const answer = el('button', { type: 'submit', class: 'primary-button', text: () => t('approval.answer') })
    const decline = el('button', { type: 'button', text: () => t('approval.declineQuestion') })
    decline.addEventListener('click', () => handlers.decide(approval, 'deny'))
    form.addEventListener('submit', event => {
      event.preventDefault()
      const answers: Record<string, string> = {}
      approval.questions!.forEach((question, index) => {
        const chosen = [...form.querySelectorAll<HTMLInputElement>(`input[name="q${index}"]:checked`)].map(input => input.value)
        if (chosen.length) answers[question.question] = chosen.join(', ')
      })
      if (Object.keys(answers).length !== approval.questions!.length) { form.querySelector<HTMLElement>('.ca-approval-hint')?.remove(); form.append(el('p', { class: 'ca-approval-hint notice', text: () => t('approval.allRequired') })); return }
      handlers.decide(approval, 'allow', answers)
    })
    actions.append(answer, decline); form.append(actions); card.append(form)
    return card
  }
  card.append(el('pre', { class: 'ca-approval-input' }, pretty(approval.input), approval.inputTruncated ? el('span', { class: 'ca-truncated', text: () => t('transcript.truncated') }) : null))
  const why = () => !approval.reason ? t('approval.defaultReason')
    : /obfuscat|expansion|brace with quote/i.test(approval.reason) ? t('approval.complexReason')
      : t('approval.unmatchedReason')
  card.append(el('p', { class: 'ca-approval-reason', text: () => t('approval.why', { reason: why() }) }))
  if (approval.blockedPath) card.append(el('p', { class: 'ca-approval-scope', text: () => t('approval.path', { path: approval.blockedPath ?? '' }) }))
  if (approval.reason) card.append(el('details', { class: 'ca-approval-raw' }, el('summary', { text: () => t('approval.rawReason') }), el('p', { text: approval.reason })))
  if (approval.allowSessionAvailable) card.append(el('details', { class: 'ca-approval-rules', open: true }, el('summary', { text: () => t('approval.remember') }),
    el('p', { text: () => t('approval.rememberHelp') }),
    el('ul', {}, ...(approval.rememberRules ?? []).map(rule => el('li', {}, el('code', { text: rule }))))))
  else card.append(el('p', { class: 'ca-approval-scope', text: () => approval.rememberUnavailableReason ?? t('approval.onceHelp') }))
  const allow = el('button', { type: 'button', class: 'primary-button', text: () => t('approval.allowOnce') })
  allow.addEventListener('click', () => handlers.decide(approval, 'allow'))
  const deny = el('button', { type: 'button', text: () => t('approval.deny') })
  deny.addEventListener('click', () => handlers.decide(approval, 'deny'))
  actions.append(allow)
  if (approval.allowSessionAvailable) { const session = el('button', { type: 'button', text: () => t('approval.allowSession') }); session.addEventListener('click', () => handlers.decide(approval, 'allow-session')); actions.append(session) }
  actions.append(deny)
  card.append(actions)
  if (approval.defaultToNo) card.dataset.defaultToNo = 'true'
  return card
}
const transcriptFrames = new WeakMap<HTMLElement, string>()
/** Keep user disclosures while replacing changed frames, including live-to-history reconciliation. */
export function syncTranscript(container: HTMLElement, items: readonly DisplayItem[], i18n: ClaudeI18n = sourceI18n): void {
  const existing = new Map<string, HTMLElement>(), disclosures = new Map<string, boolean>(), tools = new Map<string, ToolSummary>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-item-id]')) existing.set(node.dataset.itemId!, node)
  for (const details of container.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]')) disclosures.set(details.dataset.disclosureKey!, details.open)
  for (const item of items) for (const block of item.blocks) if (block.kind === 'tool_use') tools.set(block.toolUseId, toolSummary(block))
  const next = items.map(item => {
    const current = existing.get(item.id)
    const frame = JSON.stringify([item, item.blocks.map(block => block.kind === 'tool_result' ? tools.get(block.toolUseId) : null)])
    if (current && transcriptFrames.get(current) === frame) return current
    const node = renderItem(item, tools, i18n); node.dataset.streaming = String(item.streaming)
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
export function renderThreadGroups<Thread extends ThreadLike>(groups: readonly ThreadGroup<Thread>[], options: ThreadGroupOptions, handlers: ThreadGroupHandlers, i18n: ClaudeI18n = sourceI18n): HTMLElement[] {
  const { t, element: el } = i18n
  return groups.map(group => {
    const expanded = !options.collapsed.has(group.path)
    const toggle = el('button', { type: 'button', class: 'ca-group-toggle', 'aria-expanded': String(expanded), title: group.path },
      el('span', { class: 'ca-group-chevron', 'aria-hidden': 'true' }), el('span', { class: 'ca-group-name', text: group.name }), el('small', { class: 'ca-group-count', text: String(group.threads.length) }))
    toggle.addEventListener('click', () => handlers.toggle(group.path))
    const create = el('button', { type: 'button', class: 'ca-group-new', title: () => t('thread.create', { name: group.name }), 'aria-label': () => t('thread.create', { name: group.name }), text: '＋' })
    create.addEventListener('click', () => handlers.create(group.path))
    const selected = options.selectedPath === group.path && !options.currentThreadId
    const list = el('ul', { class: 'ca-group-threads', hidden: !expanded }, ...group.threads.map(thread => {
      const indicator = threadIndicator(thread)
      const status = () => thread.lastRun ? runStatusLabel(thread.lastRun.status, i18n) : t('transcript.notRun')
      const button = el('button', { type: 'button', 'data-thread-id': thread.id, 'aria-current': thread.id === options.currentThreadId ? 'true' : 'false', title: thread.title },
        el('span', { class: 'ca-thread-dot', 'data-indicator': indicator ?? '', title: indicator ? () => indicatorLabel(indicator, i18n) : undefined, 'aria-hidden': indicator ? undefined : 'true' }),
        el('span', { class: 'ca-thread-text' }, el('span', { class: 'ca-thread-name', text: thread.title }),
          el('small', { text: () => `${relativeTime(thread.updatedAt, options.now, i18n)} · ${indicator === 'approval' ? indicatorLabel('approval', i18n) : status()}` })))
      if (indicator) i18n.bind(button, 'aria-label', () => t('thread.statusLabel', { name: thread.title, status: indicatorLabel(indicator, i18n) }))
      button.addEventListener('click', () => handlers.open(thread.id))
      return el('li', {}, button)
    }))
    return el('li', { class: 'ca-thread-group', 'data-path': group.path, 'data-selected': selected ? 'true' : undefined }, el('div', { class: 'ca-group-head' }, toggle, create), list)
  })
}

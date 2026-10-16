import type { ApprovalView, TranscriptBlockView } from '../core/view.js'
import { relativeTime, runStatusLabels, splitCodeFences, threadIndicator, threadIndicatorLabels } from './state.js'
import type { DisplayItem, ThreadGroup, ThreadLike } from './state.js'

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
/** Plain text with fenced code shown in monospace blocks; no Markdown beyond the fences. The streaming caret sits on the last segment. */
export function renderText(text: string, streaming: boolean): HTMLElement {
  const segments = splitCodeFences(text)
  const wrapper = el('div', { class: 'ca-text-block' })
  if (!segments.length) wrapper.append(el('p', { class: `ca-text${streaming ? ' ca-streaming' : ''}`, text: '' }))
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment.kind === 'code') wrapper.append(el('pre', { class: `ca-code${streaming && last ? ' ca-streaming' : ''}`, 'data-language': segment.language || undefined }, el('code', { text: segment.text })))
    else wrapper.append(el('p', { class: `ca-text${streaming && last ? ' ca-streaming' : ''}`, text: segment.text }))
  })
  return wrapper
}
export function renderBlock(block: TranscriptBlockView, streaming: boolean): HTMLElement {
  switch (block.kind) {
    case 'text': return renderText(block.text + (block.truncated ? '\n…（已截断）' : ''), streaming)
    case 'thinking': {
      const details = el('details', { class: 'ca-thinking' }, el('summary', { text: streaming ? '思考中…' : '思考摘要' }), el('p', { text: block.text + (block.truncated ? '\n…（已截断）' : '') }))
      return details
    }
    case 'tool_use': return el('div', { class: 'ca-tool' }, el('div', { class: 'ca-tool-head' }, el('strong', { text: block.name || '工具' }), el('code', { text: block.toolUseId })),
      el('pre', { class: 'ca-tool-input', text: block.input === null ? (streaming ? '…' : '') : pretty(block.input) + (block.inputTruncated ? '\n…（已截断）' : '') }))
    case 'tool_result': return el('div', { class: `ca-tool-result${block.isError ? ' ca-error' : ''}` }, el('div', { class: 'ca-tool-head' }, el('strong', { text: block.isError ? '工具出错' : '工具结果' }), el('code', { text: block.toolUseId })),
      el('pre', { text: block.text + (block.truncated ? '\n…（已截断）' : '') }))
    case 'unsupported': return el('p', { class: 'ca-unsupported', text: `［未显示的内容：${block.type}］` })
  }
}
export function renderItem(item: DisplayItem): HTMLElement {
  const article = el('article', { class: `ca-item ca-${item.role}`, 'data-item-id': item.id })
  article.append(el('span', { class: 'ca-role', text: item.role === 'user' ? '你' : 'Claude' }))
  for (const block of item.blocks) article.append(renderBlock(block, item.streaming))
  return article
}
export interface ApprovalHandlers { decide(approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>): void }
export function renderApproval(approval: ApprovalView, handlers: ApprovalHandlers, domId: (local: string) => string): HTMLElement {
  const card = el('section', { class: 'ca-approval', 'data-approval-id': approval.id, 'aria-labelledby': domId(`approval-${approval.id}`) })
  const heading = el('h3', { id: domId(`approval-${approval.id}`), text: approval.title ?? (approval.kind === 'question' ? 'Claude 需要你的回答' : `允许使用 ${approval.toolName}？`) })
  card.append(heading)
  if (approval.description) card.append(el('p', { class: 'ca-approval-description', text: approval.description }))
  if (approval.reason) card.append(el('p', { class: 'ca-approval-reason', text: approval.reason }))
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
  const allow = el('button', { type: 'button', class: 'primary-button', text: '允许' })
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
/** Rebuilds the transcript list, reusing nodes by item id so a growing stream does not re-render finished items. */
export function syncTranscript(container: HTMLElement, items: readonly DisplayItem[]): void {
  const existing = new Map<string, HTMLElement>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-item-id]')) existing.set(node.dataset.itemId!, node)
  const next = items.map(item => {
    const current = existing.get(item.id)
    if (current && !item.streaming && current.dataset.streaming !== 'true') return current
    const node = renderItem(item); node.dataset.streaming = String(item.streaming)
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

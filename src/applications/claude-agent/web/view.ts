import type { ApprovalView, TranscriptBlockView } from '../core/view.js'
import type { DisplayItem } from './state.js'

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
export function renderBlock(block: TranscriptBlockView, streaming: boolean): HTMLElement {
  switch (block.kind) {
    case 'text': return el('p', { class: `ca-text${streaming ? ' ca-streaming' : ''}`, text: block.text + (block.truncated ? '\n…（已截断）' : '') })
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

import type { ResponsesViewBlock, ResponsesMessagePart, ProtocolViewBlock, ProtocolViewExchange } from '../../core/view/types.js'
import type { MountedNativeBlock, NativeBlockContext } from './view.js'
import type { ToolSummary } from '../tool-call-view.js'
import { asNativeBlock, nativeElement, mountText, mountReasoning, mountFunctionRequest, mountNotice, mountHarnessBlock, mountToolDisclosure } from './primitives.js'

function mountOutputText(initial: Extract<ResponsesMessagePart, { type: 'output_text' }>) {
  const view = mountText(initial); view.element.dataset.nativeType = 'responses.output_text'
  return view
}
function mountRefusal(initial: Extract<ResponsesMessagePart, { type: 'refusal' }>) {
  const view = mountNotice('responses.refusal', `请求被拒绝：${initial.text}`)
  return { ...view, update: (part: ResponsesMessagePart) => view.update(`请求被拒绝：${part.text}`) }
}

export function mountResponsesMessage(initial: Extract<ResponsesViewBlock, { type: 'responses.message' }>): MountedNativeBlock {
  const element = nativeElement(initial.type), phase = document.createElement('span'), body = document.createElement('div')
  phase.className = 'native-message-phase'; element.append(phase, body)
  const children = new Map<string, { type: string; element: HTMLElement; update(part: ResponsesMessagePart): void; dispose(): void }>()
  const update = (value: typeof initial) => {
    phase.hidden = !value.phase; phase.textContent = value.phase === 'commentary' ? '过程消息' : value.phase === 'final_answer' ? '最终回答' : value.phase ? '其他阶段' : ''
    const retained = new Set<string>(); let cursor: ChildNode | null = body.firstChild
    for (const part of value.content) {
      retained.add(part.id)
      let child = children.get(part.id)
      if (!child || child.type !== part.type) {
        if (child?.element === cursor) cursor = cursor.nextSibling
        child?.dispose()
        const view = part.type === 'output_text' ? mountOutputText(part) : mountRefusal(part)
        child = { ...view, type: part.type, update: next => view.update(next) }; children.set(part.id, child)
        child.element.dataset.partId = part.id
      } else child.update(part)
      if (child.element === cursor) cursor = cursor.nextSibling
      else body.insertBefore(child.element, cursor)
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
    for (const [id, view] of children) if (!retained.has(id)) { view.dispose(); children.delete(id) }
  }
  update(initial)
  return asNativeBlock<typeof initial>({ element, update, dispose() { for (const view of children.values()) view.dispose(); children.clear(); element.remove() } })
}
export function mountResponsesReasoning(initial: Extract<ResponsesViewBlock, { type: 'responses.reasoning' }>, context: NativeBlockContext): MountedNativeBlock {
  const view = mountReasoning(initial.type, '推理摘要', initial.summary, context)
  return asNativeBlock<typeof initial>({ ...view, update: (value, ctx) => view.update(value.summary, ctx) })
}
export function mountResponsesFunctionCall(initial: Extract<ResponsesViewBlock, { type: 'responses.function_call' }>, context: NativeBlockContext): MountedNativeBlock {
  const view = mountFunctionRequest(initial.type, initial, context)
  return asNativeBlock<typeof initial>(view)
}
function webSearchSummary(value: Extract<ResponsesViewBlock, { type: 'responses.web_search_call' }>, context: NativeBlockContext): ToolSummary {
  const statusLabel = ({ completed: '响应已完成', in_progress: '进行中', searching: '搜索中', failed: '失败' } as Record<string, string>)[value.status ?? ''] ?? value.status ?? '待返回'
  const failed = value.status === 'failed'
  return { title: '网页搜索', preview: [value.action, value.query, value.sources?.length ? `${value.sources.length} 个来源` : ''].filter(Boolean).join(' · '),
    statusLabel, busy: value.status === 'in_progress' || value.status === 'searching' || (!value.status && context.snapshotStatus === 'provisional'),
    attention: failed, awaitingFacts: false, success: value.status === 'completed', tone: failed ? 'danger' : 'neutral' }
}
export function mountResponsesWebSearch(initial: Extract<ResponsesViewBlock, { type: 'responses.web_search_call' }>, context: NativeBlockContext): MountedNativeBlock {
  const disclosure = mountToolDisclosure(initial.type, webSearchSummary(initial, context), context, 'native-server-tool')
  const label = document.createElement('strong'), detail = document.createElement('p'), sources = document.createElement('div')
  disclosure.body.append(label, detail, sources); let sourceKey = ''
  const update = (value: typeof initial, ctx: NativeBlockContext) => {
    const summary = webSearchSummary(value, ctx)
    disclosure.update(summary, ctx)
    label.textContent = `网页搜索 · ${summary.statusLabel}`
    detail.textContent = [value.action, value.query].filter(Boolean).join(' · ')
    const key = JSON.stringify(value.sources)
    if (key !== sourceKey) {
      sourceKey = key; sources.replaceChildren()
      for (const source of value.sources ?? []) { const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = source.title || new URL(source.url).hostname; sources.append(link) }
    }
  }
  update(initial, context); return asNativeBlock<typeof initial>({ element: disclosure.element, update, dispose() { disclosure.dispose() } })
}
export function mountResponsesBlock(block: ProtocolViewBlock, context: NativeBlockContext): MountedNativeBlock {
  const common = mountHarnessBlock(block); if (common) return common
  switch (block.type) {
    case 'responses.message': return mountResponsesMessage(block)
    case 'responses.reasoning': return mountResponsesReasoning(block, context)
    case 'responses.function_call': return mountResponsesFunctionCall(block, context)
    case 'responses.web_search_call': return mountResponsesWebSearch(block, context)
    default: throw new TypeError('Responses 内容类型不兼容。')
  }
}
export function responsesStateText(exchange: ProtocolViewExchange): string {
  const state = exchange.nativeState
  if (state?.type !== 'responses.state') return ''
  const label = ({ in_progress: '模型正在生成', queued: '模型响应等待中', completed: '模型响应已完成', incomplete: '模型响应被截断', failed: '模型响应失败', cancelled: '模型响应已取消', error: '模型响应出错' } as Record<string, string>)[state.status ?? ''] ?? (state.status ? `原生状态：${state.status}` : '')
  return [state.diagnostic ? '诊断记录' : '', state.partial ? '部分内容' : '', label, state.incompleteReason, state.errorCode].filter(Boolean).join(' · ')
}

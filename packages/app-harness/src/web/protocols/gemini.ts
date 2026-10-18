import type { GeminiViewBlock, GeminiTextPart, ProtocolViewBlock, ProtocolViewExchange } from '../../core/view/types.js'
import type { MountedNativeBlock, NativeBlockContext } from './view.js'
import { asNativeBlock, nativeElement, mountText, mountReasoning, mountFunctionRequest, mountHarnessBlock } from './primitives.js'

export function mountGeminiText(initial: GeminiTextPart) {
  const view = mountText(initial); view.element.dataset.nativeType = 'gemini.text'
  return view
}
export function mountGeminiModelOutput(initial: Extract<GeminiViewBlock, { type: 'gemini.model_output' }>): MountedNativeBlock {
  const element = nativeElement(initial.type), children = new Map<string, ReturnType<typeof mountGeminiText>>()
  const update = (value: typeof initial) => {
    const retained = new Set<string>(); let cursor: ChildNode | null = element.firstChild
    for (const part of value.content) {
      retained.add(part.id)
      let child = children.get(part.id)
      if (!child) { child = mountGeminiText(part); child.element.dataset.partId = part.id; children.set(part.id, child) }
      else child.update(part)
      if (child.element === cursor) cursor = cursor.nextSibling
      else element.insertBefore(child.element, cursor)
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
    for (const [id, child] of children) if (!retained.has(id)) { child.dispose(); children.delete(id) }
  }
  update(initial); return asNativeBlock<typeof initial>({ element, update, dispose() { for (const child of children.values()) child.dispose(); children.clear(); element.remove() } })
}
export function mountGeminiThought(initial: Extract<GeminiViewBlock, { type: 'gemini.thought' }>, context: NativeBlockContext): MountedNativeBlock {
  const view = mountReasoning(initial.type, '推理摘要', initial.summary, context)
  return asNativeBlock<typeof initial>({ ...view, update: (value, ctx) => view.update(value.summary, ctx) })
}
export function mountGeminiFunctionCall(initial: Extract<GeminiViewBlock, { type: 'gemini.function_call' }>, context: NativeBlockContext): MountedNativeBlock {
  return asNativeBlock<typeof initial>(mountFunctionRequest(initial.type, initial, context))
}
export function mountGeminiBlock(block: ProtocolViewBlock, context: NativeBlockContext): MountedNativeBlock {
  const common = mountHarnessBlock(block); if (common) return common
  switch (block.type) {
    case 'gemini.model_output': return mountGeminiModelOutput(block)
    case 'gemini.thought': return mountGeminiThought(block, context)
    case 'gemini.function_call': return mountGeminiFunctionCall(block, context)
    default: throw new TypeError('Gemini 内容类型不兼容。')
  }
}
export function geminiStateText(exchange: ProtocolViewExchange, presentation: NativeBlockContext['presentation'] = 'detail'): string {
  const state = exchange.nativeState
  if (state?.type !== 'gemini.state') return ''
  const toolCaption = presentation === 'compact' && state.status === 'requires_action' && exchange.blocks.some(block => block.type === 'gemini.function_call')
  const label = toolCaption ? '' : ({ in_progress: '模型正在生成', completed: '模型响应已完成', requires_action: '模型已请求工具', incomplete: '模型响应被截断', budget_exceeded: '达到生成预算', failed: '模型响应失败', cancelled: '模型响应已取消' } as Record<string, string>)[state.status ?? ''] ?? (state.status ? `原生状态：${state.status}` : '')
  return [state.diagnostic ? '诊断记录' : '', state.partial ? '部分内容' : '', label, state.stage, state.eventType, state.errorCode].filter(Boolean).join(' · ')
}

import type { ChatViewBlock, ProtocolViewBlock, ProtocolViewExchange } from '../../core/view/types.js'
import type { MountedNativeBlock, NativeBlockContext } from './view.js'
import { asNativeBlock, nativeElement, mountText, mountReasoning, mountFunctionRequest, mountNotice, mountHarnessBlock } from './primitives.js'
type ChatText = Extract<ChatViewBlock, { text: string }>

export function mountChatContent(initial: ChatText): MountedNativeBlock {
  const element = nativeElement('chat.content'), view = mountText(initial); element.append(view.element)
  const update = (value: ChatText) => {
    element.hidden = !value.text.trim(); element.inert = element.hidden
    view.update(value)
  }
  update(initial)
  return asNativeBlock<ChatText>({ element, update, dispose() { view.dispose(); element.remove() } })
}
export function mountChatReasoningContent(initial: ChatText, context: NativeBlockContext): MountedNativeBlock {
  const view = mountReasoning('chat.reasoning_content', '推理内容', [initial], context)
  return asNativeBlock<ChatText>({ ...view, update: (value, ctx) => view.update([value], ctx) })
}
export function mountChatRefusal(initial: ChatText): MountedNativeBlock {
  const view = mountNotice('chat.refusal', `请求被拒绝：${initial.text}`)
  return asNativeBlock<ChatText>({ ...view, update: value => view.update(`请求被拒绝：${value.text}`) })
}
export function mountChatToolCall(initial: Extract<ChatViewBlock, { type: 'chat.tool_call' }>, context: NativeBlockContext): MountedNativeBlock {
  return asNativeBlock<typeof initial>(mountFunctionRequest(initial.type, initial, context))
}
export function mountChatBlock(block: ProtocolViewBlock, context: NativeBlockContext): MountedNativeBlock {
  const common = mountHarnessBlock(block); if (common) return common
  switch (block.type) {
    case 'chat.content': return mountChatContent(block)
    case 'chat.reasoning_content': return mountChatReasoningContent(block, context)
    case 'chat.refusal': return mountChatRefusal(block)
    case 'chat.tool_call': return mountChatToolCall(block, context)
    default: throw new TypeError('Chat Completions 内容类型不兼容。')
  }
}
export function chatStateText(exchange: ProtocolViewExchange, presentation: NativeBlockContext['presentation'] = 'detail'): string {
  const state = exchange.nativeState
  if (state?.type !== 'chat.state') return ''
  const toolCaption = presentation === 'compact' && state.finishReason === 'tool_calls' && exchange.blocks.some(block => block.type === 'chat.tool_call')
  const label = toolCaption ? '' : ({ stop: '模型响应已完成', tool_calls: '模型已请求工具', length: '达到输出上限', content_filter: '内容被过滤' } as Record<string, string>)[state.finishReason ?? ''] ?? (state.finishReason ? `原生停止原因：${state.finishReason}` : '')
  return [state.diagnostic ? '诊断记录' : '', state.partial ? '部分内容' : '', label, state.errorCode].filter(Boolean).join(' · ')
}

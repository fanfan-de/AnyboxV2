import type { ProtocolViewBlock, ProtocolNativeState, ChatViewBlock } from '../view/types.js'
import { object, array, string, position, token, identity, argumentsText, replaceBlock } from './projection-common.js'
export function projectChat(response: unknown): readonly ProtocolViewBlock[] {
  return array(object(response).choices).flatMap((value, index) => {
    const choice = object(value), message = object(choice.message), id = 'choice-' + position(choice.index ?? index), blocks: ChatViewBlock[] = []
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) blocks.push({ id: id + ':reasoning', type: 'chat.reasoning_content', text: message.reasoning_content })
    if (typeof message.content === 'string') blocks.push({ id: id + ':content-0', type: 'chat.content', text: message.content })
    else array(message.content).forEach((part, at) => {
      if (typeof object(part).text === 'string') blocks.push({ id: id + ':content-' + at, type: 'chat.content', text: string(object(part).text) })
    })
    if (typeof message.refusal === 'string' && message.refusal) blocks.push({ id: id + ':refusal', type: 'chat.refusal', text: message.refusal })
    array(message.tool_calls).forEach((value, at) => {
      const call = object(value), fn = object(call.function)
      blocks.push({ id: id + ':tool-' + at, type: 'chat.tool_call', name: string(fn.name), arguments: argumentsText(fn.arguments),
        ...(typeof call.id === 'string' && call.id ? { requestId: identity(call.id) } : {}) })
    })
    return blocks
  })
}
export function chatState(response: unknown, diagnostic = false): ProtocolNativeState {
  const raw = object(response), choice = object(array(raw.choices)[0]), reason = token(choice.finish_reason), code = token(object(raw.error).code)
  const message = object(choice.message), hasContent = [message.content, message.reasoning_content, message.refusal].some(value => typeof value === 'string' && Boolean(value)) || array(message.content).length > 0 || array(message.tool_calls).length > 0
  return { type: 'chat.state', ...(reason ? { finishReason: reason } : {}), ...(code ? { errorCode: code } : {}),
    ...(diagnostic ? { diagnostic: true } : {}), ...(reason === 'length' || diagnostic && hasContent ? { partial: true } : {}) }
}
export function reduceChat(previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  let result = previous
  array(object(event).choices).forEach((value, index) => {
    const choice = object(value), delta = object(choice.delta), id = 'choice-' + position(choice.index ?? index)
    const append = (suffix: string, type: 'chat.content' | 'chat.reasoning_content' | 'chat.refusal', value: unknown) => {
      if (typeof value !== 'string' || !value && type !== 'chat.content') return
      const blockId = id + suffix, old = result.find(block => block.id === blockId)
      result = replaceBlock(result, { id: blockId, type, text: (old && 'text' in old ? old.text : '') + value })
    }
    append(':reasoning', 'chat.reasoning_content', delta.reasoning_content)
    if (typeof delta.content === 'string') append(':content-0', 'chat.content', delta.content)
    else array(delta.content).forEach((part, at) => append(':content-' + at, 'chat.content', object(part).text))
    append(':refusal', 'chat.refusal', delta.refusal)
    array(delta.tool_calls).forEach(value => {
      const call = object(value), fn = object(call.function), blockId = id + ':tool-' + position(call.index), previous = result.find(block => block.id === blockId)
      const old = previous?.type === 'chat.tool_call' ? previous : undefined
      result = replaceBlock(result, { id: blockId, type: 'chat.tool_call', name: (old?.name ?? '') + string(fn.name), arguments: (old?.arguments ?? '') + string(fn.arguments),
        ...(typeof call.id === 'string' && call.id ? { requestId: identity(call.id) } : old?.requestId ? { requestId: old.requestId } : {}) })
    })
  })
  return result
}

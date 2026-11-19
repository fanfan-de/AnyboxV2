import type { ProtocolViewBlock, ProtocolNativeState } from '../view/types.js'
import { object, array, string, position, optionalToken, token, citations, sources, argumentsText, identity, replaceBlock, unsupported } from './projection-common.js'
function block(value: unknown, index: number): ProtocolViewBlock {
  const raw = object(value), id = 'block-' + index
  if (raw.type === 'text') {
    const text = string(raw.text), links = citations(raw.citations, text)
    return { id, type: 'anthropic.text', text, ...(links.length ? { citations: links } : {}) }
  }
  if (raw.type === 'thinking') return { id, type: 'anthropic.thinking', text: string(raw.thinking) }
  if (raw.type === 'redacted_thinking') return { id, type: 'anthropic.redacted_thinking' }
  if (raw.type === 'tool_use' || raw.type === 'server_tool_use') return { id, type: raw.type === 'tool_use' ? 'anthropic.tool_use' : 'anthropic.server_tool_use',
    name: string(raw.name), arguments: argumentsText(raw.input), ...(typeof raw.id === 'string' && raw.id ? { requestId: identity(raw.id) } : {}) }
  if (raw.type === 'web_search_tool_result') {
    const failure = object(raw.content).type === 'web_search_tool_result_error'
    return { id, type: 'anthropic.web_search_tool_result', status: failure ? 'failed' : 'completed', sources: sources(raw.content),
      ...(typeof raw.tool_use_id === 'string' && raw.tool_use_id ? { requestId: identity(raw.tool_use_id) } : {}), ...optionalToken('errorCode', object(raw.content).error_code) }
  }
  return unsupported(id, 'Unsupported Anthropic content block')
}
export function projectAnthropic(response: unknown): readonly ProtocolViewBlock[] { return array(object(response).content).map(block) }
export function anthropicState(response: unknown, diagnostic = false): ProtocolNativeState {
  const raw = object(response), reason = token(raw.stop_reason), code = token(object(raw.error).type ?? object(raw.error).code ?? raw.code)
  return { type: 'anthropic.state', ...(reason ? { stopReason: reason } : {}),
    ...(typeof raw.stop_sequence === 'string' ? { stopSequence: raw.stop_sequence.slice(0, 512) } : {}), ...optionalToken('stopDetailsType', object(raw.stop_details).type),
    ...(code ? { errorCode: code } : {}), ...(diagnostic ? { diagnostic: true } : {}),
    ...(['max_tokens', 'model_context_window_exceeded'].includes(reason ?? '') || diagnostic && array(raw.content).length > 0 ? { partial: true } : {}) }
}
export function reduceAnthropic(previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  const raw = object(event), type = string(raw.type), index = position(raw.index), id = 'block-' + index
  if (type === 'content_block_start') return replaceBlock(previous, block(raw.content_block, index))
  const old = previous.find(item => item.id === id), delta = object(raw.delta)
  if (type !== 'content_block_delta' || !old) return previous
  if (delta.type === 'text_delta' && old.type === 'anthropic.text') return replaceBlock(previous, { ...old, text: old.text + string(delta.text) })
  if (delta.type === 'thinking_delta' && old.type === 'anthropic.thinking') return replaceBlock(previous, { ...old, text: old.text + string(delta.thinking) })
  if (delta.type === 'citations_delta' && old.type === 'anthropic.text') return replaceBlock(previous, { ...old, citations: [...(old.citations ?? []), ...citations([delta.citation], old.text)] })
  if (delta.type === 'input_json_delta' && (old.type === 'anthropic.tool_use' || old.type === 'anthropic.server_tool_use')) {
    // Empty start input is a placeholder, not a prefix of the streamed JSON.
    return replaceBlock(previous, { ...old, arguments: (old.arguments === '{}' ? '' : old.arguments) + string(delta.partial_json) })
  }
  return previous
}

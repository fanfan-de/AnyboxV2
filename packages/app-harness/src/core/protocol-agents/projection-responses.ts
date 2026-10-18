import type { ProtocolViewBlock, ProtocolNativeState, ResponsesViewBlock, ResponsesMessagePart } from '../view/types.js'
import { object, array, string, position, optionalToken, token, citations, sources, summary, argumentsText, identity, replaceBlock, orderedParts, unsupported } from './projection-common.js'
function part(value: unknown, id: string): ResponsesMessagePart | undefined {
  const raw = object(value)
  if (raw.type === 'output_text') {
    const text = string(raw.text), links = citations(raw.annotations, text)
    return { id, type: 'output_text', text, ...(links.length ? { citations: links } : {}) }
  }
  if (raw.type === 'refusal') return { id, type: 'refusal', text: string(raw.refusal) }
  return undefined
}
function item(value: unknown, index: number): ProtocolViewBlock {
  const raw = object(value), id = 'item-' + index
  if (raw.type === 'message') return { id, type: 'responses.message',
    ...(typeof raw.phase === 'string' ? { phase: raw.phase === 'commentary' || raw.phase === 'final_answer' ? raw.phase : 'unknown' } : {}),
    ...optionalToken('status', raw.status), content: array(raw.content).flatMap((value, at) => {
      const projected = part(value, id + ':part-' + at)
      return projected ? [projected] : []
    }) }
  if (raw.type === 'reasoning') return { id, type: 'responses.reasoning', summary: summary(raw.summary, id) }
  if (raw.type === 'function_call') return { id, type: 'responses.function_call', name: string(raw.name), arguments: argumentsText(raw.arguments),
    ...(typeof raw.call_id === 'string' && raw.call_id ? { requestId: identity(raw.call_id) } : {}), ...optionalToken('status', raw.status) }
  if (raw.type === 'web_search_call') {
    const action = object(raw.action), links = sources(action.sources)
    return { id, type: 'responses.web_search_call', ...optionalToken('status', raw.status), ...optionalToken('action', action.type),
      ...(typeof action.query === 'string' ? { query: action.query } : {}), ...(links.length ? { sources: links } : {}) }
  }
  return unsupported(id, 'Unsupported Responses item')
}
export function projectResponses(response: unknown): readonly ProtocolViewBlock[] { return array(object(response).output).map(item) }
export function responsesState(response: unknown, diagnostic = false): ProtocolNativeState {
  const raw = object(response), status = token(raw.status), reason = token(object(raw.incomplete_details).reason), code = token(object(raw.error).code ?? raw.code)
  return { type: 'responses.state', ...(status ? { status } : {}), ...(reason ? { incompleteReason: reason } : {}), ...(code ? { errorCode: code } : {}),
    ...(diagnostic ? { diagnostic: true } : {}), ...(status === 'incomplete' || diagnostic && array(raw.output).length > 0 ? { partial: true } : {}) }
}
export function reduceResponses(previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  const raw = object(event), type = string(raw.type), index = position(raw.output_index), id = 'item-' + index
  if (type === 'response.completed' || type === 'response.incomplete') return projectResponses(raw.response)
  if (type === 'response.output_item.added' || type === 'response.output_item.done') return replaceBlock(previous, item(raw.item, index))
  const old = previous.find(block => block.id === id)
  if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
    const block: Extract<ResponsesViewBlock, { type: 'responses.function_call' }> = old?.type === 'responses.function_call'
      ? old : { id, type: 'responses.function_call', name: '', arguments: '' }
    return replaceBlock(previous, { ...block, arguments: type.endsWith('.done') ? string(raw.arguments) : block.arguments + string(raw.delta) })
  }
  if (type.startsWith('response.web_search_call.')) {
    return replaceBlock(previous, { ...(old?.type === 'responses.web_search_call' ? old : { id, type: 'responses.web_search_call' as const }), status: token(type.split('.').at(-1)) })
  }
  if (type.startsWith('response.reasoning_summary')) {
    const block = old?.type === 'responses.reasoning' ? old : { id, type: 'responses.reasoning' as const, summary: [] }
    const at = position(raw.summary_index), partId = id + ':summary-' + at, content = [...block.summary]
    const found = content.findIndex(value => value.id === partId), existing = found < 0 ? undefined : content[found]
    const text = type.endsWith('.delta') ? (existing?.text ?? '') + string(raw.delta)
      : type.includes('_part.') ? string(object(raw.part).text) : string(raw.text)
    const projected = { id: partId, text }
    if (found < 0) content.push(projected); else content[found] = projected
    return replaceBlock(previous, { ...block, summary: orderedParts(content) })
  }
  if (!['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done',
    'response.content_part.added', 'response.content_part.done', 'response.output_text.annotation.added'].includes(type)) return previous
  const block = old?.type === 'responses.message' ? old : { id, type: 'responses.message' as const, content: [] }
  const at = position(raw.content_index), partId = id + ':part-' + at, content = [...block.content]
  const found = content.findIndex(value => value.id === partId), existing = found < 0 ? undefined : content[found]
  let projected: ResponsesMessagePart | undefined
  if (type.startsWith('response.content_part.')) projected = part(raw.part, partId)
  else if (type === 'response.output_text.annotation.added') {
    if (existing?.type !== 'output_text') return previous
    projected = { ...existing, citations: [...(existing.citations ?? []), ...citations([raw.annotation], existing.text)] }
  } else {
    const refusal = type.startsWith('response.refusal.'), text = type.endsWith('.delta') ? (existing?.text ?? '') + string(raw.delta) : string(refusal ? raw.refusal : raw.text)
    projected = refusal ? { id: partId, type: 'refusal', text } : { id: partId, type: 'output_text', text,
      ...(existing?.type === 'output_text' && existing.citations ? { citations: existing.citations } : {}) }
  }
  if (!projected) return previous
  if (found < 0) content.push(projected); else content[found] = projected
  return replaceBlock(previous, { ...block, content: orderedParts(content) })
}

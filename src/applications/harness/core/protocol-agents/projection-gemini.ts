import type { ProtocolViewBlock, ProtocolNativeState, GeminiTextPart } from '../view/types.js'
import { object, array, string, position, token, optionalToken, identity, argumentsText, citations, summary, replaceBlock, unsupported } from './projection-common.js'
function step(value: unknown, index: number): ProtocolViewBlock {
  const raw = object(value), id = 'step-' + index
  if (raw.type === 'model_output') return { id, type: 'gemini.model_output', content: array(raw.content).flatMap((part, at) => {
    const raw = object(part)
    if (raw.type !== 'text') return []
    const text = string(raw.text), links = citations(raw.annotations, text)
    return [{ id: id + ':part-' + at, type: 'text' as const, text, ...(links.length ? { citations: links } : {}) }]
  }) }
  if (raw.type === 'thought') return { id, type: 'gemini.thought', summary: summary(raw.summary, id) }
  if (raw.type === 'function_call') return { id, type: 'gemini.function_call', name: string(raw.name), arguments: argumentsText(raw.arguments),
    ...(typeof raw.id === 'string' && raw.id ? { requestId: identity(raw.id) } : {}) }
  return unsupported(id, 'Unsupported Gemini step')
}
export function projectGemini(response: unknown): readonly ProtocolViewBlock[] { return array(object(response).steps).map(step) }
export function geminiState(response: unknown, diagnostic = false): ProtocolNativeState {
  const raw = object(response), status = token(raw.status)
  return { type: 'gemini.state', ...(status ? { status } : {}), ...optionalToken('stage', raw.stage), ...optionalToken('eventType', raw.event_type),
    ...optionalToken('errorCode', object(array(raw.errors)[0]).code),
    ...(diagnostic ? { diagnostic: true } : {}), ...(['incomplete', 'budget_exceeded'].includes(status ?? '') || diagnostic && array(raw.steps).length > 0 ? { partial: true } : {}) }
}
export function reduceGemini(previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  const raw = object(event), type = string(raw.event_type), index = position(raw.index), id = 'step-' + index
  if (type === 'step.start') return replaceBlock(previous, step(raw.step, index))
  if (type !== 'step.delta') return previous
  const old = previous.find(block => block.id === id), delta = object(raw.delta)
  if (old?.type === 'gemini.model_output' && (delta.type === 'text' || delta.type === 'text_annotation_delta')) {
    const content: GeminiTextPart[] = [...old.content], last = content.at(-1)
    if (delta.type === 'text') {
      const projected: GeminiTextPart = last ? { ...last, text: last.text + string(delta.text) } : { id: id + ':part-0', type: 'text', text: string(delta.text) }
      if (last) content[content.length - 1] = projected; else content.push(projected)
    } else if (last) content[content.length - 1] = { ...last, citations: [...(last.citations ?? []), ...citations(delta.annotations, last.text)] }
    return replaceBlock(previous, { ...old, content })
  }
  if (old?.type === 'gemini.thought' && delta.type === 'thought_summary') {
    const text = object(delta.content).text
    if (typeof text !== 'string') return previous
    const last = old.summary.at(-1), nextIndex = last ? position(Number(last.id.slice(last.id.lastIndexOf('-') + 1))) + 1 : 0
    return replaceBlock(previous, { ...old, summary: [...old.summary, { id: id + ':summary-' + nextIndex, text }] })
  }
  if (old?.type === 'gemini.function_call' && delta.type === 'arguments_delta') return replaceBlock(previous, { ...old,
    arguments: (old.arguments === '{}' ? '' : old.arguments) + string(delta.arguments) })
  return previous
}

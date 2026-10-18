import type { JsonValue } from '@anybox/models'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { ProtocolViewBlock, ProtocolViewExchange, ProtocolViewInput, ProtocolNativeState } from '../view/types.js'
import { object, array, string, identity } from './projection-common.js'
import { projectResponses, reduceResponses, responsesState } from './projection-responses.js'
import { projectAnthropic, reduceAnthropic, anthropicState } from './projection-anthropic.js'
import { projectChat, reduceChat, chatState } from './projection-chat.js'
import { projectGemini, reduceGemini, geminiState } from './projection-gemini.js'

interface ViewRecord { readonly id: string; readonly kind: string; readonly exchangeId?: string; readonly payload: JsonValue }

interface NativeInputText { readonly id: string; readonly role: 'system' | 'developer' | 'user'; readonly text: string }

/** Read only protocol text positions. Image bodies, tool results and opaque continuation are excluded. */
function inputText(content: unknown, textTypes: readonly string[], imageTypes: readonly string[] = []): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap(value => {
    const part = object(value)
    return textTypes.includes(string(part.type)) && typeof part.text === 'string' ? [part.text] : []
  })
  if (text.length) return text.join('\n\n')
  return content.some(value => imageTypes.includes(string(object(value).type))) ? '' : undefined
}

/** Historical Prompt kinds preserve system/context meaning even when a protocol merges their native roles. */
export function projectNativeRequest(protocolId: string, request: unknown, prompts?: readonly PromptSnapshot[]): readonly ProtocolViewInput[] {
  const raw = object(request), messages: NativeInputText[] = []
  const append = (id: string, role: unknown, text: string | undefined) => {
    if (text !== undefined && (role === 'system' || role === 'developer' || role === 'user')) messages.push({ id, role, text })
  }
  if (protocolId === 'responses' || protocolId === 'chat-completions') {
    const content = protocolId === 'responses' ? raw.input : raw.messages
    if (protocolId === 'responses' && typeof content === 'string') append('input-0', 'user', content)
    else array(content).forEach((value, index) => {
      const message = object(value)
      append('input-' + index, message.role, inputText(message.content,
        protocolId === 'responses' ? ['input_text'] : ['text'], protocolId === 'responses' ? ['input_image'] : ['image_url']))
    })
  } else if (protocolId === 'anthropic-messages') {
    append('system', 'system', inputText(raw.system, ['text']))
    array(raw.messages).forEach((value, index) => {
      const message = object(value)
      append('input-' + index, message.role, inputText(message.content, ['text'], ['image']))
    })
  } else if (protocolId === 'gemini-interactions') {
    if (typeof raw.system_instruction === 'string') append('system', 'system', raw.system_instruction)
    array(raw.input).forEach((value, index) => {
      const step = object(value)
      if (step.type === 'user_input') append('input-' + index, 'user', inputText(step.content, ['text'], ['image']))
    })
  } else return []

  const initial = prompts?.filter(prompt => prompt.kind === 'agent-instruction' || prompt.kind === 'context') ?? []
  const nativeInputs = (values: readonly NativeInputText[]): readonly ProtocolViewInput[] => values.map(message => ({
    id: identity(message.id), role: message.role === 'user' ? 'user' : 'system', text: message.text }))
  if (!initial.length) return nativeInputs(messages)
  let appended: readonly NativeInputText[]
  if (protocolId === 'responses' || protocolId === 'chat-completions') {
    const hasInitial = messages.length >= initial.length && initial.every((prompt, index) =>
      messages[index]?.role === prompt.role && messages[index]?.text === prompt.content)
    if (!hasInitial) return nativeInputs(messages)
    appended = messages.slice(initial.length)
  } else {
    const instructions = initial.filter(prompt => prompt.role !== 'user').map(prompt => prompt.content).join('\n\n')
    const context = initial.filter(prompt => prompt.role === 'user')
    const users = messages.filter(message => message.role === 'user')
    const hasInitial = (instructions ? messages.some(message => message.role === 'system' && message.text === instructions) : users.length > context.length) &&
      context.every((prompt, index) => users[index]?.text === prompt.content)
    if (!hasInitial) return nativeInputs(messages)
    appended = users.slice(context.length)
  }
  // Only classify prompts actually present in this delta. Descendants inherit them through their parent records.
  return [...initial.map((prompt, index): ProtocolViewInput => ({ id: 'prompt-' + index,
    role: prompt.kind === 'context' ? 'context' : 'system', text: prompt.content })), ...nativeInputs(appended)]
}

/** Protocol-specific output and terminal state stay distinct from Run status. */
export function projectNativeResponse(protocolId: string, response: unknown): readonly ProtocolViewBlock[] {
  switch (protocolId) {
    case 'responses': return projectResponses(response)
    case 'anthropic-messages': return projectAnthropic(response)
    case 'chat-completions': return projectChat(response)
    case 'gemini-interactions': return projectGemini(response)
    default: return [{ id: 'unsupported', type: 'harness.unsupported', text: 'Protocol display is unavailable' }]
  }
}
export function projectNativeState(protocolId: string, response: unknown, diagnostic = false): ProtocolNativeState | undefined {
  switch (protocolId) {
    case 'responses': return responsesState(response, diagnostic)
    case 'anthropic-messages': return anthropicState(response, diagnostic)
    case 'chat-completions': return chatState(response, diagnostic)
    case 'gemini-interactions': return geminiState(response, diagnostic)
    default: return undefined
  }
}
export function projectNativeExchange(protocolId: string, response: unknown, diagnostic = false): Pick<ProtocolViewExchange, 'blocks' | 'nativeState'> {
  return { blocks: projectNativeResponse(protocolId, response), nativeState: projectNativeState(protocolId, response, diagnostic) }
}

function displayLength(block: ProtocolViewBlock): number {
  if ('text' in block) return block.text.length
  if ('arguments' in block) return block.arguments.length
  if ('content' in block) return block.content.reduce((sum, part) => sum + part.text.length, 0)
  if ('summary' in block) return block.summary.reduce((sum, part) => sum + part.text.length, 0)
  return block.type === 'responses.web_search_call' ? (block.query?.length ?? 0) : 0
}
/** Clipping cannot change original offsets; clipped text drops positional citations. */
function clipBlock(block: ProtocolViewBlock, budget: number): ProtocolViewBlock {
  let remaining = budget
  const clip = (text: string): string => {
    const length = Math.max(0, Math.min(remaining, 16_000))
    const value = length ? text.slice(-length) : ''
    remaining -= value.length
    return value
  }
  const id = identity(block.id)
  if ('text' in block) {
    const text = clip(block.text)
    return { ...block, id, text, ...(block.type === 'anthropic.text' && text !== block.text ? { citations: [] } : {}) }
  }
  if ('arguments' in block) return { ...block, id, name: block.name.slice(0, 256), arguments: clip(block.arguments), ...(block.requestId ? { requestId: identity(block.requestId) } : {}) }
  if (block.type === 'responses.message') return { ...block, id, content: block.content.slice(-128).reverse().map(part => {
    const text = clip(part.text)
    return { ...part, id: identity(part.id), text, ...(part.type === 'output_text' && text !== part.text ? { citations: [] } : {}) }
  }).reverse() }
  if (block.type === 'gemini.model_output') return { ...block, id, content: block.content.slice(-128).reverse().map(part => {
    const text = clip(part.text)
    return { ...part, id: identity(part.id), text, ...(text !== part.text ? { citations: [] } : {}) }
  }).reverse() }
  if ('summary' in block) return { ...block, id, summary: block.summary.slice(-128).reverse().map(part => ({ id: identity(part.id), text: clip(part.text) })).reverse() }
  if (block.type === 'responses.web_search_call') return { ...block, id, ...(block.query !== undefined ? { query: clip(block.query) } : {}) }
  if (block.type === 'anthropic.web_search_tool_result') return { ...block, id, ...(block.requestId ? { requestId: identity(block.requestId) } : {}) }
  return { ...block, id }
}
function stripReferences(block: ProtocolViewBlock): ProtocolViewBlock {
  if (block.type === 'responses.message') return { ...block, content: block.content.map(part => part.type === 'output_text' ? { ...part, citations: [] } : part) }
  if (block.type === 'gemini.model_output') return { ...block, content: block.content.map(part => ({ ...part, citations: [] })) }
  if (block.type === 'anthropic.text') return { ...block, citations: [] }
  if (block.type === 'responses.web_search_call' || block.type === 'anthropic.web_search_tool_result') return { ...block, sources: [] }
  return block
}

/** Bounded replacement frames keep slow subscribers independent from native execution. */
export function boundProtocolView(exchanges: readonly ProtocolViewExchange[]): readonly ProtocolViewExchange[] {
  const retained = exchanges.filter(exchange => exchange.id !== 'display-limit')
  let remaining = 48_000, clipped = retained.length !== exchanges.length || retained.length > 63
  const result: ProtocolViewExchange[] = []
  for (const exchange of retained.slice(-63).reverse()) {
    const blocks: ProtocolViewBlock[] = [], inputs: ProtocolViewInput[] = []
    const content = exchange.blocks.filter(block => block.type !== 'harness.display_limit')
    if (content.length !== exchange.blocks.length || content.length > 128) clipped = true
    for (const block of content.slice(-128).reverse()) {
      if (remaining <= 0) { clipped = true; break }
      const bounded = clipBlock(block, remaining)
      if (JSON.stringify(block) !== JSON.stringify(bounded)) clipped = true
      remaining -= displayLength(bounded) + 128
      blocks.unshift(bounded)
    }
    if ((exchange.inputs?.length ?? 0) > 128) clipped = true
    for (const input of (exchange.inputs ?? []).slice(-128).reverse()) {
      if (remaining <= 0) { clipped = true; break }
      const text = input.text.slice(0, Math.max(0, Math.min(remaining, 16_000)))
      remaining -= text.length + 128
      if (text !== input.text) clipped = true
      inputs.unshift({ id: identity(input.id), role: input.role, text })
    }
    result.unshift({ id: identity(exchange.id), ...(inputs.length ? { inputs } : {}), blocks, ...(exchange.nativeState ? { nativeState: exchange.nativeState } : {}) })
  }
  const bytes = () => Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (bytes() > 48 * 1024 - 512) {
    clipped = true
    for (let at = 0; at < result.length; at++) result[at] = { ...result[at]!, blocks: result[at]!.blocks.map(stripReferences) }
  }
  while (bytes() > 48 * 1024 - 512) {
    clipped = true
    const exchange = result[0]
    if (!exchange) break
    const block = exchange.blocks[0], exchangeIndex = 0
    if (block) {
      const length = displayLength(block)
      result[exchangeIndex] = { ...exchange, blocks: length > 256 ? [clipBlock(block, Math.floor(length / 2)), ...exchange.blocks.slice(1)] : exchange.blocks.slice(1) }
    } else if (exchange.inputs?.length) {
      const input = exchange.inputs[0]!
      result[exchangeIndex] = { ...exchange, inputs: input.text.length > 256 ? [{ ...input, text: input.text.slice(0, Math.floor(input.text.length / 2)) }, ...exchange.inputs.slice(1)] : exchange.inputs.slice(1) }
    } else result.shift()
  }
  if (clipped) result.unshift({ id: 'display-limit', blocks: [{ id: 'display-limit', type: 'harness.display_limit', text: 'Some display content is truncated; complete native history is retained.' }] })
  return result
}

/** Read old native record versions without rewriting them; views always use the current schema. */
export function projectProtocolRecords(protocolId: string, records: readonly ViewRecord[], prompts?: readonly PromptSnapshot[]): readonly ProtocolViewExchange[] {
  const exchanges = new Map<string, ProtocolViewExchange>()
  let firstRequest = true
  for (const record of records) {
    if (!['request', 'response', 'diagnostic'].includes(record.kind)) continue
    const id = record.exchangeId ?? record.id, previous = exchanges.get(id)
    if (record.kind === 'request') {
      const inputs = projectNativeRequest(protocolId, record.payload, firstRequest ? prompts : undefined)
      firstRequest = false
      exchanges.set(id, { ...previous, id, ...(inputs.length ? { inputs } : {}), blocks: previous?.blocks ?? [] })
    } else {
      const projected = projectNativeExchange(protocolId, record.payload, record.kind === 'diagnostic')
      exchanges.set(id, { ...previous, id, ...projected, blocks: projected.blocks.length ? projected.blocks : previous?.blocks ?? [] })
    }
  }
  return boundProtocolView([...exchanges.values()])
}

export function reduceNativeView(protocolId: string, previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  let blocks: readonly ProtocolViewBlock[]
  switch (protocolId) {
    case 'responses': blocks = reduceResponses(previous, event); break
    case 'anthropic-messages': blocks = reduceAnthropic(previous, event); break
    case 'chat-completions': blocks = reduceChat(previous, event); break
    case 'gemini-interactions': blocks = reduceGemini(previous, event); break
    default: blocks = previous
  }
  return boundProtocolView([{ id: 'stream', blocks }]).flatMap(exchange => exchange.blocks)
}
/** Stream state contains only safe display data, never a second native continuation. */
export function reduceNativeExchange(protocolId: string, previous: ProtocolViewExchange, event: unknown): ProtocolViewExchange {
  const raw = object(event), type = string(raw.type ?? raw.event_type)
  let state = previous.nativeState
  if (protocolId === 'responses') {
    if (raw.response !== undefined && type.startsWith('response.')) state = responsesState(raw.response)
    else if (['response.in_progress', 'response.queued', 'response.failed', 'response.cancelled'].includes(type)) state = responsesState({ status: type.slice(9) })
  } else if (protocolId === 'anthropic-messages') {
    if (type === 'message_start') state = anthropicState(raw.message)
    if (type === 'message_delta') state = anthropicState(raw.delta)
  } else if (protocolId === 'chat-completions') {
    if (array(raw.choices).some(choice => typeof object(choice).finish_reason === 'string')) state = chatState(raw)
  } else if (protocolId === 'gemini-interactions' && type.startsWith('interaction.')) {
    const native = object(raw.interaction), eventStatus = type === 'interaction.in_progress' ? 'in_progress' : type === 'interaction.requires_action' ? 'requires_action' : undefined
    state = geminiState({ ...native, ...(typeof raw.status === 'string' ? { status: raw.status } : native.status === undefined && eventStatus ? { status: eventStatus } : {}) })
  }
  const settled = (value: ProtocolNativeState): boolean => {
    if (value.type === 'anthropic.state') return value.stopReason !== undefined
    if (value.type === 'chat.state') return value.finishReason !== undefined
    return ['completed', 'incomplete', 'failed', 'cancelled', 'requires_action', 'budget_exceeded'].includes(value.status ?? '')
  }
  if (state && previous.nativeState?.type === state.type) {
    state = settled(previous.nativeState) && !settled(state) ? previous.nativeState : { ...previous.nativeState, ...state }
  }
  return { ...previous, blocks: reduceNativeView(protocolId, previous.blocks, event), ...(state ? { nativeState: state } : {}) }
}

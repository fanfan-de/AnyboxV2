import { parseNativeImageResourceUri } from '@anybox/models'
import type { JsonValue, NativeImageResourceRef, NativeObject } from '@anybox/models'
import { citations } from '../protocol-agents/projection-common.js'
import type { StoredProtocolRecord } from '../run/program.js'
import type { ProtocolCitation } from '../view/types.js'
import { treeError } from './domain.js'

type Protocol = 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-interactions'

type TextPart = { readonly type: 'text'; readonly text: string }
type AssistantTextPart = TextPart & { readonly citations?: readonly ProtocolCitation[] }
type ToolCallPart = { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: NativeObject }

export interface PortableProviderToolPart {
  readonly type: 'provider-tool'
  readonly protocolId: 'responses' | 'anthropic-messages'
  readonly name: string
  readonly id: string
  readonly phase: 'call' | 'result'
  readonly data: NativeObject
}

export type PortableUserPart = TextPart | { readonly type: 'image'; readonly resource: NativeImageResourceRef }
export type PortableAssistantPart = AssistantTextPart | ToolCallPart | PortableProviderToolPart
export type PortableHistoryEvent =
  | { readonly role: 'user'; readonly parts: readonly PortableUserPart[] }
  | { readonly role: 'assistant'; readonly parts: readonly PortableAssistantPart[] }
  | { readonly role: 'tool'; readonly id: string; readonly name: string; readonly output: string; readonly isError?: boolean }

function incompatible(): never { throw treeError('history-incompatible') }

function optionalObject(value: JsonValue | undefined): NativeObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NativeObject : undefined
}

function object(value: JsonValue | undefined): NativeObject {
  return optionalObject(value) ?? incompatible()
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) return incompatible()
  return value
}

function string(value: JsonValue | undefined): string {
  if (typeof value !== 'string') return incompatible()
  return value
}

function toolCall(id: JsonValue | undefined, name: JsonValue | undefined, args: JsonValue | undefined): ToolCallPart {
  let decoded = args
  if (typeof args === 'string') {
    try { decoded = JSON.parse(args) as JsonValue }
    catch { return incompatible() }
  }
  if (!id || !name) return incompatible()
  return { type: 'tool-call', id: string(id), name: string(name), arguments: object(decoded) }
}

const userFormats = {
  responses: { text: 'input_text', image: 'input_image', uri: (part: NativeObject) => part.image_url },
  'chat-completions': { text: 'text', image: 'image_url', uri: (part: NativeObject) => object(part.image_url).url },
  'anthropic-messages': { text: 'text', image: 'image', uri: (part: NativeObject) => object(part.source).url },
  'gemini-interactions': { text: 'text', image: 'image', uri: (part: NativeObject) => part.uri },
}

function user(protocol: Protocol, item: NativeObject, refs: readonly NativeImageResourceRef[]): PortableHistoryEvent {
  if (protocol === 'gemini-interactions' ? item.type !== 'user_input' : item.role !== 'user') return incompatible()
  if (typeof item.content === 'string') return { role: 'user', parts: [{ type: 'text', text: item.content }] }
  const format = userFormats[protocol]
  const parts = list(item.content).map((value): PortableUserPart => {
    const part = object(value)
    if (part.type === format.text) return { type: 'text', text: string(part.text) }
    if (part.type !== format.image) return incompatible()
    const id = parseNativeImageResourceUri(string(format.uri(part)))
    const resource = refs.find(ref => ref.id === id)
    return resource ? { type: 'image', resource } : incompatible()
  })
  if (!parts.length) return incompatible()
  return { role: 'user', parts }
}

function citedText(text: string, raw: JsonValue | undefined, citationType: 'url_citation' | 'web_search_result_location'): AssistantTextPart {
  const links = citations(Array.isArray(raw) ? raw.filter(value => optionalObject(value)?.type === citationType) : [], text)
  return { type: 'text', text, ...(links.length ? { citations: links } : {}) }
}

function textParts(content: JsonValue | undefined, type: 'text' | 'output_text'): readonly AssistantTextPart[] {
  const parts: AssistantTextPart[] = []
  for (const value of list(content)) {
    const block = object(value)
    if (block.type !== type) return incompatible()
    const text = string(block.text)
    if (text) parts.push(type === 'output_text' ? citedText(text, block.annotations, 'url_citation') : { type: 'text', text })
  }
  return parts
}

function responseSearch(item: NativeObject): readonly PortableProviderToolPart[] {
  const id = item.id
  if (typeof id !== 'string' || !id) return []
  const source = { type: 'provider-tool', protocolId: 'responses', name: 'web_search', id } as const
  const action = optionalObject(item.action), status = item.status
  let call: NativeObject = {}
  if (action?.type === 'search') {
    const queries = Array.isArray(action.queries) ? action.queries.filter(value => typeof value === 'string') : undefined
    call = { action: { type: action.type, ...(typeof action.query === 'string' ? { query: action.query } : {}),
      ...(queries === undefined ? {} : { queries }) } }
  } else if (action?.type === 'open_page' || action?.type === 'find_in_page') {
    call = { action: { type: action.type,
      ...(typeof action.url === 'string' || action.url === null ? { url: action.url } : {}),
      ...(action.type === 'find_in_page' && typeof action.pattern === 'string' ? { pattern: action.pattern } : {}) } }
  }
  const parts: PortableProviderToolPart[] = [{ ...source, phase: 'call', data: call }]
  const sources = Array.isArray(action?.sources) ? action.sources.flatMap((value): NativeObject[] => {
    const entry = optionalObject(value)
    return entry?.type === 'url' && typeof entry.url === 'string' ? [{ type: entry.type, url: entry.url }] : []
  }) : undefined
  if (typeof status === 'string' || sources !== undefined) parts.push({ ...source, phase: 'result', data: {
    ...(typeof status === 'string' ? { status } : {}), ...(sources === undefined ? {} : { sources }),
  } })
  return parts
}

function anthropicSearch(block: NativeObject): PortableProviderToolPart | undefined {
  if (block.type === 'server_tool_use' && block.name === 'web_search' && typeof block.id === 'string' && block.id) {
    const query = optionalObject(block.input)?.query
    return { type: 'provider-tool', protocolId: 'anthropic-messages', name: block.name, id: block.id, phase: 'call',
      data: { input: typeof query === 'string' ? { query } : {} } }
  }
  if (block.type !== 'web_search_tool_result' || typeof block.tool_use_id !== 'string' || !block.tool_use_id) return undefined
  const result = { type: 'provider-tool', protocolId: 'anthropic-messages', name: 'web_search', id: block.tool_use_id, phase: 'result' } as const
  if (Array.isArray(block.content)) {
    const content = block.content.flatMap((value): NativeObject[] => {
      const entry = optionalObject(value)
      if (entry?.type !== 'web_search_result') return []
      // The provider returns an encrypted document. Only its public metadata can move across protocols.
      return [{ type: entry.type, ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
        ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
        ...(typeof entry.page_age === 'string' || entry.page_age === null ? { page_age: entry.page_age } : {}) }]
    })
    return { ...result, data: { content } }
  }
  const error = optionalObject(block.content)
  if (error?.type !== 'web_search_tool_result_error' || typeof error.error_code !== 'string') return undefined
  return { ...result, data: { content: { type: error.type, error_code: error.error_code } } }
}

function assistant(protocol: Protocol, response: NativeObject): readonly PortableAssistantPart[] {
  const parts: PortableAssistantPart[] = []
  // Signatures, citation handles and encrypted search data belong to the native records.
  // The assistant's text, including any inline links, remains verbatim here.
  switch (protocol) {
    case 'responses':
      for (const value of list(response.output)) {
        const item = object(value)
        if (item.type === 'function_call') parts.push(toolCall(item.call_id, item.name, item.arguments))
        else if (item.type === 'message' && item.role === 'assistant') parts.push(...textParts(item.content, 'output_text'))
        else if (item.type === 'web_search_call') parts.push(...responseSearch(item))
        else if (item.type !== 'reasoning') return incompatible()
      }
      break
    case 'chat-completions': {
      const choices = list(response.choices)
      if (choices.length !== 1) return incompatible()
      const message = object(object(choices[0]).message)
      if (message.role !== 'assistant') return incompatible()
      const text = message.content == null ? '' : string(message.content)
      if (text) parts.push({ type: 'text', text })
      for (const value of message.tool_calls == null ? [] : list(message.tool_calls)) {
        const call = object(value)
        if (call.type !== 'function') return incompatible()
        const fn = object(call.function)
        parts.push(toolCall(call.id, fn.name, fn.arguments))
      }
      break
    }
    case 'anthropic-messages':
      for (const value of list(response.content)) {
        const block = object(value)
        if (block.type === 'tool_use') parts.push(toolCall(block.id, block.name, block.input))
        else if (block.type === 'text') {
          const text = string(block.text)
          if (text) parts.push(citedText(text, block.citations, 'web_search_result_location'))
        } else if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') {
          const search = anthropicSearch(block)
          if (search) parts.push(search)
        } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return incompatible()
      }
      break
    case 'gemini-interactions':
      for (const value of list(response.steps)) {
        const step = object(value)
        if (step.type === 'function_call') parts.push(toolCall(step.id, step.name, step.arguments))
        else if (step.type === 'model_output' && step.content !== undefined) parts.push(...textParts(step.content, 'text'))
        else if (step.type !== 'model_output' && step.type !== 'thought') return incompatible()
      }
  }
  return parts
}

/** Each completed Run owns its new user input and exchanges. Its first request can also carry an already recorded prefix. */
export function portableHistory(records: readonly StoredProtocolRecord[]): readonly PortableHistoryEvent[] {
  const first = records[0]
  if (!first || records.length % 2 !== 0) return incompatible()
  const protocol = first.protocolId
  if (protocol !== 'responses' && protocol !== 'chat-completions' && protocol !== 'anthropic-messages' && protocol !== 'gemini-interactions') return incompatible()
  const events: PortableHistoryEvent[] = []
  const pending = new Map<string, string>()
  const addResult = (rawId: JsonValue | undefined, output: JsonValue | undefined, name?: JsonValue, isError?: JsonValue): void => {
    const id = string(rawId), expectedName = pending.get(id)
    if (!expectedName || (name !== undefined && name !== expectedName) || (isError !== undefined && typeof isError !== 'boolean')) return incompatible()
    pending.delete(id)
    events.push({ role: 'tool', id, name: expectedName, output: string(output), ...(isError === undefined ? {} : { isError }) })
  }
  const field = protocol === 'anthropic-messages' || protocol === 'chat-completions' ? 'messages' : 'input'
  for (let index = 0; index < records.length; index += 2) {
    const request = records[index]!, response = records[index + 1]!
    if (request.kind !== 'request' || response.kind !== 'response' || !request.exchangeId || request.exchangeId !== response.exchangeId ||
      request.protocolId !== protocol || response.protocolId !== protocol || request.runId !== first.runId || response.runId !== request.runId) return incompatible()
    const items = list(object(request.payload)[field])
    const refs = request.resourceRefs ?? []
    if (index === 0) events.push(user(protocol, object(items.at(-1)), refs))
    else {
      for (const value of items) {
        const item = object(value)
        if (protocol === 'responses' && item.type === 'function_call_output') addResult(item.call_id, item.output)
        else if (protocol === 'chat-completions' && item.role === 'tool') addResult(item.tool_call_id, item.content)
        else if (protocol === 'gemini-interactions' && item.type === 'function_result') {
          const result = list(item.result), text = object(result[0])
          if (result.length !== 1 || text.type !== 'text') return incompatible()
          addResult(item.call_id, text.text, item.name)
        } else if (protocol === 'anthropic-messages' && item.role === 'user' && Array.isArray(item.content) &&
          item.content.length && object(item.content[0]).type === 'tool_result') {
          for (const value of item.content) {
            const block = object(value)
            if (block.type !== 'tool_result') return incompatible()
            addResult(block.tool_use_id, block.content, undefined, block.is_error)
          }
        } else events.push(user(protocol, item, refs))
      }
    }
    if (pending.size) return incompatible()
    const parts = assistant(protocol, object(response.payload))
    for (const part of parts) {
      if (part.type !== 'tool-call') continue
      if (pending.has(part.id)) return incompatible()
      pending.set(part.id, part.name)
    }
    if (parts.length) events.push({ role: 'assistant', parts })
  }
  if (pending.size) return incompatible()
  return events
}

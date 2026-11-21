import { isDeepStrictEqual } from 'node:util'
import { nativeImageResourceUri } from '@anybox/models'
import type { NativeImageResourceRef, NativeObject } from '@anybox/models'
import { modelFailure } from '../run/model.js'
import { treeError } from '../session/domain.js'
import type { PortableAssistantPart, PortableHistoryEvent, PortableUserPart } from '../session/portable-history.js'

type ProtocolId = 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-interactions'
type ToolResult = Extract<PortableHistoryEvent, { role: 'tool' }>

/** Provider tool observations and public citations travel as text in the target history. */
function assistantTexts(part: Exclude<PortableAssistantPart, { type: 'tool-call' }>): readonly string[] {
  if (part.type === 'provider-tool') return [JSON.stringify(part)]
  return part.citations?.length ? [part.text, JSON.stringify({ citations: part.citations })] : [part.text]
}

function encodeUser(protocolId: ProtocolId, parts: readonly PortableUserPart[]): NativeObject {
  if (parts.length === 1 && parts[0]?.type === 'text' && (protocolId === 'responses' || protocolId === 'chat-completions')) {
    return { role: 'user', content: parts[0].text }
  }
  const content = parts.map((part): NativeObject => {
    if (part.type === 'text') return { type: protocolId === 'responses' ? 'input_text' : 'text', text: part.text }
    const uri = nativeImageResourceUri(part.resource.id)
    switch (protocolId) {
      case 'responses': return { type: 'input_image', image_url: uri }
      case 'chat-completions': return { type: 'image_url', image_url: { url: uri } }
      case 'anthropic-messages': return { type: 'image', source: { type: 'url', url: uri } }
      case 'gemini-interactions': return { type: 'image', uri }
    }
  })
  return protocolId === 'gemini-interactions' ? { type: 'user_input', content } : { role: 'user', content }
}

/** Native IDs only correlate history within a target request. Preserve usable IDs and remap conflicts consistently. */
function correlateToolIds(protocolId: ProtocolId, history: readonly PortableHistoryEvent[]): readonly PortableHistoryEvent[] {
  const used = new Set<string>()
  const pending = new Map<string, { id: string; name: string }>()
  const prefix = protocolId === 'anthropic-messages' ? 'toolu_history_' : 'call_history_'
  let nextId = 0
  const events = history.map<PortableHistoryEvent>(event => {
    if (event.role === 'assistant') {
      if (pending.size) throw treeError('history-incompatible')
      const parts = event.parts.map(part => {
        if (part.type !== 'tool-call') return part
        if (pending.has(part.id)) throw treeError('history-incompatible')
        let id = part.id
        if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || used.has(id)) {
          do { id = prefix + nextId++ } while (used.has(id))
        }
        used.add(id)
        pending.set(part.id, { id, name: part.name })
        return { ...part, id }
      })
      return { ...event, parts }
    }
    if (event.role === 'tool') {
      const call = pending.get(event.id)
      if (!call || call.name !== event.name) throw treeError('history-incompatible')
      pending.delete(event.id)
      return { ...event, id: call.id }
    }
    if (pending.size) throw treeError('history-incompatible')
    return event
  })
  if (pending.size) throw treeError('history-incompatible')
  return events
}

function encodeAnthropic(history: readonly PortableHistoryEvent[]): readonly NativeObject[] {
  const items: NativeObject[] = []
  let results: NativeObject[] | undefined
  for (const event of history) {
    if (event.role === 'tool') {
      if (!results) {
        results = []
        items.push({ role: 'user', content: results })
      }
      results.push({ type: 'tool_result', tool_use_id: event.id, content: event.output,
        ...(event.isError === undefined ? {} : { is_error: event.isError }) })
      continue
    }
    results = undefined
    if (event.role === 'user') items.push(encodeUser('anthropic-messages', event.parts))
    else if (event.parts.length) items.push({ role: 'assistant', content: event.parts.flatMap<NativeObject>(part => part.type === 'tool-call'
      ? [{ type: 'tool_use', id: part.id, name: part.name, input: part.arguments }]
      : assistantTexts(part).map(text => ({ type: 'text', text }))) })
  }
  return items
}

function encodeResult(protocolId: Exclude<ProtocolId, 'anthropic-messages'>, event: ToolResult): NativeObject {
  switch (protocolId) {
    case 'responses': return { type: 'function_call_output', call_id: event.id, output: event.output }
    case 'chat-completions': return { role: 'tool', tool_call_id: event.id, content: event.output }
    case 'gemini-interactions': return { type: 'function_result', call_id: event.id, name: event.name,
      result: [{ type: 'text', text: event.output }], ...(event.isError === undefined ? {} : { is_error: event.isError }) }
  }
}

function encodeItems(protocolId: ProtocolId, history: readonly PortableHistoryEvent[]): readonly NativeObject[] {
  if (protocolId === 'anthropic-messages') return encodeAnthropic(history)
  return history.flatMap<NativeObject>(event => {
    if (event.role === 'user') return [encodeUser(protocolId, event.parts)]
    if (event.role === 'tool') return [encodeResult(protocolId, event)]
    switch (protocolId) {
      case 'responses': return event.parts.map((part): NativeObject => part.type === 'tool-call'
        ? { type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) }
        : { role: 'assistant', content: assistantTexts(part).join('\n') })
      case 'gemini-interactions': return event.parts.map((part): NativeObject => part.type === 'tool-call'
        ? { type: 'function_call', id: part.id, name: part.name, arguments: part.arguments }
        : { type: 'model_output', content: assistantTexts(part).map(text => ({ type: 'text', text })) })
      case 'chat-completions': {
        if (!event.parts.length) return []
        const content = event.parts.flatMap(part => part.type === 'tool-call' ? []
          : assistantTexts(part).map((text, index) => part.type === 'provider-tool' || index > 0 ? '\n' + text + '\n' : text))
        const toolCalls = event.parts.flatMap(part => part.type === 'tool-call'
          ? [{ type: 'function', id: part.id, function: { name: part.name, arguments: JSON.stringify(part.arguments) } }] : [])
        return [{ role: 'assistant', content: content.length ? content.join('') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }]
      }
    }
  })
}

/** Exchange history encodes completed observations only; the current Loop never sees imported tool calls as executable output. */
export function encodePortableHistory(protocolId: string, history: readonly PortableHistoryEvent[]): {
  readonly items: readonly NativeObject[]
  readonly resourceRefs: readonly NativeImageResourceRef[]
} {
  if (protocolId !== 'responses' && protocolId !== 'chat-completions' && protocolId !== 'anthropic-messages' && protocolId !== 'gemini-interactions') {
    throw modelFailure('unsupported-request')
  }
  const resources = new Map<string, NativeImageResourceRef>()
  for (const event of history) {
    if (event.role !== 'user') continue
    for (const part of event.parts) {
      if (part.type !== 'image') continue
      const resource = part.resource, previous = resources.get(resource.id)
      if (previous && !isDeepStrictEqual(previous, resource)) throw modelFailure('invalid-resource')
      resources.set(resource.id, resource)
    }
  }
  return { items: encodeItems(protocolId, correlateToolIds(protocolId, history)), resourceRefs: [...resources.values()] }
}

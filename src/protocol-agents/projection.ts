import type { JsonValue } from '@anybox/models'
import { createHash } from 'node:crypto'
import type { ProtocolCitation, ProtocolViewBlock, ProtocolViewExchange } from '../web/protocols/types.js'

interface ViewRecord { readonly id: string; readonly kind: string; readonly exchangeId?: string; readonly payload: JsonValue }
type ObjectValue = Readonly<Record<string, unknown>>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const identity = (value: string): string => value.length <= 256 ? value : 'display-' + createHash('sha256').update(value).digest('hex')
const safeUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try { const url = new URL(string(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

function citations(value: unknown, text: string): readonly ProtocolCitation[] {
  return array(value).slice(0, 128).flatMap(raw => {
    const item = object(raw), url = safeUrl(item.url), start = item.start_index, end = item.end_index
    if (!url) return []
    // Citations without positional metadata (Messages) are attached at the end of their block.
    const from = Number.isSafeInteger(start) && Number(start) >= 0 ? Number(start) : text.length
    const to = Number.isSafeInteger(end) && Number(end) >= from ? Number(end) : from
    if (to > text.length) return []
    return [{ start: from, end: to, url, ...(typeof item.title === 'string' ? { title: item.title.slice(0, 512) } : {}) }]
  })
}

function textBlock(id: string, value: unknown, kind: 'text' | 'reasoning' = 'text', annotations?: unknown): ProtocolViewBlock {
  const text = string(value)
  const links = citations(annotations, text)
  return { id: identity(id), kind, text, ...(links.length ? { citations: links } : {}) }
}

function tool(id: string, item: ObjectValue, name: unknown, args?: unknown): Extract<ProtocolViewBlock, { kind: 'tool' }> {
  return { id: identity(id), kind: 'tool', label: string(name) || 'Tool', status: string(item.status) || 'requested',
    ...(typeof item.id === 'string' || typeof item.call_id === 'string' ? { requestId: string(item.call_id ?? item.id) } : {}),
    ...(args === undefined ? {} : { detail: typeof args === 'string' ? args : JSON.stringify(args) }) }
}

/** Only explicitly selected display fields leave the server. Opaque recovery fields never do. */
export function projectNativeResponse(protocolId: string, response: unknown): readonly ProtocolViewBlock[] {
  const raw = object(response), blocks: ProtocolViewBlock[] = []
  if (protocolId === 'responses') {
    array(raw.output).forEach((value, index) => {
      const item = object(value), id = string(item.id) || 'item-' + index
      if (item.type === 'message') array(item.content).forEach((content, at) => {
        const block = object(content)
        if (block.type === 'output_text') blocks.push(textBlock(id + ':' + at, block.text, 'text', block.annotations))
        else if (block.type === 'refusal') blocks.push({ id: id + ':' + at, kind: 'status', text: string(block.refusal) || 'Request refused' })
        else blocks.push({ id: id + ':' + at, kind: 'status', text: 'Unsupported content block' })
      })
      else if (item.type === 'reasoning') array(item.summary).forEach((part, at) => blocks.push(textBlock(id + ':reasoning:' + at, object(part).text, 'reasoning')))
      else if (item.type === 'function_call') blocks.push(tool(id, item, item.name, item.arguments))
      else if (item.type === 'web_search_call') blocks.push({ id, kind: 'tool', label: 'Web search', status: string(item.status) || 'completed', detail: string(object(item.action).query) })
      else blocks.push({ id, kind: 'status', text: 'Unsupported response item' })
    })
  } else if (protocolId === 'anthropic-messages') {
    array(raw.content).forEach((value, index) => {
      const block = object(value), id = 'block-' + index
      if (block.type === 'text') blocks.push(textBlock(id, block.text, 'text', block.citations))
      else if (block.type === 'thinking') blocks.push(textBlock(id, block.thinking, 'reasoning'))
      else if (block.type === 'redacted_thinking') blocks.push({ id, kind: 'status', text: 'Private reasoning preserved' })
      else if (block.type === 'tool_use') blocks.push(tool(id, block, block.name, block.input))
      else if (block.type === 'server_tool_use') blocks.push({ ...tool(id, block, 'Web search', object(block.input).query), status: 'server' })
      else if (block.type === 'web_search_tool_result') blocks.push({ id, kind: 'tool', label: 'Web search results', status: object(block.content).type === 'web_search_tool_result_error' ? 'failed' : 'completed' })
      else blocks.push({ id, kind: 'status', text: 'Unsupported content block' })
    })
    if (raw.stop_reason === 'pause_turn') blocks.push({ id: 'pause', kind: 'status', text: 'Continuing server tool turn' })
  } else if (protocolId === 'gemini-interactions') {
    array(raw.steps).forEach((value, index) => {
      const step = object(value), id = 'step-' + index
      if (step.type === 'model_output') array(step.content).forEach((part, at) => blocks.push(textBlock(id + ':' + at, object(part).text)))
      else if (step.type === 'thought') array(step.summary).forEach((part, at) => blocks.push(textBlock(id + ':thought:' + at, object(part).text, 'reasoning')))
      else if (step.type === 'function_call') blocks.push(tool(id, step, step.name, step.arguments))
      else blocks.push({ id, kind: 'status', text: 'Unsupported interaction step' })
    })
  } else if (protocolId === 'chat-completions' || protocolId === 'deepseek-chat-completions') {
    array(raw.choices).forEach((value, index) => {
      const message = object(object(value).message), id = 'choice-' + index
      if (typeof message.content === 'string') blocks.push(textBlock(id, message.content))
      else array(message.content).forEach((part, at) => blocks.push(textBlock(id + ':' + at, object(part).text)))
      if (message.refusal) blocks.push({ id: id + ':refusal', kind: 'status', text: string(message.refusal) })
      array(message.tool_calls).forEach((value, at) => {
        const call = object(value), fn = object(call.function)
        blocks.push(tool(id + ':tool-' + at, call, fn.name, fn.arguments))
      })
    })
  } else blocks.push({ id: 'unsupported', kind: 'status', text: 'Protocol display is unavailable' })
  return blocks
}

/** Bounded replacement frames keep slow subscribers independent from model execution. */
export function boundProtocolView(exchanges: readonly ProtocolViewExchange[]): readonly ProtocolViewExchange[] {
  const retained = exchanges.filter(exchange => exchange.id !== 'display-limit')
  let remaining = 48_000
  let clipped = retained.length !== exchanges.length || retained.length > 63
  const result: ProtocolViewExchange[] = []
  // Reserve one exchange for the truncation marker, including after repeated streaming updates.
  for (const exchange of retained.slice(-63).reverse()) {
    const blocks: ProtocolViewBlock[] = []
    if (exchange.blocks.length > 128) clipped = true
    const content = exchange.blocks.filter(block => block.id !== 'display-limit')
    if (content.length !== exchange.blocks.length) clipped = true
    for (const block of content.slice(-128).reverse()) {
      if (remaining <= 0) { clipped = true; break }
      const field = block.kind === 'tool' ? block.detail ?? '' : block.text
      const text = field.slice(-Math.min(remaining, 16_000))
      remaining -= text.length + 128
      if (text.length !== field.length) clipped = true
      const id = identity(block.id)
      blocks.unshift(block.kind === 'tool' ? { ...block, id, label: block.label.slice(0, 256), status: block.status.slice(0, 64),
        ...(block.requestId ? { requestId: identity(block.requestId) } : {}), detail: text } :
        block.kind === 'status' ? { ...block, id, text } : { ...block, id, text, ...(text === field ? {} : { citations: [] }) })
    }
    result.unshift({ id: identity(exchange.id), blocks })
  }
  // JSON escaping and citation URLs count against the byte budget too.
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 48 * 1024 - 256) {
    clipped = true
    const citedIndex = result.findIndex(exchange => exchange.blocks.some(block => (block.kind === 'text' || block.kind === 'reasoning') && block.citations?.length))
    if (citedIndex >= 0) {
      const cited = result[citedIndex]!
      result[citedIndex] = { ...cited, blocks: cited.blocks.map(block => block.kind === 'text' || block.kind === 'reasoning' ? { ...block, citations: [] } : block) }
      continue
    }
    const exchange = result.find(item => item.blocks.length)
    if (!exchange) { result.shift(); continue }
    const block = exchange.blocks[0]!
    if (block.kind === 'text' || block.kind === 'reasoning') {
      const half = Math.floor(block.text.length / 2)
      if (half > 128) {
        result[result.indexOf(exchange)] = { ...exchange, blocks: [{ ...block, text: block.text.slice(-half), citations: [] }, ...exchange.blocks.slice(1)] }
        continue
      }
    }
    const exchangeIndex = result.indexOf(exchange)
    result[exchangeIndex] = { ...exchange, blocks: exchange.blocks.slice(1) }
    if (!result[exchangeIndex]!.blocks.length) result.splice(exchangeIndex, 1)
  }
  if (clipped) result.unshift({ id: 'display-limit', blocks: [{ id: 'display-limit', kind: 'status', text: 'Earlier display content is truncated; complete native history is retained.' }] })
  return result
}

export function projectProtocolRecords(protocolId: string, records: readonly ViewRecord[]): readonly ProtocolViewExchange[] {
  return boundProtocolView(records.filter(record => record.kind === 'response').map(record => ({
    id: record.exchangeId ?? record.id, blocks: projectNativeResponse(protocolId, record.payload),
  })))
}

/** Streaming state contains display fields only, never a second native continuation. */
export function reduceNativeView(protocolId: string, previous: readonly ProtocolViewBlock[], event: unknown): readonly ProtocolViewBlock[] {
  const raw = object(event), type = string(raw.type ?? raw.event_type), result = [...previous]
  const upsert = (rawId: string, kind: 'text' | 'reasoning', delta: string, allowEmpty = false) => {
    if (!delta && !allowEmpty) return
    const id = identity(rawId)
    const at = result.findIndex(block => block.id === id)
    const old = at < 0 ? undefined : result[at]
    const block = textBlock(id, (old && (old.kind === 'text' || old.kind === 'reasoning') ? old.text : '') + delta, kind)
    if (at < 0) result.push(block); else result[at] = block
  }
  const toolDelta = (rawId: string, name: string, args: string, requestId?: string) => {
    const id = identity(rawId), at = result.findIndex(block => block.id === id), previous = result[at]
    const old = previous?.kind === 'tool' ? previous : undefined
    const block: ProtocolViewBlock = { id, kind: 'tool', label: (old?.label === 'Tool' ? '' : old?.label ?? '') + name || 'Tool',
      status: 'preparing', detail: (old?.detail ?? '') + args, ...(requestId ? { requestId } : old?.requestId ? { requestId: old.requestId } : {}) }
    if (at < 0) result.push(block); else result[at] = block
  }
  if (protocolId === 'responses') {
    const id = string(raw.item_id) || 'item-' + String(raw.output_index ?? 0)
    if (type === 'response.output_text.delta') upsert(id + ':' + String(raw.content_index ?? 0), 'text', string(raw.delta))
    if (type === 'response.reasoning_summary_text.delta') upsert(id + ':reasoning:' + String(raw.summary_index ?? 0), 'reasoning', string(raw.delta))
    if (type === 'response.function_call_arguments.delta') toolDelta(id, '', string(raw.delta))
    if (type === 'response.output_item.added') {
      const item = object(raw.item)
      if (item.type === 'function_call') result.push(tool(string(item.id) || id, item, item.name))
      if (item.type === 'web_search_call') result.push({ id: identity(string(item.id) || id), kind: 'tool', label: 'Web search', status: 'running' })
    }
  } else if (protocolId === 'anthropic-messages') {
    const id = 'block-' + String(raw.index ?? 0), delta = object(raw.delta), block = object(raw.content_block)
    if (type === 'content_block_start') {
      if (block.type === 'text') upsert(id, 'text', string(block.text))
      if (block.type === 'thinking') upsert(id, 'reasoning', string(block.thinking))
      if (block.type === 'tool_use' || block.type === 'server_tool_use') result.push(tool(id, block, block.name))
    }
    if (type === 'content_block_delta' && delta.type === 'text_delta') upsert(id, 'text', string(delta.text))
    if (type === 'content_block_delta' && delta.type === 'thinking_delta') upsert(id, 'reasoning', string(delta.thinking))
    if (type === 'content_block_delta' && delta.type === 'input_json_delta') toolDelta(id, '', string(delta.partial_json))
    if (type === 'message_delta' && delta.stop_reason === 'pause_turn') result.push({ id: 'pause', kind: 'status', text: 'Continuing server tool turn' })
  } else if (protocolId === 'gemini-interactions') {
    const id = 'step-' + String(raw.index ?? 0), step = object(raw.step), delta = object(raw.delta)
    if (type === 'step.start' && step.type === 'model_output') array(step.content).forEach((part, at) => upsert(id + ':' + at, 'text', string(object(part).text), true))
    if (type === 'step.start' && step.type === 'thought') array(step.summary).forEach((part, at) => upsert(id + ':thought:' + at, 'reasoning', string(object(part).text), true))
    if (type === 'step.start' && step.type === 'function_call') result.push(tool(id, step, step.name))
    if (type === 'step.delta' && delta.type === 'text') {
      const content = result.filter(block => block.kind === 'text' && block.id.startsWith(id + ':'))
      upsert(content.at(-1)?.id ?? id + ':0', 'text', string(delta.text))
    }
    if (type === 'step.delta' && delta.type === 'thought_summary') {
      const at = result.filter(block => block.kind === 'reasoning' && block.id.startsWith(id + ':thought:')).length
      upsert(id + ':thought:' + at, 'reasoning', string(object(delta.content).text))
    }
    if (type === 'step.delta' && delta.type === 'arguments_delta') toolDelta(id, '', string(delta.arguments))
  } else {
    array(raw.choices).forEach((value, index) => {
      const delta = object(object(value).delta), id = 'choice-' + index
      upsert(id, 'text', string(delta.content))
      array(delta.tool_calls).forEach(value => {
        const call = object(value), fn = object(call.function)
        toolDelta(id + ':tool-' + String(call.index ?? 0), string(fn.name), string(fn.arguments), typeof call.id === 'string' ? call.id : undefined)
      })
    })
  }
  return boundProtocolView([{ id: 'stream', blocks: result }]).flatMap(exchange => exchange.blocks)
}

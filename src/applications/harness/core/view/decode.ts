import type { ProtocolCitation, ProtocolViewBlock, ProtocolViewInput, ProtocolViewSnapshot, ProtocolNativeState, ProtocolSummaryPart, ProtocolSource, ResponsesMessagePart, GeminiTextPart } from './types.js'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const content = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536
const short = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
const namespace = (protocolId: string): string | undefined => {
  switch (protocolId) {
    case 'responses': return 'responses'
    case 'anthropic-messages': return 'anthropic'
    case 'chat-completions': return 'chat'
    case 'gemini-interactions': return 'gemini'
    default: return undefined
  }
}
function decodeCitations(value: unknown, text: string): readonly ProtocolCitation[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) return undefined
  const result: ProtocolCitation[] = []
  for (const citation of value) {
    if (!object(citation) || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) || Number(citation.start) < 0 ||
      Number(citation.end) < Number(citation.start) || Number(citation.end) > text.length || citation.title !== undefined && !short(citation.title)) return undefined
    const url = safeSourceUrl(citation.url)
    if (url) result.push({ start: Number(citation.start), end: Number(citation.end), url, ...(typeof citation.title === 'string' ? { title: citation.title } : {}) })
  }
  return result
}
function decodeSources(value: unknown): readonly ProtocolSource[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined
  const result: ProtocolSource[] = []
  for (const source of value) {
    if (!object(source) || source.title !== undefined && !short(source.title)) return undefined
    const url = safeSourceUrl(source.url)
    if (url) result.push({ url, ...(typeof source.title === 'string' ? { title: source.title } : {}) })
  }
  return result
}
function decodeState(value: unknown, protocolId: string): ProtocolNativeState | undefined {
  if (!object(value) || value.type !== namespace(protocolId) + '.state' ||
    value.diagnostic !== undefined && typeof value.diagnostic !== 'boolean' || value.partial !== undefined && typeof value.partial !== 'boolean') return undefined
  const flags = { ...(typeof value.diagnostic === 'boolean' ? { diagnostic: value.diagnostic } : {}), ...(typeof value.partial === 'boolean' ? { partial: value.partial } : {}) }
  const fields = (keys: readonly string[]): Record<string, string> | undefined => {
    const result: Record<string, string> = {}
    for (const key of keys) { if (value[key] !== undefined && !short(value[key])) return undefined; if (typeof value[key] === 'string') result[key] = value[key] }
    return result
  }
  switch (value.type) {
    case 'responses.state': { const selected = fields(['status', 'incompleteReason', 'errorCode']); return selected && { type: 'responses.state', ...flags, ...selected } }
    case 'anthropic.state': { const selected = fields(['stopReason', 'stopSequence', 'stopDetailsType', 'errorCode']); return selected && { type: 'anthropic.state', ...flags, ...selected } }
    case 'chat.state': { const selected = fields(['finishReason', 'errorCode']); return selected && { type: 'chat.state', ...flags, ...selected } }
    case 'gemini.state': { const selected = fields(['status', 'stage', 'eventType', 'errorCode']); return selected && { type: 'gemini.state', ...flags, ...selected } }
    default: return undefined
  }
}

/** Decode only v2 display fields. Native response objects never enter renderers. */
export function decodeProtocolView(value: unknown): ProtocolViewSnapshot | undefined {
  if (!object(value) || value.envelopeVersion !== 1 || value.viewSchemaVersion !== 2 || !identity(value.protocolId) || !namespace(value.protocolId) || !identity(value.sessionId) || !identity(value.runId) ||
    !Number.isSafeInteger(value.viewRevision) || Number(value.viewRevision) < 0 || value.status !== 'provisional' && value.status !== 'committed' ||
    !Array.isArray(value.exchanges) || value.exchanges.length > 1024) return undefined
  let total = 0
  const decodeParts = (values: unknown, kind: 'summary' | 'responses' | 'gemini'): readonly (ProtocolSummaryPart | ResponsesMessagePart | GeminiTextPart)[] | undefined => {
    if (!Array.isArray(values) || values.length > 128) return undefined
    const ids = new Set<string>(), result: (ProtocolSummaryPart | ResponsesMessagePart | GeminiTextPart)[] = []
    for (const part of values) {
      if (!object(part) || !identity(part.id) || ids.has(part.id) || ++total > 4096 || !content(part.text)) return undefined
      ids.add(part.id)
      if (kind === 'summary') result.push({ id: part.id, text: part.text })
      else if (kind === 'responses' && part.type === 'refusal') result.push({ id: part.id, type: 'refusal', text: part.text })
      else {
        if (part.type !== (kind === 'responses' ? 'output_text' : 'text')) return undefined
        const citations = decodeCitations(part.citations, part.text)
        if (!citations) return undefined
        const base = { id: part.id, text: part.text, ...(citations.length ? { citations } : {}) }
        result.push(kind === 'responses' ? { ...base, type: 'output_text' } : { ...base, type: 'text' })
      }
    }
    return result
  }
  const decodeBlock = (block: unknown): ProtocolViewBlock | undefined => {
    if (!object(block) || !identity(block.id) || typeof block.type !== 'string' || ++total > 4096 ||
      !block.type.startsWith('harness.') && !block.type.startsWith(namespace(value.protocolId as string) + '.')) return undefined
    const id = block.id
    const tool = () => !short(block.name) || !content(block.arguments) || block.requestId !== undefined && !identity(block.requestId) ? undefined : {
      id, name: block.name, arguments: block.arguments, ...(typeof block.requestId === 'string' ? { requestId: block.requestId } : {}) }
    switch (block.type) {
      case 'responses.message': {
        if (block.phase !== undefined && (typeof block.phase !== 'string' || !['commentary', 'final_answer', 'unknown'].includes(block.phase)) || block.status !== undefined && !short(block.status)) return undefined
        const parts = decodeParts(block.content, 'responses')
        return parts && { id, type: 'responses.message', content: parts as readonly ResponsesMessagePart[],
          ...(typeof block.phase === 'string' ? { phase: block.phase as 'commentary' | 'final_answer' | 'unknown' } : {}), ...(typeof block.status === 'string' ? { status: block.status } : {}) }
      }
      case 'responses.reasoning': case 'gemini.thought': {
        const summary = decodeParts(block.summary, 'summary')
        return summary && { id, type: block.type, summary: summary as readonly ProtocolSummaryPart[] }
      }
      case 'gemini.model_output': { const parts = decodeParts(block.content, 'gemini'); return parts && { id, type: 'gemini.model_output', content: parts as readonly GeminiTextPart[] } }
      case 'responses.function_call': {
        const selected = tool()
        if (!selected || block.status !== undefined && !short(block.status)) return undefined
        return { ...selected, type: 'responses.function_call', ...(typeof block.status === 'string' ? { status: block.status } : {}) }
      }
      case 'anthropic.tool_use': case 'anthropic.server_tool_use': case 'chat.tool_call': case 'gemini.function_call': {
        const selected = tool(); return selected && { ...selected, type: block.type }
      }
      case 'responses.web_search_call': {
        if (['status', 'action'].some(key => block[key] !== undefined && !short(block[key])) || block.query !== undefined && !content(block.query)) return undefined
        const sources = block.sources === undefined ? [] : decodeSources(block.sources)
        if (!sources) return undefined
        return { id, type: 'responses.web_search_call', ...(typeof block.status === 'string' ? { status: block.status } : {}), ...(typeof block.action === 'string' ? { action: block.action } : {}),
          ...(typeof block.query === 'string' ? { query: block.query } : {}), ...(sources.length ? { sources } : {}) }
      }
      case 'anthropic.web_search_tool_result': {
        if (block.status !== 'completed' && block.status !== 'failed' || block.requestId !== undefined && !identity(block.requestId) || block.errorCode !== undefined && !short(block.errorCode)) return undefined
        const sources = decodeSources(block.sources)
        return sources && { id, type: 'anthropic.web_search_tool_result', status: block.status, sources,
          ...(typeof block.requestId === 'string' ? { requestId: block.requestId } : {}), ...(typeof block.errorCode === 'string' ? { errorCode: block.errorCode } : {}) }
      }
      case 'anthropic.redacted_thinking': return { id, type: 'anthropic.redacted_thinking' }
      case 'anthropic.text': {
        if (!content(block.text)) return undefined
        const citations = decodeCitations(block.citations, block.text)
        return citations && { id, type: 'anthropic.text', text: block.text, ...(citations.length ? { citations } : {}) }
      }
      case 'anthropic.thinking': case 'chat.content': case 'chat.reasoning_content': case 'chat.refusal': case 'harness.display_limit': case 'harness.unsupported':
        return content(block.text) ? { id, type: block.type, text: block.text } : undefined
      default: return undefined
    }
  }
  const exchangeIds = new Set<string>(), exchanges = []
  for (const exchange of value.exchanges) {
    if (!object(exchange) || !identity(exchange.id) || exchangeIds.has(exchange.id) || !Array.isArray(exchange.blocks) || exchange.blocks.length > 2048) return undefined
    exchangeIds.add(exchange.id)
    const inputIds = new Set<string>(), inputs: ProtocolViewInput[] = []
    if (exchange.inputs !== undefined) {
      if (!Array.isArray(exchange.inputs) || exchange.inputs.length > 2048) return undefined
      for (const input of exchange.inputs) {
        if (!object(input) || !identity(input.id) || inputIds.has(input.id) || ++total > 4096 || input.role !== 'system' && input.role !== 'context' && input.role !== 'user' || !content(input.text)) return undefined
        inputIds.add(input.id); inputs.push({ id: input.id, role: input.role as ProtocolViewInput['role'], text: input.text })
      }
    }
    const blockIds = new Set<string>(), blocks: ProtocolViewBlock[] = []
    for (const block of exchange.blocks) {
      const decoded = decodeBlock(block)
      if (!decoded || blockIds.has(decoded.id)) return undefined
      blockIds.add(decoded.id); blocks.push(decoded)
    }
    const state = exchange.nativeState === undefined ? undefined : decodeState(exchange.nativeState, value.protocolId)
    if (exchange.nativeState !== undefined && !state) return undefined
    exchanges.push({ id: exchange.id, ...(exchange.inputs !== undefined ? { inputs } : {}), blocks, ...(state ? { nativeState: state } : {}) })
  }
  return { envelopeVersion: 1, viewSchemaVersion: 2, protocolId: value.protocolId, sessionId: value.sessionId, runId: value.runId,
    viewRevision: Number(value.viewRevision), status: value.status, exchanges }
}

/** Complete projections handle gaps; durable facts supersede temporary text. */
export function reduceProtocolView(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot {
  if (!current) return next
  if (current.runId !== next.runId || current.sessionId !== next.sessionId || current.protocolId !== next.protocolId || current.viewSchemaVersion !== next.viewSchemaVersion ||
    current.status === 'committed' && next.status !== 'committed' || current.status === next.status && next.viewRevision <= current.viewRevision) return current
  return next
}

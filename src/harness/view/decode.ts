import type { ProtocolCitation, ProtocolViewBlock, ProtocolViewSnapshot } from './types.js'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const content = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

/** Decode into a whitelist, never pass arbitrary provider objects to a renderer. */
export function decodeProtocolView(value: unknown): ProtocolViewSnapshot | undefined {
  if (!object(value) || value.envelopeVersion !== 1 || value.viewSchemaVersion !== 1 ||
      !identity(value.protocolId) || !identity(value.sessionId) || !identity(value.runId) ||
      !Number.isSafeInteger(value.viewRevision) || Number(value.viewRevision) < 0 ||
      !['provisional', 'committed'].includes(String(value.status)) ||
      !Array.isArray(value.exchanges) || value.exchanges.length > 1024) return undefined
  const exchangeIds = new Set<string>()
  const exchanges = []
  let total = 0
  for (const exchange of value.exchanges) {
    if (!object(exchange) || !identity(exchange.id) || exchangeIds.has(exchange.id) ||
        !Array.isArray(exchange.blocks) || exchange.blocks.length > 2048) return undefined
    exchangeIds.add(exchange.id)
    const blockIds = new Set<string>(), blocks: ProtocolViewBlock[] = []
    for (const block of exchange.blocks) {
      if (!object(block) || !identity(block.id) || blockIds.has(block.id) || ++total > 4096) return undefined
      blockIds.add(block.id)
      if (block.kind === 'text' || block.kind === 'reasoning') {
        if (!content(block.text)) return undefined
        const citations: ProtocolCitation[] = []
        if (block.citations !== undefined) {
          if (!Array.isArray(block.citations) || block.citations.length > 1024) return undefined
          for (const citation of block.citations) {
            if (!object(citation) || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) ||
                Number(citation.start) < 0 || Number(citation.end) < Number(citation.start) || Number(citation.end) > block.text.length) return undefined
            const url = safeSourceUrl(citation.url)
            if (!url) continue
            if (citation.title !== undefined && !content(citation.title)) return undefined
            citations.push({ start: Number(citation.start), end: Number(citation.end), url,
              ...(typeof citation.title === 'string' ? { title: citation.title } : {}) })
          }
        }
        blocks.push({ id: block.id, kind: block.kind, text: block.text, ...(citations.length ? { citations } : {}) })
      } else if (block.kind === 'tool') {
        if (!content(block.label) || !content(block.status) || (block.detail !== undefined && !content(block.detail)) ||
            (block.requestId !== undefined && !identity(block.requestId))) return undefined
        blocks.push({ id: block.id, kind: 'tool', label: block.label, status: block.status,
          ...(typeof block.detail === 'string' ? { detail: block.detail } : {}),
          ...(typeof block.requestId === 'string' ? { requestId: block.requestId } : {}) })
      } else if (block.kind === 'status') {
        if (!content(block.text)) return undefined
        blocks.push({ id: block.id, kind: 'status', text: block.text })
      } else return undefined
    }
    exchanges.push({ id: exchange.id, blocks })
  }
  return { envelopeVersion: 1, viewSchemaVersion: 1, protocolId: value.protocolId, sessionId: value.sessionId,
    runId: value.runId, viewRevision: Number(value.viewRevision), status: value.status as ProtocolViewSnapshot['status'], exchanges }
}

/** Every event is a complete projection; gaps cannot splice unrelated text together. */
export function reduceProtocolView(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot {
  if (!current) return next
  if (current.runId !== next.runId || current.sessionId !== next.sessionId || current.protocolId !== next.protocolId ||
      current.viewSchemaVersion !== next.viewSchemaVersion ||
      (current.status === 'committed' && next.status !== 'committed') ||
      (current.status === next.status && next.viewRevision <= current.viewRevision)) return current
  return next
}


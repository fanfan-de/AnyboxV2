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

export interface MountedProtocolTurn {
  readonly element: HTMLElement
  update(snapshot: ProtocolViewSnapshot): void
  dispose(): void
}
/** Protocol turns own content order; the thread only owns the mounted element. */
export function mountProtocolTurn(initial: ProtocolViewSnapshot, binding: {
  readonly name: string
  reduce(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined
}): MountedProtocolTurn {
  const element = document.createElement('article'), heading = document.createElement('p')
  element.className = 'protocol-turn'
  element.dataset.runId = initial.runId
  element.dataset.protocol = initial.protocolId
  heading.className = 'streaming-label'
  element.append(heading)
  const mounted = new Map<string, { element: HTMLElement; value: string }>()
  let model: ProtocolViewSnapshot | undefined, disposed = false
  const update = (next: ProtocolViewSnapshot) => {
    if (disposed) return
    const reduced = binding.reduce(model, next)
    if (!reduced || reduced === model) return
    model = reduced
    heading.textContent = `${binding.name}${model.status === 'provisional' ? ' · 临时输出' : ''}`
    const retained = new Set<string>()
    const ordered: HTMLElement[] = []
    for (const exchange of model.exchanges) for (const block of exchange.blocks) {
      const key = JSON.stringify([exchange.id, block.id])
      retained.add(key)
      let entry = mounted.get(key)
      if (!entry) {
        const node = document.createElement('section')
        node.dataset.exchangeId = exchange.id; node.dataset.blockId = block.id
        entry = { element: node, value: '' }; mounted.set(key, entry)
      }
      const serialized = JSON.stringify(block)
      if (entry.value !== serialized) {
        entry.value = serialized
        entry.element.className = `protocol-block protocol-${block.kind}`
        entry.element.replaceChildren()
        if (block.kind === 'tool') {
          const label = document.createElement('strong'), status = document.createElement('span')
          label.textContent = block.label; status.textContent = ` · ${block.status}`
          entry.element.append(label, status)
          if (block.detail) { const detail = document.createElement('pre'); detail.textContent = block.detail; entry.element.append(detail) }
        } else {
          const text = document.createElement('p')
          text.className = 'message-content'
          text.style.whiteSpace = 'pre-wrap'
          if (block.kind === 'reasoning') text.setAttribute('aria-label', '推理摘要')
          if (block.kind === 'text' && block.citations?.length) {
            let offset = 0
            for (const { citation, index } of block.citations.map((citation, index) => ({ citation, index })).sort((a, b) => a.citation.end - b.citation.end)) {
              const url = safeSourceUrl(citation.url)
              if (!url) continue
              text.append(document.createTextNode(block.text.slice(offset, citation.end)))
              offset = citation.end
              const mark = document.createElement('sup'), link = document.createElement('a')
              link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
              link.textContent = `[${index + 1}]`; link.title = citation.title || new URL(url).hostname
              link.setAttribute('aria-label', `引用 ${index + 1}：${link.title}`)
              mark.append(link); text.append(mark)
            }
            text.append(document.createTextNode(block.text.slice(offset)))
          } else text.textContent = block.text
          entry.element.append(text)
          if (block.kind === 'text' && block.citations?.length) {
            const sources = document.createElement('ol'); sources.setAttribute('aria-label', '引用来源')
            for (const citation of block.citations) {
              const url = safeSourceUrl(citation.url)
              if (!url) continue
              const item = document.createElement('li'), link = document.createElement('a')
              link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
              link.textContent = citation.title || new URL(url).hostname
              link.title = block.text.slice(citation.start, citation.end)
              item.append(link); sources.append(item)
            }
            entry.element.append(sources)
          }
        }
      }
      ordered.push(entry.element)
    }
    let cursor: ChildNode | null = heading.nextSibling
    for (const node of ordered) {
      if (node === cursor) cursor = cursor.nextSibling
      else element.insertBefore(node, cursor)
    }
    while (cursor) { const next: ChildNode | null = cursor.nextSibling; cursor.remove(); cursor = next }
    for (const [key, entry] of mounted) if (!retained.has(key)) { entry.element.remove(); mounted.delete(key) }
  }
  update(initial)
  return { element, update, dispose() { disposed = true; mounted.clear(); element.remove() } }
}

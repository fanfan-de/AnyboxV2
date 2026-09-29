import type { ProtocolViewSnapshot } from '../../harness/view/types.js'
import { safeSourceUrl } from '../../harness/view/decode.js'
export { safeSourceUrl, decodeProtocolView, reduceProtocolView } from '../../harness/view/decode.js'

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

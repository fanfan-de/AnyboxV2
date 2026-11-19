import type { RootContent, Root, Definition } from 'mdast'
import type { ProtocolCitation } from '../core/view/types.js'
import { safeSourceUrl } from '../core/view/decode.js'
import { parseMarkdown } from './vendor/markdown-parser.js'

type MarkdownNode = Root | RootContent
interface CitationMark { readonly citation: ProtocolCitation; readonly index: number }

/** Parse whole replacement frames; only fixed DOM tags ever reach the document. */
export function renderMarkdown(source: string, citations: readonly ProtocolCitation[] = []): HTMLElement {
  const container = document.createElement('div')
  container.className = 'message-content markdown-content'
  const plain = (): HTMLElement => {
    container.classList.add('markdown-plain')
    container.textContent = source
    return container
  }
  let tree: Root
  try {
    if (source.length > 1_048_576) throw new RangeError('Markdown display limit')
    tree = parseMarkdown(source)
  } catch {
    return plain()
  }
  const definitions = new Map<string, Definition>()
  const leaves: MarkdownNode[] = []
  let nodeCount = 0
  const collect = (node: MarkdownNode, depth = 0): void => {
    if (++nodeCount > 20_000) throw new RangeError('Markdown node limit')
    if (depth > 64) { leaves.push(node); return }
    if (node.type === 'definition') { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node); return }
    // Links are atomic citation targets, preventing nested anchors.
    if (['link', 'linkReference', 'image', 'imageReference'].includes(node.type) || !('children' in node)) leaves.push(node)
    else for (const child of node.children) collect(child, depth + 1)
  }
  try { collect(tree) } catch { return plain() }
  const marks = new Map<MarkdownNode, CitationMark[]>()
  for (const [index, citation] of citations.entries()) {
    if (!safeSourceUrl(citation.url) || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) ||
      citation.start < 0 || citation.end <= citation.start || citation.end > source.length) continue
    const target = leaves.find(node => node.position && node.position.start.offset! < citation.end && citation.end <= node.position.end.offset!)
      ?? [...leaves].reverse().find(node => node.position && node.position.end.offset! <= citation.end) ?? leaves[0]
    if (target) marks.set(target, [...marks.get(target) ?? [], { citation, index }])
  }
  const citationNode = ({ citation, index }: CitationMark): HTMLElement => {
    const mark = document.createElement('sup'), link = document.createElement('a')
    link.href = safeSourceUrl(citation.url)!
    link.target = '_blank'; link.rel = 'noopener noreferrer'
    link.textContent = `[${index + 1}]`; link.title = citation.title || new URL(link.href).hostname
    link.setAttribute('aria-label', `引用 ${index + 1}：${link.title}`)
    mark.className = 'markdown-citation'; mark.append(link)
    return mark
  }
  const externalLink = (url: string, title?: string | null): HTMLAnchorElement | undefined => {
    const href = safeSourceUrl(url)
    if (!href) return undefined
    const link = document.createElement('a')
    link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'
    if (title) link.title = title
    return link
  }
  let renderedNodes = 0
  const render = (node: MarkdownNode, depth = 0): Node[] => {
    if (++renderedNodes > 20_000) throw new RangeError('Markdown node limit')
    const attached = [...marks.get(node) ?? []].sort((a, b) => a.citation.end - b.citation.end || a.index - b.index)
    const finish = (...nodes: Node[]): Node[] => [...nodes, ...attached.map(citationNode)]
    const literal = (value: string): Node[] => finish(document.createTextNode(value))
    if (depth > 64) return literal(source.slice(node.position?.start.offset, node.position?.end.offset))
    const children = (): Node[] => 'children' in node ? node.children.flatMap(child => render(child, depth + 1)) : []
    const wrap = (tag: string): Node[] => {
      const element = document.createElement(tag); element.append(...children()); return finish(element)
    }
    switch (node.type) {
      case 'root': return children()
      case 'paragraph': return wrap('p')
      case 'heading': return wrap(`h${Math.max(1, Math.min(6, node.depth))}`)
      case 'blockquote': return wrap('blockquote')
      case 'strong': return wrap('strong')
      case 'emphasis': return wrap('em')
      case 'delete': return wrap('del')
      case 'text': {
        const start = node.position?.start.offset, end = node.position?.end.offset
        if (!attached.length || start === undefined || end === undefined || source.slice(start, end) !== node.value) return literal(node.value)
        const nodes: Node[] = []; let offset = 0
        for (const mark of attached) {
          const next = Math.max(offset, Math.min(node.value.length, mark.citation.end - start))
          nodes.push(document.createTextNode(node.value.slice(offset, next)), citationNode(mark)); offset = next
        }
        nodes.push(document.createTextNode(node.value.slice(offset)))
        return nodes
      }
      case 'html': return literal(node.value)
      case 'break': return finish(document.createElement('br'))
      case 'thematicBreak': return finish(document.createElement('hr'))
      case 'inlineCode': {
        const code = document.createElement('code'); code.textContent = node.value; return finish(code)
      }
      case 'code': {
        const block = document.createElement('div'), bar = document.createElement('div')
        block.className = 'markdown-code-block'; bar.className = 'markdown-code-toolbar'
        const language = document.createElement('span'), copy = document.createElement('button')
        language.textContent = node.lang ?? '代码'
        copy.className = 'markdown-code-copy'; copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制代码')
        copy.addEventListener('click', () => {
          if (copy.disabled) return
          copy.disabled = true
          void (async () => {
            try { await navigator.clipboard.writeText(node.value); copy.textContent = '已复制' }
            catch { copy.textContent = '复制失败'; copy.title = '请选中代码后复制。' }
            finally { copy.disabled = false }
          })()
        })
        const pre = document.createElement('pre'), code = document.createElement('code')
        pre.tabIndex = 0; code.textContent = node.value
        bar.append(language, copy); pre.append(code); block.append(bar, pre)
        return finish(block)
      }
      case 'list': {
        const list = document.createElement(node.ordered ? 'ol' : 'ul')
        if (node.ordered && node.start !== null && node.start !== undefined) list.setAttribute('start', String(node.start))
        list.append(...children()); return finish(list)
      }
      case 'listItem': {
        const item = document.createElement('li')
        if (typeof node.checked === 'boolean') {
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'; checkbox.checked = node.checked; checkbox.disabled = true
          checkbox.setAttribute('aria-label', node.checked ? '已完成' : '未完成')
          item.className = 'markdown-task'; item.append(checkbox)
        }
        item.append(...children()); return finish(item)
      }
      case 'link': {
        const link = externalLink(node.url, node.title)
        if (!link) return finish(...children())
        link.append(...children()); return finish(link)
      }
      case 'linkReference': {
        const definition = definitions.get(node.identifier), link = definition && externalLink(definition.url, definition.title)
        if (!link) return finish(...children())
        link.append(...children()); return finish(link)
      }
      case 'image':
      case 'imageReference': {
        const definition = node.type === 'imageReference' ? definitions.get(node.identifier) : node
        const link = definition && externalLink(definition.url, definition.title)
        const label = `[图片：${node.alt || '查看图片'}]`
        if (!link) return literal(label)
        link.textContent = label; link.className = 'markdown-image-link'; return finish(link)
      }
      case 'table': {
        const scroll = document.createElement('div'), table = document.createElement('table')
        scroll.className = 'markdown-table-container'; scroll.tabIndex = 0; scroll.setAttribute('aria-label', '表格，可横向滚动')
        const head = document.createElement('thead'), body = document.createElement('tbody')
        node.children.forEach((row, index) => {
          const tr = document.createElement('tr')
          row.children.forEach((cell, column) => {
            const td = document.createElement(index === 0 ? 'th' : 'td')
            if (index === 0) td.setAttribute('scope', 'col')
            const alignment = node.align?.[column]
            if (alignment) td.style.textAlign = alignment
            td.append(...render(cell, depth + 1)); tr.append(td)
          })
          ;(index === 0 ? head : body).append(tr)
        })
        table.append(head, body); scroll.append(table); return finish(scroll)
      }
      case 'tableRow':
      case 'tableCell': return finish(...children())
      case 'definition': return []
      case 'footnoteReference': return literal(`[^${node.label ?? node.identifier}]`)
      case 'footnoteDefinition': {
        const note = document.createElement('div'); note.append(document.createTextNode(`[^${node.label ?? node.identifier}]: `), ...children()); return finish(note)
      }
      default: return literal(source.slice(node.position?.start.offset, node.position?.end.offset))
    }
  }
  try { for (const node of render(tree)) container.append(node) } catch { return plain() }
  return container
}

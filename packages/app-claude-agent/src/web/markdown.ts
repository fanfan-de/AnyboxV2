import type { Root, RootContent, Definition } from 'mdast'
import { parseMarkdown } from './vendor/markdown-parser.js'

type MarkdownNode = Root | RootContent
const displayLimit = 1_048_576

/** Only explicit web links are navigable; model text cannot open local files or app routes. */
export function safeMarkdownUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

/** Application-owned, bounded Markdown renderer. HTML is text and images are opt-in links. */
export function renderMarkdown(input: string): HTMLElement {
  const source = input.slice(0, displayLimit), container = document.createElement('div')
  container.className = 'ca-text-block ca-markdown'
  const plain = (): HTMLElement => {
    container.className += ' ca-markdown-plain'
    container.textContent = source + (input.length > displayLimit ? '\n…（显示内容已截断）' : '')
    return container
  }
  let tree: Root
  const definitions = new Map<string, Definition>()
  let count = 0
  const collect = (node: MarkdownNode, depth = 0): void => {
    if (++count > 20_000 || depth > 64) throw new RangeError('Markdown display limit')
    if (node.type === 'definition') { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node) }
    if ('children' in node) for (const child of node.children) collect(child, depth + 1)
  }
  try { if (input.length > displayLimit) return plain(); tree = parseMarkdown(source); collect(tree) } catch { return plain() }
  const linkFor = (url: string, title?: string | null): HTMLAnchorElement | undefined => {
    const href = safeMarkdownUrl(url)
    if (!href) return undefined
    const link = document.createElement('a')
    link.setAttribute('href', href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer')
    if (title) link.title = title
    return link
  }
  let rendered = 0
  const render = (node: MarkdownNode, depth = 0): Node[] => {
    if (++rendered > 20_000 || depth > 64) throw new RangeError('Markdown display limit')
    const literal = (value: string): Node[] => [document.createTextNode(value)]
    const children = (): Node[] => 'children' in node ? node.children.flatMap(child => render(child, depth + 1)) : []
    const wrap = (tag: keyof HTMLElementTagNameMap): Node[] => {
      const element = document.createElement(tag); element.append(...children()); return [element]
    }
    switch (node.type) {
      case 'root': return children()
      case 'paragraph': return wrap('p')
      case 'heading': return wrap(`h${node.depth}` as 'h1')
      case 'blockquote': return wrap('blockquote')
      case 'strong': return wrap('strong')
      case 'emphasis': return wrap('em')
      case 'delete': return wrap('del')
      case 'text': case 'html': return literal(node.value)
      case 'break': return [document.createElement('br')]
      case 'thematicBreak': return [document.createElement('hr')]
      case 'inlineCode': { const code = document.createElement('code'); code.textContent = node.value; return [code] }
      case 'code': {
        const block = document.createElement('div'), bar = document.createElement('div'), language = document.createElement('span'), copy = document.createElement('button')
        block.className = 'ca-code-block'; bar.className = 'ca-code-toolbar'; language.textContent = node.lang || '代码'
        copy.className = 'ca-code-copy'; copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制代码')
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
        pre.className = 'ca-code'; pre.tabIndex = 0; code.textContent = node.value
        if (node.lang) pre.setAttribute('data-language', node.lang)
        bar.append(language, copy); pre.append(code); block.append(bar, pre); return [block]
      }
      case 'list': {
        const list = document.createElement(node.ordered ? 'ol' : 'ul')
        if (node.ordered && node.start !== null && node.start !== undefined) list.setAttribute('start', String(node.start))
        list.append(...children()); return [list]
      }
      case 'listItem': {
        const item = document.createElement('li')
        if (typeof node.checked === 'boolean') {
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = node.checked; checkbox.disabled = true
          checkbox.setAttribute('aria-label', node.checked ? '已完成' : '未完成'); item.className = 'ca-markdown-task'; item.append(checkbox)
        }
        item.append(...children()); return [item]
      }
      case 'link': case 'linkReference': {
        const target = node.type === 'link' ? node : definitions.get(node.identifier), link = target && linkFor(target.url, target.title)
        if (!link) return children()
        link.append(...children()); return [link]
      }
      case 'image': case 'imageReference': {
        const target = node.type === 'image' ? node : definitions.get(node.identifier), link = target && linkFor(target.url, target.title)
        const label = `[图片：${node.alt || '查看图片'}]`
        if (!link) return literal(label)
        link.textContent = label; link.className = 'ca-image-link'; return [link]
      }
      case 'table': {
        const scroll = document.createElement('div'), table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody')
        scroll.className = 'ca-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('aria-label', '表格，可横向滚动')
        node.children.forEach((row, index) => {
          const tr = document.createElement('tr')
          row.children.forEach((cell, column) => {
            const td = document.createElement(index === 0 ? 'th' : 'td')
            if (index === 0) td.setAttribute('scope', 'col')
            const alignment = node.align?.[column]
            if (alignment) td.setAttribute('data-align', alignment)
            td.append(...render(cell, depth + 1)); tr.append(td)
          })
          ;(index === 0 ? head : body).append(tr)
        })
        table.append(head, body); scroll.append(table); return [scroll]
      }
      case 'tableRow': case 'tableCell': return children()
      case 'definition': return []
      case 'footnoteReference': return literal(`[^${node.label ?? node.identifier}]`)
      case 'footnoteDefinition': {
        const note = document.createElement('div'); note.append(document.createTextNode(`[^${node.label ?? node.identifier}]: `), ...children()); return [note]
      }
      default: return literal(source.slice(node.position?.start.offset, node.position?.end.offset))
    }
  }
  try { container.append(...render(tree)); return container } catch { return plain() }
}

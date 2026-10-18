/** Minimal DOM for exercising the real Claude Agent browser controllers without a browser renderer. */
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)])
const matchesSimple = (node, selector) => {
  const attributes = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
  for (const [, name, value] of attributes) {
    const actual = node.getAttribute(name)
    if (actual === null || value !== undefined && actual !== value) return false
  }
  let rest = selector.replace(/\[[^\]]+\]/g, '')
  if (rest.includes(':checked')) { if (!node.checked) return false; rest = rest.replace(':checked', '') }
  if (rest.includes(':last-of-type')) {
    if (node.parentElement?.children.filter(sibling => sibling.tagName === node.tagName).at(-1) !== node) return false
    rest = rest.replace(':last-of-type', '')
  }
  const tag = /^[a-z][\w-]*/i.exec(rest)?.[0]
  if (tag && node.tagName !== tag.toUpperCase()) return false
  for (const [, className] of rest.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(className)) return false
  const id = /#([\w-]+)/.exec(rest)?.[1]
  return !id || node.id === id
}
const matches = (node, selector) => {
  const parts = selector.trim().split(/\s+(?![^\[]*\])/)
  if (!matchesSimple(node, parts.pop())) return false
  let parent = node.parentElement
  while (parts.length) {
    const part = parts.pop()
    while (parent && !matchesSimple(parent, part)) parent = parent.parentElement
    if (!parent) return false
    parent = parent.parentElement
  }
  return true
}

class TestElement extends EventTarget {
  constructor(tag, ownerDocument) {
    super()
    this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.parentElement = null
    this.attributes = new Map(); this.dataset = {}; this.className = ''; this.id = ''; this.name = ''
    this.hidden = false; this.disabled = false; this.checked = false; this.open = false
    this.scrollTop = 0; this.scrollHeight = 0; this._children = []; this._value = undefined; this._text = ''
  }
  get children() { return this._children.filter(child => child instanceof TestElement) }
  get textContent() { return this._text + this._children.map(child => child instanceof TestElement ? child.textContent : child).join('') }
  set textContent(value) { this.replaceChildren(); this._text = String(value) }
  get value() { return this._value ?? (this.tagName === 'SELECT' ? this.options[0]?.value ?? '' : '') }
  set value(value) { this._value = String(value) }
  get options() { return this.children.filter(child => child.tagName === 'OPTION') }
  get selectedOptions() { return this.options.filter(option => option.value === this.value) }
  get firstElementChild() { return this.children[0] ?? null }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value)
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value
    else if (['disabled', 'hidden', 'checked', 'open'].includes(name)) this[name] = true
    else if (name === 'class') this.className = value
    else if (['id', 'name', 'value', 'type', 'title', 'placeholder'].includes(name)) this[name] = value
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null
    if (name === 'class') return this.className || null
    if (['disabled', 'hidden', 'checked', 'open'].includes(name)) return this[name] ? '' : null
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name) { return this.getAttribute(name) !== null }
  removeAttribute(name) {
    this.attributes.delete(name)
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)]
    else if (['disabled', 'hidden', 'checked', 'open'].includes(name)) this[name] = false
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof TestElement) { child.remove(); child.parentElement = this }
      this._children.push(child)
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null
    this._children = []; this._text = ''; this.append(...children)
  }
  remove() {
    if (this.parentElement) this.parentElement._children = this.parentElement._children.filter(child => child !== this)
    this.parentElement = null
  }
  querySelectorAll(selector) { return descendants(this).filter(node => selector.split(',').some(part => matches(node, part.trim()))) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  focus() { this.ownerDocument.activeElement = this }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click', { cancelable: true })) }
  showModal() { this.open = true }
  reset() { for (const input of this.querySelectorAll('input, textarea')) input.value = input.getAttribute('value') ?? '' }
  close() { this.open = false }
}

/** Installs globals until test cleanup; selectors and events deliberately cover only the application's DOM usage. */
export function installClaudeAgentDOM(t, { autoRestore = true } = {}) {
  const document = { createElement: tag => new TestElement(tag, document) }
  document.body = document.createElement('body'); document.activeElement = document.body
  const values = new Map()
  const sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear() }
  const globals = { document, sessionStorage, HTMLElement: TestElement, Node: TestElement }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
  if (autoRestore) t.after(restore)
  const container = document.createElement('div'); document.body.append(container)
  return {
    document, container, sessionStorage, restore,
    find: (selector, root = container) => root.querySelector(selector),
    all: (selector, root = container) => root.querySelectorAll(selector),
    fire(node, type, properties = {}) {
      const event = new Event(type, { cancelable: true })
      for (const [name, value] of Object.entries(properties)) Object.defineProperty(event, name, { value })
      node.dispatchEvent(event); return event
    },
    flush: () => new Promise(resolve => setImmediate(resolve)),
  }
}

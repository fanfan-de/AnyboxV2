import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionMenu } from '../dist/applications/harness/web/session-menu.js'

const ref = (projectId, sessionId) => ({ projectId, sessionId })

// Small DOM/event surface for exercising the controller without a browser runtime.
function fixture({ available = () => true, width = 800, height = 600 } = {}) {
  const globals = ['document', 'window', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement']
  const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  class Surface {
    listeners = new Map()
    addEventListener(type, callback, options = {}) {
      const entries = this.listeners.get(type) ?? []
      entries.push({ callback, signal: options.signal, capture: typeof options === 'boolean' ? options : options.capture })
      this.listeners.set(type, entries)
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.callback !== callback))
    }
  }
  const doc = new Surface(), view = new Surface()
  doc.defaultView = view
  doc.hidden = false
  view.innerWidth = width
  view.innerHeight = height
  const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
  const match = (node, selector) => {
    if (selector === ':popover-open') return node.popoverOpen
    if (selector === ':disabled') return node.disabled
    if (selector.startsWith('#')) return node.id === selector.slice(1)
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
    const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector)
    if (attribute) {
      const value = node.getAttribute(attribute[1])
      return value !== null && (attribute[2] === undefined || value === attribute[2])
    }
    return node.tagName.toLowerCase() === selector.toLowerCase()
  }
  class Element extends Surface {
    constructor(tagName) {
      super()
      this.ownerDocument = doc
      this.tagName = tagName.toUpperCase()
      this.children = []
      this.dataset = {}
      this.attributes = new Map()
      this.style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
      this.className = ''
      this.id = ''
      this.hidden = false
      this.disabled = false
      this.popoverOpen = false
      this.rect = { left: 0, top: 0, right: 240, bottom: 120, width: 240, height: 120 }
      this.classList = {
        contains: value => this.className.split(/\s+/).includes(value),
        toggle: (value, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean))
          if (force ?? !classes.has(value)) classes.add(value)
          else classes.delete(value)
          this.className = [...classes].join(' ')
        },
      }
    }
    setAttribute(name, value) {
      value = String(value)
      this.attributes.set(name, value)
      if (name === 'id') this.id = value
      else if (name === 'class') this.className = value
      else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value
    }
    getAttribute(name) {
      if (name === 'id') return this.id || null
      if (name === 'class') return this.className || null
      if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null
      return this.attributes.get(name) ?? null
    }
    removeAttribute(name) {
      this.attributes.delete(name)
      if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))]
    }
    hasAttribute(name) { return this.getAttribute(name) !== null }
    append(...children) {
      for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) }
    }
    appendChild(child) { this.append(child); return child }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
      this.parentElement = undefined
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
    matches(selector) { return match(this, selector) }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim())
      return this.children.flatMap(child => [...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    getBoundingClientRect() { return { ...this.rect } }
    get offsetWidth() { return this.rect.width }
    get offsetHeight() { return this.rect.height }
    get isConnected() { return doc.body === this || !!this.parentElement?.isConnected }
    get parentNode() { return this.parentElement }
    focus() { doc.activeElement = this; dispatch(this, 'focusin') }
    click() { if (!this.disabled) dispatch(this, 'click') }
    showPopover() { this.popoverOpen = true }
    hidePopover() { this.popoverOpen = false }
  }
  doc.createElement = name => new Element(name)
  doc.documentElement = { clientWidth: width, clientHeight: height }
  doc.body = new Element('body')
  function dispatch(target, type, values = {}) {
    const path = [target]
    for (let parent = target.parentElement; parent; parent = parent.parentElement) path.push(parent)
    if (target !== doc && target !== view) path.push(doc)
    if (target !== view) path.push(view)
    const event = { type, target, currentTarget: undefined, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true },
      composedPath: () => path, ...values }
    const invoke = (surface, capture) => {
      event.currentTarget = surface
      for (const entry of surface.listeners.get(type) ?? []) {
        if (entry.signal?.aborted || !!entry.capture !== capture) continue
        entry.callback(event)
      }
    }
    for (const surface of [...path].reverse()) { invoke(surface, true); if (event.stopped) return event }
    for (const surface of path) { invoke(surface, false); if (event.stopped) break }
    return event
  }
  Object.assign(globalThis, { document: doc, window: view, Node: Surface, Element, HTMLElement: Element, HTMLButtonElement: Element })
  const root = new Element('aside'), trigger = new Element('button'), otherTrigger = new Element('button'), outside = new Element('button')
  trigger.rect = { left: 160, top: 80, right: 184, bottom: 108, width: 24, height: 28 }
  otherTrigger.rect = { left: 160, top: 140, right: 184, bottom: 168, width: 24, height: 28 }
  root.append(trigger, otherTrigger); doc.body.append(root, outside)
  const selections = []
  const controller = createSessionMenu(root, { available,
    select(value, action) { selections.push({ ref: value, action, open: controller.reference() }) },
  })
  const menu = root.querySelector('.session-menu')
  const actions = () => menu.querySelectorAll('[data-session-menu-action]')
  const action = value => actions().find(button => button.dataset.sessionMenuAction === value)
  return { controller, root, menu, trigger, otherTrigger, outside, document: doc, window: view, selections, action, actions, dispatch,
    restore() {
      controller.dispose()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}

test('the floating menu carries the selected session and closes before dispatching its action', () => {
  const f = fixture(), first = ref('project-a', 'session-a'), second = ref('project-b', 'session-b')
  try {
    assert.equal(f.menu.id, f.controller.id)
    assert.equal(f.menu.getAttribute('role'), 'menu')
    assert.equal(f.menu.popover, 'manual')
    assert.deepEqual(f.actions().map(button => button.dataset.sessionMenuAction), ['right', 'bottom', 'archive'])
    assert.ok(f.actions().every(button => button.getAttribute('role') === 'menuitem'))
    assert.equal(f.action('right').title, '在活动面板右侧打开')
    assert.equal(f.action('bottom').title, '在活动面板下方打开')
    f.controller.toggle(f.trigger, first)
    assert.deepEqual(f.controller.reference(), first)
    assert.equal(f.document.activeElement, f.action('right'))
    f.controller.toggle(f.otherTrigger, second)
    f.action('archive').click()
    assert.deepEqual(f.selections, [{ ref: second, action: 'archive', open: undefined }])
    assert.equal(f.controller.reference(), undefined)
    f.controller.toggle(f.trigger, first)
    f.action('bottom').click()
    assert.deepEqual(f.selections.at(-1), { ref: first, action: 'bottom', open: undefined })
    f.controller.toggle(f.trigger, first)
    f.action('right').click()
    assert.deepEqual(f.selections.at(-1), { ref: first, action: 'right', open: undefined })
  } finally { f.restore() }
})

test('unavailable items stay disabled and stale availability cannot dispatch a session action', () => {
  const blocked = new Set(['right']), f = fixture({ available: (_ref, action) => !blocked.has(action) })
  try {
    f.controller.toggle(f.trigger, ref('p', 's'))
    assert.equal(f.action('right').disabled, true)
    assert.equal(f.document.activeElement, f.action('bottom'))
    f.dispatch(f.action('right'), 'click')
    assert.equal(f.selections.length, 0)
    blocked.add('bottom')
    f.dispatch(f.action('bottom'), 'click')
    assert.equal(f.selections.length, 0, 'an item can become unavailable after rendering')
    f.controller.refresh()
    assert.equal(f.action('bottom').disabled, true)
    f.action('archive').click()
    assert.equal(f.selections.at(-1).action, 'archive')
  } finally { f.restore() }
})

test('keyboard navigation skips disabled items, wraps, and Escape returns focus without reaching the sidebar', () => {
  const f = fixture({ available: (_ref, action) => action !== 'right' })
  try {
    let escaped = 0
    f.root.addEventListener('keydown', () => { escaped++ })
    f.controller.toggle(f.trigger, ref('p', 's'), true)
    assert.equal(f.document.activeElement, f.action('archive'))
    for (const [key, expected] of [['ArrowDown', 'bottom'], ['ArrowUp', 'archive'], ['Home', 'bottom'], ['End', 'archive']]) {
      const event = f.dispatch(f.document.activeElement, 'keydown', { key })
      assert.equal(event.defaultPrevented, true)
      assert.equal(f.document.activeElement, f.action(expected))
    }
    escaped = 0
    const escape = f.dispatch(f.document.activeElement, 'keydown', { key: 'Escape' })
    assert.equal(escape.defaultPrevented, true)
    assert.equal(escaped, 0)
    assert.equal(f.controller.reference(), undefined)
    assert.equal(f.document.activeElement, f.trigger)
  } finally { f.restore() }
})

test('Tab closes the menu and preserves default navigation from the trigger', () => {
  const f = fixture()
  try {
    for (const shiftKey of [false, true]) {
      f.controller.toggle(f.trigger, ref('p', 's'))
      const event = f.dispatch(f.document.activeElement, 'keydown', { key: 'Tab', shiftKey })
      assert.equal(event.defaultPrevented, false)
      assert.equal(f.controller.reference(), undefined)
      assert.equal(f.document.activeElement, f.trigger)
    }
  } finally { f.restore() }
})

test('a menu with no available action keeps keyboard focus without dispatching', () => {
  const f = fixture({ available: () => false })
  try {
    f.controller.toggle(f.trigger, ref('p', 's'))
    assert.ok(f.actions().every(button => button.disabled))
    assert.equal(f.document.activeElement, f.menu)
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) f.dispatch(f.menu, 'keydown', { key })
    for (const action of f.actions()) f.dispatch(action, 'click')
    assert.equal(f.document.activeElement, f.menu)
    assert.equal(f.selections.length, 0)
    f.controller.close(true)
    assert.equal(f.document.activeElement, f.trigger)
  } finally { f.restore() }
})

test('trigger toggling restores focus while outside interaction closes without stealing it', () => {
  const f = fixture()
  try {
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.controller.toggle(f.trigger, ref('p', 's'))
    assert.equal(f.controller.reference(), undefined)
    assert.equal(f.document.activeElement, f.trigger)
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.dispatch(f.menu, 'pointerdown')
    f.dispatch(f.trigger, 'pointerdown')
    assert.ok(f.controller.reference())
    f.outside.focus()
    assert.equal(f.controller.reference(), undefined)
    assert.equal(f.document.activeElement, f.outside)
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.dispatch(f.outside, 'pointerdown')
    assert.equal(f.controller.reference(), undefined)
    assert.notEqual(f.document.activeElement, f.trigger)
  } finally { f.restore() }
})

test('external scrolling, resize and hiding the page dismiss the menu', () => {
  const f = fixture()
  try {
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.dispatch(f.menu, 'scroll')
    assert.ok(f.controller.reference(), 'scrolling the menu itself keeps its actions available')
    f.dispatch(f.root, 'scroll')
    assert.equal(f.controller.reference(), undefined)
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.dispatch(f.document, 'scroll')
    assert.equal(f.controller.reference(), undefined)
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.dispatch(f.window, 'resize')
    assert.equal(f.controller.reference(), undefined)
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.document.hidden = true
    f.dispatch(f.document, 'visibilitychange')
    assert.equal(f.controller.reference(), undefined)
  } finally { f.restore() }
})

test('placement stays inside the viewport and flips upward near its bottom edge', () => {
  const f = fixture({ width: 320, height: 240 })
  try {
    f.trigger.rect = { left: 270, top: 200, right: 294, bottom: 228, width: 24, height: 28 }
    f.controller.toggle(f.trigger, ref('p', 's'))
    const left = Number.parseFloat(f.menu.style.left), top = Number.parseFloat(f.menu.style.top)
    assert.ok(left >= 8 && left + f.menu.rect.width <= 312)
    assert.ok(top >= 8 && top + f.menu.rect.height <= f.trigger.rect.top)
  } finally { f.restore() }
})

test('disposal removes the menu and prevents later listeners and calls from reopening it', () => {
  const f = fixture()
  try {
    f.controller.toggle(f.trigger, ref('p', 's'))
    f.controller.dispose()
    assert.equal(f.controller.reference(), undefined)
    assert.equal(f.root.querySelector('.session-menu'), null)
    f.controller.toggle(f.otherTrigger, ref('other', 'session'))
    f.controller.refresh()
    f.controller.close(true)
    f.dispatch(f.action('archive'), 'click')
    f.dispatch(f.document, 'pointerdown', { target: f.outside })
    f.dispatch(f.window, 'resize')
    assert.equal(f.controller.reference(), undefined)
    assert.deepEqual(f.selections, [])
    assert.equal(f.menu.popoverOpen, false)
  } finally { f.restore() }
})

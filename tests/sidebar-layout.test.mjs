import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampSidebarWidth, createSidebarStateStore, defaultSidebarState, fitSidebars, restoreSidebarState } from '../dist/applications/harness/web/sidebar-layout.js'
import { setupSidebarLayout } from '../dist/applications/harness/web/sidebar-client.js'

test('three-column fitting shrinks right before left and never changes desired widths', () => {
  assert.deepEqual(fitSidebars(1440, defaultSidebarState), {
    leftWidth: 240, rightWidth: 400, leftDocked: true, rightDocked: true, leftDrawer: false, rightDrawer: false, centerWidth: 784,
  })
  const desired = { ...defaultSidebarState, leftWidth: 360, rightWidth: 720 }
  assert.equal(fitSidebars(1200, desired).rightWidth, 504)
  assert.equal(fitSidebars(1200, desired).leftWidth, 360)
  assert.equal(fitSidebars(1000, desired).rightWidth, 320)
  assert.equal(fitSidebars(1000, desired).leftWidth, 344)
  assert.equal(fitSidebars(856, desired).centerWidth, 320)
  assert.equal(fitSidebars(855, desired).rightDrawer, true)
  assert.equal(desired.leftWidth, 360); assert.equal(desired.rightWidth, 720)
})

test('collapsed sidebars reserve no space, while narrow containers use drawers', () => {
  const closed = { ...defaultSidebarState, leftExpanded: false, rightExpanded: false }
  assert.equal(fitSidebars(1024, closed).centerWidth, 1024)
  assert.equal(fitSidebars(800, { ...closed, rightExpanded: true }).rightDocked, true)
  for (const width of [760, 390, 0]) {
    const fit = fitSidebars(width, defaultSidebarState)
    assert.equal(fit.leftDrawer, true); assert.equal(fit.rightDrawer, true)
    assert.equal(fit.leftDocked, false); assert.equal(fit.rightDocked, false)
    assert.equal(fit.centerWidth, width)
  }
})

test('sidebar recovery and shared writes preserve independent session descriptors', () => {
  const records = new Map([['workspace', '{"version":1,"root":{"kind":"pane"}}'], ['workspace.sidebars.v1', '{broken']])
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) }
  const store = createSidebarStateStore('workspace.sidebars.v1', { storage })
  assert.deepEqual(store.read(), defaultSidebarState)
  const session = { expanded: ['src'], tabs: [{ kind: 'current', path: 'src/a.ts' }] }
  store.update(state => ({ ...state, perSession: { ...state.perSession, 'device:session': session } }))
  store.update(state => ({ ...state, leftWidth: 300, rightExpanded: false }))
  assert.deepEqual(store.read().perSession['device:session'], session)
  assert.deepEqual(createSidebarStateStore('workspace.sidebars.v1', { storage }).read(), store.read())
  assert.equal(records.get('workspace'), '{"version":1,"root":{"kind":"pane"}}')
  assert.deepEqual(restoreSidebarState({ version: 99 }), defaultSidebarState)
  assert.equal(restoreSidebarState({ version: 1, leftWidth: 20, rightWidth: 1000 }).leftWidth, 200)
  assert.equal(clampSidebarWidth('right', NaN), 400)
})

test('disabled persistence retains in-memory preferences and notifies subscribers', () => {
  const failures = []
  const store = createSidebarStateStore('denied', { storage: { getItem() { throw Error('denied') }, setItem() { throw Error('denied') } }, onStorageError: error => failures.push(error.message) })
  const values = [], unsubscribe = store.subscribe(state => values.push(state.leftWidth))
  store.update(state => ({ ...state, leftWidth: 320 }))
  unsubscribe(); store.update(state => ({ ...state, leftWidth: 240 }))
  assert.deepEqual(values, [240, 320])
  assert.equal(store.read().leftWidth, 240)
  assert.deepEqual(failures, ['denied', 'denied'])
})

// This DOM fixture tests layout ownership without installing a browser dependency.
function domFixture(initialWidth) {
  const old = { HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, ResizeObserver: globalThis.ResizeObserver }
  class Element extends EventTarget {
    constructor(id, parent = null) {
      super(); this.id = id; this.parentElement = parent; this.hidden = false; this.inert = false; this.tabIndex = 0
      this.dataset = {}; this.attributes = new Map(); this.targets = []; this.width = initialWidth
      this.style = { gridTemplateColumns: '', setProperty() {} }
    }
    querySelector(selector) { return this.elements?.get(selector.slice(1)) ?? null }
    querySelectorAll() { return this.targets }
    closest(selector) {
      if (selector === '.workspace') return this.parentElement
      if (selector === '[inert]') return this.inert ? this : this.parentElement?.closest(selector) ?? null
      return null
    }
    contains(element) { return this === element || this.targets.includes(element) }
    getBoundingClientRect() { return { width: this.width } }
    getClientRects() { return this.hidden ? [] : [{}] }
    matches(selector) { return selector === ':disabled' && !!this.disabled }
    setAttribute(key, value) { this.attributes.set(key, value) }
    removeAttribute(key) { this.attributes.delete(key) }
    getAttribute(key) { return this.attributes.get(key) }
    focus() { document.activeElement = this }
    setPointerCapture(id) { this.capture = id }
    releasePointerCapture() { this.capture = undefined }
    get isConnected() { return true }
  }
  globalThis.HTMLElement = Element; globalThis.Node = Element
  const document = new EventTarget(), root = new Element('root'), shell = new Element('workspace')
  root.ownerDocument = document; root.elements = new Map()
  for (const id of ['workspace-sidebar', 'file-sidebar', 'session-workspace', 'sidebar-backdrop', 'toggle-sidebar', 'toggle-files',
    'sidebar-toggle-label', 'left-sidebar-separator', 'right-sidebar-separator', 'show-workspace', 'close-sidebar', 'close-files']) {
    root.elements.set(`agent--${id}`, new Element(`agent--${id}`, shell))
  }
  const element = id => root.elements.get(`agent--${id}`)
  element('workspace-sidebar').targets = [element('close-sidebar')]
  element('file-sidebar').targets = [element('close-files')]
  let observer
  globalThis.ResizeObserver = class { constructor(callback) { observer = this; this.callback = callback } observe() {} disconnect() { this.disconnected = true } }
  const store = createSidebarStateStore('test', { storage: { getItem: () => null, setItem() {} } })
  const layout = setupSidebarLayout(root, { storageKey: 'test', stateStore: store })
  const dispatch = (target, type, values = {}) => {
    const event = new Event(type, { cancelable: true }); for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value })
    target.dispatchEvent(event); return event
  }
  return {
    layout, store, element, shell, document, dispatch, observer: () => observer,
    width(value) { shell.width = value; observer.callback() },
    restore() { layout.dispose(); Object.assign(globalThis, old) },
  }
}

test('container drawers are exclusive, release inert and focus, and close on app deactivation', () => {
  const f = domFixture(390)
  try {
    assert.equal(f.layout.rightVisible(), false)
    f.element('toggle-sidebar').focus(); f.dispatch(f.element('toggle-sidebar'), 'click')
    assert.equal(f.element('workspace-sidebar').hidden, false)
    assert.equal(f.element('session-workspace').inert, true)
    assert.equal(f.document.activeElement, f.element('close-sidebar'))
    f.layout.openRight()
    assert.equal(f.element('workspace-sidebar').hidden, true)
    assert.equal(f.layout.rightVisible(), true)
    f.dispatch(f.document, 'keydown', { key: 'Escape' })
    assert.equal(f.layout.rightVisible(), false); assert.equal(f.element('session-workspace').inert, false)
    f.layout.openRight(); f.layout.setActive(false); f.layout.setActive(true)
    assert.equal(f.layout.rightVisible(), false)
    assert.equal(f.store.read().rightExpanded, true, 'closing a temporary drawer preserves desktop preference')
    f.width(1440)
    assert.equal(f.layout.rightVisible(), true)
    assert.equal(f.element('workspace-sidebar').hidden, false)
  } finally { f.restore() }
})

test('keyboard and pointer resizing persist preferences; zero-size and hidden-app observations do not rewrite layout', () => {
  const f = domFixture(1440)
  try {
    f.dispatch(f.element('left-sidebar-separator'), 'keydown', { key: 'ArrowRight' })
    assert.equal(f.store.read().leftWidth, 250)
    f.dispatch(f.element('right-sidebar-separator'), 'keydown', { key: 'ArrowLeft' })
    assert.equal(f.store.read().rightWidth, 410)
    f.dispatch(f.element('left-sidebar-separator'), 'pointerdown', { button: 0, pointerId: 1, clientX: 250 })
    f.dispatch(f.element('left-sidebar-separator'), 'pointermove', { pointerId: 1, clientX: 305 })
    f.dispatch(f.element('left-sidebar-separator'), 'pointerup', { pointerId: 1 })
    assert.equal(f.store.read().leftWidth, 305)
    f.dispatch(f.element('left-sidebar-separator'), 'pointerdown', { button: 0, pointerId: 2, clientX: 305 })
    f.document.hidden = true; f.dispatch(f.document, 'visibilitychange')
    assert.equal(f.element('left-sidebar-separator').capture, undefined)
    f.dispatch(f.element('left-sidebar-separator'), 'pointermove', { pointerId: 2, clientX: 330 })
    assert.equal(f.store.read().leftWidth, 305)
    const columns = f.shell.style.gridTemplateColumns
    f.width(0)
    assert.equal(f.shell.style.gridTemplateColumns, columns)
    f.layout.setActive(false); f.width(390)
    assert.equal(f.shell.style.gridTemplateColumns, columns)
    f.layout.setActive(true)
    assert.equal(f.shell.style.gridTemplateColumns, '0px 0px minmax(0, 1fr) 0px 0px')
    assert.equal(f.store.read().leftWidth, 305); assert.equal(f.store.read().rightWidth, 410)
    f.layout.dispose(); assert.equal(f.observer().disconnected, true)
  } finally { f.restore() }
})

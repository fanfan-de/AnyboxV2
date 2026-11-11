import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupFloatingApplicationMenu } from '../dist/web/floating-application-menu.js'

const positionKey = 'anybox.apps.launcher-position.v1'
const px = (value, fallback) => value === undefined || value === '' ? fallback : Number.parseFloat(value)
class Element extends EventTarget {
  style = {}; dataset = {}; open = false; width; height; captures = []; releases = []; defaultLeft = 8; defaultTop = 8
  constructor(width, height) { super(); this.width = width; this.height = height }
  getBoundingClientRect() {
    const left = px(this.style.left, this.defaultLeft), top = px(this.style.top, this.defaultTop)
    const width = Math.min(this.width, px(this.style.maxWidth, this.width)), height = Math.min(this.height, px(this.style.maxHeight, this.height))
    return { left, top, width, height, right: left + width, bottom: top + height }
  }
  setPointerCapture(id) { this.captures.push(id) }
  releasePointerCapture(id) { this.releases.push(id) }
  matches(selector) { return selector === ':popover-open' && this.open }
}
function event(type, values = {}) { const value = new Event(type, { cancelable: true }); for (const [key, item] of Object.entries(values)) Object.defineProperty(value, key, { value: item }); return value }
function fixture(t, input = {}) {
  const previous = new Map(['window', 'sessionStorage', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const win = Object.assign(new EventTarget(), { innerWidth: input.width ?? 400, innerHeight: input.height ?? 300 })
  const button = new Element(40, 40), menu = new Element(180, 160), controller = new AbortController(), values = new Map(), writes = [], observers = []
  if ('saved' in input) values.set(positionKey, input.saved)
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem(key) { if (input.storageFails) throw Error('storage unavailable'); return values.get(key) ?? null },
    setItem(key, value) { if (input.storageFails) throw Error('storage unavailable'); values.set(key, value); writes.push({ key, value }) },
  } })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: input.observe === false ? undefined : class {
    disconnected = false; targets = []
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.targets.push(target) }
    disconnect() { this.disconnected = true }
  } })
  setupFloatingApplicationMenu(button, menu, { signal: controller.signal })
  t.after(() => { controller.abort(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  const pointer = (type, x, y, extra = {}) => { const value = event(type, { pointerId: 1, clientX: x, clientY: y, isPrimary: true, button: 0, ...extra }); button.dispatchEvent(value); return value }
  const click = (detail = 1) => { const value = event('click', { detail }); button.dispatchEvent(value); return value }
  const open = () => { menu.open = true; menu.dispatchEvent(new Event('toggle')) }
  return { button, menu, win, controller, values, writes, observers, pointer, click, open }
}

test('default placement stays in CSS and ordinary pointer or keyboard clicks remain usable', t => {
  const f = fixture(t)
  assert.deepEqual(f.button.style, {})
  f.pointer('pointerdown', 15, 15, { button: 2 }); f.pointer('pointerdown', 15, 15, { isPrimary: false })
  assert.deepEqual(f.button.captures, [])
  f.pointer('pointerdown', 15, 15); f.pointer('pointermove', 18, 18); f.pointer('pointerup', 18, 18)
  assert.deepEqual(f.button.style, {}); assert.equal(f.button.dataset.dragging, undefined)
  assert.deepEqual(f.button.captures, [1]); assert.deepEqual(f.button.releases, [1]); assert.equal(f.writes.length, 0)
  assert.equal(f.click().defaultPrevented, false); assert.equal(f.click(0).defaultPrevented, false)
})

test('dragging uses the threshold, retains the grab offset, clamps to the viewport and stores its final position', t => {
  const f = fixture(t)
  f.pointer('pointerdown', 20, 20)
  f.pointer('pointermove', 23, 24)
  assert.equal(f.button.dataset.dragging, 'true'); assert.equal(f.button.style.left, '11px'); assert.equal(f.button.style.top, '12px')
  f.pointer('pointermove', 120, 80)
  assert.equal(f.button.style.left, '108px'); assert.equal(f.button.style.top, '68px')
  f.pointer('pointermove', 2000, -1000)
  assert.equal(f.button.style.left, '352px'); assert.equal(f.button.style.top, '8px')
  f.pointer('pointerup', 2000, -1000)
  assert.equal(f.button.dataset.dragging, undefined); assert.deepEqual(f.button.releases, [1])
  assert.deepEqual(JSON.parse(f.values.get(positionKey)), { left: 352, top: 8 })
})

test('only the click produced by a drag is suppressed and later real clicks and keyboard activation still work', t => {
  const f = fixture(t)
  const drag = () => { f.pointer('pointerdown', 20, 20); f.pointer('pointermove', 50, 50); f.pointer('pointerup', 50, 50) }
  let activations = 0
  f.button.addEventListener('click', () => { activations++ })
  drag(); assert.equal(f.click().defaultPrevented, true); assert.equal(activations, 0)
  assert.equal(f.click().defaultPrevented, false); assert.equal(activations, 1)
  drag(); assert.equal(f.click(0).defaultPrevented, false); assert.equal(activations, 2)
  drag(); f.pointer('pointerdown', 20, 20); f.pointer('pointerup', 20, 20)
  assert.equal(f.click().defaultPrevented, false); assert.equal(activations, 3, 'a new pointer interaction never inherits drag suppression')
})

test('saved coordinates restore within the current viewport and resizing keeps both launcher and open menu visible', t => {
  const f = fixture(t, { saved: JSON.stringify({ left: 1000, top: 1000 }) })
  assert.equal(f.button.style.left, '352px'); assert.equal(f.button.style.top, '252px')
  f.open()
  let anchor = f.button.getBoundingClientRect(), menu = f.menu.getBoundingClientRect()
  assert.ok(menu.bottom <= anchor.top - 6); assert.equal(menu.right, anchor.right)
  f.win.innerWidth = 240; f.win.innerHeight = 200; f.win.dispatchEvent(new Event('resize'))
  anchor = f.button.getBoundingClientRect(); menu = f.menu.getBoundingClientRect()
  assert.equal(anchor.right, 232); assert.equal(anchor.bottom, 192)
  assert.ok(menu.left >= 8 && menu.top >= 8 && menu.right <= 232 && menu.bottom <= 192)
  assert.deepEqual(JSON.parse(f.values.get(positionKey)), { left: anchor.left, top: anchor.top })
})

test('invalid or unavailable position storage does not prevent dragging', t => {
  const f = fixture(t, { storageFails: true, observe: false })
  assert.deepEqual(f.button.style, {})
  f.pointer('pointerdown', 20, 20); f.pointer('pointermove', 60, 70); f.pointer('pointerup', 60, 70)
  assert.equal(f.button.style.left, '48px'); assert.equal(f.button.style.top, '58px')
  assert.equal(f.click().defaultPrevented, true)
})

test('malformed coordinates never replace the default CSS position', t => {
  const f = fixture(t, { saved: JSON.stringify({ left: '12', top: null }) })
  assert.deepEqual(f.button.style, {})
  f.open(); assert.equal(f.menu.style.left, '8px'); assert.equal(f.menu.style.top, '54px')
})

test('menu dimensions are recalculated after content growth and an open menu follows a dragging launcher', t => {
  const f = fixture(t)
  f.open(); assert.equal(f.menu.style.top, '54px')
  assert.deepEqual(f.observers[0].targets, [f.button, f.menu])
  f.menu.height = 500; f.menu.width = 500; f.observers[0].callback()
  let menu = f.menu.getBoundingClientRect()
  assert.equal(menu.left, 8); assert.ok(menu.right <= 392 && menu.bottom <= 292)
  f.pointer('pointerdown', 20, 20); f.pointer('pointermove', 320, 220)
  const anchor = f.button.getBoundingClientRect(); menu = f.menu.getBoundingClientRect()
  assert.ok(menu.bottom <= anchor.top - 6); assert.ok(menu.left >= 8 && menu.right <= 392)
})

test('pointer cancellation, capture loss and window blur release dragging without consuming a normal click', t => {
  const f = fixture(t)
  for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
    f.pointer('pointerdown', 20, 20); f.pointer('pointermove', 80, 80)
    if (cancel === 'blur') f.win.dispatchEvent(new Event('blur')); else f.pointer(cancel, 80, 80)
    assert.equal(f.button.dataset.dragging, undefined)
    const position = { ...f.button.style }; f.pointer('pointermove', 100, 100)
    assert.deepEqual(f.button.style, position); assert.equal(f.click().defaultPrevented, false)
  }
  assert.equal(f.button.releases.length, 3)
})

test('aborting releases capture, removes all behavior and disconnects dimension observation', t => {
  const f = fixture(t)
  f.pointer('pointerdown', 20, 20); f.pointer('pointermove', 80, 80)
  f.controller.abort()
  assert.equal(f.button.dataset.dragging, undefined); assert.deepEqual(f.button.releases, [1]); assert.equal(f.observers[0].disconnected, true)
  const position = { ...f.button.style }
  f.pointer('pointermove', 200, 200); f.pointer('pointerup', 200, 200); f.pointer('pointerdown', 20, 20)
  f.win.innerWidth = 80; f.win.dispatchEvent(new Event('resize')); f.observers[0].callback(); f.open()
  assert.deepEqual(f.button.style, position); assert.equal(f.click().defaultPrevented, false); assert.deepEqual(f.button.captures, [1])
})

test('very small windows clamp to nonnegative positions instead of generating negative coordinates', t => {
  const f = fixture(t, { width: 10, height: 8, saved: JSON.stringify({ left: 20, top: -20 }) })
  assert.equal(f.button.style.left, '0px'); assert.equal(f.button.style.top, '0px')
  f.open()
  for (const property of ['left', 'top', 'maxWidth', 'maxHeight']) assert.ok(Number.parseFloat(f.menu.style[property]) >= 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const product = state => ({ definition: { id: 'agent', name: 'Anybox Harness', description: 'Application',
  web: { entry: fileURLToPath(new URL('./helpers/shell-application.mjs', import.meta.url)) } }, desiredEnabled: state !== 'disabled', state })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let fixtureId = 0

// Exercise the shell's actual ESM entry, DOM events and HTTP adapter with controlled requests.
function shellDocument() {
  const document = { hidden: false, activeElement: undefined, listeners: new Map() }
  const listen = function(type, callback, options) { const values = this.listeners.get(type) ?? []; values.push({ callback, signal: options?.signal }); this.listeners.set(type, values) }
  const dispatch = function(type, extra = {}) { const event = { type, target: this, preventDefault() {}, ...extra }; for (const listener of this.listeners.get(type) ?? []) if (!listener.signal?.aborted) listener.callback(event) }
  const matches = (node, selector) => {
    if (selector === ':popover-open') return !!node.popoverOpen
    if (selector.includes(':not(:disabled)') && node.disabled || selector.includes(':not([hidden])') && node.hidden) return false
    selector = selector.replace(/:not\([^)]*\)/g, '')
    if (selector.startsWith('#')) return node.id === selector.slice(1)
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
    return node.tagName === selector.toLowerCase()
  }
  const element = tagName => {
    let ownText = ''
    const node = { tagName: tagName.toLowerCase(), id: '', className: '', dataset: {}, attributes: {}, children: [], parentElement: undefined,
      hidden: false, disabled: false, inert: false, listeners: new Map(),
      addEventListener: listen, dispatch,
      click() { if (!this.disabled) this.dispatch('click') },
      focus() { document.activeElement = this },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      removeAttribute(name) { delete this.attributes[name] },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } },
      insertBefore(child, target) { child.remove(); child.parentElement = this; const index = this.children.indexOf(target); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child) },
      replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; ownText = ''; this.append(...children) },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined },
      contains(child) { return child === this || this.children.some(value => value.contains(child)) },
      matches(selector) { return matches(this, selector) },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
      showPopover() { this.popoverOpen = true; this.dispatch('toggle') },
      hidePopover() { this.popoverOpen = false; this.dispatch('toggle') },
    }
    Object.defineProperties(node, {
      textContent: { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { node.replaceChildren(); ownText = String(value) } },
      isConnected: { get: () => node === document.body || Boolean(node.parentElement?.isConnected) },
    })
    return node
  }
  document.addEventListener = listen; document.dispatch = dispatch; document.createElement = element
  document.body = element('body'); document.head = element('head')
  document.getElementById = id => document.body.querySelector('#' + id)
  document.querySelector = selector => document.body.querySelector(selector)
  const add = (parent, tag, id) => { const node = element(tag); node.id = id; parent.append(node); return node }
  const rail = add(document.body, 'nav', ''); rail.className = 'product-rail'
  add(rail, 'button', 'show-applications'); add(rail, 'div', 'application-shortcuts')
  const actions = add(rail, 'div', 'application-actions'); actions.hidden = true
  add(actions, 'button', 'close-application').hidden = true; add(actions, 'button', 'stop-application').hidden = true
  const manager = add(document.body, 'aside', 'application-manager')
  add(manager, 'p', 'workbench-notice').hidden = true; add(manager, 'section', 'application-list')
  add(document.body, 'div', 'application-panels')
  return document
}

async function fixture(t, request) {
  const document = shellDocument(), listeners = new Map(), calls = [], storage = new Map()
  const previous = new Map()
  storage.set('anybox.apps.workspace.v1', JSON.stringify({ tabs: [{ id: 'agent', route: 'saved' }], activeId: 'agent' }))
  const location = { hash: '#/apps/agent/saved', origin: 'file:///' }
  const window = {
    addEventListener(type, callback, options) { const values = listeners.get(type) ?? []; values.push({ callback, signal: options?.signal }); listeners.set(type, values) },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) ?? []) if (!listener.signal?.aborted) listener.callback(event) },
  }
  for (const [key, value] of Object.entries({ document, window, location,
    history: { pushState(_state, _title, hash) { location.hash = hash }, replaceState(_state, _title, hash) { location.hash = hash } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval: () => 1, clearInterval() {},
    fetch: async (url, options = {}) => { calls.push({ url, options }); return request(url, options) },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  t.after(() => {
    window.dispatch('pagehide', { persisted: false })
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  })
  await import(`../dist/host/web/client.js?shellFixture=${++fixtureId}`)
  const find = id => document.getElementById(id)
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) { if (predicate()) return; await tick() }
    assert.ok(predicate(), 'shell did not reach the expected state')
  }
  const state = () => find('application-list').querySelector('.application-state')?.textContent
  const cardButton = label => find('application-list').querySelectorAll('button').find(button => button.textContent === label)
  await waitFor(() => find('app-panel-agent')?.textContent === 'Mounted application')
  return { document, calls, storage, find, state, cardButton, waitFor, notice: () => find('workbench-notice'),
    refresh() { document.dispatch('visibilitychange') }, async settle() { for (let count = 0; count < 4; count++) await tick() } }
}

test('an unreachable host replaces cached running status, fences controls and preserves the mounted workspace until recovery', async t => {
  let connected = true
  const f = await fixture(t, async () => { if (!connected) throw new TypeError('Failed to fetch'); return Response.json([product('running')]) })
  assert.equal(f.state(), '运行中')
  const panel = f.find('app-panel-agent')
  connected = false; f.refresh(); await f.settle()
  assert.equal(f.state(), '暂时无法确认状态')
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, true)
  assert.equal(f.cardButton('停止应用').disabled, true)
  assert.equal(f.find('app-shortcut-agent').disabled, true)
  assert.equal(f.find('stop-application').disabled, true)
  assert.match(f.notice().textContent, /无法连接应用宿主/)
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.textContent, 'Mounted application')
  assert.equal(panel.dataset.disposed, undefined)
  connected = true; f.refresh(); await f.waitFor(() => f.state() === '运行中')
  assert.equal(f.cardButton('停止应用').disabled, false); assert.equal(f.find('stop-application').disabled, false)
  assert.equal(f.notice().hidden, true)
})

test('a lost stop response reconciles the disabled target and closes its interface without repeating the mutation', async t => {
  let current = product('running')
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { current = product('disabled'); throw new TypeError('Response lost after commit') }
    return Response.json([current])
  })
  f.find('stop-application').click()
  await f.waitFor(() => f.state() === '尚未打开' && !f.find('app-panel-agent'))
  assert.equal(f.notice().hidden, true)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [], activeId: null })
})

test('a lost stop response with an authoritative running target keeps the interface and reports the completed state check', async t => {
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') throw new TypeError('Request unavailable')
    return Response.json([product('running')])
  })
  const panel = f.find('app-panel-agent'); f.find('stop-application').click(); await f.settle()
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.dataset.disposed, undefined)
  assert.equal(f.state(), '运行中')
  assert.match(f.notice().textContent, /应用尚未停止/)
  assert.doesNotMatch(f.notice().textContent, /正在核对/)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('a busy stop retains its specific reason after a successful catalog refresh', async t => {
  const f = await fixture(t, async (_url, options) => options.method === 'POST'
    ? Response.json({ error: { code: 'product-busy' } }, { status: 409 }) : Response.json([product('running')]))
  f.find('stop-application').click(); await f.settle()
  assert.equal(f.state(), '运行中'); assert.match(f.notice().textContent, /仍有任务或写入/)
  assert.equal(f.find('app-panel-agent').dataset.disposed, undefined)
  f.refresh(); await f.settle(); assert.match(f.notice().textContent, /仍有任务或写入/)
})

test('stop reconciliation joins a prior catalog read then captures a fresh post-stop target', async t => {
  const pending = deferred(); let current = product('running'), holdNextRead = false
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { current = product('disabled'); throw new TypeError('Response lost') }
    if (holdNextRead) { holdNextRead = false; return pending.promise }
    return Response.json([current])
  })
  holdNextRead = true; f.refresh(); await f.settle()
  f.find('stop-application').click(); await f.settle()
  pending.resolve(Response.json([product('running')]))
  await f.waitFor(() => f.state() === '尚未打开' && !f.find('app-panel-agent'))
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  assert.ok(f.calls.filter(call => call.options.method === 'GET').length >= 3)
})

test('an unconfirmed stop waits through applying and closes its workspace only after a later disabled observation', async t => {
  let current = product('running')
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { current = { ...product('applying'), desiredEnabled: false }; throw new TypeError('Response lost') }
    return Response.json([current])
  })
  f.find('stop-application').click(); await f.settle()
  assert.equal(f.state(), '正在处理'); assert.match(f.notice().textContent, /等待应用停止完成/)
  assert.ok(f.find('app-panel-agent'), 'the interface position remains until the stop is confirmed')
  current = product('disabled'); f.refresh()
  await f.waitFor(() => f.state() === '尚未打开' && !f.find('app-panel-agent'))
  assert.equal(f.notice().hidden, true)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('an unavailable stop result survives the outage and reconciles disabled when the host returns', async t => {
  let current = product('running'), connected = true
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') { current = product('disabled'); connected = false; throw new TypeError('Response lost') }
    if (!connected) throw new TypeError('Failed to fetch')
    return Response.json([current])
  })
  const panel = f.find('app-panel-agent'); f.find('stop-application').click(); await f.settle()
  assert.equal(f.state(), '暂时无法确认状态'); assert.match(f.notice().textContent, /无法连接应用宿主/)
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.dataset.disposed, undefined)
  connected = true; f.refresh()
  await f.waitFor(() => f.state() === '尚未打开' && !f.find('app-panel-agent'))
  assert.equal(f.notice().hidden, true)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('a rejected stop target write retains the running workspace and explains that the saved state did not change', async t => {
  const f = await fixture(t, async (_url, options) => options.method === 'POST'
    ? Response.json({ error: { code: 'product-storage-failed' } }, { status: 503 }) : Response.json([product('running')]))
  f.find('stop-application').click(); await f.settle()
  assert.equal(f.state(), '运行中'); assert.match(f.notice().textContent, /无法保存停止状态/)
  assert.equal(f.find('app-panel-agent').dataset.disposed, undefined)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('a cleanup failure discovered after a lost stop response reports the restart requirement', async t => {
  let current = product('running')
  const f = await fixture(t, async (_url, options) => {
    if (options.method === 'POST') {
      current = { ...product('failed'), desiredEnabled: false, error: { phase: 'cleanup', code: 'product-cleanup-failed' } }
      throw new TypeError('Response lost')
    }
    return Response.json([current])
  })
  f.find('stop-application').click(); await f.settle()
  assert.equal(f.state(), '启动或关闭失败'); assert.match(f.notice().textContent, /清理失败.*重启宿主/)
  assert.ok(f.find('app-panel-agent'), 'cleanup failure does not confirm a disabled target')
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('a local interface cleanup rejection keeps a successful catalog read authoritative and controls available', async t => {
  let current = product('running')
  const f = await fixture(t, async () => Response.json([current]))
  f.find('app-panel-agent').dataset.failDispose = 'true'
  current = product('disabled'); f.refresh(); await f.settle()
  assert.equal(f.state(), '尚未打开')
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, false)
  assert.equal(f.find('app-shortcut-agent').disabled, false)
  assert.match(f.notice().textContent, /应用界面清理失败/)
  assert.doesNotMatch(f.notice().textContent, /无法连接应用宿主/)
})

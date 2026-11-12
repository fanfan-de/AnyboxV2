import assert from 'node:assert/strict'
import { test } from 'node:test'

const product = state => ({ definition: { id: 'agent', name: 'Anybox Harness', description: 'Application',
  web: { entry: new URL('./helpers/shell-application.mjs', import.meta.url).pathname } }, desiredEnabled: state !== 'disabled', state })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let fixtureId = 0

// Exercise the shell's actual ESM entry, DOM events and HTTP adapter with controlled requests.
function shellDocument() {
  const document = { hidden: false, activeElement: undefined, listeners: new Map() }
  const listen = function(type, callback, options) { const values = this.listeners.get(type) ?? []; values.push({ callback, signal: options?.signal }); this.listeners.set(type, values) }
  const unlisten = function(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(listener => listener.callback !== callback)) }
  const dispatch = function(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true },
      stopPropagation() {}, stopImmediatePropagation() { this.immediatePropagationStopped = true }, ...extra }
    for (const listener of this.listeners.get(type) ?? []) if (!listener.signal?.aborted) {
      listener.callback(event)
      if (event.immediatePropagationStopped) break
    }
    return event
  }
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
    const node = { tagName: tagName.toLowerCase(), id: '', className: '', value: '', dataset: {}, attributes: {}, children: [], parentElement: undefined,
      hidden: false, disabled: false, inert: false, listeners: new Map(), style: {},
      addEventListener: listen, removeEventListener: unlisten, dispatch,
      click() {
        if (this.disabled || this.dispatch('click', { detail: 1 }).defaultPrevented) return
        const target = document.getElementById(this.getAttribute('popovertarget'))
        if (target) target.matches(':popover-open') ? target.hidePopover() : target.showPopover()
      },
      focus() { document.activeElement = this },
      getBoundingClientRect() {
        const left = Number.parseFloat(this.style.left) || 12, top = Number.parseFloat(this.style.top) || 12
        const width = this.id === 'application-menu' ? 296 : 36, height = this.id === 'application-menu' ? 240 : 36
        return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }
      },
      setPointerCapture(pointerId) { this.capturedPointer = pointerId },
      releasePointerCapture(pointerId) { if (this.capturedPointer === pointerId) this.capturedPointer = undefined },
      hasPointerCapture(pointerId) { return this.capturedPointer === pointerId },
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
      showModal() { this.open = true; this.dispatch('toggle') },
      close() { this.open = false; this.dispatch('close'); this.dispatch('toggle') },
    }
    Object.defineProperties(node, {
      textContent: { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { node.replaceChildren(); ownText = String(value) } },
      isConnected: { get: () => node === document.body || Boolean(node.parentElement?.isConnected) },
    })
    return node
  }
  document.addEventListener = listen; document.removeEventListener = unlisten; document.dispatch = dispatch; document.createElement = element
  document.body = element('body'); document.head = element('head'); document.documentElement = element('html')
  document.documentElement.append(document.head, document.body)
  document.getElementById = id => document.body.querySelector('#' + id)
  document.querySelector = selector => document.body.querySelector(selector)
  const add = (parent, tag, id) => { const node = element(tag); node.id = id; parent.append(node); return node }
  const workbench = add(document.body, 'div', 'workbench'); workbench.className = 'workbench'
  const showMenu = add(workbench, 'button', 'show-application-menu'); showMenu.setAttribute('popovertarget', 'application-menu')
  showMenu.setAttribute('aria-label', 'Anybox 应用菜单'); showMenu.title = 'Anybox 应用菜单'
  const menu = add(document.body, 'aside', 'application-menu')
  add(menu, 'div', 'application-menu-heading')
  add(menu, 'div', 'application-menu-list'); add(menu, 'button', 'show-applications')
  add(menu, 'label', 'application-language-label')
  const language = add(menu, 'select', 'application-language'); language.value = 'system'
  for (const value of ['system', 'zh-CN', 'en']) { const option = add(language, 'option', `application-language-${value}`); option.value = value }
  const actions = add(menu, 'div', 'application-actions'); actions.hidden = true
  add(actions, 'button', 'close-application').hidden = true; add(actions, 'button', 'stop-application').hidden = true
  const manager = add(document.body, 'dialog', 'application-manager'); manager.open = false
  const managerHeader = add(manager, 'header', ''); managerHeader.className = 'application-manager-header'
  add(managerHeader, 'h2', 'application-manager-title')
  const managerTools = add(managerHeader, 'div', ''); managerTools.className = 'application-manager-tools'
  add(managerTools, 'div', 'application-install-actions'); add(managerTools, 'button', 'close-application-manager')
  add(manager, 'p', 'workbench-notice').hidden = true; add(manager, 'section', 'application-list')
  add(workbench, 'div', 'application-panels')
  return document
}

async function fixture(t, request, options = {}) {
  const document = shellDocument(), listeners = new Map(), calls = [], storage = new Map(), preferences = new Map()
  options.configureDocument?.(document)
  const previous = new Map()
  storage.set('anybox.apps.workspace.v1', JSON.stringify(options.workspace ?? { tabs: [{ id: 'agent', route: 'saved' }], activeId: 'agent' }))
  if (options.localePreference !== undefined) preferences.set('anybox.preferences.locale.v1', options.localePreference)
  const location = { hash: '#/apps/agent/saved', origin: 'file:///', reloads: 0, reload() { this.reloads++ } }
  const window = {
    innerWidth: 1280, innerHeight: 720,
    addEventListener(type, callback, options) { const values = listeners.get(type) ?? []; values.push({ callback, signal: options?.signal }); listeners.set(type, values) },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) ?? []).filter(listener => listener.callback !== callback)) },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) ?? []) if (!listener.signal?.aborted) listener.callback(event) },
  }
  for (const [key, value] of Object.entries({ document, window, location,
    history: { pushState(_state, _title, hash) { location.hash = hash }, replaceState(_state, _title, hash) { location.hash = hash } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    navigator: { languages: options.languages ?? ['zh-CN'], language: options.languages?.[0] ?? 'zh-CN' },
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
  await import(`../packages/host/dist/web/client.js?shellFixture=${++fixtureId}`)
  const find = id => document.getElementById(id)
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) { if (predicate()) return; await tick() }
    assert.ok(predicate(), 'shell did not reach the expected state')
  }
  const state = () => find('application-list').querySelector('.application-state')?.textContent
  const cardButton = label => find('application-list').querySelectorAll('button').find(button => button.textContent === label || button.getAttribute('aria-label') === label)
  await waitFor(() => find('app-panel-agent')?.textContent === 'Mounted application')
  return { document, window, location, calls, storage, preferences, find, state, cardButton, waitFor, notice: () => find('workbench-notice'),
    refresh() { document.dispatch('visibilitychange') }, async settle() { for (let count = 0; count < 4; count++) await tick() } }
}

test('an unreachable host replaces cached running status, fences controls and preserves the mounted workspace until recovery', async t => {
  let connected = true
  const f = await fixture(t, async () => { if (!connected) throw new TypeError('Failed to fetch'); return Response.json([product('running')]) })
  assert.equal(f.state(), '运行中')
  assert.equal(f.find('application-list').querySelector('.application-state').dataset.state, 'running')
  const panel = f.find('app-panel-agent')
  connected = false; f.refresh(); await f.settle()
  assert.equal(f.state(), '暂时无法确认状态')
  assert.equal(f.find('application-list').querySelector('.application-state').dataset.state, 'unknown')
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, true)
  assert.equal(f.cardButton('停止应用').disabled, true)
  assert.equal(f.find('app-menu-agent').disabled, true)
  assert.equal(f.find('stop-application').disabled, true)
  assert.match(f.notice().textContent, /无法连接应用宿主/)
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.textContent, 'Mounted application')
  assert.equal(panel.dataset.disposed, undefined)
  connected = true; f.refresh(); await f.waitFor(() => f.state() === '运行中')
  assert.equal(f.cardButton('停止应用').disabled, false); assert.equal(f.find('stop-application').disabled, false)
  assert.equal(f.notice().hidden, true)
})

test('an unavailable optional directory picker explains the limited feature while retaining application access', async t => {
  const app = { ...product('running'), capabilities: [{ id: 'system.directory-picker', range: '^1.0.0', required: false, status: 'missing' }] }
  const f = await fixture(t, async (_url, options) => Response.json(options.method === 'POST' ? app : [app]))
  const card = f.find('application-list').querySelector('.application-card')
  const details = card.querySelector('.application-capabilities')
  assert.equal(details.tagName, 'details')
  assert.match(details.querySelector('summary').textContent, /系统目录选择暂不可用/)
  assert.match(details.textContent, /system\.directory-picker/)
  assert.equal(card.querySelector('.application-required-capabilities'), null)
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, false)
  f.find('close-application').click(); await f.waitFor(() => !f.find('app-panel-agent'))
  f.cardButton('打开 Anybox Harness').click()
  await f.waitFor(() => f.find('app-panel-agent')?.textContent === 'Mounted application')
  const mutations = f.calls.filter(call => call.options.method === 'POST')
  assert.equal(mutations.length, 1)
  assert.ok(mutations[0].url.endsWith('/products/agent/open'), 'the optional feature never requires a stop or recovery mutation')
})

test('required capability failures remain visible and optional capability disclosure stays expanded across catalog updates', async t => {
  let current = { ...product('running'), capabilities: [{ id: 'system.directory-picker', range: '^1.0.0', required: false, status: 'missing' }] }
  const f = await fixture(t, async () => Response.json([current]))
  const details = f.find('application-list').querySelector('.application-capabilities')
  details.open = true; details.dispatch('toggle')
  current = { ...current, definition: { ...current.definition, description: 'Updated application details' } }
  f.refresh(); await f.waitFor(() => f.find('application-list').textContent.includes('Updated application details'))
  assert.equal(f.find('application-list').querySelector('.application-capabilities').open, true)
  current = { ...current, state: 'blocked', capabilities: [...current.capabilities, { id: 'storage.sqlite', range: '^1.0.0', required: true, status: 'missing' }] }
  f.refresh(); await f.waitFor(() => f.state() === '依赖未就绪')
  const required = f.find('application-list').querySelector('.application-required-capabilities')
  assert.ok(required)
  assert.equal(required.hidden, false)
  assert.notEqual(required.tagName, 'details', 'required failures cannot be hidden behind a collapsed disclosure')
  assert.match(required.textContent, /storage\.sqlite/)
  assert.equal(f.find('application-list').querySelector('.application-state').dataset.state, 'blocked')
  assert.ok(f.calls.every(call => call.options.method !== 'POST'), 'capability status refresh only observes the host')
})

test('startup recovery stays directly available when an application fails after its details were collapsed', async t => {
  let current = product('running')
  const f = await fixture(t, async () => Response.json([current]))
  assert.equal(f.find('application-list').querySelector('.application-details').open, false)
  for (const state of ['failed', 'blocked']) {
    current = product(state); f.refresh(); await f.waitFor(() => f.state() === (state === 'failed' ? '启动或关闭失败' : '依赖未就绪')); await f.settle()
    const card = f.find('application-list').querySelector('.application-card'), details = card.querySelector('.application-details')
    const recovery = card.querySelector('.application-recovery-actions'), retry = f.cardButton('重试启动')
    assert.equal(details.open, false, 'catalog updates preserve the user’s collapsed details')
    assert.ok(recovery)
    assert.equal(recovery.parentElement, card, 'recovery actions are outside the collapsed disclosure')
    assert.equal(recovery.hidden, false)
    assert.ok(recovery.contains(retry))
    assert.equal(retry.hidden, false)
    assert.equal(retry.disabled, false)
    assert.equal(details.contains(retry), false)
  }
  assert.ok(f.calls.every(call => call.options.method !== 'POST'), 'showing recovery never starts or retries an application automatically')
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

test('a local interface cleanup rejection keeps the catalog authoritative and fences access to its unconfirmed interface', async t => {
  let current = product('running')
  const f = await fixture(t, async () => Response.json([current]))
  f.find('app-panel-agent').dataset.failDispose = 'true'
  current = product('disabled'); f.refresh(); await f.settle()
  assert.equal(f.state(), '尚未打开')
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, true)
  assert.equal(f.find('app-menu-agent').disabled, true)
  assert.match(f.notice().textContent, /应用界面清理失败/)
  assert.doesNotMatch(f.notice().textContent, /无法连接应用宿主/)
})


test('an interface-only application mounts and closes without a business API or background controls', async t => {
  const app = { ...product('running'), definition: { ...product('running').definition, runtime: false, http: false }, desiredEnabled: false }
  const f = await fixture(t, async (_url, options) => {
    assert.equal(options.method, 'GET')
    return Response.json([app])
  })
  assert.equal(f.state(), '可打开')
  assert.equal(f.find('app-panel-agent').dataset.apiBase, 'none')
  assert.equal(f.find('stop-application').hidden, true)
  assert.equal(f.cardButton('停止应用'), undefined)
  f.find('close-application').click()
  await f.waitFor(() => !f.find('app-panel-agent'))
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [], activeId: null })
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.equal(f.find('show-application-menu').title, 'Anybox 应用菜单')
  assert.equal(f.find('application-manager').open, true, 'closing the last interface leaves application management available')
  assert.ok(f.calls.every(call => call.options.method === 'GET'))
})

const packageIdentity = { appId: 'new-app', version: '1.0.0', digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }
const packageStatus = () => ({ available: true, trustedPublisherCount: 1, registryRevision: 7, lifecycleAvailable: true, browserLifecycleAvailable: false, actual: [], operations: [], activations: [], installations: [{ appId: 'new-app', selected: null, pending: packageIdentity, installed: [{ identity: packageIdentity, state: 'installed' }] }] })
const activationReceipt = (phase, requestId = 'activation-request') => ({ id: 'activation-1', requestId, revision: 1, phase, protected: true, roles: [{ role: 'client', ready: phase === 'completed' }] })
const workspaceTwoApplications = { tabs: [{ id: 'agent', route: 'saved' }, { id: 'second-app', route: 'draft' }], activeId: 'agent' }
const secondProduct = () => ({ ...product('running'), definition: { ...product('running').definition, id: 'second-app', name: 'Second application' } })
const packageButton = (f, label) => f.find('application-manager').querySelectorAll('button').find(button => button.textContent === label)
async function showPackageManager(f) { f.find('show-applications').click(); await f.waitFor(() => packageButton(f, '应用更改') && !packageButton(f, '应用更改').disabled) }

test('opening and closing another interface preserves the floating host entry without permanent navigation', async t => {
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      assert.ok(url.endsWith('/products/second-app/open'))
      return Response.json(secondProduct())
    }
    return Response.json([product('running'), secondProduct()])
  })
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.equal(f.find('workbench-header'), null, 'the host does not reserve a separate top header row')
  assert.equal(f.find('show-application-menu').parentElement, f.find('workbench'), 'the floating application picker remains available over application content')
  assert.equal(f.find('show-application-menu').title, 'Anybox 应用菜单 · Anybox Harness')
  f.find('show-application-menu').click()
  assert.equal(f.find('application-menu').matches(':popover-open'), true)
  assert.equal(f.find('app-menu-agent').disabled, false)
  assert.equal(f.find('app-menu-second-app').disabled, false)
  f.find('app-menu-second-app').click()
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  assert.equal(f.document.querySelector('.product-rail'), null, 'opening multiple interfaces never introduces a host rail')
  assert.equal(f.find('workbench-header'), null)
  assert.equal(f.find('app-panel-agent').hidden, true)
  const secondPanel = f.find('app-panel-second-app')
  f.find('show-application-menu').click()
  f.find('close-application').click()
  await f.waitFor(() => !f.find('app-panel-second-app'))
  assert.equal(secondPanel.dataset.disposed, 'true')
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.equal(f.find('app-menu-second-app').disabled, false, 'a closed interface stays available through the application menu')
  assert.equal(f.find('workbench-header'), null)
  assert.equal(f.find('show-application-menu').title, 'Anybox 应用菜单 · Anybox Harness')
  assert.equal(f.find('app-panel-agent').hidden, false)
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [{ id: 'agent', route: 'saved' }], activeId: 'agent' })
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1, 'closing the interface does not stop its background')
})

test('restored application interfaces switch through the floating menu and retain drafts until an accepted close', async t => {
  const f = await fixture(t, async () => Response.json([product('running'), secondProduct()]), { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  const secondPanel = f.find('app-panel-second-app')
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.equal(f.find('workbench-header'), null)
  f.find('show-application-menu').click()
  assert.equal(f.find('application-menu').matches(':popover-open'), true)
  f.find('app-menu-second-app').click(); await f.settle()
  assert.equal(secondPanel.hidden, false)
  secondPanel.dataset.blockClose = 'true'
  f.find('close-application').click(); await f.settle()
  assert.equal(f.find('app-panel-second-app'), secondPanel)
  assert.ok(f.find('app-panel-agent'), 'a rejected close preserves both restored interfaces')
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.match(f.notice().textContent, /保存当前应用/)
  secondPanel.dataset.blockClose = 'false'
  f.find('close-application').click(); await f.waitFor(() => !f.find('app-panel-second-app'))
  assert.equal(f.document.querySelector('.product-rail'), null)
  assert.equal(f.find('app-panel-agent').hidden, false)
  assert.ok(f.calls.every(call => call.options.method !== 'POST'), 'restoring, selecting and closing existing interfaces only observes the host')
})

test('the compact application menu opens another interface while independent management preserves the mounted workspace', async t => {
  const f = await fixture(t, async (url, options) => options.method === 'POST'
    ? Response.json(secondProduct()) : Response.json([product('running'), secondProduct()]))
  const firstPanel = f.find('app-panel-agent'), menu = f.find('application-menu')
  assert.equal(f.find('show-application-menu').title, 'Anybox 应用菜单 · Anybox Harness')
  assert.equal(f.find('show-application-menu').getAttribute('aria-label'), 'Anybox 应用菜单')
  assert.equal(f.find('show-application-menu').textContent, '', 'the floating trigger has no visible application-name label')
  f.find('show-application-menu').click()
  assert.equal(menu.matches(':popover-open'), true)
  assert.equal(f.find('show-application-menu').getAttribute('aria-expanded'), 'true')
  assert.equal(menu.querySelector('.application-description'), null)
  assert.equal(menu.querySelector('.package-management'), null, 'the quick menu does not mount installation controls')
  const second = f.find('application-menu-list').querySelectorAll('button').find(button => button.dataset.appId === 'second-app')
  assert.ok(second)
  assert.equal(second.getAttribute('aria-label'), '打开 Second application')
  second.click(); await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  assert.equal(menu.matches(':popover-open'), false)
  assert.equal(f.find('show-application-menu').getAttribute('aria-expanded'), 'false')
  assert.equal(f.find('show-application-menu').title, 'Anybox 应用菜单 · Second application')
  assert.equal(f.find('show-application-menu').getAttribute('aria-label'), 'Anybox 应用菜单')
  f.find('show-application-menu').click()
  f.find('show-applications').click(); await f.settle()
  assert.equal(f.find('application-manager').open, true)
  const installActions = f.find('application-install-actions'), installButton = packageButton(f, '安装应用')
  assert.ok(installButton)
  assert.ok(installActions.contains(installButton), 'the installation entry is placed in the management header')
  assert.equal(menu.matches(':popover-open'), false)
  assert.equal(f.find('app-panel-agent'), firstPanel)
  assert.equal(firstPanel.dataset.disposed, undefined)
  f.find('close-application-manager').click(); await f.settle()
  assert.equal(f.find('application-manager').open, false)
  assert.equal(installActions.children.length, 0, 'closing management releases its external installation entry')
  assert.equal(f.find('app-panel-agent'), firstPanel)
  assert.equal(firstPanel.dataset.disposed, undefined)
  assert.ok(f.find('app-panel-second-app'))
})

test('dragging the floating application entry does not open its menu or disturb the mounted workspace', async t => {
  const f = await fixture(t, async () => Response.json([product('running')]))
  const trigger = f.find('show-application-menu'), menu = f.find('application-menu'), panel = f.find('app-panel-agent')
  const originalLeft = trigger.getBoundingClientRect().left
  trigger.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20 })
  trigger.dispatch('pointermove', { pointerId: 1, button: 0, isPrimary: true, clientX: 120, clientY: 80 })
  trigger.dispatch('pointerup', { pointerId: 1, button: 0, isPrimary: true, clientX: 120, clientY: 80 })
  assert.ok(trigger.getBoundingClientRect().left > originalLeft)
  trigger.click()
  assert.equal(menu.matches(':popover-open'), false, 'the click following a drag is consumed')
  assert.equal(f.find('app-panel-agent'), panel)
  assert.equal(panel.dataset.disposed, undefined)
  trigger.click()
  assert.equal(menu.matches(':popover-open'), true, 'the moved entry remains available for the next ordinary click')
  assert.equal(f.find('show-application-menu').getAttribute('aria-expanded'), 'true')
  assert.ok(f.calls.every(call => call.options.method !== 'POST'), 'moving and opening the launcher never controls application backgrounds')
})

test('a failed ordinary close remains unconfirmed through another close, reload request and version activation', async t => {
  const f = await fixture(t, async url => Response.json(url.includes('/app-packages') ? packageStatus() : [product('running')]))
  const panel = f.find('app-panel-agent'), context = panel.testContext
  panel.dataset.failDispose = 'true'
  f.find('close-application').click(); await f.settle()
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.dataset.disposed, undefined)
  assert.equal(context.signal.aborted, true); assert.match(f.notice().textContent, /应用界面清理失败/)
  assert.equal(f.cardButton('打开 Anybox Harness').disabled, true); assert.equal(f.find('stop-application').disabled, true)
  // A rejected dispose cannot be retried or forgotten even if a later invocation would succeed.
  panel.dataset.failDispose = 'false'
  f.find('close-application').click(); f.cardButton('打开 Anybox Harness').click(); f.refresh(); await f.settle()
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.testContext, context); assert.equal(panel.dataset.disposed, undefined)
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [{ id: 'agent', route: 'saved' }], activeId: 'agent' })
  const unload = { prevented: false, preventDefault() { this.prevented = true } }
  f.window.dispatch('beforeunload', unload); assert.equal(unload.prevented, true); assert.equal(unload.returnValue, '')
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.settle()
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
  assert.equal(f.location.reloads, 0); assert.equal(f.find('app-panel-agent'), panel)
  assert.match(f.find('application-manager').textContent, /保存所有已打开应用/)
})

test('failed initialization with a rejected dispose preserves the returned mount and prevents replacement or activation', async t => {
  let activations = 0, disposals = 0
  const f = await fixture(t, async url => Response.json(url.includes('/app-packages') ? packageStatus() : [product('running')]), {
    configureDocument(document) {
      const createElement = document.createElement
      document.createElement = tag => {
        const element = createElement(tag)
        Object.defineProperties(element.dataset, {
          active: { set() { activations++; throw Error('setActive failed after mount') } },
          failDispose: { get() { disposals++; return 'true' } },
        })
        return element
      }
    },
  })
  await f.settle()
  const panel = f.find('app-panel-agent'), context = panel.testContext
  assert.equal(activations, 1); assert.equal(disposals, 1); assert.equal(context.signal.aborted, true)
  assert.match(f.notice().textContent, /应用界面清理失败/)
  const reload = f.cardButton('重新加载界面'); assert.ok(reload); assert.equal(reload.disabled, true)
  const card = f.find('application-list').querySelector('.application-card'), recovery = card.querySelector('.application-recovery-actions')
  assert.equal(recovery.parentElement, card)
  assert.ok(recovery.contains(reload), 'interface recovery stays outside application details even when unsafe cleanup fences the action')
  assert.equal(card.querySelector('.application-details').contains(reload), false)
  reload.click(); f.find('close-application').click(); f.refresh(); await f.settle()
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.testContext, context)
  assert.equal(activations, 1); assert.equal(disposals, 1)
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.settle()
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0); assert.equal(f.location.reloads, 0)
})

test('closing during mount waits for its returned handle and retains a failed cleanup', async t => {
  const f = await fixture(t, async url => Response.json(url.includes('/app-packages') ? packageStatus() : [product('running')]), {
    configureDocument(document) {
      const createElement = document.createElement
      document.createElement = tag => {
        const element = createElement(tag), append = element.append
        element.append = function(...children) {
          append.call(this, ...children)
          if (this.dataset.appId === 'agent' && children.some(child => child.textContent === 'Mounted application')) {
            this.dataset.failDispose = 'true'
            document.getElementById('close-application').click()
          }
        }
        return element
      }
    },
  })
  await f.settle()
  const panel = f.find('app-panel-agent'), context = panel.testContext
  assert.equal(context.signal.aborted, true); assert.equal(panel.dataset.active, undefined)
  assert.match(f.notice().textContent, /应用界面清理失败/)
  panel.dataset.failDispose = 'false'; f.find('close-application').click(); await f.settle()
  assert.equal(f.find('app-panel-agent'), panel); assert.equal(panel.testContext, context); assert.equal(panel.dataset.disposed, undefined)
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.settle()
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0); assert.equal(f.location.reloads, 0)
})

test('version activation freezes shell controls and route changes until all interfaces have exited', async t => {
  const preparing = deferred(); let posted = false, activationRequestId
  const f = await fixture(t, async (url, options) => {
    if (url.endsWith('/activations') && options.method === 'POST') { posted = true; activationRequestId = JSON.parse(options.body).requestId; return preparing.promise }
    if (url.endsWith('/commit')) {
      assert.equal(f.find('app-panel-agent').dataset.disposed, 'true'); assert.equal(f.find('app-panel-second-app').dataset.disposed, 'true')
      return Response.json(activationReceipt('completed', activationRequestId))
    }
    if (url.includes('/app-packages')) return Response.json(packageStatus())
    return Response.json([product('running'), secondProduct()])
  }, { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.waitFor(() => posted)
  assert.equal(f.find('application-panels').inert, true); assert.equal(f.find('close-application').disabled, true); assert.equal(f.find('stop-application').disabled, true); assert.equal(f.find('app-menu-second-app').disabled, true)
  const context = f.find('app-panel-agent').testContext; context.route.navigate('should-not-change')
  assert.equal(context.route.read(), 'saved')
  f.location.hash = '#/apps/second-app/should-not-change'; f.window.dispatch('hashchange'); await f.settle(); assert.equal(f.location.hash, '#/apps/agent/saved')
  assert.equal(f.find('app-panel-agent').dataset.disposed, undefined)
  preparing.resolve(Response.json(activationReceipt('prepared', activationRequestId))); await f.waitFor(() => f.location.reloads === 1)
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), workspaceTwoApplications)
  assert.equal(f.calls.filter(call => call.url.includes('/products/') && call.options.method === 'POST').length, 0)
})

test('a draft in another mounted application prevents version activation and preserves both panels', async t => {
  const f = await fixture(t, async url => Response.json(url.includes('/app-packages') ? packageStatus() : [product('running'), secondProduct()]), { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application'); const panel = f.find('app-panel-second-app'); panel.dataset.blockClose = 'true'
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.settle()
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.options.method === 'POST').length, 0)
  assert.equal(f.find('app-panel-second-app'), panel); assert.equal(panel.dataset.disposed, undefined); assert.equal(f.find('app-panel-agent').dataset.disposed, undefined)
  assert.equal(f.find('application-panels').inert, false); assert.match(f.find('application-manager').textContent, /保存所有已打开应用/)
  panel.dataset.blockClose = 'false'
})

test('failed interface disposal retains the shell fence and cannot request a process restart', async t => {
  let activationRequestId
  const f = await fixture(t, async (url, options) => {
    if (url.endsWith('/cancel')) return Response.json(activationReceipt('cancelled', activationRequestId))
    if (url.endsWith('/activations') && options.method === 'POST') { activationRequestId = JSON.parse(options.body).requestId; return Response.json(activationReceipt('prepared', activationRequestId)) }
    return Response.json(url.includes('/app-packages') ? packageStatus() : [product('running'), secondProduct()])
  }, { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application'); f.find('app-panel-agent').dataset.failDispose = 'true'
  await showPackageManager(f); packageButton(f, '应用更改').click(); await f.waitFor(() => f.calls.some(call => call.url.endsWith('/cancel'))); await f.settle()
  assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 0); assert.equal(f.location.reloads, 0)
  assert.equal(f.find('application-panels').inert, true); assert.equal(f.find('close-application').disabled, true)
  assert.equal(f.find('app-panel-second-app').dataset.disposed, 'true', 'another accepted disposal is joined even after one fails')
})

test('completed uninstall removes only its workspace view and replaces the active route before safe reload', async t => {
  const identity = { ...packageIdentity, appId: 'agent' }; let requestId
  const f = await fixture(t, async (url, options) => {
    if (url.endsWith('/activations') && options.method === 'POST') { const body = JSON.parse(options.body); requestId = body.requestId; assert.equal(body.kind, 'remove'); assert.deepEqual(body.appIds, ['agent']); return Response.json({ ...activationReceipt('prepared', requestId), kind: 'remove', targets: [{ identity }] }) }
    if (url.endsWith('/commit')) {
      assert.equal(f.find('app-panel-agent').dataset.disposed, 'true'); assert.equal(f.find('app-panel-second-app').dataset.disposed, 'true')
      return Response.json({ ...activationReceipt('completed', requestId), kind: 'remove', targets: [{ identity }, { identity: { ...identity, version: '0.9.0' } }] })
    }
    if (url.includes('/app-packages')) return Response.json({ ...packageStatus(), installations: [{ appId: 'agent', selected: identity, pending: null, installed: [{ identity, state: 'installed' }] }] })
    return Response.json([product('running'), secondProduct()])
  }, { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  f.find('show-applications').click(); await f.waitFor(() => packageButton(f, '卸载 agent') && !packageButton(f, '卸载 agent').disabled)
  packageButton(f, '卸载 agent').click(); await f.waitFor(() => f.location.reloads === 1)
  assert.equal(f.find('app-panel-agent'), null); assert.ok(f.find('app-panel-second-app'))
  assert.equal(f.location.hash, '#/apps/second-app/draft')
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [workspaceTwoApplications.tabs[1]], activeId: 'second-app' })
  assert.equal(f.calls.filter(call => call.url.includes('/products/') && call.options.method === 'POST').length, 0)
})

test('restart drops stale removed views from completed uninstall facts while preserving every other application', async t => {
  const identity = { ...packageIdentity, appId: 'second-app' }
  const f = await fixture(t, async url => {
    if (url.includes('/app-packages')) return Response.json({ ...packageStatus(), activations: [{ ...activationReceipt('completed'), kind: 'remove', targets: [{ identity }] }], installations: [{ appId: 'second-app', selected: null, pending: null, installed: [{ identity, state: 'removed' }] }] })
    return Response.json([product('running')])
  }, { workspace: workspaceTwoApplications })
  await f.settle(); assert.equal(f.find('app-panel-second-app'), null)
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), { tabs: [workspaceTwoApplications.tabs[0]], activeId: 'agent' })
  assert.ok(f.calls.every(call => call.options.method !== 'POST'))
})

test('changing host language updates its own labels and mounted app suggestions without lifecycle calls or mutations', async t => {
  const f = await fixture(t, async () => Response.json([product('running'), secondProduct()]), { workspace: workspaceTwoApplications })
  await f.waitFor(() => f.find('app-panel-second-app')?.textContent === 'Mounted application')
  const active = f.find('app-panel-agent'), hidden = f.find('app-panel-second-app')
  active.dataset.blockClose = 'true'; hidden.dataset.blockClose = 'true'
  const panels = [active, hidden]
  const original = panels.map(panel => ({ context: panel.testContext, mounts: panel.dataset.mounts, activations: panel.dataset.activations, closeChecks: panel.dataset.closeChecks }))
  const updates = [[], []]
  for (const [index, panel] of panels.entries()) {
    const context = panel.testContext.locale
    assert.equal(Object.isFrozen(context), true)
    assert.deepEqual(Object.keys(context).sort(), ['current', 'subscribe'])
    assert.equal(context.current().preferredLocale, 'zh-CN')
    context.subscribe(() => updates[index].push(context.current().preferredLocale))
  }
  active.testContext.locale.subscribe(() => { throw Error('controlled app listener failure') })
  const select = f.find('application-language'); select.focus(); select.value = 'en'; select.dispatch('change')
  await f.waitFor(() => f.state() === 'Running')
  assert.equal(f.find('show-applications').textContent, 'Manage apps')
  assert.equal(f.document.documentElement.getAttribute('lang'), 'en')
  assert.equal(f.preferences.get('anybox.preferences.locale.v1'), 'en')
  assert.equal(f.document.activeElement, select, 'language selection does not move keyboard focus')
  assert.deepEqual(updates, [['en'], ['en']], 'hidden mounted apps receive the same suggestion')
  for (const [index, panel] of panels.entries()) {
    assert.equal(f.find(panel.id), panel)
    assert.equal(panel.testContext, original[index].context)
    assert.equal(panel.testContext.signal.aborted, false)
    assert.equal(panel.dataset.mounts, original[index].mounts)
    assert.equal(panel.dataset.activations, original[index].activations)
    assert.equal(panel.dataset.closeChecks, original[index].closeChecks)
    assert.equal(panel.dataset.disposed, undefined)
    assert.equal(panel.textContent, 'Mounted application', 'the host does not translate or rebuild app content')
  }
  assert.deepEqual(JSON.parse(f.storage.get('anybox.apps.workspace.v1')), workspaceTwoApplications)
  assert.equal(f.location.reloads, 0)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
  active.dataset.blockClose = 'false'; hidden.dataset.blockClose = 'false'
})

test('a saved host preference applies before mount and another window can change it without a lifecycle restart', async t => {
  const f = await fixture(t, async () => Response.json([product('running')]), { localePreference: 'en', languages: ['zh-CN'] })
  assert.equal(f.state(), 'Running')
  const panel = f.find('app-panel-agent'), context = panel.testContext.locale
  assert.equal(context.current().preferredLocale, 'en')
  const activations = panel.dataset.activations
  f.preferences.set('anybox.preferences.locale.v1', 'zh-CN')
  f.window.dispatch('storage', { key: 'anybox.preferences.locale.v1', newValue: 'zh-CN', storageArea: globalThis.localStorage })
  await f.waitFor(() => f.state() === '运行中')
  assert.equal(f.find('application-language').value, 'zh-CN')
  assert.equal(context.current().preferredLocale, 'zh-CN')
  assert.equal(panel.dataset.activations, activations)
  assert.equal(panel.dataset.disposed, undefined)
  assert.equal(f.location.reloads, 0)
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readApplicationDirectory } from '../packages/host/dist/package-management/directory.js'
import { verifyApplicationDirectory, verifyApplicationPackage } from '../packages/host/dist/package-management/archive.js'
import { prepareApplicationArchive } from '../packages/host/dist/package-management/preparation.js'

const directory = fileURLToPath(new URL('./fixtures/host-test-app', import.meta.url))
const verification = { trustedPublishers: [], target: { os: 'darwin', arch: 'arm64' }, applicationApiVersion: '0.1.0', allowUnsignedLocal: true }
const storageKey = 'anybox.host-test.draft.v1'

test('the host test application is a complete locally trusted interface-only directory', async () => {
  const snapshot = await readApplicationDirectory(directory)
  assert.throws(() => verifyApplicationPackage(snapshot, { ...verification, allowUnsignedLocal: false }), { code: 'publisher-not-authorized' })
  const verified = verifyApplicationPackage(snapshot, verification)
  assert.equal(verified.identity.appId, 'host-test')
  assert.equal(verified.signature, null)
  assert.equal(verified.manifest.entries, undefined)
  assert.equal(verified.manifest.runtimeRequirements, undefined)
  assert.equal(verified.manifest.capabilityRequirements, undefined)
  const prepared = await prepareApplicationArchive(verified)
  assert.deepEqual(prepared.roles, { web: { status: 'prepared', reasons: [] } })
  assert.equal(prepared.web.entry, '/apps/host-test/0.1.0/app.js')
  assert.deepEqual(prepared.web.styles, ['/apps/host-test/0.1.0/style.css'])
  assert.deepEqual(prepared.web.assets.map(asset => asset.file).sort(), ['payload/web/app.js', 'payload/web/style.css'])

  // The installable fixture must keep its stylesheet in the actual verified resource graph.
  const entries = verified.metadataPaths.filter(path => path !== 'files.json').map(path => ({ path, bytes: verified.readFile(path) }))
    .concat(verified.files.map(file => ({ path: file.path, bytes: verified.readFile(file.path), mode: file.mode })))
  const assetIndex = entries.find(entry => entry.path === 'payload/assets.json')
  const assets = JSON.parse(Buffer.from(assetIndex.bytes).toString())
  assets.assets = assets.assets.filter(asset => !asset.file.endsWith('.css'))
  assetIndex.bytes = Buffer.from(JSON.stringify(assets))
  await assert.rejects(prepareApplicationArchive(verifyApplicationDirectory(entries, verification)), { code: 'package-web-style-invalid' })
})

function applicationDocument() {
  const document = { activeElement: undefined }
  const element = tag => {
    let ownText = ''
    const node = { tagName: tag, id: '', className: '', children: [], parentElement: undefined, attributes: {}, dataset: {}, value: '', disabled: false, hidden: false, listeners: new Map(),
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } },
      replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; ownText = ''; this.append(...children) },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      addEventListener(type, listener) { const current = this.listeners.get(type) ?? new Set(); current.add(listener); this.listeners.set(type, current) },
      removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) },
      dispatch(type, data = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this, preventDefault() {}, ...data }) },
      click() { if (!this.disabled) this.dispatch('click') },
      focus() { document.activeElement = this },
    }
    node.classList = { add(...names) { node.className = [node.className, ...names].filter(Boolean).join(' ') } }
    Object.defineProperty(node, 'textContent', { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { node.replaceChildren(); ownText = String(value) } })
    return node
  }
  document.createElement = element
  document.createTextNode = text => { const node = element('#text'); node.textContent = text; return node }
  return document
}

async function fixture(t, options = {}) {
  const previous = new Map(), storage = options.storage ?? new Map(), timers = new Map(), intervals = new Map()
  let nextTimer = 0, route = '/interaction', writesBlocked = options.writesBlocked ?? false
  const routeListeners = new Set(), controller = new AbortController(), document = applicationDocument()
  const signalListeners = new Set()
  const originalAdd = controller.signal.addEventListener.bind(controller.signal), originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') signalListeners.add(listener); originalAdd(type, listener, options) }
  controller.signal.removeEventListener = (type, listener) => { if (type === 'abort') signalListeners.delete(listener); originalRemove(type, listener) }
  for (const [key, value] of Object.entries({ document,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { if (writesBlocked) throw new Error('storage denied'); storage.set(key, value) } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }, clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id }, clearInterval: id => intervals.delete(id),
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const source = await readFile(new URL('./fixtures/host-test-app/payload/web/app.js', import.meta.url))
  const application = await import(`data:text/javascript;base64,${source.toString('base64')}`)
  const container = document.createElement('div')
  const context = { appId: 'host-test', signal: controller.signal, domId: local => `host-test-${local}`, route: {
    read: () => route,
    navigate(value) { route = value; for (const listener of routeListeners) listener() },
    subscribe(listener) { routeListeners.add(listener); return () => routeListeners.delete(listener) },
  } }
  const mounted = await application.mount(container, context), mounts = [mounted]
  const all = node => [node, ...node.children.flatMap(all)]
  const find = predicate => all(container).find(predicate)
  const button = label => find(node => node.tagName === 'button' && node.textContent === label)
  t.after(async () => {
    for (const mount of mounts) await mount.dispose()
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  })
  return { container, mounted, document, context, storage, timers, intervals, routeListeners, signalListeners, controller, find, button,
    draft: find(node => node.tagName === 'textarea'), counter: find(node => node.getAttribute('aria-label') === '当前计数'),
    blockWrites(value) { writesBlocked = value },
    async remount() { const next = await application.mount(container, context); mounts.push(next); return next },
    async settle() { await Promise.resolve(); await Promise.resolve() },
    finishTask() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; assert.equal(timer.delay, 5000); timers.delete(id); timer.callback() },
    tick() { for (const interval of intervals.values()) { assert.equal(interval.delay, 1000); interval.callback() } },
    listeners: () => all(container).flatMap(node => [...node.listeners.values()]).reduce((total, listeners) => total + listeners.size, 0),
  }
}

test('draft protection survives a failed save and only a successful save is restored on remount', async t => {
  const storage = new Map([[storageKey, 'saved value']])
  const f = await fixture(t, { storage, writesBlocked: true })
  assert.equal(f.draft.value, 'saved value'); assert.equal(f.mounted.canClose(), true)
  f.draft.value = 'private unsaved value'; f.draft.dispatch('input')
  assert.equal(f.mounted.canClose(), false)
  f.button('保存草稿').click()
  assert.equal(storage.get(storageKey), 'saved value'); assert.equal(f.mounted.canClose(), false)
  assert.match(f.container.textContent, /保存失败/)
  assert.doesNotMatch(f.find(node => node.tagName === 'ol').textContent, /private unsaved value/)
  f.button('放弃修改').click()
  assert.equal(f.draft.value, 'saved value'); assert.equal(f.mounted.canClose(), true)
  f.draft.value = 'new saved value'; f.draft.dispatch('input'); f.blockWrites(false); f.button('保存草稿').click()
  assert.equal(storage.get(storageKey), 'new saved value'); assert.equal(f.mounted.canClose(), true)
  await f.mounted.dispose()
  const remount = await f.remount()
  assert.equal(f.find(node => node.tagName === 'textarea').value, 'new saved value'); assert.equal(remount.canClose(), true)
})

test('a simulated task protects closing and both cancellation and actual completion release its timer', async t => {
  const f = await fixture(t)
  assert.equal(f.button('取消任务').disabled, true)
  f.button('启动 5 秒任务').click()
  assert.equal(f.timers.size, 1); assert.equal(f.mounted.canClose(), false)
  assert.equal(f.button('启动 5 秒任务').disabled, true)
  f.button('启动 5 秒任务').click(); assert.equal(f.timers.size, 1)
  f.mounted.setActive(false, 'select')
  assert.equal(f.mounted.canClose(), false, 'a hidden application still owns its task')
  f.button('取消任务').click(); await f.settle()
  assert.equal(f.timers.size, 0); assert.equal(f.mounted.canClose(), true)
  assert.match(f.container.textContent, /已取消/)
  f.button('启动 5 秒任务').click(); f.finishTask(); await f.settle()
  assert.equal(f.timers.size, 0); assert.equal(f.mounted.canClose(), true)
  assert.match(f.container.textContent, /已完成/)
})

test('routes and activation retain mounted state while dispose joins all application resources exactly once', async t => {
  const f = await fixture(t)
  f.button('加一').click(); f.button('加一').click()
  f.mounted.setActive(true, 'open'); f.mounted.setActive(true, 'select')
  assert.equal(f.intervals.size, 1); f.tick()
  f.button('生命周期').click()
  assert.equal(f.context.route.read(), '/lifecycle')
  assert.equal(f.button('生命周期').getAttribute('aria-selected'), 'true')
  assert.match(f.container.textContent, /1 秒/)
  f.mounted.setActive(false, 'select'); assert.equal(f.intervals.size, 0)
  f.button('交互测试').click(); assert.equal(f.counter.textContent, '2')
  f.document.activeElement = f.button('交互测试')
  f.find(node => node.getAttribute('role') === 'tablist').dispatch('keydown', { key: 'End' })
  assert.equal(f.context.route.read(), '/lifecycle')
  assert.equal(f.document.activeElement, f.button('生命周期'))
  f.mounted.setActive(true, 'restore'); f.button('启动 5 秒任务').click()
  const oldCounter = f.counter, oldIncrement = f.button('加一'), oldRoute = f.context.route.read()
  const oldNodes = []
  const collect = node => { oldNodes.push(node); node.children.forEach(collect) }; collect(f.container)
  assert.equal(f.routeListeners.size, 1); assert.equal(f.signalListeners.size, 1); assert.ok(f.listeners() > 0)
  const disposal = f.mounted.dispose()
  assert.equal(f.mounted.dispose(), disposal)
  await disposal
  assert.equal(f.routeListeners.size, 0); assert.equal(f.signalListeners.size, 0)
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.deepEqual(f.container.children, [])
  assert.ok(oldNodes.every(node => [...node.listeners.values()].every(listeners => listeners.size === 0)))
  oldIncrement.click(); assert.equal(oldCounter.textContent, '2')
  f.mounted.setActive(true, 'open'); assert.equal(f.intervals.size, 0)
  f.context.route.navigate('/interaction'); assert.equal(f.routeListeners.size, 0)
  assert.equal(oldRoute, '/lifecycle'); assert.equal(f.mounted.canClose(), true)
})

test('host cancellation actually disposes the mounted interface and its active task', async t => {
  const f = await fixture(t)
  f.mounted.setActive(true, 'open'); f.button('启动 5 秒任务').click()
  f.controller.abort(); await f.mounted.dispose()
  assert.deepEqual(f.container.children, [])
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0)
  assert.equal(f.routeListeners.size, 0); assert.equal(f.signalListeners.size, 0)
})

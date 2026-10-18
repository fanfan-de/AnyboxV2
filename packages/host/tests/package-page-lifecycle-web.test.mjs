import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupPackagePageLifecycle } from '../dist/web/page-lifecycle.js'
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(t, input = {}) {
  let controller, disconnect, status = { phase: 'loading', roles: [{ role: 'client', ready: false }] }, reloaded = 0
  const calls = [], connections = [], reloads = [], encoder = new TextEncoder()
  const prepare = input.prepare ?? (async () => ({ check() {}, async disposeForRestart() {}, release() {} }))
  const view = setupPackagePageLifecycle({ prepare, pageId: 'browser-page', pollMs: input.pollMs ?? 0, connection: (...args) => connections.push(args), reload(ids) { reloaded++; reloads.push(ids) }, async fetch(url, options = {}) {
    calls.push({ url, options })
    if (url.endsWith('/events')) {
      let streamClosed = false
      const drop = input.dropFirstConnected && calls.filter(call => call.url.endsWith('/events')).length === 1
      const stream = new ReadableStream({ start(value) { controller = value; disconnect = () => { streamClosed = true; value.close() }; if (drop) { disconnect(); return }; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ action: 'connected', registrationId: options.headers['X-Anybox-Page-Registration'] })}\n\n`)); options.signal.addEventListener('abort', () => { if (!streamClosed) { streamClosed = true; value.error(new DOMException('aborted', 'AbortError')) } }, { once: true }) }, cancel() { streamClosed = true } })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.endsWith('/ack')) return Response.json({ ok: true })
    if (url.endsWith('/exit')) return Response.json({ ok: input.exitStatus === undefined }, { status: input.exitStatus ?? 200 })
    if (url.includes('/activations/')) return Response.json(status)
    return Response.json({ browserLifecycleAvailable: input.available !== false })
  } })
  t.after(() => view.dispose().catch(() => {}))
  return { view, calls, connections, reloads, get registrationId() { return calls.find(call => call.url.endsWith('/events'))?.options.headers['X-Anybox-Page-Registration'] }, get reloaded() { return reloaded }, setStatus(value) { status = value }, event(value) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) }, disconnect() { disconnect() }, acks: () => calls.filter(call => call.url.endsWith('/ack')).map(call => JSON.parse(call.options.body)) }
}

test('every registered page handles lifetime guards even when its package management panel is closed', async t => {
  const actions = [], f = fixture(t, { prepare: async () => ({ check() { actions.push('guard') }, async disposeForRestart() { actions.push('dispose') }, release() { actions.push('release') } }) })
  await f.view.ready; assert.equal(f.view.registered, true); assert.deepEqual(f.connections.at(-1), [true, true])
  f.event({ activationId: 'activation-1', action: 'freeze' }); await flush()
  assert.deepEqual(actions, ['guard']); assert.deepEqual(f.acks(), [{ registrationId: f.registrationId, activationId: 'activation-1', action: 'freeze', ok: true }])
  f.event({ activationId: 'activation-1', action: 'release' }); await flush(); assert.deepEqual(actions, ['guard', 'release'])
})

test('a page acknowledges disposal only after its actual interface cleanup has exited', async t => {
  const exit = deferred(), actions = [], f = fixture(t, { prepare: async () => ({ check() {}, async disposeForRestart() { actions.push('start'); await exit.promise; actions.push('exit') }, release() {} }) })
  await f.view.ready; f.event({ activationId: 'activation-1', action: 'freeze' }); await flush()
  f.event({ activationId: 'activation-1', action: 'dispose' }); await flush(); assert.deepEqual(actions, ['start']); assert.equal(f.acks().length, 1)
  exit.resolve(); await flush(); assert.deepEqual(actions, ['start', 'exit']); assert.deepEqual(f.acks().at(-1), { registrationId: f.registrationId, activationId: 'activation-1', action: 'dispose', ok: true })
})

test('a draft on another page negatively acknowledges freeze and never grants interface disposal', async t => {
  const f = fixture(t, { prepare: async () => { throw { code: 'application-interface-blocked' } } })
  await f.view.ready; f.event({ activationId: 'activation-1', action: 'freeze' }); await flush()
  assert.deepEqual(f.acks(), [{ registrationId: f.registrationId, activationId: 'activation-1', action: 'freeze', ok: false }])
  f.event({ activationId: 'activation-1', action: 'dispose' }); await flush(); assert.equal(f.acks().at(-1).ok, false)
})

test('an SSE disconnect keeps the page protected and observes its original activation through reconnect', async t => {
  let released = 0
  const f = fixture(t, { prepare: async () => ({ check() {}, async disposeForRestart() {}, release() { released++ } }) })
  await f.view.ready; f.event({ activationId: 'activation-1', action: 'freeze' }); await flush(); f.event({ activationId: 'activation-1', action: 'dispose' }); await flush()
  f.disconnect(); await flush(); assert.deepEqual(f.connections.at(-1), [true, false]); assert.equal(released, 0)
  await f.view.refresh(); assert.equal(f.reloaded, 0)
  f.setStatus({ phase: 'completed', roles: [{ role: 'client', ready: false }] }); await f.view.refresh(); assert.equal(f.reloaded, 0)
  f.setStatus({ phase: 'completed', roles: [{ role: 'client', ready: true }] }); await f.view.refresh(); assert.equal(f.reloaded, 1)
  assert.ok(f.calls.every(call => call.options.method !== 'POST' || call.url.endsWith('/ack')), 'a secondary page never starts or repeats activation')
})

test('hosts without lifecycle coordination do not establish a page stream or retain the registration fence', async t => {
  const f = fixture(t, { available: false })
  await f.view.ready; assert.deepEqual(f.connections, [[false, false]])
  assert.equal(f.calls.filter(call => call.url.endsWith('/events')).length, 0)
})

test('a stream disconnected before any activation reconnects the same registration and still checks drafts', async t => {
  const f = fixture(t, { pollMs: 1, prepare: async () => { throw { code: 'application-interface-blocked' } } })
  await f.view.ready; f.disconnect(); await flush()
  for (let attempt = 0; attempt < 100 && f.calls.filter(call => call.url.endsWith('/events')).length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  await flush()
  const streams = f.calls.filter(call => call.url.endsWith('/events'))
  assert.equal(streams.length, 2); assert.equal(streams[1].options.headers['X-Anybox-Page-Registration'], f.registrationId)
  assert.equal(f.view.registered, true)
  f.event({ activationId: 'activation-1', action: 'freeze' }); await flush()
  assert.deepEqual(f.acks(), [{ registrationId: f.registrationId, activationId: 'activation-1', action: 'freeze', ok: false }])
})

test('the document knows its registration before receiving the first connected event', { timeout: 5000 }, async t => {
  const f = fixture(t, { pollMs: 1, dropFirstConnected: true })
  await f.view.ready
  const streams = f.calls.filter(call => call.url.endsWith('/events'))
  assert.equal(streams.length, 2)
  assert.equal(typeof streams[0].options.headers['X-Anybox-Page-Registration'], 'string')
  assert.equal(streams[0].options.headers['X-Anybox-Page-Registration'], streams[1].options.headers['X-Anybox-Page-Registration'])
  assert.equal(f.view.registered, true)
})

test('closing only the observer never submits an interface exit proof', async t => {
  const f = fixture(t); await f.view.ready; await f.view.dispose()
  assert.equal(f.calls.filter(call => call.url.endsWith('/exit')).length, 0)
})

test('confirmed interface cleanup exits using its registration after the observer has stopped', async t => {
  const f = fixture(t); await f.view.ready; await f.view.dispose({ interfacesExited: true })
  const exits = f.calls.filter(call => call.url.endsWith('/exit'))
  assert.equal(exits.length, 1); assert.deepEqual(JSON.parse(exits[0].options.body), { registrationId: f.registrationId, interfacesExited: true })
  assert.equal(exits[0].options.keepalive, true); assert.equal(exits[0].options.signal, undefined)
  assert.equal(f.calls.find(call => call.url.endsWith('/events')).options.signal.aborted, true)
  await f.view.dispose({ interfacesExited: true }); assert.equal(f.calls.filter(call => call.url.endsWith('/exit')).length, 1)
})

test('a delayed page registration exits before its independent interface exit request is sent', async t => {
  const started = deferred(), release = deferred(), actions = []
  let registrationId, observerSignal
  const view = setupPackagePageLifecycle({ prepare: async () => { throw Error('unexpected guard') }, pageId: 'browser-page', pollMs: 0, connection() {}, reload() {}, async fetch(url, options = {}) {
    if (url.endsWith('/events')) {
      registrationId = options.headers['X-Anybox-Page-Registration']; observerSignal = options.signal; started.resolve()
      await release.promise; actions.push('registered')
      return new Response(new ReadableStream({ cancel() { actions.push('observer-exited') } }))
    }
    if (url.endsWith('/exit')) {
      actions.push('exit')
      assert.equal(observerSignal.aborted, true)
      assert.equal(options.signal, undefined)
      assert.deepEqual(JSON.parse(options.body), { registrationId, interfacesExited: true })
      assert.deepEqual(actions, ['registered', 'observer-exited', 'exit'])
      return Response.json({ ok: true })
    }
    return Response.json({ browserLifecycleAvailable: true })
  } })
  t.after(() => { release.resolve(); return view.dispose() })
  await started.promise
  const disposal = view.dispose({ interfacesExited: true })
  await flush(); assert.deepEqual(actions, [])
  release.resolve(); await disposal; assert.deepEqual(actions, ['registered', 'observer-exited', 'exit'])
})

test('a failed explicit page exit stays unconfirmed for the controlled reload caller', async t => {
  const f = fixture(t, { exitStatus: 503 }); await f.view.ready
  await assert.rejects(f.view.dispose({ interfacesExited: true }), /page exit unconfirmed/)
  assert.equal(f.view.registered, false)
})

test('all pages retain app positions until the same uninstall batch confirms reclamation and actual role readiness', async t => {
  const f = fixture(t); await f.view.ready
  f.event({ activationId: 'remove-1', action: 'freeze' }); await flush(); f.event({ activationId: 'remove-1', action: 'dispose' }); await flush()
  const value = { kind: 'remove', targets: [{ identity: { appId: 'notes' } }, { identity: { appId: 'notes' } }], roles: [{ role: 'client', ready: true }] }
  for (const phase of ['loading', 'reclaiming', 'recovery-required']) { f.setStatus({ ...value, phase }); await f.view.refresh(); assert.equal(f.reloaded, 0) }
  f.setStatus({ ...value, phase: 'completed' }); await f.view.refresh(); assert.deepEqual(f.reloads, [['notes']])
  assert.ok(f.calls.filter(call => call.url.includes('/activations/')).every(call => call.url.endsWith('/remove-1')))
})

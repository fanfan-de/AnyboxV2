import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createPackagePageLifecycle } from '../dist/package-management/page-lifecycle.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, options) {
  const registrations = new Map(); let pages = createPackagePageLifecycle(options), origin
  const server = createServer((request, response) => { void pages.handle(request, response, new URL(request.url, origin), { signal: options?.signal }).then(handled => { if (!handled) { response.statusCode = 404; response.end() } }, error => { response.statusCode = error.status ?? 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: { code: error.code ?? 'internal' } })) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await pages.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  async function open(id, registrationId = registrations.get(id), observe = true) {
    const response = await fetch(`${origin}/api/client/v1/app-packages/pages/${id}/events`, { headers: registrationId ? { 'X-Anybox-Page-Registration': registrationId } : {} })
    if (!response.ok) return { response }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
    if (!observe) return { response, close: () => reader.cancel() }
    async function event() { while (!buffer.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value) }; const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); return JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)) }
    const connected = await event(); assert.equal(connected.action, 'connected'); assert.equal(typeof connected.registrationId, 'string'); registrations.set(id, connected.registrationId)
    return { response, registrationId: connected.registrationId, event, read: () => reader.read(), close: () => reader.cancel() }
  }
  async function ack(id, activationId, action, ok, registrationId = registrations.get(id) ?? 'missing-registration') { const response = await fetch(`${origin}/api/client/v1/app-packages/pages/${id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId, activationId, action, ok }) }); return { status: response.status, data: await response.json() } }
  async function exit(id, registrationId = registrations.get(id), interfacesExited = true) { const response = await fetch(`${origin}/api/client/v1/app-packages/pages/${id}/exit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId, interfacesExited }) }); return response.status }
  return { get pages() { return pages }, open, ack, exit, async restart() { await pages.close(); pages = createPackagePageLifecycle(options) } }
}

test('all same-origin pages must freeze and then acknowledge actual disposal before handoff', async t => {
  const f = await fixture(t), first = await f.open('first'), second = await f.open('second')
  let frozen = false; const freezing = f.pages.freeze('activation-1').then(() => { frozen = true })
  assert.deepEqual(await first.event(), { activationId: 'activation-1', action: 'freeze' }); assert.deepEqual(await second.event(), { activationId: 'activation-1', action: 'freeze' })
  assert.equal((await f.ack('first', 'activation-1', 'freeze', true)).status, 200); await tick(); assert.equal(frozen, false)
  await f.ack('second', 'activation-1', 'freeze', true); await freezing; assert.equal(frozen, true)
  assert.equal((await f.open('new-page')).response.status, 503)
  let exited = false; const disposal = f.pages.dispose('activation-1').then(() => { exited = true })
  assert.equal((await first.event()).action, 'dispose'); assert.equal((await second.event()).action, 'dispose')
  await f.ack('first', 'activation-1', 'dispose', true); await tick(); assert.equal(exited, false)
  await f.ack('second', 'activation-1', 'dispose', true); await disposal; assert.equal(exited, true)
  f.pages.release('activation-1'); assert.equal((await first.event()).action, 'release')
})

test('a draft in any other page blocks the activation and release preserves all intact pages', async t => {
  const f = await fixture(t), first = await f.open('first'), second = await f.open('second')
  const result = f.pages.freeze('activation-1'); const rejected = assert.rejects(result, { code: 'activation-browser-busy' })
  await first.event(); await second.event(); await f.ack('first', 'activation-1', 'freeze', true); await f.ack('second', 'activation-1', 'freeze', false); await rejected
  await assert.rejects(f.pages.dispose('activation-1'), { code: 'activation-browser-stale' })
  f.pages.release('activation-1'); assert.equal((await first.event()).action, 'release'); assert.equal((await second.event()).action, 'release')
  assert.equal((await f.open('third')).response.status, 200)
})

test('a disconnected page after a successful freeze is not proof that its interface resources exited', async t => {
  const f = await fixture(t), page = await f.open('first'), freezing = f.pages.freeze('activation-1')
  await page.event(); await f.ack('first', 'activation-1', 'freeze', true); await freezing
  await page.close(); await tick(); await tick()
  await assert.rejects(f.pages.dispose('activation-1'), error => ['activation-browser-stale', 'activation-browser-unavailable', 'activation-browser-exit-unconfirmed'].includes(error.code))
  assert.equal((await f.open('replacement')).response.status, 503)
  f.pages.release('activation-1')
})

test('a stream disconnected before freeze remains an unknown page and only its registration can reconnect', async t => {
  const f = await fixture(t), page = await f.open('first')
  await page.close(); await tick(); await tick()
  await assert.rejects(f.pages.freeze('activation-1'), { code: 'activation-browser-unavailable' })
  await assert.rejects(f.pages.dispose('activation-1'), { code: 'activation-browser-stale' })
  f.pages.release('activation-1')
  assert.equal((await f.open('first', 'different-document')).response.status, 409)
  assert.equal(await f.exit('first', 'different-document'), 409)
  const reconnect = await f.open('first'); assert.equal(reconnect.registrationId, page.registrationId)
  const freezing = f.pages.freeze('activation-2'), rejected = assert.rejects(freezing, { code: 'activation-browser-busy' })
  assert.equal((await reconnect.event()).action, 'freeze')
  await f.ack('first', 'activation-2', 'freeze', false); await rejected
  f.pages.release('activation-2')
})

test('the original document can reconnect when its first connected event was never consumed', async t => {
  const f = await fixture(t), registrationId = 'document-memory-registration', unobserved = await f.open('first', registrationId, false)
  await unobserved.close(); await tick(); await tick()
  await assert.rejects(f.pages.freeze('activation-1'), { code: 'activation-browser-unavailable' }); f.pages.release('activation-1')
  assert.equal((await f.open('first', 'different-document')).response.status, 409)
  const reconnect = await f.open('first', registrationId)
  assert.equal(reconnect.registrationId, registrationId)
  const freezing = f.pages.freeze('activation-2'), rejected = assert.rejects(freezing, { code: 'activation-browser-busy' })
  await reconnect.event(); await f.ack('first', 'activation-2', 'freeze', false); await rejected
  f.pages.release('activation-2')
})

test('only an explicit actual interface exit unregisters a disconnected page, and retries are idempotent', async t => {
  const f = await fixture(t), page = await f.open('first')
  await page.close(); await tick(); await tick()
  assert.equal(await f.exit('first', page.registrationId, false), 400)
  await assert.rejects(f.pages.freeze('activation-1'), { code: 'activation-browser-unavailable' }); f.pages.release('activation-1')
  assert.equal(await f.exit('first'), 200); assert.equal(await f.exit('first'), 200)
  await f.pages.freeze('activation-2'); await f.pages.dispose('activation-2'); f.pages.release('activation-2')
  const replacement = await f.open('first', 'new-document-registration'); assert.notEqual(replacement.registrationId, page.registrationId)
  assert.equal(await f.exit('first', page.registrationId), 409)
  const freezing = f.pages.freeze('activation-3'); await replacement.event(); await f.ack('first', 'activation-3', 'freeze', true); await freezing
  f.pages.release('activation-3')
})

test('a replaced coordinator accepts the old page exit without deleting a new document registration', async t => {
  const f = await fixture(t), old = await f.open('first')
  await f.restart(); assert.equal((await old.read()).done, true)
  assert.equal(await f.exit('first', old.registrationId), 200)
  const current = await f.open('first', 'new-document-registration'); assert.notEqual(current.registrationId, old.registrationId)
  assert.equal(await f.exit('first', old.registrationId), 409)
  const freezing = f.pages.freeze('activation-1'), rejected = assert.rejects(freezing, { code: 'activation-browser-busy' })
  assert.equal((await current.event()).action, 'freeze'); await f.ack('first', 'activation-1', 'freeze', false); await rejected
  f.pages.release('activation-1')
})

test('an exit received before its delayed GET permanently rejects that registration for this coordinator', async t => {
  const f = await fixture(t), registrationId = 'late-document-registration'
  assert.equal(await f.exit('first', registrationId), 200)
  assert.equal(await f.exit('first', registrationId), 200)
  assert.equal((await f.open('first', registrationId)).response.status, 409)
  await f.pages.freeze('activation-1'); await f.pages.dispose('activation-1'); f.pages.release('activation-1')
  assert.equal((await f.open('first', registrationId)).response.status, 409)
  const current = await f.open('first', 'new-document-registration')
  assert.equal(current.response.status, 200)
  assert.equal(await f.exit('first', registrationId), 409)
  const freezing = f.pages.freeze('activation-2'), rejected = assert.rejects(freezing, { code: 'activation-browser-busy' })
  await current.event(); await f.ack('first', 'activation-2', 'freeze', false); await rejected
  f.pages.release('activation-2')
})

test('a confirmed page exit during either guard round supplies actual cleanup proof before disconnect', async t => {
  for (const action of ['freeze', 'dispose']) {
    const f = await fixture(t), page = await f.open('first'), freezing = f.pages.freeze('activation-1')
    await page.event()
    if (action === 'dispose') { await f.ack('first', 'activation-1', 'freeze', true); await freezing }
    const pending = action === 'dispose' ? f.pages.dispose('activation-1') : freezing
    if (action === 'dispose') await page.event()
    assert.equal(await f.exit('first'), 200); await pending
    if (action === 'freeze') await f.pages.dispose('activation-1')
    f.pages.release('activation-1')
  }
})

test('disconnecting after positive disposal proof does not invalidate an already confirmed exit', async t => {
  const f = await fixture(t), page = await f.open('first'), freezing = f.pages.freeze('activation-1')
  await page.event(); await f.ack('first', 'activation-1', 'freeze', true); await freezing
  const disposal = f.pages.dispose('activation-1'); await page.event(); await f.ack('first', 'activation-1', 'dispose', true); await disposal
  await page.close(); await tick(); await tick(); await f.pages.dispose('activation-1')
  f.pages.release('activation-1')
  await assert.rejects(f.pages.freeze('activation-2'), { code: 'activation-browser-unavailable' })
})

test('disconnecting during disposal reports unconfirmed exit and never releases the activation fence', async t => {
  const f = await fixture(t), page = await f.open('first'), freezing = f.pages.freeze('activation-1')
  await page.event(); await f.ack('first', 'activation-1', 'freeze', true); await freezing
  const disposal = f.pages.dispose('activation-1'), rejected = assert.rejects(disposal, { code: 'activation-browser-exit-unconfirmed' })
  await page.event(); await page.close(); await rejected
  assert.equal((await f.open('replacement')).response.status, 503)
})

test('a disposal timeout reports uncertainty without treating time as an exit proof', async t => {
  const f = await fixture(t, { timeoutMs: 25 }), page = await f.open('first'), freezing = f.pages.freeze('activation-1')
  await page.event(); await f.ack('first', 'activation-1', 'freeze', true); await freezing
  await assert.rejects(f.pages.dispose('activation-1'), { code: 'activation-browser-exit-unconfirmed' })
  assert.equal((await f.open('replacement')).response.status, 503)
  f.pages.release('activation-1')
})

test('stale acknowledgements, duplicate page ownership and overlapping activations cannot grant readiness', async t => {
  const f = await fixture(t), page = await f.open('first')
  assert.equal((await f.open('first')).response.status, 409)
  const freezing = f.pages.freeze('activation-1'); await page.event()
  await assert.rejects(f.pages.freeze('activation-2'), { code: 'activation-browser-busy' })
  assert.equal((await f.ack('first', 'other-activation', 'freeze', true)).status, 409)
  assert.equal((await f.ack('missing-page', 'activation-1', 'freeze', true)).status, 409)
  await f.ack('first', 'activation-1', 'freeze', true); await freezing
  assert.equal((await f.ack('first', 'activation-1', 'dispose', true)).status, 409)
})

test('the HTTP listener lifetime ends registered SSE transports without waiting for the page component Effect', async t => {
  const lifetime = new AbortController(), f = await fixture(t, { signal: lifetime.signal }), page = await f.open('first')
  lifetime.abort(); assert.equal((await page.read()).done, true)
  assert.equal((await f.open('late-page')).response.status, 503)
})

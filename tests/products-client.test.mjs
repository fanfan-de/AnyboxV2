import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPageRequests } from '../dist/applications/harness/web/page-lifecycle.js'
import { createHarnessClient, scopedId, connectionResourceURL } from '../dist/applications/harness/web/harness-client.js'
import { openChangeStream } from '../dist/applications/harness/web/event-stream.js'
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const connection = (instanceId, id = instanceId) => ({ instanceId, id, revision: 4, name: id })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('page disposal aborts reads, waits submitted writes, rejects stale results and prevents further work', async () => {
  const calls = []
  const page = createPageRequests((path, body, signal) => new Promise((resolve, reject) => {
    calls.push({ path, body, signal, resolve }); signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  const read = page.api('/read'), write = page.api('/write', { value: 'saved' })
  const settled = Promise.allSettled([read, write]); await tick()
  let finished = false; const close = page.dispose().then(() => { finished = true })
  await tick(); assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].signal.aborted, false); assert.equal(finished, false)
  await assert.rejects(page.api('/too-late'), { name: 'AbortError' }); assert.equal(calls.length, 2)
  calls[1].resolve({ saved: true }); await close
  assert.equal(finished, true); assert.ok((await settled).every(value => value.status === 'rejected'), 'old page must not render late success')
})

test('product business reads, writes and image resources retain captured connection revision and product identity', async t => {
  const calls = [], input = connection(a, 'local')
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'session' }) })
  const api = createHarnessClient([input], input.id, 'my-product')
  input.revision = 99; input.instanceId = b
  await api.forConnection('local')('/models')
  await api(`/sessions/${scopedId(a, 'session')}/runs`, { parentNodeId: null, input: 'hello' })
  for (const call of calls) {
    assert.equal(call.options.headers['X-Anybox-Product-Id'], 'my-product')
    assert.equal(call.options.headers['X-Anybox-Expected-Instance-Id'], a)
    assert.equal(call.options.headers['X-Anybox-Connection-Revision'], '4')
  }
  const image = new URL(connectionResourceURL(scopedId(a, 'session'), `/sessions/${scopedId(a, 'session')}/images/${scopedId(a, 'image')}/content`), 'http://local')
  assert.equal(image.searchParams.get('__anyboxProductId'), 'my-product'); assert.equal(image.searchParams.get('__anyboxConnectionRevision'), '4')
  await api.dispose()
})

test('business client disposal waits accepted writes without sending cancellation to the backend', async t => {
  let resolve, signal
  t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return new Promise(done => { resolve = done }) })
  const api = createHarnessClient([connection(a)], a, 'custom')
  const writing = api.forConnection(a)('/models/connections', { name: 'saved' })
  let disposed = false; const close = api.dispose().then(() => { disposed = true })
  await tick(); assert.equal(signal.aborted, false); assert.equal(disposed, false)
  resolve(Response.json({ id: 'connection' })); await writing; await close
  assert.equal(disposed, true)
})

test('SSE uses product headers, supports fragmented frames and closes its owned stream', async t => {
  let stream, signal, sentHeaders, cancelled = false
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal; sentHeaders = options.headers
    return new Response(new ReadableStream({ start(controller) { stream = controller; signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))) }, cancel() { cancelled = true } }))
  })
  const events = [], headers = { 'X-Anybox-Product-Id': 'custom' }
  const connection = openChangeStream('/changes', headers, { ready: () => events.push('ready'), change: data => events.push(data), view: data => events.push(data), error: () => events.push('error') })
  await tick(); const encoder = new TextEncoder()
  stream.enqueue(encoder.encode('event: ready\ndata: {}\n\nevent: run-changed\nda'))
  stream.enqueue(encoder.encode('ta: {"revision":2}\n\n'))
  await tick(); assert.deepEqual(events, ['ready', '{"revision":2}']); assert.equal(sentHeaders, headers)
  connection.close(); await tick(); assert.equal(signal.aborted, true); assert.deepEqual(events, ['ready', '{"revision":2}'])
})

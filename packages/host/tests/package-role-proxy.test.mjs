import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { startManagedRoleProxy } from '../dist/package-management/role-proxy.js'
import { createPackagePageLifecycle } from '../dist/package-management/page-lifecycle.js'

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function backend(t, handler) {
  const sockets = new Set(), server = createServer(handler)
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await done })
  return { url: `http://127.0.0.1:${server.address().port}`, server }
}
async function request(url, { method = 'GET', headers = {}, path, body } = {}) {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const client = httpRequest({ hostname: target.hostname, port: target.port, path: path ?? target.pathname + target.search, method, headers: { host: target.host, ...(method !== 'GET' && method !== 'HEAD' ? { origin: target.origin } : {}), ...headers }, agent: false }, async response => {
      const chunks = []; for await (const chunk of response) chunks.push(chunk)
      resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') })
    }); client.once('error', reject); client.end(body)
  })
}
async function proxy(t, target = () => undefined) {
  const front = await startManagedRoleProxy({ target, transportSecret: 'private-owner-secret' }); t.after(() => front.close()); return front
}

test('managed front validates exact Host, Origin, fetch context and request target before calling the private child', async t => {
  let requests = 0
  const child = await backend(t, (_request, response) => { requests++; response.end('child') }), front = await proxy(t, () => child.url)
  for (const input of [{ headers: { host: 'evil.invalid' } }, { headers: { origin: 'https://evil.invalid' } }, { headers: { 'sec-fetch-site': 'cross-site' } }, { method: 'POST', headers: { origin: '' }, body: '{}' }, { path: 'http://evil.invalid/' }]) {
    const result = await request(front.url, input); assert.equal(result.status, 403); assert.match(result.text, /forbidden-(host|origin)/)
  }
  assert.equal(requests, 0)
  assert.equal((await request(front.url)).text, 'child'); assert.equal(requests, 1)
})

test('a stable origin follows only an explicit ready role target and never retries across generations', async t => {
  let target, first = 0, second = 0
  const a = await backend(t, (_request, response) => { first++; response.end('first') }), b = await backend(t, (_request, response) => { second++; response.end('second') }), front = await proxy(t, () => target), origin = front.url
  assert.equal((await request(front.url)).status, 503)
  target = 'https://example.com/'; assert.equal((await request(front.url)).status, 503)
  target = 'http://127.0.0.1:1234/arbitrary-entry'; assert.equal((await request(front.url)).status, 503)
  target = a.url; assert.equal((await request(front.url + '/same-path?x=1')).text, 'first')
  target = undefined; assert.equal((await request(front.url)).status, 503)
  target = b.url; assert.equal((await request(front.url)).text, 'second')
  assert.equal(front.url, origin); assert.equal(first, 1); assert.equal(second, 1)
})

test('raw upload and streamed response preserve backpressure and replace private headers without leaking them', async t => {
  const firstChunk = defer(), release = defer(), uploaded = []
  let receivedHeaders
  const child = await backend(t, async (request, response) => {
    receivedHeaders = request.headers
    for await (const bytes of request) { uploaded.push(bytes); firstChunk.resolve() }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Anybox-Desktop-Transport': 'must-not-leak', Location: '/next' }); response.write('data: first\n\n')
    await release.promise; response.end('data: last\n\n')
  }), front = await proxy(t, () => child.url), observed = defer(), chunks = []
  const client = httpRequest(front.url + '/upload?part=1', { method: 'PUT', headers: { Origin: front.url, 'Content-Type': 'application/octet-stream', 'X-Anybox-Desktop-Transport': 'user-forged' }, agent: false })
  const done = new Promise((resolve, reject) => { client.once('error', reject); client.once('response', response => { assert.equal(response.headers['x-anybox-desktop-transport'], undefined); assert.equal(response.headers.location, front.url + '/next'); response.on('data', bytes => { chunks.push(bytes); observed.resolve() }); response.once('end', resolve); response.once('error', reject) }) })
  client.write(Buffer.from([0, 1, 2])); await firstChunk.promise; client.end(Buffer.from([3, 254, 255]))
  await observed.promise; assert.match(Buffer.concat(chunks).toString(), /data: first/)
  assert.equal(receivedHeaders.host, new URL(child.url).host); assert.equal(receivedHeaders.origin, child.url); assert.equal(receivedHeaders['x-anybox-desktop-transport'], 'private-owner-secret')
  assert.deepEqual(Buffer.concat(uploaded), Buffer.from([0, 1, 2, 3, 254, 255])); release.resolve(); await done; assert.match(Buffer.concat(chunks).toString(), /data: last/)
})

test('a complete accepted upload keeps running when its browser response observer disconnects', async t => {
  const accepted = defer(), release = defer(), completed = defer(), exited = defer()
  let responseClosed = false
  const child = await backend(t, async (request, response) => {
    for await (const _bytes of request) { /* Stub accepted byte reader. */ }
    response.once('close', () => { responseClosed = true; exited.resolve() }); accepted.resolve()
    await release.promise; completed.resolve(); response.end('committed')
  }), front = await proxy(t, () => child.url)
  const client = httpRequest(front.url + '/upload', { method: 'PUT', headers: { Origin: front.url }, agent: false }); client.on('error', () => {})
  client.end('complete bytes'); await accepted.promise; client.destroy()
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(responseClosed, false)
  release.resolve(); await completed.promise; await exited.promise
  await front.close()
})

test('partial upload and SSE observers exit when proxy shutdown completes, and later admission is refused', async t => {
  const uploadStarted = defer(), uploadExited = defer(), sseStarted = defer(), sseExited = defer()
  const child = await backend(t, (request, response) => {
    if (request.url === '/partial') { request.on('data', () => uploadStarted.resolve()); request.once('close', () => uploadExited.resolve()) }
    else { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: live\n\n'); response.once('close', () => sseExited.resolve()); sseStarted.resolve() }
  }), front = await proxy(t, () => child.url)
  const upload = httpRequest(front.url + '/partial', { method: 'PUT', headers: { Origin: front.url }, agent: false }); upload.on('error', () => {}); upload.write('partial')
  await uploadStarted.promise
  const observation = httpRequest(front.url + '/events', { agent: false }); observation.on('error', () => {}); observation.on('response', response => { response.on('error', () => {}); response.resume() }); observation.end()
  await sseStarted.promise
  front.closeAdmission(); assert.equal((await request(front.url)).status, 503)
  await front.close(); await Promise.all([uploadExited.promise, sseExited.promise]); assert.equal(child.server.listening, true)
  await assert.rejects(request(front.url), error => error.code === 'ECONNREFUSED')
})


test('an optional outer desktop transport guard authenticates before forwarding and replaces its capability', async t => {
  let token, requests = 0
  const child = await backend(t, (request, response) => { token = request.headers['x-anybox-desktop-transport']; requests++; response.end('private') })
  const front = await startManagedRoleProxy({ target: () => child.url, transportSecret: 'inner-token', incomingTransportSecret: 'outer-token' }); t.after(() => front.close())
  assert.equal((await request(front.url)).status, 403)
  assert.equal((await request(front.url, { headers: { 'X-Anybox-Desktop-Transport': 'wrong' } })).status, 403)
  assert.equal(requests, 0)
  assert.equal((await request(front.url, { headers: { 'X-Anybox-Desktop-Transport': 'outer-token' } })).text, 'private')
  assert.equal(token, 'inner-token'); assert.equal(requests, 1)
})


const withDeadline = (promise, label) => {
  let timer
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), 2000) })]).finally(() => clearTimeout(timer))
}

test('disconnecting a GET page event stream closes its upstream transport and retains its unconfirmed page lifetime', async t => {
  const pages = createPackagePageLifecycle({ timeoutMs: 100 }), registered = defer(), exited = defer()
  t.after(() => pages.close())
  const child = await backend(t, (request, response) => {
    response.once('close', exited.resolve)
    void pages.handle(request, response, new URL(request.url, 'http://127.0.0.1')).then(handled => {
      assert.equal(handled, true); registered.resolve()
    }, error => { response.destroy(error) })
  }), front = await proxy(t, () => child.url)
  const observed = defer(), client = httpRequest(front.url + '/api/client/v1/app-packages/pages/browser-first/events', { agent: false })
  client.on('error', () => {})
  client.once('response', response => { response.on('error', () => {}); response.once('data', () => observed.resolve()); response.resume() })
  client.end()
  await withDeadline(Promise.all([registered.promise, observed.promise]), 'page event stream did not register')
  client.destroy()
  await withDeadline(exited.promise, 'disconnected browser page remained registered upstream')
  // Closing the transport cannot prove that the actual document or its
  // application interfaces exited, so it still blocks a later handoff.
  await assert.rejects(pages.freeze('next-version'), { code: 'activation-browser-unavailable' })
  await assert.rejects(pages.dispose('next-version'), { code: 'activation-browser-stale' }); pages.release('next-version')
  assert.equal(child.server.listening, true)
})

for (const method of ['GET', 'HEAD']) test(`disconnecting ${method} before upstream response headers cancels only that observation`, async t => {
  const accepted = defer(), exited = defer(), release = defer()
  const child = await backend(t, async (_request, response) => {
    response.once('close', exited.resolve); accepted.resolve()
    await release.promise
    response.end('late observation')
  }), front = await proxy(t, () => child.url)
  t.after(() => release.resolve())
  const client = httpRequest(front.url + '/observe', { method, agent: false }); client.on('error', () => {}); client.end()
  await withDeadline(accepted.promise, 'observation did not reach the child')
  client.destroy()
  await withDeadline(exited.promise, 'disconnected read observation retained its upstream transport')
  release.resolve()
  assert.equal((await request(front.url)).status, 200)
})

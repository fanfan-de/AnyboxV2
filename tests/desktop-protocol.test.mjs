import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createDesktopProtocolBridge, desktopOrigin, isDesktopUrl } from '../dist/desktop/protocol.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function listener(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const bridge = createDesktopProtocolBridge(origin, 'private-transport-secret')
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { bridge, origin }
}
function desktopRequest(path, init, properties = {}) {
  const request = new Request(desktopOrigin + path, init)
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(request, key, { value })
  return request
}

test('desktop bridge yields the first SSE event before completion and reader cancellation exits upstream', { timeout: 5_000 }, async t => {
  const exited = deferred(), finish = deferred()
  t.after(() => finish.resolve())
  const { bridge } = await listener(t, (_request, response) => {
    response.once('close', exited.resolve)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: first\n\n')
    void finish.promise.then(() => response.end('data: last\n\n'))
  })
  const response = await bridge.handle(desktopRequest('/events'))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n')
  assert.equal(first.done, false)
  await reader.cancel(); await exited.promise
  await bridge.close()
})

test('desktop bridge forwards binary upload bytes and only its private transport capability', { timeout: 5_000 }, async t => {
  const bytes = Uint8Array.from([0, 255, 128, 13, 10, 0, 193, 81]), accepted = deferred()
  const { bridge, origin } = await listener(t, (request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      accepted.resolve({ body: Buffer.concat(chunks), headers: request.headers, path: request.url })
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'X-Anybox-Desktop-Transport': 'upstream-should-not-expose', 'Set-Cookie': 'private=value' })
      response.end(Buffer.concat(chunks))
    })().catch(error => { accepted.reject(error); response.destroy(error) })
  })
  const response = await bridge.handle(desktopRequest('/upload?part=1', {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length), 'X-Anybox-Desktop-Transport': 'renderer-spoof',
      Authorization: 'Bearer renderer-secret', Cookie: 'renderer=cookie', Origin: 'https://attacker.test',
      'X-Anybox-Connection-Revision': '7' },
  }, { initiatorOrigin: desktopOrigin }))
  const received = await accepted.promise
  assert.deepEqual(received.body, Buffer.from(bytes))
  assert.equal(received.path, '/upload?part=1')
  assert.equal(received.headers.host, new URL(origin).host)
  assert.equal(received.headers.origin, origin)
  assert.equal(received.headers['x-anybox-desktop-transport'], 'private-transport-secret')
  assert.equal(received.headers.authorization, undefined); assert.equal(received.headers.cookie, undefined)
  assert.equal(received.headers['x-anybox-connection-revision'], '7')
  assert.equal(response.headers.get('x-anybox-desktop-transport'), null)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes))
})

test('desktop bridge rejects foreign scheme, host, port, userinfo and initiator before forwarding', { timeout: 5_000 }, async t => {
  let forwarded = 0
  const { bridge } = await listener(t, (_request, response) => { forwarded++; response.end('ok') })
  for (const url of ['https://app/path', 'anybox-app://foreign/path', 'anybox-app://app:99/path',
    'anybox-app://user@app/path', 'anybox-app://user:password@app/path', 'invalid']) {
    assert.equal(isDesktopUrl(url), false)
    const response = await bridge.handle(desktopRequest('/path', undefined, { url }))
    assert.equal(response.status, 403)
  }
  for (const initiatorOrigin of ['https://attacker.test', 'anybox-app://foreign', 'anybox-app://app:99', 'null']) {
    const response = await bridge.handle(desktopRequest('/path', undefined, { initiatorOrigin }))
    assert.equal(response.status, 403)
  }
  assert.equal(forwarded, 0)
  bridge.closeAdmission()
  assert.equal((await bridge.handle(desktopRequest('/path'))).status, 503)
  assert.equal(forwarded, 0)
})

test('response cancellation stops the upload and protocol.close waits for its actual cancellation exit', { timeout: 5_000 }, async t => {
  const cancelling = deferred(), cancelled = deferred(), received = deferred()
  t.after(() => cancelled.resolve())
  const { bridge } = await listener(t, (request, response) => {
    received.resolve(); request.pause()
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: ready\n\n')
  })
  let sent = false
  const upload = new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(Uint8Array.from([0, 128, 255])) } },
    async cancel() { cancelling.resolve(); await cancelled.promise },
  })
  const response = await bridge.handle(desktopRequest('/upload-stream', { method: 'POST', body: upload, duplex: 'half' }))
  await received.promise
  const reader = response.body.getReader(); await reader.read(); await reader.cancel()
  await cancelling.promise
  let closed = false
  const closing = bridge.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  cancelled.resolve(); await closing; assert.equal(closed, true)
})

test('request abort closes an open response and protocol.close joins the cancelled transport', { timeout: 5_000 }, async t => {
  const exited = deferred(), controller = new AbortController()
  const { bridge } = await listener(t, (_request, response) => {
    response.once('close', exited.resolve)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: ready\n\n')
  })
  const response = await bridge.handle(desktopRequest('/events', { signal: controller.signal }))
  const reader = response.body.getReader(); await reader.read()
  const reading = reader.read(); controller.abort()
  await assert.rejects(reading); await bridge.close(); await exited.promise
})

test('synchronous request setup failure releases the owned upload reader before protocol.close', { timeout: 5_000 }, async t => {
  const cancelling = deferred(), cancelled = deferred()
  t.after(() => cancelled.resolve())
  const { bridge } = await listener(t, (_request, response) => response.end())
  const upload = new ReadableStream({ async cancel() { cancelling.resolve(); await cancelled.promise } })
  const request = desktopRequest('/bad-method', { method: 'POST', body: upload, duplex: 'half' }, { method: 'bad\nmethod' })
  await assert.rejects(bridge.handle(request))
  await cancelling.promise
  let closed = false
  const closing = bridge.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  cancelled.resolve(); await closing
})

test('Response construction failure closes the upstream response and leaves protocol.close drainable', { timeout: 5_000 }, async t => {
  const exited = deferred()
  const { bridge } = await listener(t, (_request, response) => {
    response.once('close', exited.resolve)
    response.writeHead(600, { 'Content-Type': 'text/event-stream' }); response.write('unsupported status')
  })
  await assert.rejects(bridge.handle(desktopRequest('/bad-status')), RangeError)
  await bridge.close(); await exited.promise
})

test('a locked request body rejects fromWeb setup without retaining a protocol operation', { timeout: 5_000 }, async t => {
  let forwarded = 0
  const { bridge } = await listener(t, (_request, response) => { forwarded++; response.end() })
  const request = desktopRequest('/locked', { method: 'POST', body: new ReadableStream(), duplex: 'half' })
  const reader = request.body.getReader()
  t.after(() => reader.releaseLock())
  await assert.rejects(bridge.handle(request), TypeError)
  await bridge.close(); assert.equal(forwarded, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installDesktopSessionProtocol } from '../dist/desktop/session-protocol.js'
import { desktopOrigin } from '../dist/desktop/protocol.js'
import { deferred } from './helpers/controlled-models.mjs'

const correlationHeader = 'X-Anybox-Desktop-Request-Id'
const tick = () => new Promise(resolve => setImmediate(resolve))
function fakeSession() {
  const hooks = {}, unregistered = []
  let handler
  const session = {
    webRequest: {
      onBeforeSendHeaders(filter, listener) { assert.deepEqual(filter.urls, ['anybox-app://app/*']); hooks.before = listener },
      onErrorOccurred(filter, listener) { assert.deepEqual(filter.urls, ['anybox-app://app/*']); hooks.error = listener },
      onCompleted(filter, listener) { assert.deepEqual(filter.urls, ['anybox-app://app/*']); hooks.completed = listener },
    },
    protocol: {
      handle(scheme, listener) { assert.equal(scheme, 'anybox-app'); handler = listener },
      unhandle(scheme) { unregistered.push(scheme); handler = undefined },
    },
  }
  return {
    session, hooks, unregistered,
    before(details) {
      let result, callbacks = 0
      assert.ok(hooks.before)
      hooks.before(details, value => { callbacks++; result = value })
      assert.equal(callbacks, 1)
      return result
    },
    handle(request) { assert.ok(handler, 'protocol is registered'); return handler(request) },
    error(id, extra = {}) { assert.ok(hooks.error); hooks.error({ id, ...extra }) },
    complete(id, extra = {}) { assert.ok(hooks.completed); hooks.completed({ id, ...extra }) },
    get registered() { return !!handler },
  }
}
function details(id, extra = {}) {
  return { id, url: `${desktopOrigin}/events`, method: 'GET', webContentsId: 10, requestHeaders: {}, ...extra }
}
function request(detail, headers, extra = {}) {
  const input = new Request(extra.url ?? detail.url, { method: extra.method ?? detail.method, headers, signal: extra.signal })
  Object.defineProperty(input, 'initiatorOrigin', { value: extra.initiatorOrigin ?? desktopOrigin })
  return input
}
function installed(t, forward, owner = () => 10) {
  const fake = fakeSession(), installation = installDesktopSessionProtocol(fake.session, owner, forward)
  t.after(() => installation.dispose())
  return { fake, installation }
}

test('session protocol cancels exactly one browser request among same-URL concurrent streams', { timeout: 5_000 }, async t => {
  const seen = new Map()
  const { fake } = installed(t, async input => {
    const id = input.headers.get(correlationHeader)
    seen.set(id, input)
    return new Response('stream started')
  })
  const first = details(1), second = details(2)
  const firstHeaders = fake.before(first).requestHeaders, secondHeaders = fake.before(second).requestHeaders
  assert.equal((await fake.handle(request(first, firstHeaders))).status, 200)
  assert.equal((await fake.handle(request(second, secondHeaders))).status, 200)
  fake.error(1, { url: first.url, method: first.method, webContentsId: 10 })
  assert.equal(seen.get('1').signal.aborted, true)
  assert.equal(seen.get('2').signal.aborted, false)
  assert.equal((await fake.handle(request(first, firstHeaders))).status, 403)
  fake.complete(2)
})

test('browser request ID overwrites every casing of a renderer supplied correlation header', { timeout: 5_000 }, async t => {
  let forwarded
  const { fake } = installed(t, async input => { forwarded = input; return new Response('ok') })
  const detail = details(37, { requestHeaders: { [correlationHeader]: '999', 'x-anybox-desktop-request-id': '888',
    'X-AnyBox-Desktop-Request-ID': '777', Accept: 'text/event-stream' } })
  const headers = fake.before(detail).requestHeaders
  assert.equal(Object.keys(headers).filter(key => key.toLowerCase() === correlationHeader.toLowerCase()).length, 1)
  assert.equal(new Headers(headers).get(correlationHeader), '37')
  assert.equal(new Headers(headers).get('Accept'), 'text/event-stream')
  await fake.handle(request(detail, headers))
  assert.equal(forwarded.headers.get(correlationHeader), '37')
  assert.equal(forwarded.initiatorOrigin, desktopOrigin)
  fake.complete(37)
})

test('session protocol rejects wrong owner, path, method and ID before forwarding', { timeout: 5_000 }, async t => {
  let forwarded = 0
  const { fake } = installed(t, async () => { forwarded++; return new Response('ok') })
  const detail = details(42), headers = fake.before(detail).requestHeaders
  assert.deepEqual(fake.before(details(43, { webContentsId: 20 })), { cancel: true })
  assert.deepEqual(fake.before(details(44, { url: 'anybox-app://foreign/events' })), { cancel: true })
  for (const candidate of [
    request(detail, headers, { url: `${desktopOrigin}/different` }),
    request(detail, headers, { method: 'POST' }),
    request(detail, { [correlationHeader]: '43' }),
    request(detail, { [correlationHeader]: '999' }),
    request(detail, { [correlationHeader]: '4.2' }),
    request(detail, { [correlationHeader]: '4.2e1' }),
    request(detail, {}),
  ]) assert.equal((await fake.handle(candidate)).status, 403)
  assert.equal(forwarded, 0)
  fake.complete(42)
})

test('session protocol requires an active owner before registering browser requests', { timeout: 5_000 }, async t => {
  let forwarded = 0
  const { fake } = installed(t, async () => { forwarded++; return new Response('ok') }, () => undefined)
  assert.deepEqual(fake.before(details(50, { webContentsId: undefined })), { cancel: true })
  assert.equal(forwarded, 0)
})

test('session protocol refuses ledger entries from an earlier owner generation', { timeout: 5_000 }, async t => {
  let owner = 10, forwarded = 0
  const { fake } = installed(t, async () => { forwarded++; return new Response('ok') }, () => owner)
  const detail = details(51), headers = fake.before(detail).requestHeaders
  owner = 11
  assert.equal((await fake.handle(request(detail, headers))).status, 403)
  assert.equal(forwarded, 0)
})

test('early browser abort removes the request before handler dispatch and never enters the bridge', { timeout: 5_000 }, async t => {
  let forwarded = 0
  const { fake } = installed(t, async () => { forwarded++; return new Response('ok') })
  const detail = details(60), headers = fake.before(detail).requestHeaders
  fake.error(60)
  assert.equal((await fake.handle(request(detail, headers))).status, 403)
  assert.equal(forwarded, 0)
})

test('browser completion releases the ledger entry and native request abort remains connected', { timeout: 5_000 }, async t => {
  let forwarded
  const { fake } = installed(t, async input => { forwarded = input; return new Response('ok') })
  const detail = details(70), headers = fake.before(detail).requestHeaders, controller = new AbortController()
  const response = await fake.handle(request(detail, headers, { signal: controller.signal }))
  assert.equal(await response.text(), 'ok')
  controller.abort(); assert.equal(forwarded.signal.aborted, true)
  fake.complete(70)
  assert.equal((await fake.handle(request(detail, headers))).status, 403)
})

test('disposing session protocol cancels waiting forwards, unregisters every hook and lets handlers exit', { timeout: 5_000 }, async t => {
  const seen = [], cancelling = deferred(), exited = deferred()
  t.after(() => exited.resolve())
  const { fake, installation } = installed(t, async input => {
    seen.push(input)
    input.signal.addEventListener('abort', cancelling.resolve, { once: true })
    await exited.promise
    input.signal.throwIfAborted()
    return new Response('ok')
  })
  const first = details(80), second = details(81)
  const forwarding = [fake.handle(request(first, fake.before(first).requestHeaders)),
    fake.handle(request(second, fake.before(second).requestHeaders))]
  await tick(); assert.equal(seen.length, 2)
  installation.dispose(); await cancelling.promise
  assert.ok(seen.every(input => input.signal.aborted))
  assert.equal(fake.hooks.before, null); assert.equal(fake.hooks.error, null); assert.equal(fake.hooks.completed, null)
  assert.equal(fake.registered, false); assert.deepEqual(fake.unregistered, ['anybox-app'])
  let completed = false
  const completing = Promise.all(forwarding).then(results => { completed = true; return results })
  await tick(); assert.equal(completed, false)
  exited.resolve()
  for (const response of await completing) assert.equal(response.status, 499)
})

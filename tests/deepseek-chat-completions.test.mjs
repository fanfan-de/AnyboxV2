import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { llmServiceKey } from '../dist/llm/port.js'
import { createDeepSeekChatCompletionsComponent } from '../dist/llm/deepseek-chat-completions/component.js'
import { chatCompletionsEndpoint, validateDeepSeekConfiguration } from '../dist/llm/deepseek-chat-completions/domain.js'
import { runServiceKey } from '../dist/run/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { deferred } from './helpers/controlled-llm.mjs'

const profile = (overrides = {}) => ({
  id: 'default', model: 'deepseek-chat', maxOutputTokens: 128, temperature: 0.4, timeoutMs: 30000, ...overrides,
})
const config = (version = 'v1', profiles = [profile()]) => ({ version, profiles })
const agents = [{ id: 'assistant', instructions: 'Answer briefly.', modelProfileId: 'default' }]
const messages = [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Hello' }]
const completion = content => JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
})

/** A local HTTP server standing in for api.deepseek.com. */
async function localServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

/** A fetch stand-in that records each request and holds it open until the test releases it. */
function heldFetch() {
  const requests = []
  return {
    requests,
    fetch(url, init) {
      const entry = { url: String(url), init, aborted: deferred(), released: deferred() }
      requests.push(entry)
      init.signal.addEventListener('abort', () => entry.aborted.resolve(init.signal.reason))
      return new Promise((_resolve, reject) => {
        void entry.released.promise.then(() => reject(new Error('transport exited')))
      })
    },
    release() { for (const request of requests) request.released.resolve() },
  }
}

/** Only the DeepSeek component on a root, for direct service semantics. */
async function apiFixture(transport, configuration = config()) {
  const root = new Context()
  const fiber = root.installComponent(createDeepSeekChatCompletionsComponent(configuration, transport))
  await fiber
  assert.equal(fiber.state, FiberState.ACTIVE)
  return { root, fiber, llm: root.get(llmServiceKey), close: () => root.fiber.dispose() }
}

/** DeepSeek and SQLite on the application root, then the Harness. */
async function harnessFixture(transport, configuration = config()) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-deepseek-'))
  const root = new Context()
  try {
    const api = root.installComponent(createDeepSeekChatCompletionsComponent(configuration, transport))
    const database = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await api
    await database
    const harness = await createHarness(root, { agents })
    return {
      root, api, harness,
      async close() {
        try { await harness.close() } finally { rmSync(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

/** Resolves once Nya can start a consumer of the named service. */
async function serviceReady(root, name) {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const probe = root.inject([name], () => ready())
  await started
  await probe.dispose()
}

const start = (harness, idempotencyKey = 'one') => {
  const session = harness.createSession('assistant')
  return harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey })
}

test('the component sends a native Chat Completions request and returns the final answer', async () => {
  let received
  const server = await localServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received = {
      method: request.method, path: request.url, authorization: request.headers.authorization,
      contentType: request.headers['content-type'], body: JSON.parse(body),
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(completion('Hi'))
  })
  const f = await apiFixture({ apiKey: () => 'local-key', baseUrl: server.baseUrl })
  try {
    const plan = f.llm.prepare('default')
    assert.deepEqual(plan, { snapshot: { profileId: 'default', configVersion: 'v1' } })
    assert.equal(JSON.stringify(plan).includes('local-key'), false)
    const call = f.llm.call({ plan, messages })
    assert.equal(await call.result, 'Hi')
    await call.done
    assert.deepEqual(received, {
      method: 'POST', path: '/chat/completions', authorization: 'Bearer local-key', contentType: 'application/json',
      body: { model: 'deepseek-chat', messages, max_tokens: 128, temperature: 0.4, stream: false },
    })
  } finally { await f.close(); await server.close() }
})

test('a Harness Run completes through DeepSeek without exposing credentials', async () => {
  const server = await localServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(completion('Hello from DeepSeek'))
  })
  const f = await harnessFixture({ apiKey: () => 'local-key', baseUrl: server.baseUrl })
  try {
    const run = start(f.harness)
    assert.deepEqual(run.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'Hello from DeepSeek')
    assert.equal(JSON.stringify(terminal).includes('local-key'), false)
    assert.deepEqual(f.harness.getSession(run.sessionId).turns, [{ input: 'Hello', output: 'Hello from DeepSeek' }])
  } finally { await f.close(); await server.close() }
})

test('configuration, endpoint, and credentials are validated before any request', async () => {
  assert.throws(() => validateDeepSeekConfiguration(config(' ')), /version/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [])), /non-empty/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [profile({ timeoutMs: 0 })])), /timeoutMs/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [profile({ timeoutMs: 2 ** 31 })])), /timeoutMs/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [profile({ temperature: 3 })])), /temperature/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [profile({ topP: 1 })])), /unsupported/)
  assert.throws(() => validateDeepSeekConfiguration(config('v1', [profile(), profile()])), /duplicate/)
  assert.throws(() => validateDeepSeekConfiguration({ ...config(), provider: 'deepseek' }), /unsupported/)
  const selections = validateDeepSeekConfiguration(config())
  assert.deepEqual(selections.get('default'), { ...profile(), configVersion: 'v1' })
  assert.equal(chatCompletionsEndpoint().href, 'https://api.deepseek.com/chat/completions')
  assert.equal(chatCompletionsEndpoint('http://127.0.0.1:8080/v1').href, 'http://127.0.0.1:8080/v1/chat/completions')
  assert.throws(() => chatCompletionsEndpoint('ftp://example.com'), /HTTP/)
  assert.throws(() => createDeepSeekChatCompletionsComponent(config(), { apiKey: 'literal' }), /API key provider/)
  assert.throws(() => createDeepSeekChatCompletionsComponent(config(), { apiKey: () => 'k', fetch: 'nope' }), /fetch/)

  const held = heldFetch()
  const root = new Context()
  try {
    const fiber = root.installComponent(createDeepSeekChatCompletionsComponent(config(), {
      apiKey: () => '', fetch: held.fetch,
    }))
    try { await fiber } catch {}
    assert.equal(fiber.state, FiberState.FAILED)
    assert.match(String(fiber.error?.message), /API key is required/)
    assert.equal(root.get(llmServiceKey), undefined)
    assert.equal(held.requests.length, 0)
  } finally { await root.fiber.dispose() }
})

test('HTTP errors, incomplete output, malformed bodies, and unsupported messages become fixed categories', async () => {
  const responses = []
  const server = await localServer((request, response) => {
    const next = responses.shift()
    response.writeHead(next.status, { 'content-type': 'application/json' })
    response.end(next.body)
  })
  const f = await apiFixture({ apiKey: () => 'local-key', baseUrl: server.baseUrl })
  const attempt = async plan => {
    const call = f.llm.call({ plan, messages })
    const outcome = await call.result.then(value => ({ value }), error => ({ error }))
    await call.done
    return outcome
  }
  try {
    const plan = f.llm.prepare('default')
    responses.push({ status: 401, body: 'authentication details' })
    const denied = await attempt(plan)
    assert.equal(denied.error.category, 'provider-failure')
    assert.equal(denied.error.message.includes('authentication'), false)
    responses.push({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) })
    assert.equal((await attempt(plan)).error.category, 'invalid-response')
    responses.push({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [] } }] }) })
    assert.equal((await attempt(plan)).error.category, 'invalid-response')
    responses.push({ status: 200, body: '{not json' })
    assert.equal((await attempt(plan)).error.category, 'invalid-response')
    assert.throws(() => f.llm.call({ plan, messages: [{ role: 'developer', content: 'Policy' }] }),
      error => error.category === 'unsupported-request')
    assert.throws(() => f.llm.call({ plan, messages: [] }), error => error.category === 'unsupported-request')
    assert.throws(() => f.llm.prepare('missing'), error => error.category === 'model-unavailable')
    const other = await apiFixture({ apiKey: () => 'other-key', baseUrl: server.baseUrl })
    try {
      assert.throws(() => other.llm.call({ plan, messages }), error => error.category === 'model-unavailable')
    } finally { await other.close() }
  } finally { await f.close(); await server.close() }
})

test('timeout fails the result first, aborts the request, and waits for the transport to exit', async () => {
  const direct = heldFetch()
  const d = await apiFixture({ apiKey: () => 'local-key', fetch: direct.fetch }, config('v1', [profile({ timeoutMs: 10 })]))
  try {
    const call = d.llm.call({ plan: d.llm.prepare('default'), messages })
    await assert.rejects(call.result, error => error.category === 'timeout')
    assert.equal(await direct.requests[0].aborted.promise, 'timeout')
    let exited = false
    const waiting = call.done.then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    direct.release()
    await waiting
  } finally { direct.release(); await d.close() }

  const held = heldFetch()
  const f = await harnessFixture({ apiKey: () => 'local-key', fetch: held.fetch }, config('v1', [profile({ timeoutMs: 10 })]))
  try {
    const run = start(f.harness)
    assert.equal(await held.requests[0].aborted.promise, 'timeout')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.harness.getRun(run.id).status, 'running')
    held.release()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'timeout')
    assert.equal(terminal.error, 'model call timed out')
    assert.deepEqual(f.harness.getSession(run.sessionId).turns, [])
  } finally { held.release(); await f.close() }
})

test('cancelling and closing abort the request and settle only after it exits', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ apiKey: () => 'local-key', fetch: held.fetch })
  try {
    const run = start(f.harness)
    const waiting = f.harness.waitRun(run.id)
    assert.equal(f.harness.cancelRun(run.id).status, 'cancelling')
    assert.equal(await held.requests[0].aborted.promise, 'user-requested')
    let closed = false
    const closing = f.harness.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.throws(() => f.harness.startRun({ sessionId: run.sessionId, input: 'Late', idempotencyKey: 'late' }), /closing/)
    held.release()
    assert.equal((await waiting).status, 'cancelled')
    await closing
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(localStorageServiceKey), undefined)
  } finally { held.release(); await f.close() }

  const closing = heldFetch()
  const g = await harnessFixture({ apiKey: () => 'local-key', fetch: closing.fetch })
  try {
    const run = start(g.harness)
    const waiting = g.harness.waitRun(run.id)
    let closed = false
    const shutdown = g.harness.close().then(() => { closed = true })
    assert.equal(await closing.requests[0].aborted.promise, 'owner-disposed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    closing.release()
    assert.equal((await waiting).status, 'cancelled')
    await shutdown
    assert.equal(g.root.get(llmServiceKey), undefined)
  } finally { closing.release(); await g.close() }
})

test('revoking the API component fails accepted Runs and a replacement serves new keys with its own credentials', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ apiKey: () => 'first-key', fetch: held.fetch })
  let server
  try {
    const session = f.harness.createSession('assistant')
    const request = { sessionId: session.id, input: 'Hello', idempotencyKey: 'first' }
    const run = f.harness.startRun(request)
    assert.equal(held.requests[0].init.headers.Authorization, 'Bearer first-key')
    const waiting = f.harness.waitRun(run.id)
    let disposed = false
    const stopping = f.api.dispose().then(() => { disposed = true })
    assert.equal(await held.requests[0].aborted.promise, 'dependency-unavailable')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    held.release()
    const terminal = await waiting
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'dependency-unavailable')
    await stopping
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(runServiceKey), undefined)
    assert.equal(f.harness.getSession(session.id).id, session.id)

    let authorization
    server = await localServer((incoming, response) => {
      authorization = incoming.headers.authorization
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion('Replaced'))
    })
    await f.root.installComponent(createDeepSeekChatCompletionsComponent(config('v2'), {
      apiKey: () => 'second-key', baseUrl: server.baseUrl,
    }))
    await serviceReady(f.root, runServiceKey)
    assert.equal(f.harness.startRun(request), f.harness.getRun(run.id))
    const fresh = f.harness.startRun({ ...request, idempotencyKey: 'second' })
    assert.equal(fresh.llmSnapshot.configVersion, 'v2')
    assert.equal((await f.harness.waitRun(fresh.id)).output, 'Replaced')
    assert.equal(authorization, 'Bearer second-key')
    assert.equal(held.requests.length, 1)
  } finally { held.release(); await f.close(); await server?.close() }
})

test('disposing the component aborts and joins a direct call before withdrawing the service', async () => {
  const held = heldFetch()
  const f = await apiFixture({ apiKey: () => 'local-key', fetch: held.fetch })
  try {
    const plan = f.llm.prepare('default')
    const call = f.llm.call({ plan, messages })
    let stopped = false
    const stopping = f.fiber.dispose().then(() => { stopped = true })
    assert.equal(await held.requests[0].aborted.promise, 'llm-disposed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    assert.throws(() => f.llm.prepare('default'), error => error.category === 'dependency-unavailable')
    assert.throws(() => f.llm.call({ plan, messages }), error => error.category === 'dependency-unavailable')
    held.release()
    await assert.rejects(call.result, error => error.category === 'provider-failure')
    await call.done
    await stopping
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(held.requests.length, 1)
  } finally { held.release(); await f.close() }
})

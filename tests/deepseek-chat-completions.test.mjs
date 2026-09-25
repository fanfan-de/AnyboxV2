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
import { credentialReadServiceKey } from '../dist/credentials/port.js'
import { createDeepSeekChatCompletionsComponent, deepSeekCredentialId } from '../dist/llm/deepseek-chat-completions/component.js'
import { chatCompletionsEndpoint, validateDeepSeekConfiguration } from '../dist/llm/deepseek-chat-completions/domain.js'
import { runServiceKey } from '../dist/run/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { deferred } from './helpers/controlled-llm.mjs'
import { memoryCredentials } from './helpers/memory-credentials.mjs'

const profile = (overrides = {}) => ({
  id: 'default', model: 'deepseek-chat', maxOutputTokens: 128, temperature: 0.4, timeoutMs: 30000, ...overrides,
})
const config = (version = 'v1', profiles = [profile()]) => ({ version, profiles })
const agents = [{ id: 'assistant', instructions: 'Answer briefly.', modelProfileId: 'default' }]
const messages = [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Hello' }]
const completion = content => JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
})
const withKey = key => ({ [deepSeekCredentialId]: key })
const settle = promise => promise.then(() => {}, () => {})
const requestAt = async (held, index) => {
  for (let i = 0; i < 100 && !held.requests[index]; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(held.requests[index], `request ${index} did not start`)
  return held.requests[index]
}
const readAt = async (credentials, index) => {
  for (let i = 0; i < 100 && !credentials.reads[index]; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(credentials.reads[index], `read ${index} did not start`)
  return credentials.reads[index]
}

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

/** The fake credential source and the DeepSeek component on a root, for direct service semantics. */
async function apiFixture(transport, configuration = config(), key = 'local-key') {
  const root = new Context()
  const credentials = memoryCredentials(withKey(key))
  await root.installComponent(credentials.component())
  const fiber = root.installComponent(createDeepSeekChatCompletionsComponent(configuration, transport))
  await fiber
  assert.equal(fiber.state, FiberState.ACTIVE)
  return { root, fiber, credentials, llm: root.get(llmServiceKey), close: () => root.fiber.dispose() }
}

/** Credentials, DeepSeek and SQLite on the application root, then the Harness. */
async function harnessFixture(transport, configuration = config(), key = 'local-key') {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-deepseek-'))
  const root = new Context()
  const credentials = memoryCredentials(withKey(key))
  try {
    const source = root.installComponent(credentials.component())
    const api = root.installComponent(createDeepSeekChatCompletionsComponent(configuration, transport))
    const database = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await source
    await api
    await database
    const harness = await createHarness(root, { agents })
    return {
      root, source, api, credentials, harness,
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

const start = async (harness, idempotencyKey = 'one') => {
  const session = await createSession(harness)
  return await harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey })
}

async function createSession(harness) {
  const project = await harness.openProject(process.cwd())
  return harness.createSession(project.id, 'assistant')
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
  const f = await apiFixture({ baseUrl: server.baseUrl })
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
  const f = await harnessFixture({ baseUrl: server.baseUrl })
  try {
    const run = await start(f.harness)
    assert.deepEqual(run.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'Hello from DeepSeek')
    assert.equal(JSON.stringify(terminal).includes('local-key'), false)
    assert.deepEqual((await f.harness.getSession(run.sessionId)).turns, [{ input: 'Hello', output: 'Hello from DeepSeek' }])
  } finally { await f.close(); await server.close() }
})

test('Harness starts without a key and settles an unconfigured Run explicitly', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch }, config(), '')
  try {
    const run = await start(f.harness)
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'credential-missing')
    assert.equal(terminal.error, 'model API key is not configured')
    assert.equal(held.requests.length, 0)
    assert.equal(f.api.state, FiberState.ACTIVE)
  } finally { await f.close() }
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
  assert.throws(() => createDeepSeekChatCompletionsComponent(config(), { fetch: 'nope' }), /fetch/)

  const held = heldFetch()
  const root = new Context()
  const credentials = memoryCredentials()
  try {
    const fiber = root.installComponent(createDeepSeekChatCompletionsComponent(config(), { fetch: held.fetch }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fiber.state, FiberState.PENDING)
    assert.deepEqual(fiber.inspect().dependencies.map(item => item.serviceName), [credentialReadServiceKey])
    await root.installComponent(credentials.component())
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    const llm = root.get(llmServiceKey)
    const plan = llm.prepare('default')
    const attempt = async () => {
      const call = llm.call({ plan, messages })
      const error = await call.result.then(() => assert.fail('expected failure'), error => error)
      await call.done
      return error
    }
    assert.equal((await attempt()).category, 'credential-missing')
    credentials.secrets.set(deepSeekCredentialId, '   ')
    assert.equal((await attempt()).category, 'credential-missing')
    credentials.failure = new Error('vault private URL and secret')
    const error = await attempt()
    assert.equal(error.category, 'credential-unavailable')
    assert.equal(error.message.includes('vault'), false)
    assert.equal(held.requests.length, 0)
    assert.equal(fiber.state, FiberState.ACTIVE)
  } finally { await root.fiber.dispose() }
})

test('HTTP errors, incomplete output, malformed bodies, and unsupported messages become fixed categories', async () => {
  const responses = []
  const server = await localServer((request, response) => {
    const next = responses.shift()
    response.writeHead(next.status, { 'content-type': 'application/json' })
    response.end(next.body)
  })
  const f = await apiFixture({ baseUrl: server.baseUrl })
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
    const other = await apiFixture({ baseUrl: server.baseUrl }, config(), 'other-key')
    try {
      assert.throws(() => other.llm.call({ plan, messages }), error => error.category === 'model-unavailable')
    } finally { await other.close() }
  } finally { await f.close(); await server.close() }
})

test('timeout fails the result first, aborts the request, and waits for the transport to exit', async () => {
  const direct = heldFetch()
  const d = await apiFixture({ fetch: direct.fetch }, config('v1', [profile({ timeoutMs: 10 })]))
  try {
    const call = d.llm.call({ plan: d.llm.prepare('default'), messages })
    await assert.rejects(call.result, error => error.category === 'timeout')
    assert.equal(await (await requestAt(direct, 0)).aborted.promise, 'timeout')
    let exited = false
    const waiting = call.done.then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    direct.release()
    await waiting
  } finally { direct.release(); await d.close() }

  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch }, config('v1', [profile({ timeoutMs: 10 })]))
  try {
    const run = await start(f.harness)
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'timeout')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    held.release()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'timeout')
    assert.equal(terminal.error, 'model call timed out')
    assert.deepEqual((await f.harness.getSession(run.sessionId)).turns, [])
  } finally { held.release(); await f.close() }
})

test('cancelling and closing abort the request and settle only after it exits', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch })
  try {
    const run = await start(f.harness)
    const waiting = f.harness.waitRun(run.id)
    await requestAt(held, 0)
    assert.equal((await f.harness.cancelRun(run.id)).status, 'cancelling')
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'user-requested')
    let closed = false
    const closing = f.harness.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    await assert.rejects(async () => f.harness.startRun({ sessionId: run.sessionId, input: 'Late', idempotencyKey: 'late' }), /closing/)
    held.release()
    assert.equal((await waiting).status, 'cancelled')
    await closing
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(localStorageServiceKey), undefined)
  } finally { held.release(); await f.close() }

  const closing = heldFetch()
  const g = await harnessFixture({ fetch: closing.fetch })
  try {
    const run = await start(g.harness)
    const waiting = g.harness.waitRun(run.id)
    let closed = false
    await requestAt(closing, 0)
    const shutdown = g.harness.close().then(() => { closed = true })
    assert.equal(await (await requestAt(closing, 0)).aborted.promise, 'owner-disposed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    closing.release()
    assert.equal((await waiting).status, 'cancelled')
    await shutdown
    assert.equal(g.root.get(llmServiceKey), undefined)
  } finally { closing.release(); await g.close() }
})

test('revoking the API component fails accepted Runs and a replacement serves new keys with the current credential', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch }, config(), 'first-key')
  let server
  try {
    const session = await createSession(f.harness)
    const request = { sessionId: session.id, input: 'Hello', idempotencyKey: 'first' }
    const run = await f.harness.startRun(request)
    assert.equal((await requestAt(held, 0)).init.headers.Authorization, 'Bearer first-key')
    const waiting = f.harness.waitRun(run.id)
    let disposed = false
    const stopping = f.api.dispose().then(() => { disposed = true })
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'dependency-unavailable')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    held.release()
    const terminal = await waiting
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'dependency-unavailable')
    await stopping
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(runServiceKey), undefined)
    assert.equal((await f.harness.getSession(session.id)).id, session.id)

    let authorization
    server = await localServer((incoming, response) => {
      authorization = incoming.headers.authorization
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion('Replaced'))
    })
    f.credentials.secrets.set(deepSeekCredentialId, 'second-key')
    await f.root.installComponent(createDeepSeekChatCompletionsComponent(config('v2'), { baseUrl: server.baseUrl }))
    await serviceReady(f.root, runServiceKey)
    assert.deepEqual(await f.harness.startRun(request), await f.harness.getRun(run.id))
    const fresh = await f.harness.startRun({ ...request, idempotencyKey: 'second' })
    assert.equal(fresh.llmSnapshot.configVersion, 'v2')
    assert.equal((await f.harness.waitRun(fresh.id)).output, 'Replaced')
    assert.equal(authorization, 'Bearer second-key')
    assert.equal(held.requests.length, 1)
  } finally { held.release(); await f.close(); await server?.close() }
})

test('disposing the component aborts and joins a direct call before withdrawing the service', async () => {
  const held = heldFetch()
  const f = await apiFixture({ fetch: held.fetch })
  try {
    const plan = f.llm.prepare('default')
    const call = f.llm.call({ plan, messages })
    let stopped = false
    const stopping = f.fiber.dispose().then(() => { stopped = true })
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'llm-disposed')
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

test('rotation and deletion affect only calls whose credential read starts afterward', async () => {
  const requests = []
  const fetch = (_url, init) => {
    const gate = deferred()
    requests.push({ authorization: init.headers.Authorization, gate })
    return gate.promise
  }
  const f = await harnessFixture({ fetch }, config(), 'first-key')
  try {
    const session = await createSession(f.harness)
    const run = async key => f.harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: key })
    const first = await run('first')
    for (let i = 0; i < 100 && !requests[0]; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests[0].authorization, 'Bearer first-key')
    f.credentials.secrets.set(deepSeekCredentialId, 'second-key')
    const secondSession = await createSession(f.harness)
    const secondAttempt = await f.harness.startRun({ sessionId: secondSession.id, input: 'Hello', idempotencyKey: 'second' })
    for (let i = 0; i < 100 && !requests[1]; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests[1].authorization, 'Bearer second-key')
    f.credentials.secrets.delete(deepSeekCredentialId)
    const missingSession = await createSession(f.harness)
    const missing = await f.harness.startRun({ sessionId: missingSession.id, input: 'Hello', idempotencyKey: 'third' })
    const terminal = await f.harness.waitRun(missing.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'credential-missing')
    requests[0].gate.resolve(new Response(completion('first answer'), { status: 200 }))
    requests[1].gate.resolve(new Response(completion('second answer'), { status: 200 }))
    assert.equal((await f.harness.waitRun(first.id)).output, 'first answer')
    assert.equal((await f.harness.waitRun(secondAttempt.id)).output, 'second answer')
    assert.equal(JSON.stringify([first, secondAttempt, terminal]).includes('first-key'), false)
    assert.equal(requests.length, 2)
  } finally { for (const request of requests) request.gate.resolve(new Response(completion('late'), { status: 200 })); await f.close() }
})

test('cancelling during a held credential read settles result before done and joins native exit', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch })
  f.credentials.holding = true
  try {
    const run = await start(f.harness)
    const read = await readAt(f.credentials, 0)
    const waiting = f.harness.waitRun(run.id)
    assert.equal((await f.harness.cancelRun(run.id)).status, 'cancelling')
    assert.equal(await read.aborted.promise, 'user-requested')
    let exited = false
    void waiting.then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    f.credentials.release()
    assert.equal((await waiting).status, 'cancelled')
    assert.equal(held.requests.length, 0)
  } finally { f.credentials.release(); await f.close() }
})

test('a direct call settles result on read cancellation while done waits for the reader', async () => {
  const held = heldFetch()
  const f = await apiFixture({ fetch: held.fetch })
  f.credentials.holding = true
  try {
    const call = f.llm.call({ plan: f.llm.prepare('default'), messages })
    const read = await readAt(f.credentials, 0)
    call.cancel('user-requested')
    assert.equal(await read.aborted.promise, 'user-requested')
    await assert.rejects(call.result, error => error.category === 'provider-failure')
    let exited = false
    void call.done.then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    f.credentials.release()
    await call.done
    assert.equal(exited, true)
    assert.equal(held.requests.length, 0)
  } finally { f.credentials.release(); await f.close() }
})

test('revoking the credential source stops the API component and its Runs until a source returns', async () => {
  const held = heldFetch()
  const f = await harnessFixture({ fetch: held.fetch })
  try {
    const run = await start(f.harness)
    const waiting = f.harness.waitRun(run.id)
    let revoked = false
    await requestAt(held, 0)
    const revoking = f.source.dispose().then(() => { revoked = true })
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'dependency-unavailable')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(revoked, false)
    ;(await requestAt(held, 0)).released.resolve()
    assert.equal((await waiting).errorCategory, 'dependency-unavailable')
    await revoking
    assert.equal(f.api.state, FiberState.PENDING)
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(runServiceKey), undefined)

    const replacement = memoryCredentials(withKey('replacement-key'))
    await f.root.installComponent(replacement.component())
    await serviceReady(f.root, runServiceKey)
    assert.equal(f.api.state, FiberState.ACTIVE)
    const fresh = await f.harness.startRun({ sessionId: run.sessionId, input: 'Again', idempotencyKey: 'again' })
    assert.equal((await requestAt(held, 1)).init.headers.Authorization, 'Bearer replacement-key')
    held.release()
    await f.harness.waitRun(fresh.id)
  } finally { held.release(); await f.close() }
})

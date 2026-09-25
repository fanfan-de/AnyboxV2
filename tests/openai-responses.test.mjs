import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { credentialReadServiceKey } from '../dist/credentials/port.js'
import { createOpenAIResponsesComponent, openAIResponsesCredentialId } from '../dist/llm/openai-responses/component.js'
import { responsesEndpoint, validateOpenAIResponsesConfiguration } from '../dist/llm/openai-responses/domain.js'
import { llmServiceKey } from '../dist/llm/port.js'
import { runServiceKey } from '../dist/run/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { deferred } from './helpers/controlled-llm.mjs'
import { memoryCredentials } from './helpers/memory-credentials.mjs'

const profile = (overrides = {}) => ({
  id: 'default', model: 'test-model', maxOutputTokens: 128, timeoutMs: 30_000, ...overrides,
})
const config = (version = 'v1', profiles = [profile()]) => ({ version, profiles })
const messages = [
  { role: 'system', content: 'System instruction' },
  { role: 'developer', content: 'Developer instruction' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: 'Continue' },
]
const output = text => ({ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] })
const completed = (...items) => ({ object: 'response', status: 'completed', output: items })
const withKey = key => ({ [openAIResponsesCredentialId]: key })
const settle = promise => promise.then(() => {}, () => {})
const requestAt = async (held, index) => {
  for (let i = 0; i < 100 && !held.requests[index]; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(held.requests[index], `request ${index} did not start`)
  return held.requests[index]
}

async function localServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

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

async function apiFixture(transport = {}, configuration = config(), key = 'local-key') {
  const root = new Context()
  const credentials = memoryCredentials(withKey(key))
  await root.installComponent(credentials.component())
  const fiber = root.installComponent(createOpenAIResponsesComponent(configuration, transport))
  await fiber
  assert.equal(fiber.state, FiberState.ACTIVE)
  return { root, fiber, credentials, llm: root.get(llmServiceKey), close: () => root.fiber.dispose() }
}

async function harnessFixture(transport = {}, configuration = config()) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-openai-responses-'))
  const root = new Context()
  const credentials = memoryCredentials(withKey('local-key'))
  try {
    await root.installComponent(credentials.component())
    const api = root.installComponent(createOpenAIResponsesComponent(configuration, transport))
    await api
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', instructions: 'Answer briefly.', modelProfileId: 'default' }],
    })
    return {
      root, api, credentials, harness,
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

async function serviceReady(root, name) {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const probe = root.inject([name], () => ready())
  await started
  await probe.dispose()
}

async function createSession(harness) {
  const project = await harness.openProject(process.cwd())
  return harness.createSession(project.id, 'assistant')
}

test('validates its own configuration and uses the Responses endpoint', () => {
  assert.throws(() => validateOpenAIResponsesConfiguration(config(' ')), /version/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [])), /non-empty/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [profile({ timeoutMs: 0 })])), /timeoutMs/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [profile({ maxOutputTokens: 0 })])), /maxOutputTokens/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [profile({ temperature: 3 })])), /temperature/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [profile({ topP: 1 })])), /unsupported/)
  assert.throws(() => validateOpenAIResponsesConfiguration(config('v1', [profile(), profile()])), /duplicate/)
  assert.throws(() => validateOpenAIResponsesConfiguration({ ...config(), provider: 'openai' }), /unsupported/)
  assert.deepEqual(validateOpenAIResponsesConfiguration(config()).get('default'), { ...profile(), configVersion: 'v1' })
  assert.equal(responsesEndpoint().href, 'https://api.openai.com/v1/responses')
  assert.equal(responsesEndpoint('http://127.0.0.1:8080/v1').href, 'http://127.0.0.1:8080/v1/responses')
  assert.throws(() => responsesEndpoint('ftp://example.com'), /HTTP/)
  assert.throws(() => createOpenAIResponsesComponent(config(), { fetch: 'nope' }), /fetch/)
})

test('sends native non-streaming input with all roles and returns final text after reasoning', async () => {
  let received
  const server = await localServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received = {
      method: request.method, path: request.url, authorization: request.headers.authorization,
      contentType: request.headers['content-type'], body: JSON.parse(body),
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(completed(
      { type: 'reasoning', summary: [] },
      { ...output('thinking'), phase: 'commentary' },
      { ...output('Final answer'), phase: 'final' },
    )))
  })
  const f = await apiFixture({ baseUrl: server.baseUrl }, config('v2', [profile({ temperature: 0.4 })]))
  try {
    const plan = f.llm.prepare('default')
    assert.deepEqual(plan, { snapshot: { profileId: 'default', configVersion: 'v2' } })
    const call = f.llm.call({ plan, messages })
    assert.equal(await call.result, 'Final answer')
    await call.done
    assert.deepEqual(received, {
      method: 'POST', path: '/v1/responses', authorization: 'Bearer local-key', contentType: 'application/json',
      body: {
        model: 'test-model', input: messages, max_output_tokens: 128, temperature: 0.4, stream: false, store: false,
      },
    })
    assert.equal(JSON.stringify(plan).includes('local-key'), false)
  } finally { await f.close(); await server.close() }
})

test('completes a Harness Run and keeps the native response and credential out of snapshots', async () => {
  const server = await localServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(completed(output('Hello from Responses'))))
  })
  const f = await harnessFixture({ baseUrl: server.baseUrl })
  try {
    const session = await createSession(f.harness)
    const run = await f.harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: 'one' })
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'Hello from Responses')
    assert.deepEqual(terminal.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
    assert.equal(JSON.stringify(terminal).includes('local-key'), false)
    assert.deepEqual((await f.harness.getSession(session.id)).turns, [{ input: 'Hello', output: 'Hello from Responses' }])
  } finally { await f.close(); await server.close() }
})

test('rejects incomplete, tool, refusal, malformed, and HTTP error responses with fixed categories', async () => {
  const replies = [
    new Response('secret provider error', { status: 401 }),
    new Response('{bad json', { status: 200 }),
    Response.json({ object: 'response', status: 'incomplete', output: [output('partial')] }),
    Response.json(completed({ type: 'function_call', name: 'tool', arguments: '{}' })),
    Response.json(completed({ ...output(''), content: [{ type: 'refusal', refusal: 'no' }] })),
    Response.json(completed({ ...output('thinking'), phase: 'commentary' })),
  ]
  const f = await apiFixture({ fetch: async () => replies.shift() })
  try {
    const plan = f.llm.prepare('default')
    for (const category of ['provider-failure', 'invalid-response', 'invalid-response', 'invalid-response',
      'invalid-response', 'invalid-response']) {
      const call = f.llm.call({ plan, messages })
      await assert.rejects(call.result, error => error.category === category && !error.message.includes('secret'))
      await call.done
    }
    assert.throws(() => f.llm.call({ plan, messages: [] }), error => error.category === 'unsupported-request')
    assert.throws(() => f.llm.prepare('missing'), error => error.category === 'model-unavailable')
    const other = await apiFixture()
    try { assert.throws(() => other.llm.call({ plan, messages }), error => error.category === 'model-unavailable') }
    finally { await other.close() }
  } finally { await f.close() }
})

test('timeout resolves result before done and waits for the transport to exit', async () => {
  const held = heldFetch()
  const f = await apiFixture({ fetch: held.fetch }, config('v1', [profile({ timeoutMs: 10 })]))
  try {
    const call = f.llm.call({ plan: f.llm.prepare('default'), messages })
    await assert.rejects(call.result, error => error.category === 'timeout')
    assert.equal(await (await requestAt(held, 0)).aborted.promise, 'timeout')
    let exited = false
    const waiting = call.done.then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    held.release()
    await waiting
  } finally { held.release(); await f.close() }
})

test('disposing the component aborts and joins an in-flight direct call', async () => {
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
    held.release()
    await assert.rejects(call.result, error => error.category === 'provider-failure')
    await call.done
    await stopping
    assert.equal(f.root.get(llmServiceKey), undefined)
  } finally { held.release(); await f.close() }
})

test('key rotation and deletion apply to later calls without component restart', async () => {
  const requests = []
  const fetch = (_url, init) => {
    const gate = deferred()
    requests.push({ authorization: init.headers.Authorization, gate })
    return gate.promise
  }
  const f = await harnessFixture({ fetch })
  try {
    const start = async key => {
      const session = await createSession(f.harness)
      return await f.harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: key })
    }
    const first = await start('one')
    for (let i = 0; i < 100 && !requests[0]; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests[0].authorization, 'Bearer local-key')
    f.credentials.secrets.set(openAIResponsesCredentialId, 'rotated-key')
    const second = await start('two')
    for (let i = 0; i < 100 && !requests[1]; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests[1].authorization, 'Bearer rotated-key')
    f.credentials.secrets.delete(openAIResponsesCredentialId)
    requests[0].gate.resolve(Response.json(completed(output('old'))))
    requests[1].gate.resolve(Response.json(completed(output('new'))))
    assert.equal((await f.harness.waitRun(first.id)).output, 'old')
    assert.equal((await f.harness.waitRun(second.id)).output, 'new')
    const missing = await start('three')
    assert.equal((await f.harness.waitRun(missing.id)).errorCategory, 'credential-missing')
    assert.equal(f.api.state, FiberState.ACTIVE)
    assert.equal(requests.length, 2)
  } finally { for (const request of requests) request.gate.resolve(Response.json(completed(output('late')))); await f.close() }
})

test('missing and unreadable credentials fail a call with fixed categories while llm stays ready', async () => {
  const root = new Context()
  const credentials = memoryCredentials()
  try {
    const fiber = root.installComponent(createOpenAIResponsesComponent(config()))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fiber.state, FiberState.PENDING)
    assert.deepEqual(fiber.inspect().dependencies.map(item => item.serviceName), [credentialReadServiceKey])
    await root.installComponent(credentials.component())
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    const llm = root.get(llmServiceKey)
    const call = () => llm.call({ plan: llm.prepare('default'), messages })
    const missing = call()
    await assert.rejects(missing.result, error => error.category === 'credential-missing')
    await missing.done
    credentials.failure = new Error('private store URL and secret')
    const unreadable = call()
    await assert.rejects(unreadable.result, error => error.category === 'credential-unavailable' && !error.message.includes('private'))
    await unreadable.done
    assert.equal(root.get(llmServiceKey), llm)
  } finally { await root.fiber.dispose() }
})

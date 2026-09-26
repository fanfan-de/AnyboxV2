import { applyPatchToolDefinition } from '../dist/tool/apply-patch-component.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { bashToolDefinition } from '../dist/tool/bash-component.js'
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
  for (let i = 0; i < 500 && !held.requests[index]; i++) await new Promise(resolve => setTimeout(resolve, 10))
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
    const source = root.installComponent(credentials.component())
    await source
    const api = root.installComponent(createOpenAIResponsesComponent(configuration, transport))
    await api
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', instructions: 'Answer briefly.', modelProfileId: 'default' }],
    })
    return {
      root, source, api, credentials, harness, directory,
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
  const { maxOutputTokens, ...unlimited } = profile()
  assert.deepEqual(validateOpenAIResponsesConfiguration(config('v1', [unlimited])).get('default'),
    { ...unlimited, configVersion: 'v1' })
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
      { ...output('Final answer'), phase: 'final_answer' },
    )))
  })
  const f = await apiFixture({ baseUrl: server.baseUrl }, config('v2', [profile({ temperature: 0.4 })]))
  try {
    const plan = f.llm.prepare('default')
    assert.deepEqual(plan, { snapshot: { profileId: 'default', configVersion: 'v2' } })
    const call = f.llm.call({ plan, messages })
    assert.deepEqual(await call.result, { kind: 'final', text: 'Final answer' })
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
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'one' })
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'Hello from Responses')
    assert.deepEqual(terminal.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
    assert.equal(JSON.stringify(terminal).includes('local-key'), false)
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [{ input: 'Hello', output: 'Hello from Responses' }])
  } finally { await f.close(); await server.close() }
})

test('rejects incomplete, unsolicited tool, refusal, malformed, and HTTP error responses with fixed categories', async () => {
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
      return await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: key })
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

const toolCall = (id, command, overrides = {}) => ({
  type: 'function_call', id: `item-${id}`, call_id: id, name: 'bash',
  arguments: JSON.stringify({ command }), status: 'completed', ...overrides,
})
const toolMessages = (history, reply, observations = reply.calls.map(call => ({ id: call.id, content: 'observed' }))) => [
  ...history, { role: 'assistant', content: reply.content ?? null, toolCalls: reply.calls },
  ...observations.map(({ id, content }) => ({ role: 'tool', toolCallId: id, content })),
]
const finish = async call => {
  const reply = await call.result
  await call.done
  return reply
}
const startToolRun = async (fixture, idempotencyKey = 'tools') => {
  const project = await fixture.harness.openProject(fixture.directory)
  const session = await fixture.harness.createSession(project.id, 'assistant')
  return fixture.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Use Bash', idempotencyKey })
}

// Keep the next model step alive even after cancellation to exercise actual resource exit.
function toolThenHeldFetch() {
  const requests = []
  return {
    requests,
    fetch(_url, init) {
      const entry = { init, body: JSON.parse(init.body), aborted: deferred(), released: deferred() }
      requests.push(entry)
      init.signal.addEventListener('abort', () => entry.aborted.resolve(init.signal.reason))
      if (requests.length === 1) return Promise.resolve(Response.json(completed(toolCall('first', 'printf first'))))
      return entry.released.promise.then(() => Response.json(completed(toolCall('late', 'printf late > late-marker'))))
    },
    release() { for (const request of requests) request.released.resolve() },
  }
}

test('Responses runs three HTTP rounds, replays native reasoning and phase, and executes long Bash batches serially', async () => {
  const text = `<!doctype html>\n${'<!-- 原样保存完整工具参数 -->\n'.repeat(700)}`
  const command = `cat > source.html <<'ANYBOX_RESPONSES_HTML'\n${text}ANYBOX_RESPONSES_HTML\n`
  assert.ok(Buffer.byteLength(command) > 8_192)
  const firstOutput = [
    { id: 'reasoning-one', type: 'reasoning', summary: [], encrypted_content: 'encrypted-first' },
    { id: 'commentary-one', ...output('I will create and verify the file.'), phase: 'commentary' },
    toolCall('write', command), toolCall('copy', 'cat source.html > copied.html'),
  ]
  const secondOutput = [
    { id: 'reasoning-two', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Verify the saved result.' }], encrypted_content: 'encrypted-second' },
    { id: 'commentary-two', ...output('Checking the copied file.'), phase: null },
    toolCall('verify', 'cmp source.html copied.html && printf verified'),
  ]
  const received = []
  const server = await localServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ body: JSON.parse(body), authorization: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(completed(...(received.length === 1 ? firstOutput : received.length === 2 ? secondOutput
      : [{ ...output('File saved and verified.'), phase: 'final_answer' }]))))
  })
  const { maxOutputTokens, ...unlimited } = profile()
  const f = await harnessFixture({ baseUrl: server.baseUrl }, config('v1', [unlimited]))
  try {
    assert.equal(f.root.get(llmServiceKey).supportsTools, true)
    const run = await startToolRun(f)
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'File saved and verified.')
    assert.equal(readFileSync(join(f.directory, 'source.html'), 'utf8'), text)
    assert.equal(readFileSync(join(f.directory, 'copied.html'), 'utf8'), text)
    assert.equal(received.length, 3)
    assert.equal(f.credentials.reads.length, 1)
    for (const { body, authorization } of received) {
      assert.equal(authorization, 'Bearer local-key')
      assert.equal(body.store, false)
      assert.equal(body.stream, false)
      assert.equal(Object.hasOwn(body, 'max_output_tokens'), false)
      assert.equal(Object.hasOwn(body, 'previous_response_id'), false)
      assert.deepEqual(body.tools, [bashToolDefinition, applyPatchToolDefinition].map(definition => ({ type: 'function', ...definition, strict: false })))
      assert.deepEqual(body.include, ['reasoning.encrypted_content'])
    }
    const initial = received[0].body.input
    const afterFirst = received[1].body.input
    assert.deepEqual(afterFirst.slice(0, initial.length + firstOutput.length), [...initial, ...firstOutput])
    const firstObservations = afterFirst.slice(initial.length + firstOutput.length)
    assert.deepEqual(firstObservations.map(({ type, call_id }) => ({ type, call_id })), [
      { type: 'function_call_output', call_id: 'write' }, { type: 'function_call_output', call_id: 'copy' },
    ])
    for (const observation of firstObservations) assert.equal(JSON.parse(observation.output).exitCode, 0)
    const afterSecond = received[2].body.input
    assert.deepEqual(afterSecond.slice(0, afterFirst.length + secondOutput.length), [...afterFirst, ...secondOutput])
    assert.equal(afterSecond.at(-1).call_id, 'verify')
    assert.equal(JSON.parse(afterSecond.at(-1).output).stdout, 'verified')
    const events = await f.harness.getRunEvents(run.id)
    assert.deepEqual(events.map(event => event.kind), [
      'model-started', 'model-tool-calls', 'tool-started', 'tool-observed', 'tool-started', 'tool-observed',
      'model-started', 'model-tool-calls', 'tool-started', 'tool-observed', 'model-started', 'terminal',
    ])
    assert.equal(events.find(event => event.kind === 'tool-started').call.arguments.command, command)
    const nodes = (await f.harness.listNodes(run.sessionId, null)).nodes
    assert.equal(nodes.length, 1)
    for (const privateValue of ['encrypted-first', 'encrypted-second', 'local-key', 'commentary-one']) {
      assert.equal(JSON.stringify([terminal, events, nodes]).includes(privateValue), false)
    }
  } finally { await f.close(); await server.close() }
})

test('malformed JSON, duplicate call IDs, unknown tools, and invalid Bash parameters reject an entire Responses batch', async t => {
  for (const [name, invalid] of [
    ['malformed JSON', toolCall('bad', '', { arguments: '{broken' })],
    ['duplicate ID', toolCall('valid', 'printf should-not-run')],
    ['unknown tool', toolCall('bad', 'printf should-not-run', { name: 'unregistered-tool' })],
    ['invalid parameters', toolCall('bad', '', { arguments: '{"command":42}' })],
  ]) {
    await t.test(name, async () => {
      const f = await harnessFixture({ fetch: async () => Response.json(completed(
        toolCall('valid', 'printf unsafe > marker'), invalid,
      )) })
      try {
        const run = await startToolRun(f)
        const terminal = await f.harness.waitRun(run.id)
        assert.equal(terminal.status, 'failed')
        assert.equal(terminal.errorCategory, 'invalid-tool-request')
        assert.equal(existsSync(join(f.directory, 'marker')), false)
        assert.equal((await f.harness.getRunEvents(run.id)).some(event => event.kind === 'tool-started'), false)
        assert.deepEqual((await f.harness.listNodes(run.sessionId, null)).nodes, [])
      } finally { await f.close() }
    })
  }
})

test('Responses accepts final_answer, omitted and null phase and rejects legacy final and malformed commentary', async () => {
  const replies = [
    completed({ ...output('explicit'), phase: 'final_answer' }), completed(output('omitted')),
    completed({ ...output('nullable'), phase: null }), completed({ ...output('legacy'), phase: 'final' }),
    completed({ ...output(''), phase: 'commentary', content: [{ type: 'refusal', refusal: 'private refusal' }] }, output('answer')),
  ]
  const f = await apiFixture({ fetch: async () => Response.json(replies.shift()) })
  try {
    for (const text of ['explicit', 'omitted', 'nullable']) {
      assert.deepEqual(await finish(f.llm.call({ plan: f.llm.prepare('default'), messages })), { kind: 'final', text })
    }
    for (let i = 0; i < 2; i++) {
      const call = f.llm.call({ plan: f.llm.prepare('default'), messages })
      await assert.rejects(call.result, error => error.category === 'invalid-response')
      await call.done
    }
  } finally { await f.close() }
})

test('Responses preserves each concurrent plan context and reuses its first key across later tool steps', async () => {
  const received = []
  const gates = new Map()
  const f = await apiFixture({ fetch: (_url, init) => {
    const body = JSON.parse(init.body)
    const tag = body.input.find(message => message.role === 'user').content
    received.push({ tag, body, authorization: init.headers.Authorization })
    if (body.input.some(item => item.type === 'function_call_output')) {
      return Promise.resolve(Response.json(completed(output(`Finished ${tag}`))))
    }
    const gate = deferred()
    gates.set(tag, gate)
    return gate.promise
  } })
  try {
    const planA = f.llm.prepare('default'), planB = f.llm.prepare('default')
    const a = [{ role: 'user', content: 'A' }], b = [{ role: 'user', content: 'B' }]
    const firstA = f.llm.call({ plan: planA, messages: a, tools: [bashToolDefinition] })
    await requestAt({ requests: received }, 0)
    f.credentials.secrets.set(openAIResponsesCredentialId, 'rotated-key')
    const firstB = f.llm.call({ plan: planB, messages: b, tools: [bashToolDefinition] })
    await requestAt({ requests: received }, 1)
    const native = tag => [
      { id: `reason-${tag}`, type: 'reasoning', summary: [], encrypted_content: `encrypted-${tag}` },
      toolCall('shared-call-id', `printf ${tag}`),
    ]
    gates.get('B').resolve(Response.json(completed(...native('B'))))
    gates.get('A').resolve(Response.json(completed(...native('A'))))
    const [replyA, replyB] = await Promise.all([finish(firstA), finish(firstB)])
    f.credentials.secrets.delete(openAIResponsesCredentialId)
    const [finalA, finalB] = await Promise.all([
      finish(f.llm.call({ plan: planA, messages: toolMessages(a, replyA), tools: [bashToolDefinition] })),
      finish(f.llm.call({ plan: planB, messages: toolMessages(b, replyB), tools: [bashToolDefinition] })),
    ])
    assert.equal(finalA.text, 'Finished A')
    assert.equal(finalB.text, 'Finished B')
    for (const tag of ['A', 'B']) {
      const requests = received.filter(item => item.tag === tag)
      assert.deepEqual(requests.map(item => item.authorization), Array(2).fill(tag === 'A' ? 'Bearer local-key' : 'Bearer rotated-key'))
      assert.deepEqual(requests[1].body.input.slice(1, 3), native(tag))
      assert.equal(JSON.stringify(requests[1].body.input).includes(`encrypted-${tag === 'A' ? 'B' : 'A'}`), false)
      assert.equal(requests[1].body.input.at(-1).call_id, 'shared-call-id')
    }
    assert.equal(f.credentials.reads.length, 2)
    const missing = f.llm.call({ plan: f.llm.prepare('default'), messages })
    await assert.rejects(missing.result, error => error.category === 'credential-missing')
    await missing.done
    assert.equal(received.length, 4)
  } finally {
    for (const gate of gates.values()) gate.resolve(Response.json(completed(output('released'))))
    await f.close()
  }
})

test('Responses rejects changed history or incomplete observations before acquiring transport and retries a failed continuation unchanged', async () => {
  const received = []
  const native = [
    { type: 'reasoning', summary: [], encrypted_content: 'retain-on-retry' },
    toolCall('one', 'printf one'), toolCall('two', 'printf two'),
  ]
  const f = await apiFixture({ fetch: async (_url, init) => {
    received.push(JSON.parse(init.body))
    if (received.length === 1) return Response.json(completed(...native))
    if (received.length === 2) return new Response('private failure', { status: 503 })
    return Response.json(completed(output('Retried')))
  } })
  try {
    const plan = f.llm.prepare('default')
    const reply = await finish(f.llm.call({ plan, messages, tools: [bashToolDefinition] }))
    const history = toolMessages(messages, reply, [{ id: 'one', content: 'first' }, { id: 'two', content: 'second' }])
    const changed = structuredClone(history)
    changed[0].content = 'changed policy'
    const changedCall = structuredClone(history)
    changedCall[messages.length].toolCalls[0].arguments.command = 'changed command'
    const invalidHistories = [
      messages, history.slice(0, -1), changed, changedCall,
      [...history.slice(0, -2), history.at(-1), history.at(-2)],
      [...history, { role: 'tool', toolCallId: 'extra', content: 'unexpected' }],
    ]
    for (const input of invalidHistories) {
      assert.throws(() => f.llm.call({ plan, messages: input, tools: [bashToolDefinition] }),
        error => error.category === 'unsupported-request')
    }
    assert.equal(received.length, 1)
    const failed = f.llm.call({ plan, messages: history, tools: [bashToolDefinition] })
    await assert.rejects(failed.result, error => error.category === 'provider-failure')
    await failed.done
    assert.deepEqual(await finish(f.llm.call({ plan, messages: history, tools: [bashToolDefinition] })),
      { kind: 'final', text: 'Retried' })
    assert.deepEqual(received[2], received[1])
    assert.deepEqual(received[2].input.slice(messages.length, messages.length + native.length), native)
    assert.equal(f.credentials.reads.length, 1)
  } finally { await f.close() }
})

for (const stage of ['fetch', 'response JSON']) {
  test(`a Responses cancellation during ${stage} keeps the plan busy through cleanup and ignores late output before retry`, async () => {
    const received = []
    const gate = deferred(), aborted = deferred(), jsonStarted = deferred()
    const cleanupStarted = deferred(), cleanupReleased = deferred()
    const original = [toolCall('first', 'printf first')]
    const latePayload = completed(
      { type: 'reasoning', summary: [], encrypted_content: 'must-not-commit' }, toolCall('late', 'printf late'),
    )
    const f = await apiFixture({ fetch: (_url, init) => {
      received.push(JSON.parse(init.body))
      if (received.length === 1) return Promise.resolve(Response.json(completed(...original)))
      if (received.length === 2) {
        init.signal.addEventListener('abort', () => aborted.resolve(init.signal.reason))
        if (stage === 'fetch') return gate.promise
        // Separate response parsing from fetch settlement to cover cancellation during body consumption.
        return Promise.resolve({ ok: true, json() { jsonStarted.resolve(); return gate.promise } })
      }
      return Promise.resolve(Response.json(completed(output('Retry succeeded'))))
    } })
    try {
      const plan = f.llm.prepare('default')
      const reply = await finish(f.llm.call({ plan, messages, tools: [bashToolDefinition] }))
      const history = toolMessages(messages, reply)
      const call = f.llm.call({ plan, messages: history, tools: [bashToolDefinition] })
      await requestAt({ requests: received }, 1)
      if (stage === 'response JSON') await jsonStarted.promise
      const assertBusy = () => assert.throws(() => f.llm.call({ plan, messages: history, tools: [bashToolDefinition] }),
        error => error.category === 'unsupported-request')
      assertBusy()
      call.cancel('test-cancel')
      assert.equal(await aborted.promise, 'test-cancel')
      await assert.rejects(call.result, error => error.category === 'provider-failure')
      let exited = false
      void call.done.then(() => { exited = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(exited, false)
      assertBusy()
      if (stage === 'fetch') {
        gate.resolve(new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(latePayload))) },
          cancel() { cleanupStarted.resolve(); return cleanupReleased.promise },
        })))
        await cleanupStarted.promise
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(exited, false)
        assertBusy()
        cleanupReleased.resolve()
      } else gate.resolve(latePayload)
      await call.done
      assert.equal((await finish(f.llm.call({ plan, messages: history, tools: [bashToolDefinition] }))).text, 'Retry succeeded')
      assert.deepEqual(received[2], received[1])
      assert.equal(JSON.stringify(received[2]).includes('must-not-commit'), false)
    } finally {
      gate.resolve(Response.json(completed(output('released'))))
      cleanupReleased.resolve()
      await f.close()
    }
  })
}

test('failed cleanup after cancelling a Responses continuation preserves its checkpoint and is reported on close', async () => {
  const received = []
  const gate = deferred()
  const f = await apiFixture({ fetch: (_url, init) => {
    received.push(JSON.parse(init.body))
    if (received.length === 1) return Promise.resolve(Response.json(completed(toolCall('first', 'printf first'))))
    if (received.length === 2) return gate.promise
    return Promise.resolve(Response.json(completed(output('Retried after cleanup failure'))))
  } })
  try {
    const plan = f.llm.prepare('default')
    const reply = await finish(f.llm.call({ plan, messages, tools: [bashToolDefinition] }))
    const history = toolMessages(messages, reply)
    const call = f.llm.call({ plan, messages: history, tools: [bashToolDefinition] })
    await requestAt({ requests: received }, 1)
    call.cancel('test-cancel')
    await assert.rejects(call.result, error => error.category === 'provider-failure')
    gate.resolve(new Response(new ReadableStream({ cancel() { throw new Error('private cleanup failure') } })))
    await assert.rejects(call.done, error => error.category === 'cleanup-failure' && !error.message.includes('private'))
    assert.equal((await finish(f.llm.call({ plan, messages: history, tools: [bashToolDefinition] }))).text,
      'Retried after cleanup failure')
    assert.deepEqual(received[2], received[1])
    await assert.rejects(f.close())
  } finally { gate.resolve(Response.json(completed(output('released')))); await settle(f.close()) }
})

for (const action of ['timeout', 'cancel', 'close']) {
  test(`Responses tool continuation ${action} waits for transport exit and cannot execute a late tool or create a node`, async () => {
    const held = toolThenHeldFetch()
    const f = await harnessFixture({ fetch: held.fetch }, config('v1', [profile({ timeoutMs: action === 'timeout' ? 100 : 30_000 })]))
    try {
      const run = await startToolRun(f)
      const waiting = f.harness.waitRun(run.id)
      const continuation = await requestAt(held, 1)
      let closing
      let closed = false
      if (action === 'cancel') assert.equal((await f.harness.cancelRun(run.id)).status, 'cancelling')
      if (action === 'close') closing = f.harness.close().then(() => { closed = true })
      assert.equal(await continuation.aborted.promise, action === 'timeout' ? 'timeout' : action === 'cancel' ? 'user-requested' : 'owner-disposed')
      let settled = false
      void waiting.then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false)
      assert.equal(closed, false)
      held.release()
      const terminal = await waiting
      assert.equal(terminal.status, action === 'timeout' ? 'failed' : 'cancelled')
      if (action === 'timeout') assert.equal(terminal.errorCategory, 'timeout')
      assert.equal(existsSync(join(f.directory, 'late-marker')), false)
      if (action !== 'close') {
        assert.deepEqual((await f.harness.listNodes(run.sessionId, null)).nodes, [])
        assert.equal((await f.harness.getRunEvents(run.id)).filter(event => event.kind === 'tool-started').length, 1)
      }
      await closing
      assert.equal(held.requests.length, 2)
    } finally { held.release(); await f.close() }
  })
}

for (const dependency of ['API component', 'credential source']) {
  test(`revoking the Responses ${dependency} during a tool continuation waits for exit and a replacement serves new Runs`, async () => {
    const held = toolThenHeldFetch()
    const f = await harnessFixture({ fetch: held.fetch })
    try {
      const run = await startToolRun(f)
      const waiting = f.harness.waitRun(run.id)
      const continuation = await requestAt(held, 1)
      let disposed = false
      const stopping = (dependency === 'API component' ? f.api : f.source).dispose().then(() => { disposed = true })
      assert.equal(await continuation.aborted.promise, 'dependency-unavailable')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(disposed, false)
      held.release()
      const terminal = await waiting
      assert.equal(terminal.status, 'failed')
      assert.equal(terminal.errorCategory, 'dependency-unavailable')
      await stopping
      assert.equal(existsSync(join(f.directory, 'late-marker')), false)
      assert.deepEqual((await f.harness.listNodes(run.sessionId, null)).nodes, [])
      assert.equal(f.root.get(llmServiceKey), undefined)
      assert.equal(f.root.get(runServiceKey), undefined)
      let authorization
      if (dependency === 'credential source') {
        assert.equal(f.api.state, FiberState.PENDING)
        const replacement = memoryCredentials(withKey('replacement-key'))
        // Replace the pending API as well so the new Run uses a completing transport.
        await f.api.dispose()
        await f.root.installComponent(replacement.component())
      } else f.credentials.secrets.set(openAIResponsesCredentialId, 'replacement-key')
      await f.root.installComponent(createOpenAIResponsesComponent(config('v2'), {
        fetch: async (_url, init) => {
          authorization = init.headers.Authorization
          return Response.json(completed(output('Replacement completed')))
        },
      }))
      await serviceReady(f.root, runServiceKey)
      const fresh = await f.harness.startRun({ sessionId: run.sessionId, parentNodeId: null, input: 'Again', idempotencyKey: 'replacement' })
      assert.equal(fresh.llmSnapshot.configVersion, 'v2')
      assert.equal((await f.harness.waitRun(fresh.id)).output, 'Replacement completed')
      assert.equal(authorization, 'Bearer replacement-key')
    } finally { held.release(); await f.close() }
  })
}

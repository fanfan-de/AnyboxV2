import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createExecutionHost } from '../../host/dist/execution.js'
import { claudeAgentServerApplication } from '../dist/registration.js'
import { claudeAgentSdkServiceKey } from '../dist/core/sdk/port.js'
import { createLocalHttpStream } from '../dist/local-execution/http-stream.js'
import { localExecutionLimits } from '../dist/local-execution/protocol.js'
import { fakeSdk, fakeEnvironment, sampleResult } from '../../../tests/helpers/claude-agent.mjs'

async function until(work) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await delay(5) }
  throw new Error('local execution observation deadline')
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-local-'))
  const sdk = fakeSdk({ onClose(run) {
    run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } })
    if (options.exitOnClose !== false) run.exit()
  } })
  const sdkComponent = { name: 'local-test-sdk', apply(ctx) { ctx.provide(claudeAgentSdkServiceKey, sdk.port) } }
  const application = claudeAgentServerApplication({}, { sdkComponent, runs: { directoryExists: async () => true,
    cancel: { interruptTimeoutMs: 5, resultTimeoutMs: 10, exitTimeoutMs: 1000 } } })
  const host = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications: [application] })
  await host.ready
  t.after(async () => {
    for (const run of sdk.runs) { run.finish({ kind: 'result', result: sampleResult() }); run.exit() }
    await host.close(); await rm(directory, { recursive: true, force: true })
  })
  const channel = (payload, signal = new AbortController().signal) => application.channel.handle(host.root, payload, { signal, sourceRole: 'client', appId: 'claude-agent' })
  const request = async (method, path, body) => {
    const first = await channel({ type: 'request', method, path, ...(body === undefined ? {} : { body }), instanceId: host.instance.instanceId })
    const chunks = [Buffer.from(first.chunk, 'base64')]
    try {
      let frame = first
      while (!frame.done) { frame = await channel({ type: 'read', requestId: first.requestId, instanceId: first.instanceId }); chunks.push(Buffer.from(frame.chunk, 'base64')) }
    } finally { await channel({ type: 'close', requestId: first.requestId, instanceId: first.instanceId }) }
    return { status: first.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: first.headers }
  }
  return { directory, host, sdk, channel, request }
}

test('the private application channel describes a closed local target and uses the existing business routes without issuing credentials', async t => {
  const f = await fixture(t)
  assert.equal(f.host.products.get('claude-agent').state, 'disabled')
  assert.equal(f.host.root.get('claude-agent.sdk'), undefined)
  assert.deepEqual(await f.channel({ type: 'describe' }), { instanceId: f.host.instance.instanceId, name: '本机', capabilities: ['claude-agent.v1'] })
  assert.equal(f.host.root.get('claude-agent.sdk'), undefined, 'describing the target must not open its SDK or business resources')
  assert.equal((await f.request('GET', '/products/claude-agent')).data.state, 'disabled')
  assert.equal((await f.request('GET', '/apps/claude-agent/environment')).status, 503)
  assert.equal((await f.request('POST', '/products/claude-agent/open', {})).data.state, 'running')
  assert.deepEqual((await f.request('GET', '/apps/claude-agent/environment')).data, fakeEnvironment)
  assert.equal((await f.request('POST', '/apps/claude-agent/threads', { projectPath: '/p', unexpected: true })).status, 400)
  const thread = await f.request('POST', '/apps/claude-agent/threads', { projectPath: '/p', title: '本机项目' })
  assert.equal(thread.status, 201); assert.equal(thread.data.title, '本机项目')
  assert.deepEqual((await f.request('GET', '/apps/claude-agent/threads')).data.map(item => item.id), [thread.data.id])
  assert.equal((await f.request('POST', '/products/claude-agent/stop', {})).data.state, 'disabled')
  assert.deepEqual(await f.host.root.get('host.access').list(), [], 'local IPC never issues a device access token')
  assert.equal(f.host.root.get('claude-agent.connections'), undefined)
  for (const command of [
    { type: 'request', method: 'GET', path: '/apps/agent/projects' },
    { type: 'request', method: 'GET', path: 'https://example.invalid' },
    { type: 'request', method: 'GET', path: '/apps/claude-agent/../agent' },
  ]) await assert.rejects(f.channel(command), error => ['invalid-input', 'not-found'].includes(error.code))
  await assert.rejects(f.channel({ type: 'request', method: 'GET', path: '/instance', instanceId: randomUUID() }), { code: 'instance-mismatch' })
  await assert.rejects(f.channel({ type: 'request', method: 'POST', path: '/apps/claude-agent/threads', body: { projectPath: 'x'.repeat(localExecutionLimits.bodyBytes) } }), { code: 'request-too-large' })
})

test('private HTTP frames preserve UTF-8 bytes with bounded reads and backpressure', async () => {
  const stream = createLocalHttpStream('GET', undefined), text = '汉字🙂'.repeat(30_000)
  let exited = false
  stream.response.end(text, () => { exited = true })
  const head = await stream.head
  assert.equal(head.status, 200)
  await delay(5); assert.equal(exited, false, 'the writable must wait for the receiver to consume its buffered output')
  const chunks = []
  let frame
  do {
    frame = await stream.read()
    const bytes = Buffer.from(frame.chunk, 'base64')
    assert.ok(bytes.length <= localExecutionLimits.frameBytes)
    chunks.push(bytes)
  } while (!frame.done)
  assert.equal(Buffer.concat(chunks).toString('utf8'), text)
  await until(() => exited)
  stream.close()
})

test('SSE uses the existing ordered event stream, read cancellation closes its observation, and business stop drains subscriptions', async t => {
  const f = await fixture(t)
  await f.request('POST', '/products/claude-agent/open', {})
  const thread = (await f.request('POST', '/apps/claude-agent/threads', { projectPath: '/p' })).data
  const open = () => f.channel({ type: 'request', method: 'GET', path: `/apps/claude-agent/events?threadId=${thread.id}`, instanceId: f.host.instance.instanceId })
  const first = await open()
  assert.match(first.headers['content-type'], /text\/event-stream/)
  assert.match(Buffer.from(first.chunk, 'base64').toString(), /event: ready/)
  f.host.root.get('claude-agent.http').notifyChange({ threadId: thread.id, runId: 'one', status: 'running', seq: 1 })
  f.host.root.get('claude-agent.http').notifyChange({ threadId: thread.id, runId: 'one', status: 'completed', seq: 2 })
  let received = ''
  while (!received.includes('"seq":2')) {
    const frame = await f.channel({ type: 'read', requestId: first.requestId, instanceId: first.instanceId })
    received += Buffer.from(frame.chunk, 'base64').toString()
  }
  assert.ok(received.indexOf('"seq":1') < received.indexOf('"seq":2'))
  const controller = new AbortController()
  const pending = f.channel({ type: 'read', requestId: first.requestId, instanceId: first.instanceId }, controller.signal)
  await delay(5); controller.abort()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(f.host.products.get('claude-agent').state, 'running')
  assert.deepEqual(await f.channel({ type: 'close', requestId: first.requestId, instanceId: first.instanceId }), { instanceId: first.instanceId, closed: true })
  const second = await open()
  const stoppingRead = f.channel({ type: 'read', requestId: second.requestId, instanceId: second.instanceId })
  assert.equal((await f.request('POST', '/products/claude-agent/stop', {})).data.state, 'disabled')
  assert.equal((await stoppingRead).done, true)
  await assert.rejects(f.channel({ type: 'read', requestId: second.requestId, instanceId: second.instanceId }), { code: 'stream-not-found' })
})

test('a client-selected request identity closes an observation whose opening acknowledgement was lost', async t => {
  const f = await fixture(t)
  await f.request('POST', '/products/claude-agent/open', {})
  const requestId = randomUUID(), instanceId = f.host.instance.instanceId
  const opening = { type: 'request', requestId, method: 'GET', path: '/apps/claude-agent/events?threadId=one', instanceId }
  await f.channel(opening) // Model a reply that reached the transport but was lost before the caller consumed it.
  await assert.rejects(f.channel(opening), { code: 'request-conflict' })
  assert.deepEqual(await f.channel({ type: 'close', requestId, instanceId }), { instanceId, closed: true })
  await assert.rejects(f.channel({ type: 'read', requestId, instanceId }), { code: 'stream-not-found' })
  assert.equal(f.host.products.get('claude-agent').state, 'running')
})

test('a private watch cancellation drains an SSE observation while its browser has stopped pulling frames', async t => {
  const f = await fixture(t)
  await f.request('POST', '/products/claude-agent/open', {})
  const first = await f.channel({ type: 'request', requestId: randomUUID(), method: 'GET', path: '/apps/claude-agent/events?threadId=one', instanceId: f.host.instance.instanceId })
  const controller = new AbortController()
  const watch = f.channel({ type: 'watch', requestId: first.requestId, instanceId: first.instanceId }, controller.signal)
  f.host.root.get('claude-agent.http').notifyChange({ threadId: 'one', runId: 'run', status: 'running', seq: 1 })
  await delay(5)
  controller.abort()
  await assert.rejects(watch, { code: 'cancelled' })
  await assert.rejects(f.channel({ type: 'read', requestId: first.requestId, instanceId: first.instanceId }), { code: 'stream-not-found' })
  assert.equal(f.host.products.get('claude-agent').state, 'running')
  assert.equal((await f.request('POST', '/products/claude-agent/stop', {})).data.state, 'disabled', 'the subscription lease has actually exited')
})

test('reserved requests wait for their watch before opening any business and support either arrival order', async t => {
  const f = await fixture(t), requestId = randomUUID(), instanceId = f.host.instance.instanceId
  assert.deepEqual(await f.channel({ type: 'reserve', requestId, instanceId }), { requestId, instanceId, reserved: true })
  const opening = f.channel({ type: 'request', requestId, reserved: true, method: 'POST', path: '/products/claude-agent/open', body: {}, instanceId })
  await delay(5)
  assert.equal(f.host.root.get('claude-agent.sdk'), undefined)
  assert.equal(f.host.products.get('claude-agent').desiredEnabled, false)
  const controller = new AbortController()
  const watch = f.channel({ type: 'watch', requestId, instanceId }, controller.signal)
  const response = await opening
  assert.equal(response.requestId, requestId); assert.equal(response.status, 200)
  assert.equal(JSON.parse(Buffer.from(response.chunk, 'base64')).state, 'running')
  controller.abort(); await watch.catch(error => assert.equal(error.code, 'cancelled'))
  assert.equal(f.host.products.get('claude-agent').state, 'running')
})

test('a watch cancelled before request dispatch permanently revokes that reservation and a late request cannot initialize business', async t => {
  const f = await fixture(t), requestId = randomUUID(), instanceId = f.host.instance.instanceId
  await f.channel({ type: 'reserve', requestId, instanceId })
  const controller = new AbortController()
  const watch = f.channel({ type: 'watch', requestId, instanceId }, controller.signal)
  controller.abort(); await watch.catch(error => assert.equal(error.code, 'cancelled'))
  await assert.rejects(f.channel({ type: 'request', requestId, reserved: true, method: 'POST', path: '/products/claude-agent/open', body: {}, instanceId }), { code: 'request-reservation-unavailable' })
  assert.equal(f.host.root.get('claude-agent.sdk'), undefined)
  assert.equal(f.host.products.get('claude-agent').desiredEnabled, false)
})

test('request cancellation while waiting for watch attachment drains the intent and never dispatches HTTP', async t => {
  const f = await fixture(t), requestId = randomUUID(), instanceId = f.host.instance.instanceId
  await f.channel({ type: 'reserve', requestId, instanceId })
  const controller = new AbortController()
  const opening = f.channel({ type: 'request', requestId, reserved: true, method: 'POST', path: '/products/claude-agent/open', body: {}, instanceId }, controller.signal)
  await delay(5); controller.abort()
  await assert.rejects(opening, { code: 'cancelled' })
  assert.deepEqual(await f.channel({ type: 'watch', requestId, instanceId }), { instanceId, closed: true })
  await assert.rejects(f.channel({ type: 'request', requestId, reserved: true, method: 'POST', path: '/products/claude-agent/open', body: {}, instanceId }), { code: 'request-reservation-unavailable' })
  assert.equal(f.host.root.get('claude-agent.sdk'), undefined)
})

test('lightweight reservations are bounded and root shutdown drains requests still waiting for their watch', async t => {
  const f = await fixture(t), instanceId = f.host.instance.instanceId, ids = []
  for (let index = 0; index < localExecutionLimits.sessions; index++) {
    const requestId = randomUUID(); ids.push(requestId)
    await f.channel({ type: 'reserve', requestId, instanceId })
  }
  await assert.rejects(f.channel({ type: 'reserve', requestId: randomUUID(), instanceId }), { code: 'too-many-streams' })
  const opening = f.channel({ type: 'request', requestId: ids[0], reserved: true, method: 'POST', path: '/products/claude-agent/open', body: {}, instanceId })
  const rejected = assert.rejects(opening, { code: 'cancelled' })
  await f.host.close(); await rejected
  assert.equal(f.sdk.runs.length, 0)
})

test('closing private responses leaves an accepted Run protected and root shutdown still waits for its actual process exit', async t => {
  const f = await fixture(t, { exitOnClose: false })
  await f.request('POST', '/products/claude-agent/open', {})
  const thread = (await f.request('POST', '/apps/claude-agent/threads', { projectPath: '/p' })).data
  const requestId = randomUUID(), instanceId = f.host.instance.instanceId, controller = new AbortController()
  await f.channel({ type: 'reserve', requestId, instanceId })
  const watch = f.channel({ type: 'watch', requestId, instanceId }, controller.signal)
  const response = await f.channel({ type: 'request', requestId, reserved: true, method: 'POST', path: `/apps/claude-agent/threads/${thread.id}/runs`, body: { prompt: 'work', idempotencyKey: 'accepted' }, instanceId })
  const run = JSON.parse(Buffer.from(response.chunk, 'base64'))
  assert.equal(run.status, 'running')
  controller.abort(); await watch.catch(error => assert.equal(error.code, 'cancelled'))
  const observerId = randomUUID(), observer = new AbortController()
  await f.channel({ type: 'reserve', requestId: observerId, instanceId })
  const observing = f.channel({ type: 'watch', requestId: observerId, instanceId }, observer.signal)
  await f.channel({ type: 'request', requestId: observerId, reserved: true, method: 'GET', path: `/apps/claude-agent/events?threadId=${thread.id}`, instanceId })
  observer.abort(); await assert.rejects(observing, { code: 'cancelled' })
  assert.equal((await f.request('POST', '/products/claude-agent/stop', {})).data.error.code, 'product-busy')
  assert.equal(f.sdk.runs[0].interrupts, 0, 'closing the response is only an observation disconnect')
  assert.equal((await f.request('GET', `/apps/claude-agent/runs/${run.id}`)).data.status, 'running')
  let exited = false
  const closing = f.host.close().then(() => { exited = true })
  await until(() => f.sdk.runs[0].closed)
  assert.equal(exited, false)
  f.sdk.runs[0].exit()
  await closing
  assert.equal(exited, true)
})

import { createImageAssetsComponent } from '../dist/harness/image/component.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness/index.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { runViewEvent } from '../dist/harness/run/notifications.js'
import { installManagedModels } from './helpers/managed-models.mjs'
import { controlledModels, deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function host(directory, controlled) {
  const root = new Context()
  let transport = controlled
  if (transport) await root.installComponent(transport.component())
  else transport = (await installManagedModels(root, directory)).controlled
  await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'harness.sqlite')) + ".images" }))
  const harness = await createHarness(root, { agents: [{ id: 'assistant', instructions: 'Answer briefly.' }] })
  const project = await harness.openProject(directory)
  return { root, harness, project, transport, async close() {
    for (const call of transport.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await harness.close()
  } }
}
async function finish(f, run, text = 'Answer') {
  const call = f.transport.calls.at(-1)
  call.result.resolve(text); call.done.resolve()
  return f.harness.waitRun(run.id)
}

test('explicit Session selection persists and omitted-id idempotency keeps the original model snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-model-selection-'))
  let f = await host(directory)
  try {
    const settings = f.root.get('models.settings'), original = settings.configurations()[0]
    const { id, revision, versionId, createdAt, updatedAt, modelDefinitionVersionId, remoteModelId, ...data } = original
    await settings.createConfiguration({ ...data, baseline: false, id: 'alternate', name: 'Alternate', parameters: { protocolId: 'chat-completions', formatVersion: 1, value: { temperature: 0.8 } } })
    const session = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(session.modelId, null)
    const input = { sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'first' }
    await assert.rejects(f.harness.startRun(input), error => error.category === 'model-unavailable')
    assert.deepEqual(await f.harness.listRuns(session.id), [])
    await f.harness.selectSessionModel(session.id, 'default')
    const run = await f.harness.startRun(input)
    assert.equal(run.modelId, 'default'); assert.equal(run.requestedModelId, null)
    assert.equal(run.modelSnapshot.modelVersionId, original.versionId)
    await f.harness.selectSessionModel(session.id, 'alternate')
    const duplicate = await f.harness.startRun(input)
    assert.equal(duplicate.id, run.id); assert.equal(duplicate.modelId, 'default')
    assert.equal(f.transport.calls.length, 1)
    await finish(f, run)
    const explicit = await f.harness.startRun({ ...input, idempotencyKey: 'explicit', modelId: 'default' })
    await assert.rejects(f.harness.startRun({ ...input, idempotencyKey: 'explicit', modelId: 'alternate' }), /idempotency key/)
    await finish(f, explicit)
    const alternate = await f.harness.startRun({ ...input, idempotencyKey: 'next' })
    assert.equal(alternate.modelId, 'alternate')
    assert.deepEqual(alternate.modelSnapshot.parameters.value, { temperature: 0.8 })
    await finish(f, alternate)
    await f.close(); f = await host(directory)
    assert.equal((await f.harness.getSession(session.id)).modelId, 'alternate')
    const restored = await f.harness.getRun(run.id)
    assert.equal(restored.modelId, 'default')
    assert.deepEqual(restored.modelSnapshot, run.modelSnapshot)
    assert.equal(restored.modelSnapshot.schemaVersion, 3)
    assert.equal(restored.modelSnapshot.modelDefinitionId, original.modelDefinitionId)
    assert.equal(f.transport.calls.length, 0)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('actual Models preserves text plus tools and streams progress while Agent sends only new tool observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-model-toolflow-')), f = await host(directory), events = []
  try {
    await f.root.installComponent({ name: 'progress-observer', apply(ctx) { ctx.on(runViewEvent, value => events.push(value)) } })
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Use a tool', idempotencyKey: 'tool' })
    f.transport.calls[0].input.onEvent({ type: 'text-delta', delta: 'Checking.' })
    f.transport.calls[0].result.resolve({ status: 'completed', text: 'Checking.', toolCalls: [{ id: 'tool-1', name: 'bash', arguments: { command: 'printf observed' } }] })
    f.transport.calls[0].done.resolve()
    for (let i = 0; i < 100 && f.transport.calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.transport.calls.length, 2)
    assert.deepEqual(f.transport.calls[1].input.newMessages.map(message => message.role), ['tool'])
    assert.equal(f.transport.calls[1].input.newMessages[0].callId, 'tool-1')
    assert.equal(f.transport.calls[1].input.messages.find(message => message.role === 'assistant').content, 'Checking.')
    assert.equal(JSON.parse(f.transport.calls[1].input.newMessages[0].content).stdout, 'observed')
    assert.ok(events.some(value => value.sessionId === session.id && value.runId === run.id && JSON.stringify(value.frame.payload).includes('Checking.')))
    assert.ok(events.every(value => value.frame.protocolId === 'chat-completions'))
    const terminal = await finish(f, run, 'Finished')
    assert.equal(terminal.status, 'completed')
    assert.equal((await f.harness.getNode(session.id, terminal.resultNodeId)).output, 'Finished')
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const status of ['incomplete', 'refused']) test(`${status} model output never executes tools or creates a successful node`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-model-terminal-')), f = await host(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Request', idempotencyKey: status })
    const call = f.transport.calls[0]
    call.result.resolve({ status, text: 'Partial or refused', toolCalls: [] }); call.done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.resultNodeId, undefined)
    assert.equal((await f.harness.getRunEvents(run.id)).some(event => event.kind === 'tool-started'), false)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Harness shutdown aborts and joins an execution still opening before durable Run admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-model-open-close-')), entered = deferred(), aborted = deferred(), release = deferred()
  const transport = controlledModels({ async open(input) { entered.resolve(); input.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise } })
  const f = await host(directory, transport)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const starting = f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Request', idempotencyKey: 'pending' })
    const rejected = assert.rejects(starting)
    await entered.promise
    let closed = false
    const closing = f.harness.close().then(() => { closed = true })
    await aborted.promise; await tick(); assert.equal(closed, false)
    release.resolve(); await Promise.all([rejected, closing])
    assert.equal(transport.calls.length, 0)
  } finally { release.resolve(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const fail of [false, true]) test(`Run settlement waits for execution.close and preserves cleanup failure (${fail})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-model-execution-close-')), f = await host(directory, controlledModels())
  const entered = deferred(), release = deferred()
  const models = f.root.get('models'), originalOpen = models.openNative.bind(models)
  models.openNative = async input => {
    const execution = await originalOpen(input)
    return { ...execution, async close() { entered.resolve(); await release.promise; const report = await execution.close(); if (fail) throw new Error('private native cleanup detail'); return report } }
  }
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Request', idempotencyKey: 'close' })
    f.transport.calls[0].result.resolve('Done'); f.transport.calls[0].done.resolve()
    await entered.promise
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
    release.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, fail ? 'failed' : 'completed')
    if (fail) { assert.equal(terminal.errorCategory, 'cleanup-failure'); assert.equal(terminal.resultNodeId, undefined) }
    assert.doesNotMatch(JSON.stringify(terminal), /private native/)
  } finally {
    release.resolve()
    if (fail) await assert.rejects(f.close()); else await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

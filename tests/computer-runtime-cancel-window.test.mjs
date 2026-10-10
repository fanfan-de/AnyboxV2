import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { createRunRuntimeComponent } from '../dist/applications/harness/core/run/runtime-component.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'
import { createLocalComputerProvider } from './helpers/fixed-computer-provider.mjs'
import { installComputerServices, createControlledComputerWorker } from './helpers/computer-services.mjs'
import { deferred, modelSnapshot } from './helpers/controlled-models.mjs'
import { nativeRegistration, completedOutcome } from './helpers/native-records.mjs'

const inputs = { now: () => 'now', newId: randomUUID }

for (const batchId of [undefined, 'durable-batch']) {
  test(`cancellation after tool admission consumes one cancelled fact without dispatch (${batchId ?? 'live IDs'}), including a lost consumption acknowledgement`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-runtime-cancel-window-')), root = new Context()
    const admitted = deferred(), releaseAdmission = deferred()
    t.after(async () => {
      releaseAdmission.resolve()
      try { await root.fiber.dispose() }
      finally { await rm(directory, { recursive: true, force: true }) }
    })
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createProjectComponent(inputs))
    const project = await root.get('harness.projects').openProject(directory)
    const provider = createLocalComputerProvider()
    let activations = 0, executions = 0
    root.provide('computer.instance-provider', { ...provider, activate(input) { activations++; return provider.activate(input) } })
    const worker = createControlledComputerWorker(root)
    await installComputerServices(root, inputs, { worker })
    await root.installComponent(createProjectFilesComponent(inputs))
    await root.installComponent(createSessionComponent(inputs, [{ id: 'assistant' }]))
    await root.installComponent(createRunRuntimeComponent(inputs))
    const sessions = root.get('harness.sessions'), records = root.get('harness.session-runs'), runtime = root.get('harness.run-runtime')
    await sessions.setAgentTools('assistant', { toolIds: ['anybox.bash'], expectedRevision: 0 })
    const session = await sessions.createSession(project.id, 'assistant'), snapshot = modelSnapshot()
    const selection = session.toolSelection
    const initialization = { schemaVersion: 2, prompts: [], tools: selection.tools.map(tool => tool.definition), toolContractVersion: 'tool-library-v1', toolSelection: selection }
    const runId = 'cancel-window', input = { sessionId: session.id, parentNodeId: null, idempotencyKey: runId, input: runId }
    const registration = nativeRegistration(input, snapshot, [], null, initialization)
    await records.registerRun(runId, input, 'now', [], snapshot, registration)
    worker.setExecution(runId, { execute() { executions++; throw new Error('cancelled tool must never execute') }, hasProcesses: () => false,
      close() { return { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} } } })
    let operationId, lostAcknowledgements = 0
    const originalStart = records.startOperation, originalObserve = records.observeOperation
    records.startOperation = async (...args) => {
      const accepted = await originalStart(...args)
      if (args[0] === runId && args[1].kind === 'tool') {
        operationId = args[1].id
        admitted.resolve()
        await releaseAdmission.promise
      }
      return accepted
    }
    records.observeOperation = async (...args) => {
      await originalObserve(...args)
      if (args[1] === operationId && lostAcknowledgements++ === 0) throw new Error('injected lost consumption acknowledgement')
    }
    const final = completedOutcome(runId, 'unreachable output')
    const program = { binding: registration.binding, modelSnapshot: snapshot, initialization, input: registration.input,
      signal: new AbortController().signal, release() {},
      async execute(host) {
        await host.executeTools([{ id: 'bash-call', name: 'bash', arguments: { command: 'must never execute' } }], 'serial', batchId)
        return { kind: 'completed', output: final.output, resultRecordIds: final.resultRecordIds }
      },
      async close() { return { records: final.records, checkpoint: final.checkpoint, cleanup: 'completed' } } }
    const started = runtime.start({ runId, program })
    await admitted.promise
    const db = root.get('local-storage'), ops = root.get('harness.computer-operations')
    assert.equal((await ops.get(operationId)).state, 'accepted')
    assert.equal((await records.getRunOperation(runId, operationId)).observation, undefined)
    await runtime.cancel(runId, 'user-requested')
    await runtime.cancel(runId, 'user-requested')
    releaseAdmission.resolve()
    assert.equal((await started).status, 'cancelled')
    assert.equal((await runtime.wait(runId)).status, 'cancelled')
    assert.equal(activations, 0)
    assert.equal(executions, 0)
    assert.equal(worker.records.size, 0)
    const operation = await ops.get(operationId)
    assert.equal(operation.state, 'cancelled')
    assert.equal(operation.observed, true)
    assert.equal(operation.binding, undefined)
    assert.deepEqual((await records.getRunOperation(runId, operationId)).observation, { kind: 'error', errorCategory: 'tool-cancelled' })
    assert.equal((await records.getRunExecution(runId)).toolCalls, 1)
    const events = await sessions.getRunEvents(runId)
    assert.equal(events.filter(event => event.kind === 'tool-started').length, 1)
    assert.equal(events.filter(event => event.kind === 'tool-failed' && event.category === 'tool-cancelled').length, 1)
    const reservation = await db.read(reader => reader.get('SELECT released_at FROM harness_workspace_reservations WHERE scope_id=?', [runId]))
    assert.notEqual(reservation.released_at, null)
    assert.equal(await root.get('harness.computers').getPin(`computer-run:${runId}`), undefined)
    assert.deepEqual((await sessions.listNodes(session.id, null)).nodes, [])
    await runtime.cancel(runId, 'user-requested')
    assert.equal((await records.getRunExecution(runId)).toolCalls, 1)
    assert.deepEqual(await sessions.getRunEvents(runId), events)
    records.startOperation = originalStart
    records.observeOperation = originalObserve
  })
}

test('Run cancellation while computer activation is pending never reopens or dispatches the cancelled declaration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-activation-cancel-window-')), root = new Context()
  const activating = deferred(), releaseActivation = deferred()
  t.after(async () => {
    releaseActivation.resolve()
    try { await root.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent(inputs))
  const project = await root.get('harness.projects').openProject(directory)
  const provider = createLocalComputerProvider()
  root.provide('computer.instance-provider', { ...provider, activate(input) {
    const call = provider.activate(input)
    activating.resolve()
    const result = releaseActivation.promise.then(() => call.result)
    return { result, done: result.then(() => call.done, () => call.done), cancel: call.cancel }
  } })
  const worker = createControlledComputerWorker(root)
  await installComputerServices(root, inputs, { worker })
  let executions = 0
  worker.setExecution('activation-cancel', { execute() { executions++; throw new Error('cancelled operation was dispatched') }, hasProcesses: () => false,
    close() { return { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} } } })
  const db = root.get('local-storage'), ops = root.get('harness.computer-operations')
  await db.transaction(tx => ops.acceptIn(tx, { operationId: 'op', runId: 'activation-cancel', sessionId: 'session', projectId: project.id,
    request: { id: 'call', name: 'bash', arguments: { command: 'must never execute' } }, tool: getToolById('anybox.bash') }))
  const scope = ops.openRun({ runId: 'activation-cancel' }), call = scope.execute('op')
  await activating.promise
  await scope.cancel()
  assert.equal((await ops.get('op')).state, 'cancelled')
  assert.equal((await ops.get('op')).binding, undefined)
  releaseActivation.resolve()
  await assert.rejects(call.result, { category: 'tool-cancelled' })
  await call.done
  assert.equal((await ops.get('op')).state, 'cancelled')
  assert.equal(executions, 0)
  assert.equal(worker.records.size, 0)
  const close = scope.close()
  await close.result
  await close.done
  const reservation = await db.read(reader => reader.get('SELECT released_at FROM harness_workspace_reservations WHERE scope_id=?', ['activation-cancel']))
  assert.notEqual(reservation.released_at, null)
})

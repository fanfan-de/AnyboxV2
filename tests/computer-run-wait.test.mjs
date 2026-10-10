import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { createComputersComponent } from '../dist/applications/harness/core/computer/component.js'
import { createWorkspacesComponent } from '../dist/applications/harness/core/workspace/component.js'
import { createComputerOperationsComponent } from '../dist/applications/harness/core/computer/operations-component.js'
import { createRunRuntimeComponent } from '../dist/applications/harness/core/run/runtime-component.js'
import { createRunComponent } from '../dist/applications/harness/core/run/component.js'
import { bashToolDefinition } from '../dist/applications/harness/core/tool/bash-component.js'
import { createLocalComputerProviderComponent } from './helpers/fixed-computer-provider.mjs'
import { createControlledComputerWorker } from './helpers/computer-services.mjs'
import { deferred, ids } from './helpers/controlled-models.mjs'
import { registerNativeRun, completedOutcome, completeNativeRun } from './helpers/native-records.mjs'

async function promptly(work) {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('observer was blocked by unrelated recovery')), 1000) })]) }
  finally { clearTimeout(timer) }
}

test('worker authorization and orphan draining do not block another Run wait; abort detaches recovery observers without cancelling worker execution', { timeout: 10000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-run-wait-'))), root = new Context()
  const enumeration = deferred(), releaseEnumeration = deferred(), authorizing = deferred(), releaseAuthorization = deferred(), draining = deferred(), releaseDrain = deferred()
  let closing
  t.after(async () => {
    releaseEnumeration.resolve(); releaseAuthorization.resolve(); releaseDrain.resolve()
    try { await (closing ?? root.fiber.dispose()) }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const inputs = { now: () => 'now', newId: ids() }, agents = [{ id: 'assistant', modelId: 'default', instructions: 'Fixed' }]
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  const worker = createControlledComputerWorker(root)
  await root.installComponent(worker.component)
  await root.installComponent(createLocalComputerProviderComponent())
  await root.installComponent(createComputersComponent(inputs))
  await root.installComponent(createWorkspacesComponent(inputs))
  let operationsFiber = root.installComponent(createComputerOperationsComponent(inputs)); await operationsFiber
  let sessionFiber = root.installComponent(createSessionComponent(inputs, agents)); await sessionFiber
  const project = await root.get('harness.projects').openProject(directory), sessions = root.get('harness.sessions'), records = root.get('harness.session-runs')
  await sessions.setAgentTools('assistant', { toolIds: ['anybox.bash'], expectedRevision: 0 })
  const session = await sessions.createSession(project.id, 'assistant')
  const initialization = { schemaVersion: 1, prompts: [], tools: [bashToolDefinition], toolContractVersion: 'known-tools-v1' }
  const register = id => registerNativeRun(records, id, { sessionId: session.id, parentNodeId: null, input: id, idempotencyKey: id }, 'now', [], undefined, initialization)
  await register('finished'); const finished = await completeNativeRun(records, 'finished', 'already complete', 'now')
  await register('recovering')
  const tool = { id: 'original-call', name: 'bash', arguments: { command: 'original command' } }
  const value = { name: 'bash', result: { exitCode: 0, signal: null, stdout: 'original', stderr: '', truncated: false } }
  let executions = 0, cancellations = 0
  worker.setExecution('recovering', {
    execute() { executions++; return { result: Promise.resolve(value), done: Promise.resolve(), cancel() { cancellations++ } } },
    hasProcesses: () => false,
    close: () => ({ result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() { cancellations++ } }),
  })
  await records.startOperation('recovering', { id: 'original-operation', kind: 'tool', tool, intent: tool }, 'now', 1)
  const scope = root.get('harness.computer-operations').openRun({ runId: 'recovering' }), original = scope.execute('original-operation')
  await original.result; await original.done
  await records.observeOperation('recovering', 'original-operation', { kind: 'value', tool: value }, 'now', 1)
  const outcome = completedOutcome('recovering', 'original answer'), exchangeId = outcome.records[0].exchangeId
  await records.startOperation('recovering', { id: exchangeId, kind: 'model', intent: {}, records: [outcome.records[0]] }, 'now', 1)
  await records.observeOperation('recovering', exchangeId, { kind: 'value', records: [outcome.records[1]],
    protocolCursor: { schemaVersion: 1, protocolId: 'chat-completions', exchangeId } }, 'now', 1)
  await records.saveRunResume('recovering', 1, { stage: 'cleanup', conclusion: { kind: 'completed', output: outcome.output, resultRecordIds: outcome.resultRecordIds } }, 'now')

  // Reconstruct observers while the separate worker retains its original receipt and execution.
  await sessionFiber.dispose(); await operationsFiber.dispose()
  operationsFiber = root.installComponent(createComputerOperationsComponent(inputs)); await operationsFiber
  sessionFiber = root.installComponent(createSessionComponent(inputs, agents)); await sessionFiber
  const currentRecords = root.get('harness.session-runs'), operations = root.get('harness.computer-operations')
  const list = currentRecords.listRunResumes.bind(currentRecords), claim = worker.service.claimRun.bind(worker.service), drain = operations.recoverCancelledRuns.bind(operations)
  currentRecords.listRunResumes = async () => { enumeration.resolve(); await releaseEnumeration.promise; return list() }
  worker.service.claimRun = async input => { if (input.runId === 'recovering' && input.runOwnerEpoch === 2) { authorizing.resolve(); await releaseAuthorization.promise } return claim(input) }
  operations.recoverCancelledRuns = async ids => { draining.resolve(); await releaseDrain.promise; return drain(ids) }
  await root.installComponent({ name: 'wait-test-unused-model-ports', apply(ctx) {
    ctx.provide('models', {})
    ctx.provide('harness.agent-prompts', {})
    ctx.provide('harness.protocol-agents', { prepareResume() { assert.fail('cleanup recovery must not reopen model execution') } })
  } })
  await root.installComponent(createRunRuntimeComponent(inputs))
  await root.installComponent(createRunComponent(inputs, agents))
  const runs = root.get('harness.runs')
  await enumeration.promise
  const beforeReady = new AbortController(), beforeReadyWait = runs.waitRun('finished', beforeReady.signal), firstReason = new Error('detach before registration')
  const firstRejected = assert.rejects(beforeReadyWait, error => error === firstReason)
  beforeReady.abort(firstReason); await promptly(firstRejected)
  releaseEnumeration.resolve(); await authorizing.promise; await draining.promise
  assert.deepEqual(await promptly(runs.waitRun('finished')), finished)
  const duringHandoff = new AbortController(), recoveryWait = runs.waitRun('recovering', duringHandoff.signal), secondReason = new Error('detach during authorization')
  const secondRejected = assert.rejects(recoveryWait, error => error === secondReason)
  await new Promise(resolve => setImmediate(resolve))
  duringHandoff.abort(secondReason); await promptly(secondRejected)
  assert.equal(cancellations, 0); assert.equal(executions, 1)
  assert.equal(worker.records.get('original-operation').executeCount, 1)
  assert.equal((await currentRecords.getRun('recovering')).status, 'running')
  releaseAuthorization.resolve()
  const recovered = await promptly(runs.waitRun('recovering'))
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.output, 'original answer')
  assert.equal(executions, 1); assert.equal(cancellations, 0)
  assert.equal((await currentRecords.getRunExecution('recovering')).toolCalls, 1)
  assert.equal((await root.get('harness.sessions').getRunEvents('recovering')).filter(event => event.kind === 'terminal').length, 1)
  let closed = false
  closing = root.fiber.dispose().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false, 'component exit must still join the independent orphan drain')
  releaseDrain.resolve(); await closing
})

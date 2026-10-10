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
import { installComputerServices } from './helpers/computer-services.mjs'
import { ids, modelSnapshot } from './helpers/controlled-models.mjs'
import { registerNativeRun } from './helpers/native-records.mjs'

async function fixture(t) {
  const root = new Context(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-session-resume-')))
  const inputs = { now: () => 'now', newId: ids() }, agents = [{ id: 'assistant', modelId: 'default', instructions: 'Fixed' }]
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  await installComputerServices(root, inputs)
  let fiber = root.installComponent(createSessionComponent(inputs, agents)); await fiber
  const project = await root.get('harness.projects').openProject(directory)
  const session = await root.get('harness.sessions').createSession(project.id, 'assistant')
  t.after(async () => { try { await root.fiber.dispose() } finally { rmSync(directory, { recursive: true, force: true }) } })
  const restart = async () => { await fiber.dispose(); fiber = root.installComponent(createSessionComponent(inputs, agents)); await fiber; return root.get('harness.session-runs') }
  return { root, session, records: root.get('harness.session-runs'), db: root.get('local-storage'), restart }
}
async function acceptedResponse(f, id = 'run') {
  await registerNativeRun(f.records, id, { sessionId: f.session.id, parentNodeId: null, input: id, idempotencyKey: id }, 'now')
  const request = { id: `${id}:request`, exchangeId: `${id}:exchange`, kind: 'request', formatVersion: 1, payload: { messages: [{ role: 'user', content: id }] } }
  const response = { id: `${id}:response`, exchangeId: `${id}:exchange`, kind: 'response', formatVersion: 1,
    payload: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'saved response' } }] } }
  const start = { id: `${id}:exchange`, kind: 'model', intent: {}, records: [request] }
  await f.records.startOperation(id, start, 'now', 1)
  const observation = { kind: 'value', records: [request, response], protocolCursor: { schemaVersion: 1, protocolId: 'chat-completions', exchangeId: `${id}:exchange` } }
  await f.records.observeOperation(id, start.id, observation, 'now', 1)
  return { start, observation }
}

test('response record and cursor commit together; lost start/consume acknowledgements do not repeat events, calls or bytes', async t => {
  const f = await fixture(t), { start, observation } = await acceptedResponse(f)
  const initial = await f.records.loadRunResume('run')
  const initialEvents = await f.root.get('harness.sessions').getRunEvents('run')
  await f.records.startOperation('run', start, 'retry', 1)
  await f.records.observeOperation('run', start.id, observation, 'retry', 1)
  assert.deepEqual((await f.records.loadRunResume('run')).state, initial.state)
  assert.deepEqual(await f.root.get('harness.sessions').getRunEvents('run'), initialEvents)
  assert.equal((await f.records.getRunExecution('run')).modelCalls, 1)

  const tool = { id: 'tool', name: 'codex_update_plan', arguments: { plan: [{ step: 'check', status: 'completed' }] } }
  const batch = { id: 'run:exchange', requests: [tool], operationIds: ['stable-tool-op'] }
  await f.records.saveRunResume('run', 1, { batch }, 'now')
  const toolStart = { id: 'stable-tool-op', kind: 'tool', tool, intent: { name: tool.name, requestId: tool.id, arguments: tool.arguments } }
  const toolObservation = { kind: 'value', tool: { name: tool.name, result: { saved: true } } }
  await f.records.startOperation('run', toolStart, 'now', 1)
  await f.records.observeOperation('run', toolStart.id, toolObservation, 'now', 1)
  const consumed = await f.records.loadRunResume('run')
  await f.records.startOperation('run', toolStart, 'lost-confirmation', 1)
  await f.records.observeOperation('run', toolStart.id, toolObservation, 'lost-confirmation', 1)
  assert.deepEqual((await f.records.loadRunResume('run')).state, consumed.state)
  assert.equal((await f.records.getRunExecution('run')).toolCalls, 1)
  assert.equal(consumed.state.totalToolOutputBytes, Buffer.byteLength(JSON.stringify(toolObservation.tool.result)))
  assert.deepEqual((await f.records.getRunOperation('run', toolStart.id)).observation, toolObservation)
  await assert.rejects(f.records.observeOperation('run', toolStart.id, { kind: 'error' }, 'conflict', 1), { code: 'operation-observation-conflict' })
})

test('new owner claims a committed response; old owner cannot admit, consume, update cursor or settle', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  const records = await f.restart()
  assert.equal((await records.getRun('run')).status, 'running')
  assert.equal((await records.listRunResumes()).length, 1)
  const claimed = await records.claimRunResume('run', 1, 'takeover')
  assert.equal(claimed.state.runOwnerEpoch, 2)
  await assert.rejects(records.claimRunResume('run', 1, 'late'), { code: 'stale-run-owner' })
  await assert.rejects(records.startOperation('run', { id: 'late', kind: 'operation', intent: {} }, 'late', 1), { code: 'stale-run-owner' })
  await assert.rejects(records.observeOperation('run', 'run:exchange', { kind: 'error' }, 'late', 1), { code: 'stale-run-owner' })
  await assert.rejects(records.saveRunResume('run', 1, { stage: 'cleanup' }, 'late'), { code: 'stale-run-owner' })
  await assert.rejects(records.settleRun('run', { kind: 'failed', category: 'provider-failure', error: 'late' }, 'late', 1), { code: 'stale-run-owner' })
  await records.saveRunResume('run', 2, { stage: 'cleanup' }, 'now')
  assert.equal((await records.settleRun('run', { kind: 'failed', category: 'provider-failure', error: 'new owner' }, 'now', 2)).status, 'failed')
})

test('takeover preserves original call counts and the next exchange continues the same accounting', async t => {
  const f = await fixture(t), { start, observation } = await acceptedResponse(f)
  const tool = { id: 'call', name: 'codex_update_plan', arguments: { plan: [] } }
  const toolStart = { id: 'stable-tool', kind: 'tool', tool, intent: {} }
  const toolObservation = { kind: 'value', tool: { name: tool.name, result: { saved: true } } }
  await f.records.startOperation('run', toolStart, 'now', 1)
  await f.records.observeOperation('run', toolStart.id, toolObservation, 'now', 1)
  const before = await f.records.getRunExecution('run'), records = await f.restart()
  await records.claimRunResume('run', 1, 'takeover')
  assert.deepEqual(await records.getRunExecution('run'), before)
  await records.startOperation('run', start, 'lost model acceptance', 2)
  await records.observeOperation('run', start.id, observation, 'lost model consumption', 2)
  await records.startOperation('run', toolStart, 'lost tool acceptance', 2)
  await records.observeOperation('run', toolStart.id, toolObservation, 'lost tool consumption', 2)
  assert.deepEqual(await records.getRunExecution('run'), before)
  const nextStart = { id: 'next-model', kind: 'model', intent: {}, records: [{ id: 'next-request', exchangeId: 'next-model', kind: 'request', formatVersion: 1, payload: { messages: [] } }] }
  await records.startOperation('run', nextStart, 'next', 2)
  await records.startOperation('run', nextStart, 'lost next acceptance', 2)
  const after = await records.getRunExecution('run')
  assert.equal(after.modelCalls, 2)
  assert.equal(after.toolCalls, 1)
  assert.equal((await records.loadRunResume('run')).state.totalToolOutputBytes, Buffer.byteLength(JSON.stringify(toolObservation.tool.result)))
})

test('a fixed subsequent model request makes an unfinished exchange non-replayable after restart', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  await f.records.startOperation('run', { id: 'next-exchange', kind: 'model', intent: {}, records: [{ id: 'next-request',
    exchangeId: 'next-exchange', kind: 'request', formatVersion: 1, payload: { messages: [] } }] }, 'now', 1)
  assert.equal((await f.records.loadRunResume('run')).state.stage, 'model-pending')
  const records = await f.restart()
  assert.equal((await records.getRun('run')).status, 'interrupted')
  assert.deepEqual(await records.listRunResumes(), [])
  await assert.rejects(records.claimRunResume('run', 1, 'takeover'), { code: 'run-not-resumable' })
})

test('tool observation rollback cannot publish a cursor, quota or event independently', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  const before = await f.records.loadRunResume('run')
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER reject_resume_update BEFORE UPDATE ON harness_run_resumes
    BEGIN SELECT RAISE(ABORT, 'injected resume commit failure'); END`))
  const operation = { id: 'tool', kind: 'tool', tool: { id: 'call', name: 'codex_update_plan', arguments: { plan: [] } }, intent: {} }
  await f.records.startOperation('run', operation, 'now', 1)
  await assert.rejects(f.records.observeOperation('run', 'tool', { kind: 'value', tool: { name: 'codex_update_plan', result: { ok: true } } }, 'now', 1), { code: 'operation-failed' })
  assert.equal((await f.records.getRunOperation('run', 'tool')).observation, undefined)
  assert.deepEqual((await f.records.loadRunResume('run')).state, before.state)
  assert.equal((await f.root.get('harness.sessions').getRunEvents('run')).filter(event => event.kind === 'tool-observed').length, 0)
})

test('cleanup and settlement takeover preserve the original terminal node under lost confirmation', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  const conclusion = { kind: 'completed', output: 'saved response', resultRecordIds: ['run:response'] }
  await f.records.saveRunResume('run', 1, { stage: 'cleanup', conclusion }, 'cleanup')
  const records = await f.restart(), resumed = await records.claimRunResume('run', 1, 'claim')
  assert.equal(resumed.state.stage, 'cleanup')
  assert.deepEqual(resumed.state.conclusion, conclusion)
  await records.saveRunResume('run', 2, { stage: 'settling' }, 'settling')
  const outcome = { ...conclusion, checkpoint: { protocolId: 'chat-completions', recordFormatVersion: 1, modelSnapshot: modelSnapshot() } }
  const first = await records.settleRun('run', outcome, 'settled', 2)
  const repeated = await records.settleRun('run', outcome, 'confirmation lost', 2)
  assert.equal(first.resultNodeId, repeated.resultNodeId)
  assert.equal((await f.root.get('harness.sessions').listNodes(f.session.id, null)).nodes.length, 1)
  assert.equal((await f.root.get('harness.sessions').getRunEvents('run')).filter(event => event.kind === 'terminal').length, 1)
})

test('a durable cancelling Run retains its tool-stage recovery record and creates no success node', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  await f.records.requestCancellation('run', 'cancel')
  const records = await f.restart(), resume = await records.claimRunResume('run', 1, 'claim')
  assert.equal(resume.run.status, 'cancelling')
  await records.saveRunResume('run', 2, { stage: 'cleanup' }, 'cleanup')
  assert.equal((await records.settleRun('run', { kind: 'cancelled' }, 'exit confirmed', 2)).status, 'cancelled')
  assert.deepEqual((await f.root.get('harness.sessions').listNodes(f.session.id, null)).nodes, [])
})

test('scope tail output is counted atomically once and settlement retains an actual cleanup failure', async t => {
  const f = await fixture(t); await acceptedResponse(f)
  const cleanup = { id: 'run:computer-scope-close', kind: 'operation', cleanup: true, intent: { kind: 'tool-process-cleanup' } }
  const observed = { kind: 'value', result: { cleanup: 'completed', processes: [{ session_id: 1, output: 'tail output' }] } }
  await f.records.startOperation('run', cleanup, 'close', 1)
  await f.records.observeOperation('run', cleanup.id, observed, 'closed', 1)
  await f.records.observeOperation('run', cleanup.id, observed, 'lost confirmation', 1)
  assert.equal((await f.records.loadRunResume('run')).state.totalToolOutputBytes, Buffer.byteLength('tail output'))
  const exitRecord = { id: 'exit-failure', exchangeId: 'run:exchange', kind: 'diagnostic', formatVersion: 1, payload: { cleanup: 'failed' } }
  const settlement = { kind: 'cleanup-failed', category: 'cleanup-failure', error: 'model actual exit failed', records: [exitRecord], checkpoint: null }
  await f.records.saveRunResume('run', 1, { stage: 'settling', settlement }, 'fix outcome')
  await f.records.saveRunResume('run', 1, { stage: 'settling', settlement }, 'lost confirmation')
  const records = await f.restart(), claimed = await records.claimRunResume('run', 1, 'new owner')
  assert.equal(claimed.state.settlement.kind, 'cleanup-failed')
  assert.equal(claimed.state.settlement.records, undefined, 'exit records belong to the immutable native ledger')
  assert.equal(claimed.records.filter(record => record.id === exitRecord.id).length, 1)
  const terminal = await records.settleRun('run', claimed.state.settlement, 'settle', 2)
  assert.equal(terminal.status, 'failed'); assert.equal(terminal.errorCategory, 'cleanup-failure')
  assert.deepEqual((await f.root.get('harness.sessions').listNodes(f.session.id, null)).nodes, [])
})

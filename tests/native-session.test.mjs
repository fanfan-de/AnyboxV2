import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { controlledModels, modelSnapshot, ids } from './helpers/controlled-models.mjs'
import { nativeRegistration, registerNativeRun, completedOutcome } from './helpers/native-records.mjs'

const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Root instruction' }]
async function host(t, executing = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-native-session-'))), root = new Context()
  const inputs = { now: () => 'now', newId: ids() }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'state.sqlite')) + ".images" }))
  let harness, llm, sessionFiber
  if (executing) {
    llm = controlledModels()
    await root.installComponent(llm.component())
    harness = await createTestHarnessServerCore(root, { agents })
  } else {
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createProjectFilesComponent(inputs))
    sessionFiber = root.installComponent(createSessionComponent(inputs, agents))
    await sessionFiber
  }
  const sessions = root.get('harness.sessions'), records = root.get('harness.session-runs'), db = root.get('local-storage')
  const project = await root.get('harness.projects').openProject(directory)
  const session = await sessions.createSession(project.id, 'assistant')
  t.after(async () => {
    for (const call of llm?.calls ?? []) { call.result.resolve('Cleanup'); call.done.resolve() }
    try { await root.fiber.dispose() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  return { directory, root, harness, llm, sessions, records, db, session, sessionFiber, inputs }
}
const input = (sessionId, id, parentNodeId = null) => ({ sessionId, input: id, parentNodeId, idempotencyKey: id })

test('Session titles are available from lists before history loads and retain first admission across failure, branches and restart', async t => {
  const f = await host(t)
  assert.equal(f.session.title, null)
  assert.deepEqual(await f.sessions.listSessions(f.session.projectId), [f.session])
  const raw = 'First\n\t accepted   input', title = 'First accepted input'
  const first = { ...input(f.session.id, 'z-first'), input: raw }
  const registration = nativeRegistration(first)
  registration.input.text = 'Task template content must not become the title'
  await f.records.registerRun('z-first', first, 'same-time', [], modelSnapshot(), registration)
  const saved = await f.db.read(reader => reader.get('SELECT input, native_input_json FROM harness_runs WHERE id = ?', ['z-first']))
  // This reads only the Session list, before asking for nodes, Run history or a selected path.
  assert.equal((await f.sessions.listSessions(f.session.projectId))[0].title, title)
  await f.records.settleRun('z-first', { kind: 'failed', error: 'test failure', category: 'provider-failure' }, 'same-time')
  assert.equal((await f.sessions.getSession(f.session.id)).title, title)
  assert.deepEqual((await f.sessions.listNodes(f.session.id, null)).nodes, [])

  // Same timestamps and reverse lexical IDs must keep the first accepted input.
  await registerNativeRun(f.records, 'a-later-root', input(f.session.id, 'a-later-root'), 'same-time')
  const root = await f.records.settleRun('a-later-root', completedOutcome('a-later-root', 'root answer'), 'same-time')
  await registerNativeRun(f.records, 'child', input(f.session.id, 'child', root.resultNodeId), 'same-time')
  await f.records.settleRun('child', completedOutcome('child', 'child answer'), 'same-time')
  assert.equal((await f.sessions.getNodePath(f.session.id, root.resultNodeId))[0].input, 'a-later-root')
  assert.equal((await f.sessions.selectSessionModel(f.session.id, 'default', 'chat-completions')).title, title)
  const archived = await f.sessions.archiveSession(f.session.id)
  assert.equal(archived.title, title)
  assert.deepEqual(await f.sessions.listArchivedSessions(), [archived])
  assert.equal((await f.sessions.restoreSession(f.session.id)).title, title)

  await f.sessionFiber.dispose()
  await f.root.installComponent(createSessionComponent(f.inputs, agents))
  const restarted = f.root.get('harness.sessions')
  assert.equal((await restarted.listSessions(f.session.projectId))[0].title, title)
  assert.equal((await restarted.getSession(f.session.id)).title, title)
  assert.deepEqual(await f.db.read(reader => reader.get('SELECT input, native_input_json FROM harness_runs WHERE id = ?', ['z-first'])), saved)
})

test('Session titles bound Unicode input without changing the original Run', async t => {
  const f = await host(t), raw = '😀'.repeat(125)
  await registerNativeRun(f.records, 'long-title', { ...input(f.session.id, 'long-title'), input: raw }, 'now')
  const title = (await f.sessions.listSessions(f.session.projectId))[0].title
  assert.equal(title, `${'😀'.repeat(119)}…`)
  assert.equal(Array.from(title).length, 120)
  assert.equal((await f.sessions.getRun('long-title')).input, raw)
})

test('first native admission atomically binds a Session; failure does not release its protocol', async t => {
  const f = await host(t), a = modelSnapshot(), b = { ...modelSnapshot(), protocolId: 'responses', parameters: { protocolId: 'responses', formatVersion: 1, value: {} } }
  const results = await Promise.allSettled([a, b].map((snapshot, i) => {
    const request = input(f.session.id, `run-${i}`)
    return f.records.registerRun(request.input, request, 'now', [], snapshot, nativeRegistration(request, snapshot))
  }))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected')[0].reason.code, 'protocol-mismatch')
  const [run] = await f.sessions.listRuns(f.session.id)
  const bound = await f.sessions.getSession(f.session.id)
  assert.equal(bound.protocolId, run.protocolBinding.protocolId)
  await f.records.settleRun(run.id, { kind: 'failed', error: 'test failure', category: 'provider-failure' }, 'now')
  assert.equal((await f.sessions.getSession(f.session.id)).protocolId, bound.protocolId)
  const fixed = await f.records.loadNativeInitialization(f.session.id)
  assert.ok(fixed)
  const retry = input(f.session.id, 'retry')
  const altered = nativeRegistration(retry, run.modelSnapshot)
  altered.initialization = { ...fixed, tools: [{ name: 'changed', description: 'changed', parameters: {} }] }
  await assert.rejects(f.records.registerRun('retry', retry, 'now', [], run.modelSnapshot, altered), /history-incompatible/)
  assert.deepEqual(await f.records.loadNativeInitialization(f.session.id), fixed)
  await assert.rejects(f.sessions.selectSessionModel(f.session.id, 'other', bound.protocolId === a.protocolId ? b.protocolId : a.protocolId), /protocol-mismatch/)
})

test('native records are immutable, belong to one Run, and roll back with invalid result references', async t => {
  const f = await host(t), request = input(f.session.id, 'first')
  await registerNativeRun(f.records, 'first', request, 'now')
  const record = { id: 'request', exchangeId: 'exchange', kind: 'request', formatVersion: 1, payload: { input: 'hello' } }
  await f.records.startOperation('first', { id: 'op', kind: 'model', intent: {}, records: [record] }, 'now')
  await f.records.observeOperation('first', 'op', { kind: 'value', records: [record] }, 'now')
  assert.equal((await f.sessions.getRunRecords('first')).length, 1)
  await assert.rejects(f.db.transaction(tx => tx.execute('UPDATE harness_native_records SET payload_json = ? WHERE id = ?', ['{}', record.id])))
  const proposed = completedOutcome('first', 'result')
  await assert.rejects(f.records.settleRun('first', { ...proposed, resultRecordIds: ['missing'] }, 'now'))
  assert.equal((await f.records.getRun('first')).status, 'running')
  assert.equal((await f.sessions.getRunRecords('first')).length, 1)
  assert.deepEqual((await f.sessions.listNodes(f.session.id, null)).nodes, [])
  const first = await f.records.settleRun('first', proposed, 'now')
  const secondInput = input(f.session.id, 'second', first.resultNodeId)
  await registerNativeRun(f.records, 'second', secondInput, 'now')
  await assert.rejects(f.records.startOperation('second', { id: 'op-2', kind: 'model', intent: {}, records: [record] }, 'now'))
  assert.equal((await f.sessions.getRunRecords('second')).length, 0)
  const history = await f.records.loadNativeHistory(f.session.id, first.resultNodeId)
  assert.ok(history.records.every(item => item.runId === 'first'))
  const contexts = await f.db.read(reader => reader.all('SELECT * FROM harness_native_contexts'))
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].parent_ref, null)
})

test('child admission rechecks its exact immutable parent context after preparation', async t => {
  const f = await host(t), firstInput = input(f.session.id, 'first')
  await registerNativeRun(f.records, 'first', firstInput, 'now')
  const first = await f.records.settleRun('first', completedOutcome('first', 'answer'), 'now')
  const child = input(f.session.id, 'child', first.resultNodeId)
  await assert.rejects(f.records.registerRun('child', child, 'now', [], modelSnapshot(), nativeRegistration(child)), /invalid-history/)
  assert.equal(await f.records.getRun('child'), undefined)
})

test('root instructions and tools stay fixed; the current task template applies once only to new input', async t => {
  const f = await host(t, true)
  const template = await f.harness.createPrompt('owner', { name: 'Task', kind: 'task-template', role: 'user', content: 'first:{{input}}' })
  const firstTemplate = await f.harness.publishPrompt('owner', template.id)
  await f.harness.bindPrompt('owner', 'assistant', firstTemplate.id)
  const raw = '$& {{input}}'
  const first = await f.harness.startRun({ ...input(f.session.id, 'first'), input: raw })
  assert.equal(first.protocolBinding.viewSchemaVersion, 2)
  assert.equal(f.llm.calls[0].input.messages.at(-1).content, `first:${raw}`)
  f.llm.calls[0].result.resolve('first answer'); f.llm.calls[0].done.resolve()
  const completed = await f.harness.waitRun(first.id)
  const newInstruction = await f.harness.createPrompt('owner', { name: 'New instruction', kind: 'agent-instruction', role: 'system', content: 'New root only' })
  await f.harness.bindPrompt('owner', 'assistant', (await f.harness.publishPrompt('owner', newInstruction.id)).id)
  await f.harness.editPrompt('owner', template.id, template.draft.revision, { content: 'second:{{input}}' })
  const secondTemplate = await f.harness.publishPrompt('owner', template.id)
  await f.harness.bindPrompt('owner', 'assistant', secondTemplate.id)
  const second = await f.harness.startRun(input(f.session.id, 'next', completed.resultNodeId))
  assert.equal(second.protocolBinding.viewSchemaVersion, 2)
  assert.deepEqual(f.llm.calls[1].input.messages.map(message => message.content), ['Root instruction', `first:${raw}`, 'first answer', 'second:next'])
  assert.equal(second.nativeInput.template.versionId, secondTemplate.id)
  assert.ok(second.promptVersionIds.includes(first.promptVersionIds[0]))
  f.llm.calls[1].result.resolve('second answer'); f.llm.calls[1].done.resolve()
  const done = await f.harness.waitRun(second.id)
  assert.equal(done.status, 'completed')
  const rows = await f.db.read(reader => ({ initializations: reader.all('SELECT * FROM harness_native_initializations'), contexts: reader.all('SELECT * FROM harness_native_contexts'), records: reader.all('SELECT * FROM harness_native_records') }))
  assert.equal(rows.initializations.length, 1)
  assert.equal(rows.contexts.length, 2)
  assert.equal(rows.records.length, 4)
  const secondRecords = await f.harness.getRunRecords(second.id)
  assert.equal(secondRecords.find(record => record.kind === 'request').payload.messages.length, 1)
  assert.doesNotMatch(rows.contexts[1].checkpoint_json, /first answer|second answer|Root instruction/)
  const regeneratedRoot = await f.harness.startRun(input(f.session.id, 'regenerate-first'))
  assert.deepEqual(f.llm.calls[2].input.messages.map(message => message.content), ['Root instruction', 'second:regenerate-first'])
  f.llm.calls[2].result.resolve('regenerated'); f.llm.calls[2].done.resolve()
  assert.equal((await f.harness.waitRun(regeneratedRoot.id)).status, 'completed')
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM harness_native_initializations'))).length, 1)
  const freshSession = await f.harness.createSession(f.session.projectId, 'assistant')
  const freshRoot = await f.harness.startRun(input(freshSession.id, 'fresh'))
  assert.deepEqual(f.llm.calls[3].input.messages.map(message => message.content), ['New root only', 'second:fresh'])
  f.llm.calls[3].result.resolve('fresh'); f.llm.calls[3].done.resolve()
  assert.equal((await f.harness.waitRun(freshRoot.id)).status, 'completed')
})

test('concurrent first roots cannot commit different Session initializations', async t => {
  const f = await host(t), snapshot = modelSnapshot()
  const attempts = ['first', 'second'].map(id => {
    const request = input(f.session.id, id), native = nativeRegistration(request, snapshot)
    native.initialization = { ...native.initialization, tools: [{ name: id, description: id, parameters: {} }] }
    return f.records.registerRun(id, request, 'now', [], snapshot, native)
  })
  const results = await Promise.allSettled(attempts)
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'history-incompatible')
  assert.equal((await f.sessions.listRuns(f.session.id)).length, 1)
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM harness_native_initializations'))).length, 1)
})

test('a failed start-intent commit performs no external operation and leaves no response record', async t => {
  const f = await host(t, true)
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER reject_operation BEFORE INSERT ON harness_run_operations BEGIN SELECT RAISE(ABORT, 'stop'); END`))
  const run = await f.harness.startRun(input(f.session.id, 'blocked'))
  assert.equal(run.status, 'failed')
  assert.equal(run.errorCategory, 'state-write-failure')
  assert.equal(f.llm.calls.length, 0)
  assert.deepEqual(await f.harness.getRunRecords(run.id), [])
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
})

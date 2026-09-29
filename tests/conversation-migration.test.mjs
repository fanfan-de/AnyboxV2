import { createProjectFilesComponent } from '../dist/project-files/component.js'
import { createImageAssetsComponent } from '../dist/image/component.js'
import { createSessionComponent } from '../dist/session/component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../dist/session/port.js'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { initialRunExecution } from '../dist/run/execution.js'
import { ids, modelSnapshot, controlledModels } from './helpers/controlled-models.mjs'
const sample = JSON.parse(readFileSync(new URL('./fixtures/legacy-turns-v2.json', import.meta.url), 'utf8'))
const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Test instructions.' }]

async function legacyFixture(t, turns = sample.turns) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tree-migrate-')))
  const root = new Context(), inputs = { newId: ids(), now: () => 'now' }
  t.after(async () => { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'state.sqlite')) + ".images" }))
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  const project = await root.get(projectServiceKey).openProject(directory)
  const db = root.get(localStorageServiceKey)
  await db.migrate('run-state', [{ version: 1, up(tx) {
    tx.execute(`CREATE TABLE harness_sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES harness_projects(id),
      agent_id TEXT NOT NULL, created_at TEXT NOT NULL, turns_json TEXT NOT NULL
    )`)
    tx.execute('CREATE INDEX harness_sessions_project ON harness_sessions(project_id, created_at, id)')
    tx.execute(`CREATE TABLE harness_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES harness_sessions(id),
      idempotency_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, prompts_json TEXT NOT NULL,
      llm_snapshot_json TEXT NOT NULL, output TEXT, error TEXT, error_category TEXT,
      UNIQUE(session_id, idempotency_key)
    )`)
    tx.execute('CREATE INDEX harness_runs_session ON harness_runs(session_id, created_at, id)')
  } }, { version: 2, up(tx) {
    tx.execute(`ALTER TABLE harness_runs ADD COLUMN execution_json TEXT NOT NULL DEFAULT '${JSON.stringify(initialRunExecution)}'`)
    tx.execute(`CREATE TABLE harness_run_events (run_id TEXT NOT NULL REFERENCES harness_runs(id), seq INTEGER NOT NULL,
      at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, seq))`)
  } }])
  await db.transaction(tx => {
    tx.execute('INSERT INTO harness_sessions VALUES (?, ?, ?, ?, ?)', ['legacy', project.id, 'assistant', 'same-time', JSON.stringify(turns)])
    tx.execute('INSERT INTO harness_sessions VALUES (?, ?, ?, ?, ?)', ['empty', project.id, 'assistant', 'same-time', '[]'])
    for (const run of sample.runs) {
      const active = run.status === 'running' || run.status === 'cancelling'
      const execution = { ...initialRunExecution, revision: 1, phase: active ? 'model-in-flight' : 'terminal', modelCalls: 1 }
      tx.execute(`INSERT INTO harness_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        run.id, 'legacy', run.id, run.input, run.status, 'same-time', 'same-time',
        JSON.stringify([{ versionId: 'v1', documentId: 'p1', kind: 'agent-instruction', role: 'system', content: 'Saved prompt' }]),
        '{"profileId":"default","configVersion":"old"}', run.output ?? null, run.error ?? null, run.category ?? null,
        JSON.stringify(execution),
      ])
      tx.execute('INSERT INTO harness_run_events VALUES (?, ?, ?, ?)', [run.id, 1, 'same-time', JSON.stringify(
        active ? { kind: 'model-started' } : { kind: 'terminal', status: run.status },
      )])
    }
  })
  return { root, inputs, db }
}

test('legacy turns migrate in array order; ambiguous Run associations remain explicitly unknown', async t => {
  const f = await legacyFixture(t)
  await f.root.installComponent(createSessionComponent(f.inputs, agents))
  const state = f.root.get(sessionRunServiceKey), sessions = f.root.get(sessionServiceKey)
  const first = (await sessions.listNodes('legacy', null)).nodes[0]
  const second = (await sessions.listNodes('legacy', first.id)).nodes[0]
  const third = (await sessions.listNodes('legacy', second.id)).nodes[0]
  const path = await sessions.getNodePath('legacy', third.id)
  assert.deepEqual(path.map(({ input, output }) => ({ input, output })), sample.turns)
  assert.ok(path.every(node => node.sourceRunId === null && node.id.startsWith('legacy:')))
  assert.deepEqual(await sessions.getNodePath('empty', null), [])
  for (const old of sample.runs) {
    const run = await state.getRun(old.id)
    assert.deepEqual(run.history, { kind: 'legacy-unknown' })
    assert.equal(run.resultNodeId, undefined)
    assert.equal(run.contextVersion, null)
    assert.equal(run.input, old.input)
    assert.equal(run.output, old.output)
    assert.deepEqual(run.promptVersionIds, ['v1'])
    const saved = await f.db.read(reader => reader.get('SELECT prompts_json FROM harness_runs WHERE id = ?', [old.id]))
    assert.equal(JSON.parse(saved.prompts_json)[0].content, 'Saved prompt')
    assert.equal(run.modelSnapshot, null)
    assert.deepEqual(run.legacyModelSnapshot, { profileId: 'default', configVersion: 'old' })
    assert.equal((await sessions.getRunByKey('legacy', old.id)).id, old.id)
    const active = old.status === 'running' || old.status === 'cancelling'
    assert.equal(run.status, active ? 'interrupted' : old.status)
    const events = await sessions.getRunEvents(old.id)
    assert.equal(events.length, active ? 2 : 1)
    assert.deepEqual(events.map(e => e.seq), active ? [1, 2] : [1])
  }
  await assert.rejects(state.findAcceptedRun({ sessionId: 'legacy', parentNodeId: null, input: 'Duplicate', idempotencyKey: 'z-completed' }), /idempotency key/)
  assert.equal((await sessions.getSession('legacy')).historyMode, 'dialogue-v1')
  assert.equal((await sessions.getSession('empty')).historyMode, 'dialogue-v1')
  await assert.rejects(state.registerRun('new-run', { sessionId: 'legacy', parentNodeId: third.id, input: 'Continue', idempotencyKey: 'new-key' }, 'now', [], modelSnapshot()), /legacy-session-readonly/)
  await assert.rejects(sessions.selectSessionModel('legacy', 'default', 'chat-completions'), /legacy-session-readonly/)
  assert.equal((await sessions.getNodePath('legacy', third.id)).length, 3)
  const schema = await f.db.read(reader => reader.all('PRAGMA table_info(harness_sessions)'))
  assert.equal(schema.some(column => column.name === 'turns_json'), false)
  assert.equal((await f.db.read(reader => reader.get("SELECT version FROM schema_migrations WHERE domain = 'run-state'"))).version, 6)
})

test('invalid legacy data rolls back the entire tree migration and its version record', async t => {
  const f = await legacyFixture(t, [sample.turns[0], { input: 'broken', output: null }])
  const installation = f.root.installComponent(createSessionComponent(f.inputs, agents))
  await assert.rejects(Promise.resolve(installation))
  assert.equal(f.root.get(sessionRunServiceKey), undefined)
  const version = await f.db.read(reader => reader.get("SELECT version FROM schema_migrations WHERE domain = 'run-state'"))
  assert.equal(version.version, 2)
  assert.equal(await f.db.read(reader => reader.get("SELECT name FROM sqlite_master WHERE name = 'harness_nodes'")), undefined)
  const legacy = await f.db.read(reader => reader.get("SELECT turns_json FROM harness_sessions WHERE id = 'legacy'"))
  assert.equal(JSON.parse(legacy.turns_json)[1].output, null)
  assert.equal((await f.db.read(reader => reader.get("SELECT status FROM harness_runs WHERE id = 'running'"))).status, 'running')
})


test('Session reads historical and version 2 snapshots without rewriting stored JSON', async t => {
  const f = await legacyFixture(t)
  const current = { schemaVersion: 2, modelDefinitionId: 'definition-default', providerDefinitionId: 'test-provider-definition', modelDefinitionVersionId: 'definition-v1',
    modelId: 'default', modelRevision: 1, modelVersionId: 'model-v2', providerId: 'test-provider', providerRevision: 1,
    providerVersionId: 'provider-v1', remoteModelId: 'test-remote', protocolId: 'chat-completions', protocolVersion: 'v2', options: {} }
  const { schemaVersion, modelDefinitionId, providerDefinitionId, modelDefinitionVersionId, ...historical } = current
  const samples = [['historical-model', historical], ['current-model', current]]
  await f.db.transaction(tx => {
    for (const [id, snapshot] of samples) tx.execute('INSERT INTO harness_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, 'empty', id, id, 'completed', 'now', 'now', '[]', JSON.stringify(snapshot), 'Answer', null, null,
        JSON.stringify({ ...initialRunExecution, phase: 'terminal' })])
  })
  await f.root.installComponent(createSessionComponent(f.inputs, agents))
  const records = f.root.get(sessionRunServiceKey), sessions = f.root.get(sessionServiceKey)
  for (const [id, snapshot] of samples) {
    const before = await f.db.read(reader => reader.get('SELECT model_snapshot_json FROM harness_runs WHERE id = ?', [id]))
    assert.deepEqual((await records.getRun(id)).modelSnapshot, snapshot)
    assert.deepEqual((await sessions.getRunByKey('empty', id)).modelSnapshot, snapshot)
    const after = await f.db.read(reader => reader.get('SELECT model_snapshot_json FROM harness_runs WHERE id = ?', [id]))
    assert.equal(after.model_snapshot_json, before.model_snapshot_json)
  }
})

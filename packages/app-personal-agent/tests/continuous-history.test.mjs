import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { commitContinuousRoot, continuousBudget, planContinuousRun } from '../dist/core/session/continuous-history.js'

test('continuous budget reserves space for configured output and honors the available model input limit', () => {
  const model = { parameters: { value: { max_tokens: 64 } }, limits: { context: 1024, output: 128, input: 900 } }
  assert.equal(continuousBudget(model, 644), 0)
  assert.throws(() => continuousBudget(model, 645), { code: 'context-too-large' })
  assert.equal(continuousBudget({ ...model, limits: { ...model.limits, input: 10_000 } }, 644), 60)
  assert.equal(continuousBudget({ parameters: { value: {} } }, 1000), 4_888)
  assert.equal(continuousBudget({ parameters: { value: {} }, limits: { context: 1024 } }, 100), 412)
})

test('continuous history evicts whole escaped rounds and bounds exact recall to its project and budget', t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec(`
    CREATE TABLE harness_sessions (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE harness_runs (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE harness_nodes (seq INTEGER PRIMARY KEY, id TEXT, session_id TEXT, source_run_id TEXT, input TEXT, output TEXT);
    CREATE TABLE harness_continuous_roots (seq INTEGER PRIMARY KEY, id TEXT, session_id TEXT, parent_id TEXT,
      anchor_node_id TEXT, cutoff_seq INTEGER, evicted_node_ids_json TEXT);
    CREATE VIRTUAL TABLE harness_continuous_search USING fts5(terms, session_id UNINDEXED, project_id UNINDEXED);
    INSERT INTO harness_sessions VALUES ('session', 'alpha');
    INSERT INTO harness_runs VALUES ('old-run', 'alpha'), ('latest-run', 'alpha');
  `)
  const insert = database.prepare('INSERT INTO harness_nodes VALUES (?, ?, ?, ?, ?, ?)')
  const old = 'Archive detail. ' + '\\'.repeat(5_000)
  const recent = { nodeId: 'recent', user: 'The current request\nkeeps quotes "intact".', assistant: 'Full answer.' }
  insert.run(1, 'old', 'session', 'old-run', old, '旧回答。'.repeat(500))
  insert.run(2, recent.nodeId, 'session', 'latest-run', recent.user, recent.assistant)
  const db = {
    get: (sql, values = []) => database.prepare(sql).get(...values),
    all: (sql, values = []) => database.prepare(sql).all(...values),
    execute: (sql, values = []) => database.prepare(sql).run(...values),
  }
  const input = { sessionId: 'session', projectId: 'alpha', parentNodeId: recent.nodeId, query: 'Completely unrelated', remainingTokens: 8_000 }
  const plan = planContinuousRun(db, input, () => 'first-root')
  assert.deepEqual(plan.context.recent, [recent])
  assert.deepEqual(plan.context.memory, [])
  assert.deepEqual(plan.root.evicted.map(turn => turn.nodeId), ['old'])
  commitContinuousRoot(db, input.sessionId, plan)
  const lookup = (query, projectId = 'alpha', remainingTokens = 8_000) =>
    planContinuousRun(db, { ...input, query, projectId, remainingTokens }, () => 'unexpected-root').context.memory
  assert.ok(lookup('[历史:old]')[0].user.startsWith('Archive detail. '))
  assert.ok(lookup('[历史:old]')[0].assistant.endsWith('…'))
  assert.deepEqual(lookup('[历史:missing]'), [])
  assert.deepEqual(lookup('[历史:old]', 'beta'), [])
  assert.deepEqual(lookup('[历史:old]', 'alpha', 65), [])
})

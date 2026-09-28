import { createSessionComponent } from '../dist/session/component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../dist/session/port.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { runChangedEvent } from '../dist/run/notifications.js'
import { deferred, ids, modelSnapshot, controlledModels } from './helpers/controlled-models.mjs'
const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Test instructions.' }]

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-notifications-')), root = new Context()
  const inputs = { newId: ids(), now: () => '2026-09-27T00:00:00Z' }
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'test.sqlite')))
    await root.installComponent(createProjectComponent(inputs))
    const stateFiber = root.installComponent(createSessionComponent(inputs, agents)); await stateFiber
    const state = root.get(sessionRunServiceKey), sessions = root.get(sessionServiceKey), project = await root.get(projectServiceKey).openProject(directory)
    const session = await sessions.createSession(project.id, 'assistant')
    const plan = modelSnapshot('default', 'test')
    return { root, records: state, sessions, sessionId: session.id, stateFiber, db: root.get(localStorageServiceKey),
      accept: id => state.registerRun(id, { sessionId: session.id, parentNodeId: null, input: 'hello', idempotencyKey: id }, inputs.now(), [], plan),
      async close() { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }); throw error }
}

test('Run hints follow committed revisions; retries, no-ops and rollbacks publish nothing', async () => {
  const f = await fixture(), changes = [], reads = []
  try {
    await f.root.installComponent({ name: 'observer', apply(ctx) {
      ctx.on(runChangedEvent, change => {
        changes.push(change)
        reads.push(f.records.getRun(change.runId).then(async run => ({ change, run,
          node: run.resultNodeId ? await f.sessions.getNode(run.sessionId, run.resultNodeId) : undefined })))
      })
    } })
    await f.accept('run')
    await f.accept('run')
    await assert.rejects(f.records.recordRunEvent('run', { kind: 'model-tool-calls', calls: [] }, 'time'))
    assert.equal(changes.length, 1)
    await f.records.recordRunEvent('run', { kind: 'model-started' }, 'time')
    await f.records.requestCancellation('run', 'time')
    await f.records.requestCancellation('run', 'time')
    assert.equal(await f.records.recordRunEvent('run', { kind: 'model-started' }, 'time'), undefined)
    await f.records.settleRun('run', { kind: 'cancelled' }, 'time')
    await f.records.settleRun('run', { kind: 'cancelled' }, 'time')
    assert.deepEqual(changes.map(item => item.revision), [0, 1, 2, 3])
    await f.accept('success')
    await f.records.settleRun('success', { kind: 'completed', output: 'answer' }, 'time')
    const observed = await Promise.all(reads)
    for (const { change, run } of observed) {
      assert.equal(change.sessionId, f.sessionId)
      assert.equal(Object.isFrozen(change), true)
      assert.deepEqual(Object.keys(change).sort(), ['revision', 'runId', 'sessionId'])
      assert.ok(run.revision >= change.revision)
    }
    assert.equal(observed.at(-1).node.output, 'answer')

    await f.db.transaction(tx => tx.execute(`CREATE TRIGGER fail_run BEFORE INSERT ON harness_runs
      BEGIN SELECT RAISE(ABORT, 'reject'); END`))
    const count = changes.length
    await assert.rejects(f.accept('rolled-back'))
    assert.equal(await f.records.getRun('rolled-back'), undefined)
    assert.equal(changes.length, count)
  } finally { await f.close() }
})

test('observer failures are logged without failing committed work or skipping other observers', async () => {
  const f = await fixture(), changes = []
  try {
    await f.root.installComponent({ name: 'broken-observers', apply(ctx) {
      ctx.on(runChangedEvent, () => { throw new Error('sync listener failed') })
      ctx.on(runChangedEvent, async () => { throw new Error('async listener failed') })
    } })
    const observer = f.root.installComponent({ name: 'healthy-observer', apply(ctx) {
      ctx.on(runChangedEvent, change => { changes.push(change) })
    } }); await observer
    await f.accept('first')
    assert.equal(changes.length, 1)
    assert.equal((await f.records.getRun('first')).status, 'running')
    assert.ok(f.root.logger.records().some(record => record.message === 'Run change notification failed after commit'))
    await observer.restart()
    await f.accept('second')
    assert.equal(changes.length, 2)
    await observer.dispose()
    await f.accept('third')
    assert.equal(changes.length, 2)
  } finally { await f.close() }
})

test('concurrent Run commits carry their own revisions and state cleanup joins notification dispatch', async () => {
  const f = await fixture(), changes = [], gate = deferred(), entered = deferred()
  let hold = false
  try {
    await f.root.installComponent({ name: 'dispatch-probe', apply(ctx) {
      ctx.on(runChangedEvent, change => {
        changes.push(change)
        if (hold) { entered.resolve(); return gate.promise }
      })
    } })
    await Promise.all([f.accept('a'), f.accept('b')])
    await Promise.all([f.records.requestCancellation('a', 'time'), f.records.requestCancellation('b', 'time')])
    for (const id of ['a', 'b']) assert.deepEqual(changes.filter(item => item.runId === id).map(item => item.revision), [0, 1])
    hold = true
    const writing = f.accept('held')
    await entered.promise
    let closed = false
    const closing = f.stateFiber.dispose().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    gate.resolve()
    await writing
    await closing
  } finally { gate.resolve(); await f.close() }
})

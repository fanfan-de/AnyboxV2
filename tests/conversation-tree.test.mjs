import { createProjectFilesComponent } from '../dist/harness/project-files/component.js'
import { createImageAssetsComponent } from '../dist/harness/image/component.js'
import { registerNativeRun, completeNativeRun, completedOutcome } from './helpers/native-records.mjs'
import { createSessionComponent } from '../dist/harness/session/component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../dist/harness/session/port.js'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness/index.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/harness/storage/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/harness/project/component.js'
import { runRuntimeServiceKey } from '../dist/harness/run/runtime-component.js'
import { assemblePath } from '../dist/harness/session/domain.js'
import { controlledModels, modelSnapshot, deferred, ids } from './helpers/controlled-models.mjs'

const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Original instructions.' }]
const tick = () => new Promise(resolve => setImmediate(resolve))
const now = () => '2026-09-26T00:00:00.000Z'

async function host(directory, clock = now) {
  const root = new Context(), llm = controlledModels()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'state.sqlite')) + ".images" }))
  await root.installComponent(llm.component())
  const harness = await createHarness(root, { agents, now: clock })
  const project = await harness.openProject(directory)
  const plans = new Map(), loop = root.get(runRuntimeServiceKey), start = loop.start.bind(loop)
  loop.start = request => { plans.set(request.runId, request.program); return start(request) }
  return { root, llm, harness, project, plans, records: root.get(sessionRunServiceKey), sessions: root.get(sessionServiceKey), db: root.get(localStorageServiceKey) }
}
async function fixture(t, { expectedCleanupFailure = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tree-')))
  const f = await host(directory)
  const session = await f.harness.createSession(f.project.id, 'assistant')
  t.after(async () => {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    try {
      if (expectedCleanupFailure) await assert.rejects(f.harness.close())
      else await f.harness.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const plans = f.plans
  const calls = run => f.llm.calls.filter(call => call.input.execution.snapshot === plans.get(run.id).modelSnapshot)
  return { ...f, directory, session,
    call: (run, step = 0) => calls(run)[step],
    async start(input, parentNodeId = null, idempotencyKey = input) {
      const run = await f.harness.startRun({ sessionId: session.id, parentNodeId, input, idempotencyKey })
      return run
    },
    async finish(run, output = `Answer ${run.input}`) {
      const call = calls(run).at(-1)
      call.result.resolve(output)
      call.done.resolve()
      return f.harness.waitRun(run.id)
    },
  }
}
async function accepted(f, id, parentNodeId = null) {
  return (await registerNativeRun(f.records, id, { sessionId: f.session.id, parentNodeId, input: id, idempotencyKey: id }, now(), [],
    modelSnapshot())).run
}

test('same-parent Runs enter together, finish out of order, and inherit only their own ancestor path', async t => {
  const f = await fixture(t)
  const seed = await f.finish(await f.start('Seed'), 'Root answer')
  const parent = seed.resultNodeId
  const [a, b] = await Promise.all([f.start('Branch A', parent), f.start('Branch B', parent)])
  assert.equal(f.llm.calls.length, 3)
  assert.equal((await f.harness.listRuns(f.session.id, { active: true, parentNodeId: parent })).length, 2)
  const expected = [{ role: 'system', content: 'Original instructions.' },
    { role: 'user', content: 'Seed' }, { role: 'assistant', content: 'Root answer' }]
  assert.deepEqual(f.call(a).input.messages, [...expected, { role: 'user', content: 'Branch A' }])
  assert.deepEqual(f.call(b).input.messages, [...expected, { role: 'user', content: 'Branch B' }])
  const doneB = await f.finish(b, 'B answer')
  const nextB = await f.start('B continuation', doneB.resultNodeId)
  const doneA = await f.finish(a, 'A answer')
  assert.deepEqual(f.llm.calls[3].input.messages, [...expected,
    { role: 'user', content: 'Branch B' }, { role: 'assistant', content: 'B answer' },
    { role: 'user', content: 'B continuation' }])
  await f.finish(nextB)
  const nextA = await f.start('A continuation', doneA.resultNodeId)
  assert.deepEqual(f.llm.calls[4].input.messages, [...expected,
    { role: 'user', content: 'Branch A' }, { role: 'assistant', content: 'A answer' },
    { role: 'user', content: 'A continuation' }])
  await f.finish(nextA)
  const children = await f.harness.listNodes(f.session.id, parent, { limit: 1 })
  assert.equal(children.nodes[0].id, doneB.resultNodeId)
  const rest = await f.harness.listNodes(f.session.id, parent, { cursor: children.nextCursor, limit: 1 })
  assert.equal(rest.nodes[0].id, doneA.resultNodeId)
  assert.equal(rest.nextCursor, undefined)
  assert.equal(rest.nodes[0].parentId, parent)
  assert.deepEqual((await f.harness.getNodePath(f.session.id, doneA.resultNodeId)).map(n => n.id), [parent, doneA.resultNodeId])
  assert.equal('turns' in await f.harness.getSession(f.session.id), false)
})

test('concurrent idempotent admission shares one execution; changed input or parent leaves no records', async t => {
  const f = await fixture(t)
  const root = await f.finish(await f.start('Seed'))
  const calls = Array.from({ length: 12 }, () => f.start('  Same  ', root.resultNodeId, 'same-key'))
  const conflict = f.start('Different', root.resultNodeId, 'same-key')
  await assert.rejects(conflict, /idempotency key/)
  await assert.rejects(f.start('Same', null, 'same-key'), /idempotency key/)
  const values = await Promise.all(calls)
  assert.equal(new Set(values.map(run => run.id)).size, 1)
  assert.equal(f.llm.calls.length, 2)
  assert.equal((await f.harness.listRuns(f.session.id)).length, 2)
  assert.equal((await f.harness.getRunByKey(f.session.id, 'same-key')).id, values[0].id)
  await f.finish(values[0])
  await assert.rejects(f.start('Same', null, 'same-key'), /idempotency key/)
  assert.equal((await f.start('Same', root.resultNodeId, 'same-key')).id, values[0].id)
  assert.equal(f.llm.calls.length, 2)
})

test('invalid, missing and cross-Session parents are rejected before any Run or node is inserted', async t => {
  const f = await fixture(t)
  const seed = await f.finish(await f.start('Seed'))
  const other = await f.harness.createSession(f.project.id, 'assistant')
  await assert.rejects(f.harness.startRun({ sessionId: other.id, parentNodeId: seed.resultNodeId, input: 'x', idempotencyKey: 'x' }), /node-not-found/)
  await assert.rejects(async () => f.harness.startRun({ sessionId: other.id, input: 'x', idempotencyKey: 'x' }), /parentNodeId/)
  await assert.rejects(f.start('x', 'missing'), /node-not-found/)
  assert.deepEqual(await f.harness.listRuns(other.id), [])
  assert.equal((await f.harness.listRuns(f.session.id)).length, 1)
  assert.equal(f.llm.calls.length, 1)
  await assert.rejects(f.db.transaction(tx => tx.execute(
    'INSERT INTO harness_nodes (id, session_id, parent_id, input, output) VALUES (?, ?, ?, ?, ?)',
    ['cross-parent', other.id, seed.resultNodeId, 'x', 'y'])), /operation-failed/)
  await assert.rejects(f.db.transaction(tx => tx.execute('UPDATE harness_nodes SET output = ? WHERE id = ?', ['edited', seed.resultNodeId])), /operation-failed/)
  await assert.rejects(f.db.transaction(tx => tx.execute('DELETE FROM harness_nodes WHERE id = ?', [seed.resultNodeId])), /operation-failed/)
})

test('regeneration and edited input produce immutable siblings with fixed instructions and raw historical input', async t => {
  const f = await fixture(t)
  const task = await f.harness.createPrompt('alice', { name: 'Task', kind: 'task-template', role: 'user', content: 'Task: {{input}}' })
  await f.harness.bindPrompt('alice', 'assistant', (await f.harness.publishPrompt('alice', task.id)).id)
  const original = await f.finish(await f.start('Original input'))
  const continuation = await f.start('Descendant', original.resultNodeId)
  const instructions = await f.harness.createPrompt('alice', { name: 'Instructions', kind: 'agent-instruction', role: 'system', content: 'New instructions.' })
  await f.harness.bindPrompt('alice', 'assistant', (await f.harness.publishPrompt('alice', instructions.id)).id)
  const n = await f.harness.getNode(f.session.id, original.resultNodeId)
  const [regenerated, edited] = await Promise.all([
    f.start(n.input, n.parentId, 'regenerate'), f.start('Edited input', n.parentId, 'edit'),
  ])
  assert.deepEqual(f.llm.calls[1].input.messages, [
    { role: 'system', content: 'Original instructions.' }, { role: 'user', content: 'Task: Original input' },
    { role: 'assistant', content: 'Answer Original input' }, { role: 'user', content: 'Task: Descendant' },
  ])
  assert.deepEqual(f.call(regenerated).input.messages, [
    { role: 'system', content: 'Original instructions.' }, { role: 'user', content: 'Task: Original input' },
  ])
  assert.deepEqual(regenerated.promptVersionIds, original.promptVersionIds)
  assert.deepEqual(f.call(edited).input.messages, [
    { role: 'system', content: 'Original instructions.' }, { role: 'user', content: 'Task: Edited input' },
  ])
  assert.deepEqual((await f.harness.getRun(continuation.id)).promptVersionIds, continuation.promptVersionIds)
  const child = await f.finish(continuation)
  await f.finish(edited)
  await f.finish(regenerated)
  assert.deepEqual(await f.harness.getNode(f.session.id, n.id), n)
  assert.deepEqual((await f.harness.getNodePath(f.session.id, child.resultNodeId)).map(n => n.input), ['Original input', 'Descendant'])
  assert.equal((await f.harness.listNodes(f.session.id, null)).nodes.length, 3)
})

for (const cancel of [false, true]) test(`startup ownership deduplicates start and keeps wait pending (cancel=${cancel})`, async t => {
  const f = await fixture(t)
  const entered = deferred(), release = deferred()
  const original = f.records.getRun.bind(f.records)
  let gated = false
  f.records.getRun = async id => {
    if (!gated && f.plans.has(id)) { gated = true; entered.resolve(id); await release.promise }
    return original(id)
  }
  t.after(() => release.resolve())
  const starting = f.start('Startup')
  const id = await entered.promise
  const loop = f.root.get(runRuntimeServiceKey)
  const duplicate = loop.start({ runId: id, program: f.plans.get(id) })
  let finished = false
  const waiting = f.harness.waitRun(id).then(run => { finished = true; return run })
  if (cancel) assert.equal((await f.harness.cancelRun(id)).status, 'cancelling')
  await tick()
  assert.equal(finished, false)
  assert.equal(f.llm.calls.length, 0)
  release.resolve()
  const [first, second] = await Promise.all([starting, duplicate])
  assert.equal(first.id, second.id)
  if (cancel) {
    assert.equal((await waiting).status, 'cancelled')
    assert.equal(f.llm.calls.length, 0)
  } else {
    assert.equal(f.llm.calls.length, 1)
    await f.finish(first)
    assert.equal((await waiting).status, 'completed')
    await loop.start({ runId: id, program: f.plans.get(id) })
    assert.equal(f.llm.calls.length, 1)
  }
})

test('cancellation and failure affect only the selected branch; success waits for done', async t => {
  const f = await fixture(t)
  const [a, b, c] = await Promise.all([f.start('Cancel me'), f.start('Fail me'), f.start('Finish me')])
  f.call(c).result.resolve('Final answer')
  await tick()
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
  assert.equal((await f.harness.cancelRun(a.id)).status, 'cancelling')
  assert.deepEqual(f.call(b).cancellations, [])
  assert.deepEqual(f.call(c).cancellations, [])
  f.call(a).result.resolve('Cannot become an answer')
  f.call(a).done.resolve()
  f.call(b).result.reject(new Error('private supplier failure'))
  f.call(b).done.resolve()
  assert.equal((await f.harness.waitRun(a.id)).status, 'cancelled')
  assert.equal((await f.harness.waitRun(b.id)).status, 'failed')
  f.call(c).done.resolve()
  assert.equal((await f.harness.waitRun(c.id)).status, 'completed')
  assert.equal((await f.harness.cancelRun(c.id)).status, 'completed')
  const nodes = (await f.harness.listNodes(f.session.id, null)).nodes
  assert.deepEqual(nodes.map(node => node.sourceRunId), [c.id])
})

test('cancel versus success uses transaction order; duplicate settlement creates exactly one node and event', async t => {
  const f = await fixture(t)
  const a = await accepted(f, 'cancel-first'), b = await accepted(f, 'success-first')
  await Promise.all([f.records.requestCancellation(a.id, now()), completeNativeRun(f.records, a.id, 'A', now())])
  const [success] = await Promise.all([completeNativeRun(f.records, b.id, 'B', now()), f.records.requestCancellation(b.id, now())])
  assert.equal((await f.records.getRun(a.id)).status, 'cancelled')
  assert.equal(success.status, 'completed')
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => completeNativeRun(f.records, b.id, 'Changed', now())))
  assert.ok(duplicates.every(run => run.resultNodeId === success.resultNodeId && run.output === 'B'))
  assert.equal((await f.harness.listNodes(f.session.id, null)).nodes.length, 1)
  assert.equal((await f.sessions.getRunEvents(b.id)).length, 1)
})

test('success settlement rolls back Run, node, execution and event when the final linking write fails', async t => {
  const f = await fixture(t)
  const run = await accepted(f, 'atomic')
  const before = await f.records.getRunExecution(run.id)
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_result BEFORE UPDATE OF result_node_id ON harness_runs
    BEGIN SELECT RAISE(ABORT, 'injected link failure'); END`))
  await assert.rejects(completeNativeRun(f.records, run.id, 'Final', now()), /operation-failed/)
  assert.deepEqual(await f.records.getRun(run.id), run)
  assert.deepEqual(await f.records.getRunExecution(run.id), before)
  assert.deepEqual(await f.sessions.getRunEvents(run.id), [])
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
  await f.db.transaction(tx => tx.execute('DROP TRIGGER test_fail_result'))
  const done = await completeNativeRun(f.records, run.id, 'Final', now())
  assert.equal(done.status, 'completed')
  assert.equal((await f.sessions.getRunEvents(run.id)).length, 1)
  assert.equal((await f.records.getRunExecution(run.id)).phase, 'terminal')
})

test('a failed success commit is classified as state-write-failure without replay or a partial node', async t => {
  const f = await fixture(t)
  const run = await f.start('Commit fault')
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_success BEFORE UPDATE OF result_node_id ON harness_runs
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`))
  const terminal = await f.finish(run)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.equal(terminal.output, undefined)
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
  assert.deepEqual((await f.sessions.getRunEvents(run.id)).map(e => e.kind), ['operation-started', 'operation-observed', 'terminal'])
  assert.equal(f.llm.calls.length, 1)
})

test('tool observation commit failure stops the batch without repeating the side effect', async t => {
  const f = await fixture(t)
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_observation BEFORE INSERT ON harness_run_events
    WHEN json_extract(NEW.payload_json, '$.kind') = 'tool-observed'
    BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`))
  const run = await f.start('Tool fault')
  f.llm.calls[0].result.resolve({ status: 'completed', text: '', toolCalls: [
    { id: 'one', name: 'bash', arguments: { command: 'printf once >> marker' } },
    { id: 'two', name: 'bash', arguments: { command: 'printf unexpected > second' } },
  ] })
  f.llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.equal(readFileSync(join(f.directory, 'marker'), 'utf8'), 'once')
  assert.equal(existsSync(join(f.directory, 'second')), false)
  assert.equal(f.llm.calls.length, 1)
  await f.root.get(runRuntimeServiceKey).start({ runId: run.id, program: f.plans.get(run.id) })
  assert.equal(readFileSync(join(f.directory, 'marker'), 'utf8'), 'once')
  assert.deepEqual((await f.sessions.getRunEvents(run.id)).map(e => e.kind), ['operation-started', 'operation-observed', 'tool-started', 'terminal'])
})

test('ancestor validation rejects broken, cyclic and cross-Session paths', () => {
  const root = { id: 'root', sessionId: 's', parentId: null, input: 'x', output: 'y', sourceRunId: null }
  const child = { ...root, id: 'child', parentId: 'root' }
  assert.deepEqual(assemblePath('s', 'child', [child, root]), [root, child])
  for (const path of [[child], [{ ...child, sessionId: 'other' }, root], [child, { ...root, parentId: 'child' }, child]]) {
    assert.throws(() => assemblePath('s', 'child', path), /invalid-history/)
  }
})


test('closing during startup cancels before the first call and still joins the handoff', async t => {
  const f = await fixture(t)
  const entered = deferred(), release = deferred()
  const original = f.records.getRun.bind(f.records)
  let gated = false
  f.records.getRun = async id => {
    if (!gated && f.plans.has(id)) { gated = true; entered.resolve(id); await release.promise }
    return original(id)
  }
  const starting = f.start('Closing at startup')
  const id = await entered.promise
  const closed = f.harness.close()
  // The close path must issue cancellation before waiting for the blocked startup.
  for (let i = 0; i < 20 && (await original(id)).status === 'running'; i++) await tick()
  const cancelled = (await original(id)).status
  release.resolve()
  const result = await starting
  await closed
  assert.equal(cancelled, 'cancelling')
  assert.equal(result.status, 'cancelled')
  assert.equal(f.llm.calls.length, 0)
})

test('Harness close joins every active branch before releasing SQLite and the model component', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.start('First'), f.start('Second')])
  const waiting = [f.harness.waitRun(a.id), f.harness.waitRun(b.id)]
  let closed = false
  const closing = f.harness.close().then(() => { closed = true })
  await Promise.all(f.llm.calls.map(call => call.cancelled.promise))
  f.call(a).result.resolve('First')
  f.call(a).done.resolve()
  assert.equal((await waiting[0]).status, 'cancelled')
  f.call(b).result.resolve('Second')
  await tick()
  assert.equal(closed, false)
  assert.equal(f.root.get(localStorageServiceKey), f.db)
  f.call(b).done.resolve()
  assert.equal((await waiting[1]).status, 'cancelled')
  await closing
  assert.equal(f.root.get(localStorageServiceKey), undefined)
  assert.deepEqual(f.llm.events, ['disposed'])
})

test('persistent settlement failure rejects wait and repeated start; restart interrupts without replay', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tree-write-failure-')))
  let f = await host(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Fail storage', idempotencyKey: 'fault' })
    await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_settle BEFORE UPDATE OF status ON harness_runs
      WHEN NEW.status IN ('completed', 'failed', 'cancelled')
      BEGIN SELECT RAISE(ABORT, 'persistent failure'); END`))
    const waiting = f.harness.waitRun(run.id)
    f.llm.calls[0].result.resolve('Already executed')
    f.llm.calls[0].done.resolve()
    await assert.rejects(waiting, /operation-failed/)
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    await assert.rejects(f.root.get(runRuntimeServiceKey).start({ runId: run.id, program: f.plans.get(run.id) }), /operation-failed/)
    assert.equal(f.llm.calls.length, 1)
    await f.db.transaction(tx => tx.execute('DROP TRIGGER test_fail_settle'))
    await assert.rejects(f.harness.close())
    f = await host(directory)
    const interrupted = await f.harness.getRun(run.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.deepEqual(interrupted.history, { kind: 'tree', parentNodeId: null })
    assert.equal(interrupted.resultNodeId, undefined)
    assert.equal(f.llm.calls.length, 0)
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
  } finally { try { await f.harness.close() } finally { rmSync(directory, { recursive: true, force: true }) } }
})

test('restart interrupts multiple active Runs independently while retaining their fixed parents', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tree-recovery-')))
  const root = new Context(), inputs = { now, newId: ids() }
  let restarted
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'state.sqlite')) + ".images" }))
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createProjectFilesComponent(inputs))
    await root.installComponent(createSessionComponent(inputs, agents))
    const project = await root.get(projectServiceKey).openProject(directory)
    const state = root.get(sessionRunServiceKey), sessions = root.get(sessionServiceKey)
    const session = await sessions.createSession(project.id, 'assistant')
    const f = { records: state, session, sessions }
    await accepted(f, 'seed')
    const seed = await completeNativeRun(state, 'seed', 'Saved answer', now())
    const a = await accepted(f, 'a', seed.resultNodeId), b = await accepted(f, 'b', seed.resultNodeId)
    const call = { id: 'bash', name: 'bash', arguments: { command: 'printf uncertain >> marker' } }
    await state.startOperation(a.id, { id: 'tool-operation', kind: 'tool', tool: call, intent: call }, now())
    await state.requestCancellation(b.id, now())
    await root.fiber.dispose()
    restarted = await host(directory)
    for (const id of [a.id, b.id]) {
      const run = await restarted.harness.getRun(id)
      assert.equal(run.status, 'interrupted')
      assert.deepEqual(run.history, { kind: 'tree', parentNodeId: seed.resultNodeId })
      assert.equal((await restarted.records.getRunExecution(id)).phase, 'terminal')
      assert.equal((await restarted.sessions.getRunEvents(id)).at(-1).kind, 'interrupted')
    }
    assert.equal(restarted.llm.calls.length, 0)
    assert.equal(existsSync(join(directory, 'marker')), false)
    assert.deepEqual((await restarted.harness.listNodes(session.id, seed.resultNodeId)).nodes, [])
    const next = await restarted.harness.startRun({ sessionId: session.id, parentNodeId: seed.resultNodeId, input: 'New attempt', idempotencyKey: 'new' })
    assert.deepEqual(restarted.llm.calls[0].input.messages, [
      { role: 'user', content: 'seed' }, { role: 'assistant', content: 'Saved answer' }, { role: 'user', content: 'New attempt' },
    ])
    restarted.llm.calls[0].result.resolve('Done')
    restarted.llm.calls[0].done.resolve()
    await restarted.harness.waitRun(next.id)
  } finally {
    await restarted?.harness.close()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('native tool trajectories continue along their own branch and exclude siblings', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.start('Use tool'), f.start('Sibling')])
  f.call(a).result.resolve({ status: 'completed', text: 'Checking', toolCalls: [
    { id: 'one', name: 'bash', arguments: { command: 'printf private-tool-observation' } },
  ] })
  f.call(a).done.resolve()
  await f.finish(b, 'Sibling answer')
  for (let i = 0; i < 100 && f.llm.calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.llm.calls.length, 3)
  const own = f.call(a, 1).input.messages
  assert.equal(own.at(-1).role, 'tool')
  assert.match(own.at(-1).content, /private-tool-observation/)
  assert.doesNotMatch(JSON.stringify(own), /Sibling/)
  const done = await f.finish(a, 'Tool answer')
  const child = await f.start('Continue', done.resultNodeId)
  const inherited = f.llm.calls[3].input.messages
  assert.deepEqual(inherited.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
  assert.match(inherited.find(message => message.role === 'tool').content, /private-tool-observation/)
  assert.equal(inherited.at(-1).content, 'Continue')
  assert.doesNotMatch(JSON.stringify(inherited), /Sibling/)
  await f.finish(child)
})

test('aborting a Run waiter removes its listener without cancelling execution', async t => {
  const { getEventListeners } = await import('node:events')
  const f = await fixture(t)
  const run = await f.start('Waiter')
  const controllers = Array.from({ length: 10 }, () => new AbortController())
  const waits = controllers.map(controller => f.harness.waitRun(run.id, controller.signal))
  const rejected = waits.map(wait => assert.rejects(wait, { name: 'AbortError' }))
  for (const controller of controllers) controller.abort()
  await Promise.all(rejected)
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.deepEqual(f.llm.calls[0].cancellations, [])
  const completedWaiter = new AbortController()
  const waiting = f.harness.waitRun(run.id, completedWaiter.signal)
  await f.finish(run)
  assert.equal((await waiting).status, 'completed')
  assert.equal(getEventListeners(completedWaiter.signal, 'abort').length, 0)
})

test('wait covers the committed admission before AgentLoop takes ownership', async t => {
  const f = await fixture(t)
  const committed = deferred(), release = deferred()
  const original = f.records.registerRun.bind(f.records)
  f.records.registerRun = async (...args) => {
    const accepted = await original(...args)
    committed.resolve(accepted.run.id)
    await release.promise
    return accepted
  }
  const starting = f.start('Handoff')
  const id = await committed.promise
  let ended = false
  const waiting = f.harness.waitRun(id).then(value => { ended = true; return value })
  try {
    assert.equal((await f.harness.getRunByKey(f.session.id, 'Handoff')).id, id)
    await tick()
    assert.equal(ended, false)
    assert.equal(f.llm.calls.length, 0)
    assert.equal((await f.harness.cancelRun(id)).status, 'cancelling')
    await tick()
    assert.equal(ended, false)
  } finally { release.resolve() }
  assert.equal((await starting).status, 'cancelled')
  assert.equal((await waiting).status, 'cancelled')
  assert.equal(f.llm.calls.length, 0)
})

test('an accepted Run keeps ancestry and snapshots even if a sibling completes before startup reads', async t => {
  const f = await fixture(t)
  const seed = await f.finish(await f.start('Seed'))
  const sibling = await f.start('Sibling', seed.resultNodeId)
  const entered = deferred(), release = deferred()
  const original = f.records.loadRunContext.bind(f.records)
  f.records.loadRunContext = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const starting = f.start('Accepted earlier', seed.resultNodeId)
  await entered.promise
  const doc = await f.harness.createPrompt('alice', { name: 'Later', kind: 'agent-instruction', role: 'system', content: 'Later instruction' })
  const published = await f.harness.publishPrompt('alice', doc.id)
  await f.harness.bindPrompt('alice', 'assistant', published.id)
  await f.finish(sibling, 'Sibling completed before startup')
  release.resolve()
  const run = await starting
  assert.deepEqual(f.llm.calls[2].input.messages, [
    { role: 'system', content: 'Original instructions.' }, { role: 'user', content: 'Seed' },
    { role: 'assistant', content: 'Answer Seed' }, { role: 'user', content: 'Accepted earlier' },
  ])
  await f.finish(run)
})

test('cleanup failure still wins over cancellation after a transient terminal write error', async t => {
  const f = await fixture(t, { expectedCleanupFailure: true })
  const run = await f.start('Cleanup and write failure')
  await f.harness.cancelRun(run.id)
  const original = f.records.settleRun.bind(f.records)
  let injected = false
  f.records.settleRun = async (...args) => {
    if (!injected) { injected = true; throw new Error('injected terminal write failure') }
    return original(...args)
  }
  f.llm.calls[0].result.resolve('Not successful')
  f.llm.calls[0].done.reject(new Error('actual cleanup failure'))
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'cleanup-failure')
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
})

test('a state failure after cancellation is not hidden as an ordinary cancelled outcome', async t => {
  const f = await fixture(t)
  const run = await f.start('Cancel with storage failure')
  await f.harness.cancelRun(run.id)
  const original = f.records.observeOperation.bind(f.records)
  let injected = false
  f.records.observeOperation = async (...args) => {
    if (!injected) { injected = true; throw new Error('injected observation write failure') }
    return original(...args)
  }
  f.llm.calls[0].result.resolve('Never an answer')
  f.llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.equal(terminal.resultNodeId, undefined)
})


test('a transient terminal write failure remains visible after user cancellation', async t => {
  const f = await fixture(t)
  const run = await f.start('Cancel and terminal write failure')
  await f.harness.cancelRun(run.id)
  const original = f.records.settleRun.bind(f.records)
  let injected = false
  f.records.settleRun = async (...args) => {
    if (!injected) { injected = true; throw new Error('injected terminal commit failure') }
    return original(...args)
  }
  f.llm.calls[0].result.resolve('Not successful')
  f.llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
})

test('archive preserves native history, hides default lists, blocks writes and restores continuation', async t => {
  const f = await fixture(t)
  const completed = await f.finish(await f.start('Seed'))
  const before = await f.harness.getNodePath(f.session.id, completed.resultNodeId)
  const records = await f.harness.getRunRecords(completed.id)
  const archived = await f.harness.archiveSession(f.session.id)
  assert.equal(archived.archivedAt, now())
  assert.deepEqual(await f.harness.archiveSession(f.session.id), archived)
  assert.deepEqual(await f.harness.listSessions(f.project.id), [])
  assert.deepEqual(await f.harness.listArchivedSessions(), [archived])
  assert.deepEqual(await f.harness.getNodePath(f.session.id, completed.resultNodeId), before)
  assert.deepEqual(await f.harness.getRunRecords(completed.id), records)
  const opens = f.llm.opens.length
  await assert.rejects(f.start('New'), { code: 'session-archived' })
  await assert.rejects(f.harness.selectSessionModel(f.session.id, 'default'), { code: 'session-archived' })
  await assert.rejects(accepted(f, 'direct'), { code: 'session-archived' })
  const image = f.harness.importImage(f.session.id, { async *[Symbol.asyncIterator]() { assert.fail('must not consume image') } })
  await assert.rejects(image.result, { code: 'session-archived' }); await image.done
  const files = f.harness.prepareProjectFiles(f.session.id, 'files', [{ kind: 'project-file', path: 'missing' }])
  await assert.rejects(files.result, { code: 'session-archived' }); await files.done
  assert.equal((await f.start('Seed')).id, completed.id)
  await assert.rejects(f.start('Changed', null, 'Seed'), /idempotency key/)
  assert.equal(f.llm.opens.length, opens)
  const restored = await f.harness.restoreSession(f.session.id)
  assert.equal(restored.archivedAt, null)
  assert.deepEqual(await f.harness.restoreSession(f.session.id), restored)
  assert.deepEqual(await f.harness.listArchivedSessions(), [])
  const next = await f.finish(await f.start('Continued', completed.resultNodeId))
  assert.equal(next.status, 'completed')
  assert.equal((await f.harness.getNodePath(f.session.id, next.resultNodeId)).length, 2)
  await assert.rejects(f.harness.archiveSession('missing'), /unknown session/)
  await assert.rejects(f.harness.restoreSession('missing'), /unknown session/)
})

test('archive rejects running and cancelling Runs until actual model exit and settlement', async t => {
  const f = await fixture(t), run = await f.start('Active')
  await assert.rejects(f.harness.archiveSession(f.session.id), { code: 'session-has-active-runs' })
  await f.harness.cancelRun(run.id)
  await f.call(run).cancelled.promise
  await assert.rejects(f.harness.archiveSession(f.session.id), { code: 'session-has-active-runs' })
  assert.equal((await f.harness.getSession(f.session.id)).archivedAt, null)
  f.call(run).done.resolve()
  assert.equal((await f.harness.waitRun(run.id)).status, 'cancelled')
  assert.equal((await f.harness.archiveSession(f.session.id)).archivedAt, now())
})

test('archive winning during preparation rejects acceptance and joins untransferred program cleanup', async t => {
  const f = await fixture(t), entered = deferred(), proceed = deferred(), closing = deferred(), exited = deferred()
  const protocols = f.root.get('harness.protocol-agents'), prepare = protocols.prepare.bind(protocols)
  let released = false, settled = false
  protocols.prepare = async input => {
    const program = await prepare(input)
    entered.resolve()
    await proceed.promise
    return { ...program, async close() { closing.resolve(); await exited.promise; return program.close() }, release() { released = true; program.release() } }
  }
  const starting = f.start('Racing')
  const rejected = assert.rejects(starting, { code: 'session-archived' }).then(() => { settled = true })
  try {
    await entered.promise
    await f.harness.archiveSession(f.session.id)
    proceed.resolve()
    await closing.promise
    await tick()
    assert.equal(settled, false); assert.equal(released, false)
    assert.equal(f.llm.calls.length, 0)
    assert.deepEqual(await f.harness.listRuns(f.session.id), [])
    exited.resolve(); await rejected
    assert.equal(released, true)
    assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
    const facts = await f.db.read(reader => ['harness_native_initializations', 'harness_native_records', 'harness_native_contexts'].map(table => reader.get(`SELECT count(*) AS n FROM ${table}`).n))
    assert.deepEqual(facts, [0, 0, 0])
  } finally { proceed.resolve(); exited.resolve() }
})

test('archive and restore survive restart and work across unavailable project directories', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-archives-')))
  const { mkdirSync } = await import('node:fs')
  let time = now(), f = await host(directory, () => time)
  t.after(async () => { await f.harness.close(); rmSync(directory, { recursive: true, force: true }) })
  const otherPath = join(directory, 'other'); mkdirSync(otherPath)
  const otherProject = await f.harness.openProject(otherPath)
  const a = await f.harness.createSession(f.project.id, 'assistant'), b = await f.harness.createSession(otherProject.id, 'assistant')
  await f.harness.archiveSession(a.id); await f.harness.archiveSession(b.id)
  const expected = [a.id, b.id].sort()
  assert.deepEqual((await f.harness.listArchivedSessions()).map(item => item.id), expected)
  await f.harness.close()
  rmSync(otherPath, { recursive: true })
  f = await host(directory, () => time)
  assert.deepEqual((await f.harness.listArchivedSessions()).map(item => item.id), expected)
  assert.equal((await f.harness.getSession(a.id)).archivedAt, now())
  assert.deepEqual(await f.harness.listSessions(otherProject.id), [])
  await f.harness.restoreSession(b.id)
  assert.equal((await f.harness.listSessions(otherProject.id))[0].id, b.id)
  time = '2026-09-29T00:00:00.000Z'
  await f.harness.archiveSession(b.id)
  assert.deepEqual((await f.harness.listArchivedSessions()).map(item => item.id), [b.id, a.id])
})

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { createSqliteStateComponent, stateServiceKey } from '../dist/run/sqlite-state.js'
import { agentLoopServiceKey } from '../dist/run/agent-loop-component.js'
import { assemblePath } from '../dist/run/domain.js'
import { controlledLLM, deferred, ids } from './helpers/controlled-llm.mjs'

const agents = [{ id: 'assistant', modelProfileId: 'default', instructions: 'Original instructions.' }]
const tick = () => new Promise(resolve => setImmediate(resolve))
const now = () => '2026-09-26T00:00:00.000Z'

async function host(directory) {
  const root = new Context(), llm = controlledLLM()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(llm.component())
  const harness = await createHarness(root, { agents, now })
  const project = await harness.openProject(directory)
  return { root, llm, harness, project, state: root.get(stateServiceKey), db: root.get(localStorageServiceKey) }
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
  const plans = new Map()
  const calls = run => f.llm.calls.filter(call => call.input.plan === plans.get(run.id))
  return { ...f, directory, session,
    call: (run, step = 0) => calls(run)[step],
    async start(input, parentNodeId = null, idempotencyKey = input) {
      const run = await f.harness.startRun({ sessionId: session.id, parentNodeId, input, idempotencyKey })
      const plan = run.status === 'running' ? await f.state.getRunPlan(run.id) : undefined
      if (plan) plans.set(run.id, plan)
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
  return (await f.state.acceptRun(id, { sessionId: f.session.id, parentNodeId, input: id, idempotencyKey: id }, now(), [],
    { snapshot: { profileId: 'default', configVersion: 'v1' } })).run
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

test('regeneration and edited input produce immutable siblings with current snapshots and raw historical input', async t => {
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
    { role: 'system', content: 'Original instructions.' }, { role: 'user', content: 'Original input' },
    { role: 'assistant', content: 'Answer Original input' }, { role: 'user', content: 'Task: Descendant' },
  ])
  assert.deepEqual(f.call(regenerated).input.messages, [
    { role: 'system', content: 'New instructions.' }, { role: 'user', content: 'Task: Original input' },
  ])
  assert.notDeepEqual(regenerated.promptVersionIds, original.promptVersionIds)
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
  const original = f.state.getRun.bind(f.state)
  let gated = false
  f.state.getRun = async id => {
    if (!gated) { gated = true; entered.resolve(id); await release.promise }
    return original(id)
  }
  t.after(() => release.resolve())
  const starting = f.start('Startup')
  const id = await entered.promise
  const loop = f.root.get(agentLoopServiceKey)
  const duplicate = loop.start(id)
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
    await loop.start(id)
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
  await Promise.all([f.state.requestCancellation(a.id, now()), f.state.settleRun(a.id, { kind: 'completed', output: 'A' }, now())])
  const [success] = await Promise.all([f.state.settleRun(b.id, { kind: 'completed', output: 'B' }, now()), f.state.requestCancellation(b.id, now())])
  assert.equal((await f.state.getRun(a.id)).status, 'cancelled')
  assert.equal(success.status, 'completed')
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => f.state.settleRun(b.id, { kind: 'completed', output: 'Changed' }, now())))
  assert.ok(duplicates.every(run => run.resultNodeId === success.resultNodeId && run.output === 'B'))
  assert.equal((await f.harness.listNodes(f.session.id, null)).nodes.length, 1)
  assert.equal((await f.state.getRunEvents(b.id)).length, 1)
})

test('success settlement rolls back Run, node, execution and event when the final linking write fails', async t => {
  const f = await fixture(t)
  const run = await accepted(f, 'atomic')
  const before = await f.state.getRunExecution(run.id)
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_result BEFORE UPDATE OF result_node_id ON harness_runs
    BEGIN SELECT RAISE(ABORT, 'injected link failure'); END`))
  await assert.rejects(f.state.settleRun(run.id, { kind: 'completed', output: 'Final' }, now()), /operation-failed/)
  assert.deepEqual(await f.state.getRun(run.id), run)
  assert.deepEqual(await f.state.getRunExecution(run.id), before)
  assert.deepEqual(await f.state.getRunEvents(run.id), [])
  assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
  await f.db.transaction(tx => tx.execute('DROP TRIGGER test_fail_result'))
  const done = await f.state.settleRun(run.id, { kind: 'completed', output: 'Final' }, now())
  assert.equal(done.status, 'completed')
  assert.equal((await f.state.getRunEvents(run.id)).length, 1)
  assert.equal((await f.state.getRunExecution(run.id)).phase, 'terminal')
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
  assert.deepEqual((await f.state.getRunEvents(run.id)).map(e => e.kind), ['model-started', 'terminal'])
  assert.equal(f.llm.calls.length, 1)
})

test('tool observation commit failure stops the batch without repeating the side effect', async t => {
  const f = await fixture(t)
  await f.db.transaction(tx => tx.execute(`CREATE TRIGGER test_fail_observation BEFORE INSERT ON harness_run_events
    WHEN json_extract(NEW.payload_json, '$.kind') = 'tool-observed'
    BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`))
  const run = await f.start('Tool fault')
  f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [
    { id: 'one', name: 'bash', arguments: { command: 'printf once >> marker' } },
    { id: 'two', name: 'bash', arguments: { command: 'printf unexpected > second' } },
  ] })
  f.llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.equal(readFileSync(join(f.directory, 'marker'), 'utf8'), 'once')
  assert.equal(existsSync(join(f.directory, 'second')), false)
  assert.equal(f.llm.calls.length, 1)
  await f.root.get(agentLoopServiceKey).start(run.id)
  assert.equal(readFileSync(join(f.directory, 'marker'), 'utf8'), 'once')
  assert.deepEqual((await f.state.getRunEvents(run.id)).map(e => e.kind), ['model-started', 'model-tool-calls', 'tool-started', 'terminal'])
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
  const original = f.state.getRun.bind(f.state)
  let gated = false
  f.state.getRun = async id => {
    if (!gated) { gated = true; entered.resolve(id); await release.promise }
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
    await assert.rejects(f.root.get(agentLoopServiceKey).start(run.id), /operation-failed/)
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
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createSqliteStateComponent(inputs))
    const project = await root.get(projectServiceKey).openProject(directory)
    const state = root.get(stateServiceKey)
    const session = await state.createSession('s', project.id, 'assistant', now())
    const f = { state, session }
    await accepted(f, 'seed')
    const seed = await state.settleRun('seed', { kind: 'completed', output: 'Saved answer' }, now())
    const a = await accepted(f, 'a', seed.resultNodeId), b = await accepted(f, 'b', seed.resultNodeId)
    await state.recordRunEvent(a.id, { kind: 'model-started' }, now())
    const call = { id: 'bash', name: 'bash', arguments: { command: 'printf uncertain >> marker' } }
    await state.recordRunEvent(a.id, { kind: 'model-tool-calls', calls: [call] }, now())
    await state.recordRunEvent(a.id, { kind: 'tool-started', call }, now())
    await state.requestCancellation(b.id, now())
    await root.fiber.dispose()
    restarted = await host(directory)
    for (const id of [a.id, b.id]) {
      const run = await restarted.harness.getRun(id)
      assert.equal(run.status, 'interrupted')
      assert.deepEqual(run.history, { kind: 'tree', parentNodeId: seed.resultNodeId })
      assert.equal((await restarted.state.getRunExecution(id)).phase, 'terminal')
      assert.equal((await restarted.state.getRunEvents(id)).at(-1).kind, 'interrupted')
    }
    assert.equal(restarted.llm.calls.length, 0)
    assert.equal(existsSync(join(directory, 'marker')), false)
    assert.deepEqual((await restarted.harness.listNodes(session.id, seed.resultNodeId)).nodes, [])
    const next = await restarted.harness.startRun({ sessionId: session.id, parentNodeId: seed.resultNodeId, input: 'New attempt', idempotencyKey: 'new' })
    assert.deepEqual(restarted.llm.calls[0].input.messages.slice(1), [
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

test('tool trajectories stay inside their Run and never become ancestor messages', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.start('Use tool'), f.start('Sibling')])
  f.call(a).result.resolve({ kind: 'tool-calls', content: 'Checking', calls: [
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
  assert.deepEqual(f.llm.calls[3].input.messages.slice(1), [
    { role: 'user', content: 'Use tool' }, { role: 'assistant', content: 'Tool answer' }, { role: 'user', content: 'Continue' },
  ])
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
  const original = f.state.acceptRun.bind(f.state)
  f.state.acceptRun = async (...args) => {
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
    assert.equal((await f.harness.cancelRun(id)).status, 'cancelled')
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
  const original = f.state.getNodePath.bind(f.state)
  f.state.getNodePath = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
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
  const original = f.state.settleRun.bind(f.state)
  let injected = false
  f.state.settleRun = async (...args) => {
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
  const original = f.state.getRun.bind(f.state)
  let injected = false
  f.state.getRun = async id => {
    if (!injected) { injected = true; throw new Error('injected state read failure') }
    return original(id)
  }
  f.llm.calls[0].result.resolve('Never an answer')
  f.llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'state-write-failure')
  assert.equal(terminal.resultNodeId, undefined)
})

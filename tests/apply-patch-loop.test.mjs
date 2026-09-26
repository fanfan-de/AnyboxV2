import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { createSqliteStateComponent, stateServiceKey } from '../dist/run/sqlite-state.js'
import { applyPatchServiceKey } from '../dist/tool/apply-patch-component.js'
import { controlledLLM, deferred } from './helpers/controlled-llm.mjs'

const agents = [{ id: 'assistant', instructions: 'Use the available tools.', modelProfileId: 'default' }]
const patch = (id, text) => ({ id, name: 'apply_patch', arguments: { patch: text } })
const bash = (id, command) => ({ id, name: 'bash', arguments: { command } })
const add = (path, content) => `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch`

async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-patch-loop-')))
  const root = new Context(), llm = controlledLLM()
  await root.installComponent(llm.component())
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const harness = await createHarness(root, { agents })
  const project = await harness.openProject(directory)
  const session = await harness.createSession(project.id, 'assistant')
  t.after(async () => {
    for (const call of llm.calls) call.done.resolve()
    await harness.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, root, llm, harness, session }
}

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('expected tool-loop progress did not occur')
}
function answer(call, value) { call.result.resolve(value); call.done.resolve() }
function start(f) {
  return f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Edit the project', idempotencyKey: 'one' })
}

test('Bash, Apply Patch and Bash share one ordered batch and native tool observations', async t => {
  const f = await fixture(t), run = await start(f)
  assert.deepEqual(f.llm.calls[0].input.tools.map(tool => tool.name), ['bash', 'apply_patch'])
  answer(f.llm.calls[0], { kind: 'tool-calls', calls: [
    bash('before', 'printf old > source.txt'),
    patch('edit', '*** Begin Patch\n*** Update File: source.txt\n@@\n-old\n+new\n*** End Patch'),
    bash('after', 'cat source.txt'),
  ] })
  await until(() => f.llm.calls.length === 2)
  const observations = f.llm.calls[1].input.messages.filter(message => message.role === 'tool')
  assert.deepEqual(observations.map(message => message.toolCallId), ['before', 'edit', 'after'])
  assert.equal(JSON.parse(observations[1].content).status, 'applied')
  assert.equal(JSON.parse(observations[2].content).stdout, 'new')
  answer(f.llm.calls[1], 'Updated and checked.')
  assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
  assert.equal((await f.root.get(stateServiceKey).getRunExecution(run.id)).toolCalls, 3)
  const events = await f.harness.getRunEvents(run.id)
  assert.deepEqual(events.filter(event => event.kind === 'tool-observed').map(event => event.name), ['bash', 'apply_patch', 'bash'])
  const stored = await f.root.get(localStorageServiceKey).read(reader => reader.all('SELECT payload_json FROM harness_run_events'))
  assert.ok(stored.every(row => !row.payload_json.includes('"kind":"bash-')))
})

test('invalid patch text is returned to the model and a corrected patch can succeed', async t => {
  const f = await fixture(t), run = await start(f)
  answer(f.llm.calls[0], { kind: 'tool-calls', calls: [patch('bad', 'not a patch')] })
  await until(() => f.llm.calls.length === 2)
  const rejected = JSON.parse(f.llm.calls[1].input.messages.at(-1).content)
  assert.equal(rejected.status, 'rejected')
  assert.deepEqual(rejected.changes, [])
  assert.ok(rejected.diagnostic.message)
  answer(f.llm.calls[1], { kind: 'tool-calls', calls: [patch('good', add('fixed.txt', 'fixed'))] })
  await until(() => f.llm.calls.length === 3)
  answer(f.llm.calls[2], 'Fixed.')
  assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
  assert.equal(readFileSync(join(f.directory, 'fixed.txt'), 'utf8'), 'fixed\n')
})

test('a malformed argument envelope prevents every tool in a mixed batch', async t => {
  const f = await fixture(t), run = await start(f)
  answer(f.llm.calls[0], { kind: 'tool-calls', calls: [
    patch('valid', add('untouched.txt', 'must not exist')),
    { id: 'bad', name: 'apply_patch', arguments: { patch: 42 } },
    bash('also-valid', 'touch bash-marker'),
  ] })
  assert.equal((await f.harness.waitRun(run.id)).errorCategory, 'invalid-tool-request')
  assert.equal(existsSync(join(f.directory, 'untouched.txt')), false)
  assert.equal(existsSync(join(f.directory, 'bash-marker')), false)
})

for (const cleanupFailure of [false, true]) {
  test(`patch ${cleanupFailure ? 'cleanup failure' : 'cancellation'} retains changes and waits for actual exit`, async t => {
    const entered = deferred(), result = deferred(), done = deferred(), cancelled = deferred()
    t.after(() => { result.resolve({ status: 'cancelled', changes: [], pending: [] }); done.resolve() })
    const f = await fixture(t)
    f.root.get(applyPatchServiceKey).execute = () => {
      entered.resolve()
      return { result: result.promise, done: done.promise, cancel: reason => cancelled.resolve(reason) }
    }
    const run = await start(f)
    answer(f.llm.calls[0], { kind: 'tool-calls', calls: [patch('edit', add('written.txt', 'written'))] })
    await entered.promise
    const waiting = f.harness.waitRun(run.id)
    let finished = false
    void waiting.then(() => { finished = true })
    const summary = { status: 'cancelled', changes: [{ kind: 'added', path: join(f.directory, 'written.txt') }], pending: [] }
    result.resolve(summary)
    await f.harness.cancelRun(run.id)
    await cancelled.promise
    assert.equal(finished, false)
    assert.equal((await f.harness.getRun(run.id)).status, 'cancelling')
    if (cleanupFailure) done.reject(new Error('controlled cleanup failure'))
    else done.resolve()
    const terminal = await waiting
    assert.equal(terminal.status, cleanupFailure ? 'failed' : 'cancelled')
    if (cleanupFailure) assert.equal(terminal.errorCategory, 'tool-cleanup-failure')
    assert.equal(f.llm.calls.length, 1)
    const event = (await f.harness.getRunEvents(run.id)).find(event => event.kind === (cleanupFailure ? 'tool-failed' : 'tool-observed'))
    assert.deepEqual(event.result, summary)
    assert.equal(event.name, 'apply_patch')
    assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes, [])
  })
}

async function stateHost(directory) {
  const root = new Context(), inputs = { now: () => 'now', newId: () => 'project' }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createSqliteStateComponent(inputs))
  return { root, state: root.get(stateServiceKey), db: root.get(localStorageServiceKey), projects: root.get(projectServiceKey) }
}

test('old Bash JSON reads as tool events without rewriting completed history or changing cursors', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-patch-legacy-')))
  const first = await stateHost(directory)
  let second
  t.after(async () => { await second?.root.fiber.dispose(); await first.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const project = await first.projects.openProject(directory)
  const session = await first.state.createSession('session', project.id, 'assistant', 'old')
  const plan = { snapshot: { profileId: 'default', configVersion: 'v1' } }
  for (const id of ['completed', 'in-flight', 'failed']) {
    await first.state.acceptRun(id, { sessionId: session.id, parentNodeId: null, input: id, idempotencyKey: id }, 'old', [], plan)
  }
  await first.state.settleRun('completed', { kind: 'completed', output: 'saved' }, 'old')
  await first.state.settleRun('failed', { kind: 'failed', error: 'old failure', category: 'tool-timeout' }, 'old')
  const call = bash('legacy-call', 'printf old')
  const legacyResult = { exitCode: 0, signal: null, stdout: 'old', stderr: '', truncated: false }
  const completedEvents = [
    { kind: 'model-started' }, { kind: 'model-tool-calls', calls: [call] },
    { kind: 'bash-started', call }, { kind: 'bash-observed', requestId: call.id, result: legacyResult },
    { kind: 'model-started' }, { kind: 'terminal', status: 'completed' },
  ]
  await first.db.transaction(tx => {
    for (const id of ['completed', 'in-flight', 'failed']) {
      const complete = id !== 'in-flight'
      const events = id === 'completed' ? completedEvents : id === 'failed' ? [
        ...completedEvents.slice(0, 3),
        { kind: 'bash-failed', requestId: call.id, category: 'tool-timeout' },
        { kind: 'terminal', status: 'failed', errorCategory: 'tool-timeout' },
      ] : completedEvents.slice(0, 3)
      tx.execute('DELETE FROM harness_run_events WHERE run_id = ?', [id])
      const execution = { phase: complete ? 'terminal' : 'tool-in-flight', revision: events.length,
        modelCalls: complete ? 2 : 1, bashCalls: 1, nextToolIndex: 0, batch: complete ? [] : [call] }
      tx.execute('UPDATE harness_runs SET execution_json = ? WHERE id = ?', [JSON.stringify(execution), id])
      events.forEach((event, index) => tx.execute('INSERT INTO harness_run_events VALUES (?, ?, ?, ?)', [id, index + 1, 'old', JSON.stringify(event)]))
    }
  })
  const legacyBytes = await first.db.read(reader => reader.get('SELECT execution_json FROM harness_runs WHERE id = ?', ['completed']).execution_json)
  await first.root.fiber.dispose()
  second = await stateHost(directory)
  assert.equal((await second.state.getRunExecution('completed')).toolCalls, 1)
  const events = await second.state.getRunEvents('completed', 3)
  assert.deepEqual(events.map(event => [event.seq, event.kind, event.at]), [[4, 'tool-observed', 'old'], [5, 'model-started', 'old'], [6, 'terminal', 'old']])
  assert.equal(events[0].name, 'bash')
  assert.deepEqual(events[0].result, legacyResult)
  assert.equal(await second.db.read(reader => reader.get('SELECT execution_json FROM harness_runs WHERE id = ?', ['completed']).execution_json), legacyBytes)
  const oldFailure = (await second.state.getRunEvents('failed', 3))[0]
  assert.deepEqual(oldFailure, { kind: 'tool-failed', name: 'bash', requestId: call.id, category: 'tool-timeout', seq: 4, at: 'old' })
  assert.equal((await second.state.getRun('in-flight')).status, 'interrupted')
  assert.equal((await second.state.getRunEvents('in-flight')).at(-1).seq, 4)
})

test('an in-flight Apply Patch intent is interrupted on restart without replaying files', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-patch-recovery-')))
  const first = await stateHost(directory)
  let second
  t.after(async () => { await second?.root.fiber.dispose(); await first.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const project = await first.projects.openProject(directory)
  const session = await first.state.createSession('s', project.id, 'assistant', 'old')
  await first.state.acceptRun('r', { sessionId: session.id, parentNodeId: null, input: 'edit', idempotencyKey: 'one' }, 'old', [],
    { snapshot: { profileId: 'default', configVersion: 'v1' } })
  const call = patch('patch', add('marker', 'would overwrite'))
  await first.state.recordRunEvent('r', { kind: 'model-started' }, 'old')
  await first.state.recordRunEvent('r', { kind: 'model-tool-calls', calls: [call] }, 'old')
  await first.state.recordRunEvent('r', { kind: 'tool-started', call }, 'old')
  writeFileSync(join(directory, 'marker'), 'already written')
  await first.root.fiber.dispose()
  second = await stateHost(directory)
  assert.equal((await second.state.getRun('r')).status, 'interrupted')
  assert.equal(readFileSync(join(directory, 'marker'), 'utf8'), 'already written')
  assert.deepEqual((await second.state.getRunEvents('r')).map(event => event.kind), ['model-started', 'model-tool-calls', 'tool-started', 'interrupted'])
})

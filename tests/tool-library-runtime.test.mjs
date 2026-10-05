import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { controlledModels } from './helpers/controlled-models.mjs'

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-process-runtime-'))), root = new Context(), llm = controlledModels()
  await root.installComponent(llm.component())
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  const harness = await createTestHarnessServerCore(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Use tools.' }] }, { legacyTools: false })
  const project = await harness.openProject(directory), session = await harness.createSession(project.id, 'assistant')
  return { directory, root, llm, harness, session, async close(failure = false) {
    llm.calls.forEach(call => call.done.resolve())
    try { if (failure) await assert.rejects(harness.close()); else await harness.close() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  } }
}
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Run did not reach its next model operation')
}
async function running(f, waitForPid = true) {
  const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'process', idempotencyKey: 'one' })
  f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'exec', name: 'codex_exec_command', arguments: { cmd: 'printf "%s" "$$" > process.pid; sleep 30', yield_time_ms: 0 } }] })
  f.llm.calls[0].done.resolve()
  await until(() => f.llm.calls.length === 2 && (!waitForPid || existsSync(join(f.directory, 'process.pid'))))
  return run
}
function gone(pid) {
  try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}
async function cleanupFact(f, run) {
  const rows = await f.root.get('local-storage').read(reader => reader.all('SELECT intent_json, observation_json FROM harness_run_operations WHERE run_id = ?', [run.id]))
  const cleanup = rows.find(row => JSON.parse(row.intent_json).kind === 'tool-process-cleanup')
  assert.ok(cleanup, 'Run must persist a cleanup operation')
  return JSON.parse(cleanup.observation_json)
}

test('normal completion closes yielded processes and commits their final exits before creating the node', { timeout: 10000 }, async () => {
  const f = await fixture()
  try {
    const run = await running(f), pid = Number(readFileSync(join(f.directory, 'process.pid'), 'utf8'))
    assert.equal(gone(pid), false)
    f.llm.calls[1].result.resolve('complete'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'completed')
    assert.equal(gone(pid), true)
    const cleanup = await cleanupFact(f, run)
    assert.equal(cleanup.kind, 'value')
    assert.equal(cleanup.result.cleanup, 'completed')
    assert.equal(cleanup.result.processes[0].terminated, true)
    assert.ok(finished.resultNodeId)
  } finally { await f.close() }
})

for (const action of ['cancel', 'close']) test(`${action} waits for accepted model exit and persists yielded process cleanup`, { timeout: 10000 }, async () => {
  const f = await fixture()
  let closed = false
  try {
    const run = await running(f), pid = Number(readFileSync(join(f.directory, 'process.pid'), 'utf8'))
    let settled = false
    const waiting = f.harness.waitRun(run.id).then(value => { settled = true; return value })
    const stopping = action === 'close' ? f.harness.close() : f.harness.cancelRun(run.id)
    await f.llm.calls[1].cancelled.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    f.llm.calls[1].done.resolve()
    const finished = await waiting; await stopping
    assert.equal(finished.status, 'cancelled')
    assert.equal(gone(pid), true)
    if (action === 'cancel') assert.equal((await cleanupFact(f, run)).result.cleanup, 'completed')
    else closed = true
    assert.equal(finished.resultNodeId, undefined)
  } finally { if (!closed) await f.close(); else rmSync(f.directory, { recursive: true, force: true }) }
})

test('process cleanup failure preserves its facts and prevents successful settlement', { timeout: 10000 }, async () => {
  const f = await fixture()
  try {
    const result = { processes: [{ session_id: 1, exit_code: null, signal: 'SIGTERM', output: 'partial', terminated: true, timed_out: false, truncated: false }], cleanup: 'failed' }
    f.root.get('tools.processes').openRun = () => ({
      execute: () => ({ result: Promise.resolve({ output: 'started', session_id: 1, exit_code: null }), done: Promise.resolve(), cancel() {} }),
      close: () => ({ result: Promise.resolve(result), done: Promise.reject(new Error('controlled cleanup failure')), cancel() {} }),
    })
    const run = await running(f, false)
    f.llm.calls[1].result.resolve('must not publish'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'tool-cleanup-failure')
    assert.equal(finished.resultNodeId, undefined)
    const cleanup = await cleanupFact(f, run)
    assert.equal(cleanup.kind, 'cleanup-failed')
    assert.deepEqual(cleanup.result, result)
  } finally { await f.close(true) }
})

test('failed final observation closes process resources and fails settlement', { timeout: 10000 }, async () => {
  const f = await fixture()
  try {
    const run = await running(f), pid = Number(readFileSync(join(f.directory, 'process.pid'), 'utf8'))
    const records = f.root.get('harness.session-runs'), start = records.startOperation.bind(records), observe = records.observeOperation.bind(records)
    const cleanupIds = new Set()
    records.startOperation = async (id, operation, at) => { if (operation.cleanup) cleanupIds.add(operation.id); return start(id, operation, at) }
    records.observeOperation = (id, operationId, value, at) => cleanupIds.has(operationId) ? Promise.reject(new Error('storage failed')) : observe(id, operationId, value, at)
    f.llm.calls[1].result.resolve('must not publish'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'state-write-failure')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal(gone(pid), true)
  } finally { await f.close() }
})

test('output captured at final process close participates in the Run output limit', { timeout: 10000 }, async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'output', idempotencyKey: 'one' })
    f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'exec', name: 'codex_exec_command', arguments: {
      cmd: "head -c 200000 /dev/zero | tr '\\0' 'x'; printf ready > output.ready; sleep 30", yield_time_ms: 0,
    } }] })
    f.llm.calls[0].done.resolve()
    await until(() => f.llm.calls.length === 2 && existsSync(join(f.directory, 'output.ready')))
    f.llm.calls[1].result.resolve('must not publish'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'limit-exceeded')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal((await cleanupFact(f, run)).result.processes[0].truncated, true)
  } finally { await f.close() }
})

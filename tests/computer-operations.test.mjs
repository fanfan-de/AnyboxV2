import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import sharp from 'sharp'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createProjectComponent } from '../packages/app-harness/dist/core/project/component.js'
import { createImageAssetsComponent } from '../packages/app-harness/dist/core/image/component.js'
import { createProjectFilesComponent } from '../packages/app-harness/dist/core/project-files/component.js'
import { createSessionComponent } from '../packages/app-harness/dist/core/session/component.js'
import { createRunRuntimeComponent } from '../packages/app-harness/dist/core/run/runtime-component.js'
import { createLocalComputerProvider } from './helpers/fixed-computer-provider.mjs'
import { workerError } from '../packages/app-harness/dist/core/computer/worker-port.js'
import { computerDeclarationDigest } from '../packages/app-harness/dist/core/computer/operations-domain.js'
import { getToolById } from '../packages/app-harness/dist/core/tool/catalog.js'
import { installComputerServices, createControlledComputerWorker, installComputerWorkerStub } from './helpers/computer-services.mjs'
import { deferred, modelSnapshot } from './helpers/controlled-models.mjs'
import { nativeRegistration, completedOutcome } from './helpers/native-records.mjs'

const inputs = { now: () => 'now', newId: randomUUID }
const tick = () => new Promise(resolve => setImmediate(resolve))
const request = (id = 'tool', command = 'echo once') => ({ id, name: 'bash', arguments: { command } })
const observation = { name: 'bash', result: { exitCode: 23, signal: null, stdout: 'once', stderr: '', truncated: false } }
const immediate = value => ({ result: Promise.resolve(value), done: Promise.resolve(), cancel() {} })
async function joined(call) { try { return await call.result } finally { await call.done } }
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await tick() }
  assert.fail('expected state was not reached')
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-computer-operations-')), root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const worker = createControlledComputerWorker(root)
  await root.installComponent(worker.component)
  await root.installComponent(createProjectComponent(inputs))
  const projects = root.get('harness.projects'), project = await projects.openProject(directory)
  const provider = createLocalComputerProvider(), events = { activations: 0, executions: [], cleanupFailed: false }
  root.provide('computer.instance-provider', { ...provider, activate(input) { events.activations++; return provider.activate(input) } })
  await installComputerServices(root, inputs, { worker })
  const db = root.get('local-storage'), ops = root.get('harness.computer-operations'), computers = root.get('harness.computers')
  t.after(async () => {
    try {
      if (events.cleanupFailed) await assert.rejects(root.fiber.dispose())
      else await root.fiber.dispose()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const accept = (operationId, runId = 'run', toolRequest = request(operationId)) => db.transaction(tx => ops.acceptIn(tx,
    { operationId, runId, sessionId: 'session', projectId: project.id, request: toolRequest, tool: getToolById('anybox.bash') }))
  const executor = (execute = () => immediate(observation), close = () => immediate({ processes: [] })) => ({
    execute(req, binding) { events.executions.push({ req, binding }); return execute(req, binding) }, hasProcesses: () => false, close,
  })
  const openRun = ({ execution, ...input }) => { worker.setExecution(input.runId, execution); return ops.openRun(input) }
  return { root, directory, db, ops, computers, projects, project, events, accept, executor, openRun, worker }
}

test('pushed tool images are resolved from the Session scope instead of being imported again, and mismatched receipts are rejected', async t => {
  const f = await fixture(t)
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0f0f0f' } }).png().toBuffer()
  const assets = f.root.get('harness.image-assets')
  const imported = await joined(assets.importImage({ scopeId: 'session', bytes: (async function* () { yield png })() }))
  const { expiresAt: _draft, ...ref } = imported
  assert.equal(typeof _draft, 'string')
  const pushed = { assetId: imported.assetId, sha256: imported.sha256, byteLength: imported.byteLength, mimeType: imported.mediaType }
  const viewed = { name: 'bash', result: { exitCode: 0, signal: null, stdout: 'image', stderr: '', truncated: false }, images: [ref] }
  await f.accept('pushed'); await f.accept('mismatch'); await f.accept('foreign')
  const scope = f.openRun({ runId: 'run', imageInput: true, execution: f.executor(req => immediate({ ...viewed, workerImages: [
    req.id === 'pushed' ? { ref, pushed } : req.id === 'mismatch' ? { ref, pushed: { ...pushed, sha256: createHash('sha256').update('other').digest('hex') } } : { ref, pushed: { ...pushed, assetId: 'missing' } }] })) })
  const observed = await joined(scope.execute('pushed'))
  assert.deepEqual(observed.images, [ref], 'the receipt resolves to the retained Session asset without a second import')
  assert.equal((await assets.describe('session', [ref.assetId]))[0].expiresAt, undefined, 'the observation transaction retained the pushed draft')
  await assert.rejects(joined(scope.execute('mismatch')), { code: 'computer-operation-conflict' })
  await assert.rejects(joined(scope.execute('foreign')), { code: 'computer-operation-conflict' })
  assert.equal((await f.ops.get('mismatch')).state, 'failed'); assert.equal((await f.ops.get('foreign')).state, 'failed')
  await joined(scope.close())
})

test('operation declaration and resource demand roll back together; hashes exclude authorization and normalize parameter key order', async t => {
  const f = await fixture(t)
  await assert.rejects(f.db.transaction(tx => {
    f.ops.acceptIn(tx, { operationId: 'rollback', runId: 'run', sessionId: 'session', projectId: f.project.id,
      request: request(), tool: getToolById('anybox.bash') })
    throw new Error('abort admission')
  }), /abort admission/)
  assert.equal(await f.ops.get('rollback'), undefined)
  assert.deepEqual(await f.computers.list(), [])
  assert.equal(await f.root.get('harness.workspaces').getForProject(f.project.id), undefined)
  const accepted = await f.accept('op')
  assert.equal(accepted.state, 'accepted')
  assert.equal(f.events.activations, 0)
  assert.deepEqual(await f.accept('op'), accepted)
  await assert.rejects(f.accept('op', 'run', request('op', 'different')), { code: 'computer-operation-conflict' })
  assert.equal(computerDeclarationDigest({ ...accepted.declaration, runOwnerEpoch: 1 }), computerDeclarationDigest({ ...accepted.declaration, runOwnerEpoch: 99 }))
  const sorted = { ...accepted.declaration, request: { arguments: { b: 2, a: 1 }, id: 'op', name: 'bash' } }
  assert.equal(computerDeclarationDigest(sorted), computerDeclarationDigest({ ...sorted, request: { ...sorted.request, arguments: { a: 1, b: 2 } } }))
  const scope = f.openRun({ runId: 'run', execution: f.executor() })
  await joined(scope.close())
  assert.equal((await f.ops.get('op')).state, 'cancelled')
})

test('a Run uses one prepared placement and repeated operation ID returns the same execution and actual observation', async t => {
  const f = await fixture(t), scope = f.openRun({ runId: 'run', execution: f.executor() })
  await f.accept('first')
  const first = scope.execute('first')
  assert.strictEqual(scope.execute('first'), first)
  assert.deepEqual(await joined(first), observation)
  assert.equal(f.events.activations, 1)
  const pin = await f.computers.getPin('computer-run:run')
  assert.equal(pin.releasedAt, null)
  const original = f.projects.requireAvailable
  f.projects.requireAvailable = async () => { throw new Error('must not re-resolve fixed placement') }
  await f.accept('second')
  assert.deepEqual(await joined(scope.execute('second')), observation)
  f.projects.requireAvailable = original
  assert.equal(f.events.executions.length, 2)
  assert.deepEqual(f.events.executions[0].binding, f.events.executions[1].binding)
  await f.db.transaction(tx => f.ops.observeIn(tx, 'first', { kind: 'value', tool: observation }))
  await f.db.transaction(tx => f.ops.observeIn(tx, 'first', { kind: 'value', tool: observation }))
  await assert.rejects(f.db.transaction(tx => f.ops.observeIn(tx, 'first', { kind: 'error' })), { code: 'computer-operation-conflict' })
  await joined(scope.close())
  assert.equal(typeof (await f.computers.getPin('computer-run:run')).releasedAt, 'string')
})

test('result is not published and pin is not released until tool and scope resources actually exit', async t => {
  const f = await fixture(t), toolResult = deferred(), toolDone = deferred(), closeDone = deferred()
  const scope = f.openRun({ runId: 'run', execution: f.executor(() => ({ result: toolResult.promise, done: toolDone.promise, cancel() {} }),
    () => ({ result: Promise.resolve({ processes: [] }), done: closeDone.promise, cancel() {} })) })
  await f.accept('op')
  const call = scope.execute('op')
  await until(() => f.events.executions.length === 1)
  toolResult.resolve(observation)
  let returned = false
  void call.result.then(() => { returned = true })
  await tick()
  assert.equal(returned, false)
  assert.equal((await f.computers.getPin('computer-run:run')).releasedAt, null)
  toolDone.resolve()
  assert.deepEqual(await joined(call), observation)
  const close = scope.close()
  await tick()
  assert.equal((await f.computers.getPin('computer-run:run')).releasedAt, null)
  closeDone.resolve()
  await joined(close)
  assert.notEqual((await f.computers.getPin('computer-run:run')).releasedAt, null)
})

test('cancelling before dispatch never activates, and cancellation does not close another Run admission', async t => {
  const f = await fixture(t), first = f.openRun({ runId: 'first', execution: f.executor() })
  await f.accept('cancelled', 'first')
  const call = first.execute('cancelled'); call.cancel('cancel immediately')
  await assert.rejects(joined(call))
  await joined(first.close())
  assert.equal(f.events.activations, 0)
  assert.equal((await f.ops.get('cancelled')).state, 'cancelled')
  const second = f.openRun({ runId: 'second', execution: f.executor() })
  await f.accept('accepted', 'second')
  assert.deepEqual(await joined(second.execute('accepted')), observation)
  await joined(second.close())
})

test('failed actual exit does not hang on an unresolved result and scope cleanup cannot release its pin', async t => {
  const f = await fixture(t), done = deferred(), never = deferred()
  const scope = f.openRun({ runId: 'run', execution: f.executor(() => ({ result: never.promise, done: done.promise, cancel() {} })) })
  await f.accept('op')
  const call = scope.execute('op')
  await until(() => f.events.executions.length === 1)
  done.reject(new Error('actual cleanup failed'))
  await assert.rejects(call.result)
  await assert.rejects(call.done)
  const close = scope.close()
  assert.deepEqual(await close.result, { processes: [] }, 'known cleanup observations survive the uncertain tool exit')
  await assert.rejects(close.done)
  assert.equal((await f.computers.getPin('computer-run:run')).releasedAt, null)
  assert.equal((await f.db.read(reader => reader.get('SELECT closed FROM harness_computer_scopes WHERE run_id=?',['run']))).closed, 0)
  assert.equal((await f.ops.get('op')).state, 'outcome-unknown')
  f.events.cleanupFailed = true
})

test('a mismatched owner cannot dispatch, and live process references keep their exact placement until scope exit', async t => {
  const f = await fixture(t)
  const stale = f.openRun({ runId: 'stale', runOwnerEpoch: 2, execution: f.executor() })
  await f.accept('stale-op', 'stale')
  await assert.rejects(joined(stale.execute('stale-op')), { code: 'computer-operation-owner' })
  await assert.rejects(stale.close().result, { code: 'computer-operation-owner' })
  await assert.rejects(stale.close().done, { code: 'computer-operation-cleanup' })
  f.events.cleanupFailed = true
  assert.equal(f.events.activations, 0)
  assert.throws(() => f.openRun({ runId: 'invalid', runOwnerEpoch: 0, execution: f.executor() }), { code: 'computer-operation-owner' })
  const processResult = { name: 'codex_exec_command', result: { session_id: 42, output: 'partial' } }
  const scope = f.openRun({ runId: 'process', execution: { ...f.executor(() => immediate(processResult)), hasProcesses: () => true } })
  await f.db.transaction(tx => f.ops.acceptIn(tx, { operationId: 'process-op', runId: 'process', sessionId: 'session', projectId: f.project.id,
    request: { id: 'process-call', name: 'codex_exec_command', arguments: { cmd: 'long process' } }, tool: getToolById('codex.exec_command') }))
  await joined(scope.execute('process-op'))
  const operation = await f.ops.get('process-op')
  assert.equal(operation.processRef.sessionId, 42)
  assert.equal(operation.processRef.runId, 'process')
  assert.equal(operation.processRef.computerInstanceId, operation.binding.computerInstanceId)
  assert.equal(operation.processRef.instanceGeneration, operation.binding.instanceGeneration)
  assert.equal((await f.computers.getPin('computer-run:process')).releasedAt, null)
  await joined(scope.close())
  assert.notEqual((await f.computers.getPin('computer-run:process')).releasedAt, null)
})

test('a scope close failure is reported and never releases a placement pin', async t => {
  const f = await fixture(t)
  const scope = f.openRun({ runId: 'run', execution: f.executor(undefined, () => { throw new Error('scope could not close') }) })
  await f.accept('op')
  await joined(scope.execute('op'))
  const close = scope.close()
  await assert.rejects(close.result, { code: 'computer-operation-cleanup' })
  await assert.rejects(close.done, { code: 'computer-operation-cleanup' })
  assert.equal((await f.computers.getPin('computer-run:run')).releasedAt, null)
  f.events.cleanupFailed = true
})

test('component reconstruction preserves uncertain execution facts and never replays old declarations', async t => {
  const f = await fixture(t)
  await f.accept('uncertain')
  await f.accept('not-started', 'other-run')
  await f.db.transaction(tx => { tx.execute("UPDATE harness_computer_operations SET state = 'starting' WHERE operation_id = ?", ['uncertain']);
    tx.execute('DELETE FROM harness_computer_scopes WHERE run_id=?', ['run']) })
  await f.root.fiber.dispose()
  const second = new Context()
  try {
    await second.installComponent(createLocalSqliteComponent(join(f.directory, 'state.sqlite')))
    await installComputerWorkerStub(second)
    await second.installComponent(createProjectComponent(inputs))
    const provider = createLocalComputerProvider()
    second.provide('computer.instance-provider', { ...provider, activate(input) { f.events.activations++; return provider.activate(input) } })
    await installComputerServices(second, inputs)
    const operations = second.get('harness.computer-operations')
    assert.equal((await operations.get('uncertain')).state, 'outcome-unknown')
    assert.equal((await operations.get('not-started')).state, 'accepted')
    await tick()
    assert.equal(f.events.activations, 0)
    assert.equal(f.events.executions.length, 0)
  } finally { await second.fiber.dispose() }
})

test('Run intent and ComputerOperation admission share the Session transaction; model and plan Runs leave computer idle', async t => {
  const f = await fixture(t)
  await f.root.installComponent(createProjectFilesComponent(inputs))
  await f.root.installComponent(createSessionComponent(inputs, [{ id: 'assistant' }]))
  const sessions = f.root.get('harness.sessions'), records = f.root.get('harness.session-runs')
  await sessions.setAgentTools('assistant', { toolIds: ['anybox.bash', 'codex.update_plan'], expectedRevision: 0 })
  const session = await sessions.createSession(f.project.id, 'assistant'), snapshot = modelSnapshot()
  const selection = session.toolSelection
  const initialization = { schemaVersion: 2, prompts: [], tools: selection.tools.map(tool => tool.definition), toolContractVersion: 'tool-library-v1', toolSelection: selection }
  f.root.provide('tools.bash', { execute(input) { f.events.executions.push(input); return immediate(observation.result) } })
  f.root.provide('tools.apply-patch', {})
  f.root.provide('tools.processes', {})
  f.root.provide('tools.files', {})
  await f.root.installComponent(createRunRuntimeComponent(inputs))
  const runtime = f.root.get('harness.run-runtime')
  async function run(id, requests = []) {
    const input = { sessionId: session.id, parentNodeId: null, idempotencyKey: id, input: id }
    const registration = nativeRegistration(input, snapshot, [], null, initialization)
    await records.registerRun(id, input, 'now', [], snapshot, registration)
    const final = completedOutcome(id, 'complete')
    const program = { binding: registration.binding, modelSnapshot: snapshot, initialization, input: registration.input,
      signal: new AbortController().signal, release() {},
      async execute(host) { if (requests.length) await host.executeTools(requests); return { kind: 'completed', output: 'complete', resultRecordIds: final.resultRecordIds } },
      async close() { return { records: final.records, checkpoint: final.checkpoint, cleanup: 'completed' } } }
    await runtime.start({ runId: id, program })
    return runtime.wait(id)
  }
  assert.equal((await run('model')).status, 'completed')
  assert.equal((await run('plan', [{ id: 'plan-call', name: 'codex_update_plan', arguments: { plan: [{ step: 'Task', status: 'pending' }] } }])).status, 'completed')
  assert.equal(f.events.activations, 0)
  assert.deepEqual(await f.computers.list(), [])
  assert.equal(await f.root.get('harness.workspaces').getForProject(f.project.id), undefined)
  const rollbackInput = { sessionId: session.id, parentNodeId: null, idempotencyKey: 'rollback', input: 'rollback' }
  await records.registerRun('rollback', rollbackInput, 'now', [], snapshot, nativeRegistration(rollbackInput, snapshot, [], null, initialization))
  await assert.rejects(records.startOperation('rollback', { id: 'rollback-op', kind: 'tool', tool: request('rollback-call'),
    intent: { name: 'bash' }, records: [{ id: 'bad-record', kind: 'invalid', formatVersion: 1, payload: {} }] }, 'now'))
  assert.equal(await f.ops.get('rollback-op'), undefined)
  assert.equal(await f.db.read(reader => reader.get('SELECT id FROM harness_run_operations WHERE id = ?', ['rollback-op'])), undefined)
  assert.deepEqual(await f.computers.list(), [])
  await records.settleRun('rollback', { kind: 'cancelled' }, 'now')
  const originalStart = records.startOperation
  records.startOperation = async (runId, operation, at) => {
    const accepted = await originalStart(runId, operation, at)
    if (runId === 'cancel-after-admission' && operation.kind === 'tool') await runtime.cancel(runId, 'user-requested')
    return accepted
  }
  assert.equal((await run('cancel-after-admission', [request('cancel-call')])).status, 'cancelled')
  records.startOperation = originalStart
  assert.equal(f.events.activations, 0)
  assert.equal(f.events.executions.length, 0)
  const cancelled = await f.db.read(reader => reader.get('SELECT state FROM harness_computer_operations WHERE run_id = ?', ['cancel-after-admission']))
  assert.equal(cancelled.state, 'cancelled')
  const reservation = await f.db.read(reader => reader.get('SELECT released_at FROM harness_workspace_reservations WHERE scope_id = ?', ['cancel-after-admission']))
  assert.notEqual(reservation.released_at, null)
  await run('bash', [request('bash-call')])
  const operations = await f.db.read(reader => reader.all('SELECT operation_id, state, observed FROM harness_computer_operations WHERE run_id = ?', ['bash']))
  assert.equal(operations.length, 1)
  assert.equal(operations[0].state, 'succeeded')
  assert.equal(operations[0].observed, 1)
  const intent = await f.db.read(reader => reader.get('SELECT status FROM harness_run_operations WHERE id = ?', [operations[0].operation_id]))
  assert.equal(intent.status, 'value')
  assert.equal(f.events.executions[0].workspacePath, f.project.path)
  assert.equal(f.events.activations, 1)
  assert.equal((await f.ops.get(operations[0].operation_id)).declaration.tool.toolId, 'anybox.bash')
})


test('an unconfirmed restored placement keeps owner recovery pending until the worker can answer', async t => {
  const f = await fixture(t)
  await f.accept('placed')
  const scope = f.openRun({ runId: 'run', execution: f.executor() })
  await joined(scope.execute('placed'))
  const placement = (await f.ops.get('placed')).binding
  await f.accept('unconfirmed')
  await f.db.transaction(tx => {
    tx.execute("UPDATE harness_computer_operations SET state='starting',binding_json=? WHERE operation_id='unconfirmed'", [JSON.stringify(placement)])
    // Model the durable boundary after dispatch, before the Authority persisted any first receipt.
    tx.execute("UPDATE harness_computer_operations SET worker_receipt=NULL WHERE run_id='run'")
  })
  const claim = f.worker.service.claimRun, controller = new AbortController()
  f.worker.service.claimRun = async () => { throw workerError('worker-unreachable') }
  let authorized = false
  const authorizing = f.ops.authorizeRun('run', 1, controller.signal).then(() => { authorized = true })
  void authorizing.catch(() => {})
  try {
    for (let n = 0; n < 5; n++) await tick()
    assert.equal(authorized, false, 'no receipt after restart does not prove the placed call was never dispatched')
  } finally {
    f.worker.service.claimRun = claim
    controller.abort(); await Promise.allSettled([authorizing])
    await joined(scope.execute('unconfirmed')); await joined(scope.close())
  }
})

test('cancelling a fresh placement before its first submit remains bounded while the unit is offline', { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), releaseClaim = deferred()
  await f.accept('unsent')
  const scope = f.openRun({ runId: 'run', execution: f.executor() }), claim = f.worker.service.claimRun
  let first = true
  f.worker.service.claimRun = async () => {
    if (first) { first = false; entered.resolve(); await releaseClaim.promise }
    throw workerError('worker-unreachable')
  }
  const call = scope.execute('unsent'); void call.result.catch(() => {})
  let timer
  try {
    await entered.promise
    assert.equal((await f.ops.get('unsent')).state, 'starting')
    const cancelled = scope.cancel().then(() => true)
    assert.equal(await Promise.race([cancelled, new Promise(resolve => { timer = setTimeout(() => resolve(false), 250) })]), true,
      'this generation knows it has not called submit, so cancellation does not wait for a nonexistent remote scope')
  } finally {
    clearTimeout(timer)
    f.worker.service.claimRun = claim; releaseClaim.resolve()
    await Promise.allSettled([call.result, call.done]); await joined(scope.close())
  }
  assert.equal(f.events.executions.length, 0)
  assert.notEqual((await f.computers.getPin('computer-run:run')).releasedAt, null)
})

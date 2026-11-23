import { createComputerToolEnvironmentBinding } from '../packages/app-harness/dist/core/tool-environments/computer.js'
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
import { installUnitAttachments } from './helpers/unit-attachments.mjs'
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

async function fixture(t, { multi = false } = {}) {
  const clock = multi ? { ...inputs, now: () => new Date().toISOString() } : inputs
  const directory = await mkdtemp(join(tmpdir(), 'anybox-computer-operations-')), root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const worker = createControlledComputerWorker(root)
  await root.installComponent(worker.component)
  if (multi) await installUnitAttachments(root, clock)
  await root.installComponent(createProjectComponent(clock, multi ? { enableWorkspaceAttachments: true,
    computerQuery: async (_attachment, query) => ({ kind: 'stat', directory: true, canonical: query.path }) } : {}))
  const projects = root.get('harness.projects'), project = await projects.openProject(directory)
  const provider = createLocalComputerProvider(), events = { activations: 0, executions: [], cleanupFailed: false }
  const unitProvider = createLocalComputerProvider({ providerId: 'unit' })
  root.provide('computer.instance-provider', { ...provider, providerIds: multi ? ['local', 'unit'] : ['local'],
    activate(input) { events.activations++; return (input.resource.spec.providerId === 'unit' ? unitProvider : provider).activate(input) } })
  await installComputerServices(root, clock, { worker })
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

test('two workspace scopes isolate process handles, owner recovery and close receipts on the same parent Run', async t => {
  const f = await fixture(t, { multi: true })
  const units = f.root.get('harness.unit-attachments'), primary = (await units.local('computer')).binding
  const ceiling = { kind: 'computer', projects: 'all', tools: 'all' }
  const { code } = await units.createAttachCode({ unitKind: 'computer', scope: ceiling })
  const { attachment } = await units.attach({ code, unitKind: 'computer', unitId: 'controlled-local', ceiling, contractVersion: 'computer-worker-1',
    capabilities: { platform: process.platform, architecture: process.arch } })
  const secondary = await units.binding(attachment.attachmentId)
  const members = await f.projects.addProjectWorkspace(f.project.id, { expectedRevision: 1, requestId: 'add', name: 'secondary', path: '/other', computerAttachmentId: attachment.attachmentId })
  const runId = 'parent', fields = unit => ({ runId, unit, workspaceBindingId: members.workspaces.find(row => row.computerAttachmentId === unit.attachmentId).id })
  const submit = (id, unit, toolId, args, epoch = 1) => {
    const tool = getToolById(toolId)
    return f.db.transaction(tx => f.ops.acceptIn(tx, { ...fields(unit), workspaceBindingRevision: 1, operationId: id, projectId: f.project.id,
      sessionId: 'session', runOwnerEpoch: epoch, tool, request: { id, name: tool.definition.name, arguments: args } }))
  }
  const first = await submit('first', primary, 'codex.exec_command', { cmd: 'echo first' })
  const second = await submit('second', secondary, 'codex.exec_command', { cmd: 'echo second' })
  assert.notEqual(first.declaration.runId, second.declaration.runId)
  assert.deepEqual(first.declaration.workspaceScope.parentRunId, runId)
  const info = f.worker.service.info.bind(f.worker.service)
  f.worker.service.info = async () => ({ ...await info(), workspaceScopeVersion: 1 })
  for (const op of [first, second]) f.worker.setExecution(op.declaration.runId, f.executor(
    req => immediate({ name: req.name, result: { session_id: 1, output: 'test' } }),
    () => immediate({ processes: [{ session_id: 1, exit_code: 0 }, { session_id: 42, exit_code: 0 }] })))
  const scopeA = f.ops.openRun(fields(primary)), scopeB = f.ops.openRun(fields(secondary))
  const a = await joined(scopeA.execute('first')), b = await joined(scopeB.execute('second'))
  assert.notEqual(a.result.session_id, b.result.session_id, 'equal worker numbers become distinct model-visible handles')
  assert.deepEqual(f.events.executions.map(call => call.binding.path), [f.project.path, '/other'])
  await assert.rejects(submit('wrong', secondary, 'codex.write_stdin', { session_id: a.result.session_id }), { category: 'invalid-tool-request' })
  assert.equal(await f.ops.get('wrong'), undefined)
  const correct = await submit('right', secondary, 'codex.write_stdin', { session_id: b.result.session_id })
  assert.equal(correct.declaration.request.arguments.session_id, 1)
  assert.equal((await joined(scopeB.execute('right'))).result.session_id, b.result.session_id)
  const exitA = await joined(scopeA.close())
  assert.equal(exitA.processes[0].session_id, a.result.session_id)
  assert.equal((await f.computers.getPin('computer-run:' + second.declaration.runId)).releasedAt, null)
  const exitB = await joined(scopeB.close())
  assert.equal(exitB.processes[0].session_id, b.result.session_id)
  assert.equal(new Set([...exitA.processes, ...exitB.processes].map(p => p.session_id)).size, 4)
  assert.deepEqual(await joined(f.ops.openRun(fields(secondary)).close()), exitB, 'closed scopes return the already translated receipt')
  assert.equal(f.worker.records.get(first.declaration.runId + ':computer-close-scope').executeCount, 0)
  assert.equal(f.worker.records.get(second.declaration.runId + ':computer-close-scope').state, 'succeeded')
  await f.db.transaction(tx => f.ops.claimRunIn(tx, runId, 2))
  assert.equal((await f.ops.get('second')).runOwnerEpoch, 2)
  assert.equal((await f.ops.get('first')).runOwnerEpoch, 2)
})

test('a workspace preserves translated process handles in partial cleanup results and on recovery', async t => {
  const f = await fixture(t, { multi: true })
  const unit = (await f.root.get('harness.unit-attachments').local('computer')).binding
  const target = { runId: 'partial-cleanup', workspaceBindingId: f.project.id, unit }
  const tool = getToolById('codex.exec_command'), rawId = 41
  const op = await f.db.transaction(tx => f.ops.acceptIn(tx, { ...target, workspaceBindingRevision: 1, operationId: 'start-process',
    projectId: f.project.id, sessionId: 'session', tool, request: { id: 'start-process', name: tool.definition.name, arguments: { cmd: 'echo value' } } }))
  const info = f.worker.service.info.bind(f.worker.service)
  f.worker.service.info = async () => ({ ...await info(), workspaceScopeVersion: 1 })
  const workerFact = { cleanup: 'failed', processes: [{ session_id: rawId, output: 'remaining output' }] }
  f.worker.setExecution(op.declaration.runId, f.executor(req => immediate({ name: req.name, result: { session_id: rawId } }),
    () => ({ result: Promise.resolve(workerFact), done: Promise.reject(new Error('injected partial exit')), cancel() {} })))
  const scope = f.ops.openRun(target)
  const handle = (await joined(scope.execute('start-process'))).result.session_id
  assert.notEqual(handle, rawId)
  const expected = { cleanup: 'failed', processes: [{ session_id: handle, output: 'remaining output' }] }
  f.events.cleanupFailed = true
  for (const attempt of [() => scope.close(), () => f.ops.openRun(target).close()]) {
    const close = attempt()
    assert.deepEqual(await close.result, expected)
    await assert.rejects(close.done, { code: 'computer-operation-cleanup' })
  }
  const row = await f.db.read(reader => reader.get('SELECT closed,result_json FROM harness_computer_scopes WHERE run_id=?', [op.declaration.runId]))
  assert.equal(row.closed, 0)
  assert.deepEqual(JSON.parse(row.result_json), expected)
  assert.equal((await f.computers.getPin('computer-run:' + op.declaration.runId)).releasedAt, null)
})

test('a workspace declaration cannot dispatch through an older worker', async t => {
  const f = await fixture(t, { multi: true })
  const unit = (await f.root.get('harness.unit-attachments').local('computer')).binding
  const target = { runId: 'scoped', workspaceBindingId: f.project.id, unit }
  const tool = getToolById('anybox.bash')
  await f.db.transaction(tx => f.ops.acceptIn(tx, { ...target, workspaceBindingRevision: 1, operationId: 'old-worker', projectId: f.project.id,
    sessionId: 'session', tool, request: request('old-worker') }))
  const scope = f.ops.openRun(target)
  await assert.rejects(joined(scope.execute('old-worker')), { code: 'worker-scope-version-unsupported', category: 'computer-worker-upgrade-required' })
  assert.equal(f.worker.records.size, 0)
  await joined(scope.close())
  const restored = f.ops.openRun(target)
  await assert.rejects(joined(restored.execute('old-worker')), { category: 'computer-worker-upgrade-required' })
  await joined(restored.close())
})

test('a worker boot change detected before first dispatch closes the workspace without an uncertain pin', async t => {
  const f = await fixture(t, { multi: true }), unit = (await f.root.get('harness.unit-attachments').local('computer')).binding
  const target = { runId: 'replaced', workspaceBindingId: f.project.id, unit }, info = f.worker.service.info.bind(f.worker.service)
  f.worker.service.info = async () => ({ ...await info(), bootId: 'replacement-boot', workspaceScopeVersion: 1 })
  const op = await f.db.transaction(tx => f.ops.acceptIn(tx, { ...target, workspaceBindingRevision: 1, operationId: 'preflight',
    projectId: f.project.id, sessionId: 'session', tool: getToolById('anybox.bash'), request: request('preflight') }))
  const scope = f.ops.openRun(target)
  await assert.rejects(joined(scope.execute('preflight')), { code: 'worker-instance-replaced' })
  assert.equal((await f.ops.get('preflight')).state, 'failed')
  assert.equal(f.worker.records.size, 0)
  await joined(scope.close())
  assert.notEqual((await f.computers.getPin('computer-run:' + op.declaration.runId)).releasedAt, null)
})

for (const received of ['lost reply', 'acknowledged queued operation']) test(`a workspace tool with a ${received} and no original worker record remains unknown and is never resubmitted`, async t => {
  const f = await fixture(t, { multi: true })
  const unit = (await f.root.get('harness.unit-attachments').local('computer')).binding
  const target = { runId: 'orphan', workspaceBindingId: f.project.id, unit }
  const { declaration } = await f.db.transaction(tx => f.ops.acceptIn(tx, { ...target, workspaceBindingRevision: 1, operationId: 'lost',
    projectId: f.project.id, sessionId: 'session', tool: getToolById('anybox.bash'), request: request('lost') }))
  const info = f.worker.service.info.bind(f.worker.service), submit = f.worker.service.submit.bind(f.worker.service)
  f.worker.service.info = async () => ({ ...await info(), workspaceScopeVersion: 1 })
  let sent = 0
  f.worker.service.submit = async input => {
    if (input.kind !== 'tool') return submit(input)
    sent++
    if (received === 'acknowledged queued operation' && sent === 1) return { operationId: input.operationId, runId: input.runId,
      declarationDigest: input.declarationDigest, state: 'queued', receipt: 'original-receipt', executeCount: 0 }
    throw workerError('worker-unavailable')
  }
  const scope = f.ops.openRun(target)
  f.events.cleanupFailed = true
  await assert.rejects(joined(scope.execute('lost')))
  await assert.rejects(joined(scope.close()))
  const operation = await f.ops.get('lost')
  assert.equal(operation.state, 'outcome-unknown')
  assert.equal(operation.workerReceipt, received === 'acknowledged queued operation' ? 'original-receipt' : undefined)
  assert.equal((await f.computers.getPin('computer-run:' + declaration.runId)).releasedAt, null)
  assert.equal(sent, 1)
})

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

test('migration of a v3 single-target scope preserves its identity, digest, process number and close receipt', async t => {
  const f = await fixture(t), runId = 'legacy-run', id = 'legacy-exec'
  const tool = getToolById('codex.exec_command')
  const original = await f.db.transaction(tx => f.ops.acceptIn(tx, { runId, operationId: id, projectId: f.project.id, sessionId: 'legacy-session',
    tool, request: { id, name: tool.definition.name, arguments: { cmd: 'echo legacy' } } }))
  const observation = { name: tool.definition.name, result: { session_id: 52, output: 'legacy' } }
  const cleanup = { processes: [{ session_id: 52, output: 'tail' }] }
  const scope = f.openRun({ runId, execution: f.executor(() => immediate(observation), () => immediate(cleanup)) })
  assert.deepEqual(await joined(scope.execute(id)), observation)
  assert.deepEqual(await joined(scope.close()), cleanup)
  const receipt = (await f.ops.get(id)).workerReceipt
  // Restore the exact scope table and migration version written by the previous release.
  await f.db.transaction(tx => {
    tx.execute('DROP TABLE harness_computer_process_handles')
    tx.execute('DROP INDEX harness_computer_scopes_workspace')
    tx.execute('ALTER TABLE harness_computer_scopes DROP COLUMN workspace_binding_id')
    tx.execute('ALTER TABLE harness_computer_scopes DROP COLUMN parent_run_id')
    tx.execute("UPDATE schema_migrations SET version=3 WHERE domain='computer-operations'")
  })
  await f.root.fiber.dispose()
  const next = new Context()
  try {
    await next.installComponent(createLocalSqliteComponent(join(f.directory, 'state.sqlite')))
    await installComputerWorkerStub(next)
    await next.installComponent(createProjectComponent(inputs))
    await installComputerServices(next, inputs)
    const operations = next.get('harness.computer-operations'), db = next.get('local-storage')
    await db.transaction(tx => operations.claimRunIn(tx, runId, 2))
    const restored = await operations.get(id)
    assert.deepEqual(restored.declaration, original.declaration)
    assert.equal(restored.declarationDigest, original.declarationDigest)
    assert.equal(restored.workerReceipt, receipt)
    assert.equal(restored.processRef.sessionId, 52)
    const scope = operations.openRun({ runId, runOwnerEpoch: 2 })
    assert.deepEqual(await joined(scope.execute(id)), observation)
    assert.deepEqual(await joined(scope.close()), cleanup)
    const row = await db.read(reader => reader.get('SELECT parent_run_id,workspace_binding_id,close_receipt FROM harness_computer_scopes WHERE run_id=?', [runId]))
    assert.deepEqual({ ...row }, { parent_run_id: runId, workspace_binding_id: null, close_receipt: 'receipt:legacy-run:computer-close-scope' })
  } finally { await next.fiber.dispose() }
})

test('Run intent and ComputerOperation admission share the Session transaction; model and historical plan Runs leave computer idle', async t => {
  const f = await fixture(t)
  await f.root.installComponent(createProjectFilesComponent(inputs))
  await f.root.installComponent(createSessionComponent(inputs, [{ id: 'assistant' }]))
  const sessions = f.root.get('harness.sessions'), records = f.root.get('harness.session-runs')
  const historicalSelection = { schemaVersion: 1, tools: ['anybox.bash', 'codex.update_plan'].map(toolId => {
    const tool = getToolById(toolId)
    return { toolId, version: tool.version, definition: tool.definition }
  }) }
  await f.db.transaction(tx => tx.execute(`INSERT INTO harness_sessions
    (id, project_id, agent_id, created_at, model_id, history_mode, tool_selection_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['historical-session', f.project.id, 'assistant', 'now', null, 'native-local-v1', JSON.stringify(historicalSelection)]))
  const session = await sessions.getSession('historical-session'), snapshot = modelSnapshot()
  const selection = session.toolSelection
  const initialization = { schemaVersion: 2, prompts: [], tools: selection.tools.map(tool => tool.definition), toolContractVersion: 'tool-library-v1', toolSelection: selection }
  f.root.provide('tools.bash', { execute(input) { f.events.executions.push(input); return immediate(observation.result) } })
  f.root.provide('tools.apply-patch', {})
  f.root.provide('tools.processes', {})
  f.root.provide('tools.files', {})
  await f.root.installComponent(createRunRuntimeComponent(inputs, createComputerToolEnvironmentBinding()))
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

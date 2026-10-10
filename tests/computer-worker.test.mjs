import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createComputerWorkerExecutorComponent } from '../dist/applications/harness/core/computer/worker-component.js'
import { connectLocalComputerWorker, createLocalComputerWorkerComponent } from '../dist/applications/harness/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'

const unix = process.platform !== 'win32'
async function finish(port, input) {
  for (let n = 0; n < 1000; n++) {
    const op = await port.get(input)
    if (op && ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(op.state)) return op
    await delay(10)
  }
  throw new Error('worker did not finish')
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-contract-'))
  const port = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  t.after(async () => { try { await port.shutdown(); await port.closeObserver() } finally { await rm(directory, { recursive: true, force: true }) } })
  let owner = { runId: 'run', runOwnerEpoch: 1 }
  const cold = await Promise.all([port.info(), port.info(), port.info()])
  assert.deepEqual(cold[1], cold[0]); assert.deepEqual(cold[2], cold[0])
  const info = cold[0]
  let binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: 'local', computerInstanceId: `${info.workerId}:${info.bootId}`, instanceGeneration: 1, workspaceEpoch: 1,
    revision: 0, path: directory, preparedAt: 'now' }
  await port.claimRun(owner)
  const tool = (operationId, toolId, args, imageInput = false) => {
    const entry = getToolById(toolId)
    const declaration = { schemaVersion: 1, operationId, ...owner, sessionId: 'session', projectId: binding.projectId,
      tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
      request: { id: `call-${operationId}`, name: entry.definition.name, arguments: args }, workspaceId: binding.workspaceId,
      workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    return { ...owner, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding: { ...binding }, imageInput, workerBootId: info.bootId }
  }
  const close = async id => {
    const input = { ...owner, operationId: id, kind: 'close-scope', declarationDigest: id }
    await port.submit(input); return finish(port, input)
  }
  return { directory, port, tool, close, info, get owner() { return owner }, get binding() { return binding },
    async nextRun(runId, changes) { owner = { runId, runOwnerEpoch: 1 }; binding = { ...binding, scopeId: runId, bindingId: `binding-${runId}`, reservationId: `reservation-${runId}`, ...changes }; await port.claimRun(owner) } }
}

test('installing and disposing the worker proxy does not allocate computer or create a ledger', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-lazy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  await root.installComponent(createLocalComputerWorkerComponent({ directory: join(directory, 'worker') }))
  await root.fiber.dispose()
  await assert.rejects(readFile(join(directory, 'worker', 'endpoint.json')), { code: 'ENOENT' })
  const port = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  await port.shutdown(); await port.closeObserver()
  await assert.rejects(readFile(join(directory, 'worker', 'worker.sqlite')), { code: 'ENOENT' })
})

test('worker freezes file bindings and remembers maximum workspace and instance generations after scope exit', { skip: !unix, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const initial = f.tool('write', 'claude-code.Write', { file_path: 'value.txt', content: 'one' })
  await f.port.submit(initial)
  assert.equal((await finish(f.port, initial)).state, 'succeeded')
  assert.equal(await readFile(join(f.directory, 'value.txt'), 'utf8'), 'one')
  await assert.rejects(f.port.submit({ ...initial, binding: { ...initial.binding, workspaceEpoch: 2 } }), { code: 'worker-operation-conflict' })
  const old = { ...f.binding }
  await f.close('close-one')
  await f.nextRun('two', { workspaceEpoch: 2, instanceGeneration: 2, computerInstanceId: 'new-instance' })
  const next = f.tool('write-two', 'claude-code.Write', { file_path: 'value.txt', content: 'two' })
  await f.port.submit(next)
  assert.equal((await finish(f.port, next)).state, 'succeeded')
  await f.close('close-two')
  await f.nextRun('stale', { workspaceEpoch: 1, instanceGeneration: 1, computerInstanceId: old.computerInstanceId })
  await assert.rejects(f.port.submit(f.tool('stale-effect', 'anybox.bash', { command: 'touch stale.effect' })), { code: 'worker-binding-conflict' })
  await assert.rejects(readFile(join(f.directory, 'stale.effect')), { code: 'ENOENT' })
})

test('whole Run cancellation persists before acknowledgement and rejects new tools while keeping old facts and cleanup', { skip: !unix, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const original = f.tool('command', 'codex.exec_command', { cmd: "printf 'alive\\n'; sleep 30", yield_time_ms: 0 })
  await f.port.submit(original)
  const observed = await finish(f.port, original)
  assert.equal(observed.state, 'succeeded')
  const cancel = { ...f.owner, operationId: 'cancel-run', kind: 'cancel', declarationDigest: 'cancel-run' }
  const receipt = await f.port.submit(cancel)
  const cancelled = await finish(f.port, cancel)
  assert.equal(cancelled.state, 'succeeded')
  assert.equal((await f.port.submit(cancel)).receipt, receipt.receipt)
  assert.deepEqual((await f.port.submit(original)).observation, observed.observation)
  await assert.rejects(f.port.submit(f.tool('late-command', 'anybox.bash', { command: 'touch late.effect' })), { code: 'worker-run-cancelled' })
  const closed = await f.close('close-cancelled')
  assert.deepEqual(closed.observation, cancelled.observation.cleanup)
  assert.deepEqual((await f.close('close-cancelled')).observation, closed.observation)
})

test('worker image results retain immutable raw bytes and stable receipt through replacement observers', { skip: !unix, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  await writeFile(join(f.directory, 'image.png'), bytes)
  const image = f.tool('image', 'codex.view_image', { path: 'image.png' }, true)
  await f.port.submit(image)
  const result = await finish(f.port, image)
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(Buffer.from(result.images[0].base64, 'base64'), bytes)
  assert.equal(result.images[0].ref.expiresAt, undefined)
  const endpoint = JSON.parse(await readFile(join(f.directory, 'worker', 'endpoint.json'), 'utf8'))
  assert.equal((await fetch(`${endpoint.url}/info`, { method: 'POST', body: '{}' })).status, 401)
  await f.port.closeObserver()
  const next = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
  t.after(() => next.closeObserver())
  await next.claimRun({ ...f.owner, runOwnerEpoch: 2 })
  const repeated = await next.submit({ ...image, runOwnerEpoch: 2 })
  assert.equal(repeated.receipt, result.receipt)
  assert.deepEqual(repeated.images, result.images)
  await next.submit({ ...f.owner, runOwnerEpoch: 2, operationId: 'close-image', kind: 'close-scope', declarationDigest: 'close-image' })
  await finish(next, { ...f.owner, runOwnerEpoch: 2, operationId: 'close-image' })
  await next.shutdown()
})

test('failed actual exit cannot hang on a missing tool result or certify a scope as safely closed', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-broken-exit-'))
  const root = new Context()
  let disposed = false
  t.after(async () => { try { if (!disposed) await root.fiber.dispose().catch(() => {}) } finally { await rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'ledger.sqlite')))
  await root.installComponent({ name: 'broken-worker-tools', apply(ctx) {
    ctx.provide('tools.bash', { execute() {
      const done = Promise.reject(new Error('injected actual-exit failure'))
      void done.catch(() => {})
      return { result: new Promise(() => {}), done, cancel() {} }
    } })
    ctx.provide('tools.apply-patch', { execute() {
      const done = Promise.reject(new Error('injected patch cleanup failure'))
      void done.catch(() => {})
      return { result: Promise.resolve({ changes: [{ path: 'written.txt', kind: 'added' }], pending: ['unwritten.txt'] }), done, cancel() {} }
    } })
    ctx.provide('tools.files', {})
    ctx.provide('tools.processes', {})
    ctx.provide('harness.image-assets', {})
  } })
  await root.installComponent(createComputerWorkerExecutorComponent({ workerId: 'worker', bootId: 'boot' }))
  const port = root.get('computer.worker'), owner = { runId: 'run', runOwnerEpoch: 1 }
  await port.claimRun(owner)
  const entry = getToolById('anybox.bash')
  const binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: 'local', computerInstanceId: 'instance', instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path: directory, preparedAt: 'now' }
  const declaration = { schemaVersion: 1, operationId: 'broken', runId: owner.runId, sessionId: 'session', projectId: 'project',
    tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition }, request: { id: 'call', name: 'bash', arguments: { command: 'ignored' } },
    workspaceId: 'workspace', workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
  const input = { ...owner, operationId: declaration.operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: 'boot' }
  await port.submit(input)
  const failure = await finish(port, input)
  assert.equal(failure.state, 'failed')
  assert.equal(failure.error.category, 'cleanup-failure')
  const close = { ...owner, operationId: 'close-broken', kind: 'close-scope', declarationDigest: 'close-broken' }
  await port.submit(close)
  assert.equal((await finish(port, close)).state, 'outcome-unknown')
  const patchOwner = { runId: 'patch-run', runOwnerEpoch: 1 }
  await port.claimRun(patchOwner)
  const patchEntry = getToolById('anybox.apply_patch')
  const patchDeclaration = { ...declaration, runId: patchOwner.runId, operationId: 'partial-patch',
    tool: { toolId: patchEntry.toolId, version: patchEntry.version, definition: patchEntry.definition },
    request: { id: 'patch-call', name: 'apply_patch', arguments: { patch: 'mocked partial patch' } } }
  const partial = { ...patchOwner, operationId: patchDeclaration.operationId, kind: 'tool', declaration: patchDeclaration,
    declarationDigest: computerDeclarationDigest(patchDeclaration), binding: { ...binding, scopeId: patchOwner.runId, bindingId: 'patch-binding', reservationId: 'patch-reservation' }, workerBootId: 'boot' }
  await port.submit(partial)
  const partialFact = await finish(port, partial)
  assert.equal(partialFact.error.category, 'cleanup-failure')
  assert.deepEqual(partialFact.observation, { name: 'apply_patch', result: { changes: [{ path: 'written.txt', kind: 'added' }], pending: ['unwritten.txt'] } })
  await assert.rejects(root.fiber.dispose())
  disposed = true
})

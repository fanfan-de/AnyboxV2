import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createWorkerAttachmentsComponent } from '../dist/applications/harness/core/computer/worker-attachments.js'
import { createComputerWorkerExecutorComponent } from '../dist/applications/harness/core/computer/worker-component.js'
import { computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'

const ceiling = { kind: 'computer', projects: 'all', tools: 'all' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const immediate = value => ({ result: Promise.resolve(value), done: Promise.resolve(), cancel() {} })
const alive = child => { try { return !!child && process.kill(child.pid, 0) } catch { return false } }
const terminal = state => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
const hasCode = (error, code) => !!error && (error.code === code || error.errors?.some(item => hasCode(item, code)) || hasCode(error.cause, code))
async function until(check) {
  for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('condition did not become true')
}

// The ledger and executor are real; only the ProcessToolsPort's close failure is injected.
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-permissions-failure-'))), credentials = new Map()
  const cleanupEntered = deferred(), allowExit = deferred(), roots = []
  let child, closeAttempts = 0, executions = 0, forceCleanup = false, boot = 'boot-one'
  t.after(async () => {
    forceCleanup = true; allowExit.resolve()
    try {
      if (alive(child)) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    } finally {
      await Promise.allSettled(roots.map(root => root.fiber.dispose()))
      await rm(directory, { recursive: true, force: true })
    }
  })
  const install = async () => {
    const root = new Context(); roots.push(root)
    await root.installComponent(createLocalSqliteComponent(join(directory, 'worker.sqlite')))
    for (const key of ['tools.bash', 'tools.apply-patch', 'tools.files', 'harness.image-assets']) root.provide(key, {})
    root.provide('tools.processes', { openRun({ runId }) { return {
      execute() {
        executions++
        if (runId !== 'old') return immediate({ session_id: executions, output: 'started' })
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const result = once(child, 'spawn').then(() => ({ session_id: executions, output: 'started' }))
        return { result, done: result.then(() => {}), cancel() {} }
      },
      close() {
        if (runId !== 'old') return immediate({ processes: [] })
        closeAttempts++
        if (closeAttempts <= 2 && !forceCleanup) {
          const result = Promise.reject(new Error('injected process cleanup failure'))
          const done = Promise.reject(new Error('actual exit not proven'))
          void result.catch(() => {}); void done.catch(() => {})
          return { result, done, cancel() {} }
        }
        const result = Promise.resolve().then(async () => {
          cleanupEntered.resolve()
          await allowExit.promise
          if (alive(child)) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
          return { processes: [{ session_id: 1, exit_code: null, signal: 'SIGKILL' }], cleanup: 'completed' }
        })
        return { result, done: result.then(() => {}), cancel() {} }
      },
    } } })
    await root.installComponent(createWorkerAttachmentsComponent({ openEntry: (_service, id) => ({
      getPassword: async () => credentials.get(id), setPassword: async value => credentials.set(id, value), deleteCredential: async () => credentials.delete(id),
    }) }))
    const attachments = root.get('computer.worker-attachments')
    if (!(await attachments.list()).length) await attachments.record({ attachmentId: 'remote', harnessUrl: 'https://peer.example', instanceId: 'peer', state: 'approved', ceiling, scope: ceiling, epoch: 1, createdAt: 'now', revokedAt: null }, 'credential')
    await root.installComponent(createComputerWorkerExecutorComponent({ workerId: 'worker', bootId: boot }))
    return { root, attachments, worker: root.get('computer.worker') }
  }
  let current = await install()
  const owner = runId => ({ runId, runOwnerEpoch: 1, attachmentId: 'remote' })
  const submission = (runId, operationId = `${runId}-tool`) => {
    const entry = getToolById('codex.exec_command'), generation = boot === 'boot-one' ? 1 : 2
    const binding = { bindingId: `${runId}-binding`, reservationId: `${runId}-reservation`, workspaceId: 'shared-workspace', projectId: 'project', scopeId: runId,
      computerId: 'computer', computerInstanceId: `worker:${boot}`, instanceGeneration: generation, workspaceEpoch: generation, revision: 0, path: directory, preparedAt: 'now' }
    const declaration = { schemaVersion: 1, operationId, runId, sessionId: 'session', projectId: 'project', tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
      request: { id: operationId, name: 'codex_exec_command', arguments: { cmd: 'held process' } }, workspaceId: binding.workspaceId, workspaceRevision: 0, computerId: 'computer',
      spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    return { ...owner(runId), operationId, kind: 'tool', declaration, binding, declarationDigest: computerDeclarationDigest(declaration), workerBootId: boot }
  }
  const observe = operationId => until(async () => { const operation = await current.worker.get({ ...owner('old'), operationId }); return operation && terminal(operation.state) ? operation : undefined })
  return {
    directory, owner, submission, observe, cleanupEntered, allowExit,
    get current() { return current }, get child() { return child }, get closeAttempts() { return closeAttempts }, get executions() { return executions },
    async restart() {
      await assert.rejects(current.root.fiber.dispose(), error => hasCode(error, 'worker-cleanup-failed'))
      boot = 'boot-two'; current = await install()
    },
  }
}

for (const kind of ['cancel', 'close-scope']) test(`failed permission cleanup keeps admission closed and ${kind} retries retain the process scope until actual exit`, { timeout: 15000 }, async t => {
  const f = await fixture(t), { worker, attachments } = f.current
  await worker.claimRun(f.owner('old'))
  await worker.claimRun(f.owner('preclaimed'))
  const original = f.submission('old')
  await worker.submit(original)
  const first = await f.observe(original.operationId)
  assert.equal(first.state, 'succeeded'); assert.equal(alive(f.child), true)
  const narrowed = { kind: 'computer', projects: [f.directory], tools: ['codex.exec_command'] }
  await assert.rejects(attachments.updatePermissions('remote', narrowed), { code: 'worker-cleanup-failed' })
  assert.equal(f.closeAttempts, 1); assert.equal(alive(f.child), true)
  await assert.rejects(worker.claimRun(f.owner('late')), { code: 'worker-cleanup-failed' })
  await assert.rejects(worker.submit(f.submission('preclaimed')), { code: 'worker-cleanup-failed' })
  await assert.rejects(worker.query({ attachmentId: 'remote', query: { kind: 'stat', path: f.directory } }), { code: 'worker-cleanup-failed' })
  assert.equal((await worker.submit(original)).receipt, first.receipt, 'existing accepted facts remain available')

  const control = id => ({ ...f.owner('old'), operationId: id, kind, declarationDigest: id })
  await worker.submit(control('failed-control'))
  assert.equal((await f.observe('failed-control')).state, 'failed')
  assert.equal(f.closeAttempts, 2, 'control retries the retained scope even though the Run is uncertain')
  assert.equal(alive(f.child), true)
  await worker.submit(control('retry-control'))
  await f.cleanupEntered.promise
  assert.equal((await worker.get({ ...f.owner('old'), operationId: 'retry-control' })).state, 'starting')
  assert.equal(alive(f.child), true, 'control cannot complete before the held process exits')
  f.allowExit.resolve()
  assert.equal((await f.observe('retry-control')).state, 'outcome-unknown', 'cleanup cannot erase the prior uncertain fact')
  assert.equal(f.closeAttempts, 3); assert.equal(alive(f.child), false)
  await assert.rejects(attachments.updatePermissions('remote', narrowed), { code: 'worker-cleanup-failed' })
  await assert.rejects(worker.claimRun(f.owner('still-blocked')), { code: 'worker-cleanup-failed' }, 'successful later cleanup still requires a fresh boot')

  await f.restart()
  assert.deepEqual((await f.current.attachments.list())[0].ceiling, narrowed)
  assert.equal((await f.current.worker.get({ ...f.owner('old'), operationId: original.operationId })).receipt, first.receipt)
  await f.current.worker.claimRun(f.owner('new-boot'))
  const fresh = f.submission('new-boot')
  await f.current.worker.submit(fresh)
  const completed = await until(async () => { const operation = await f.current.worker.get({ ...f.owner('new-boot'), operationId: fresh.operationId }); return operation && terminal(operation.state) ? operation : undefined })
  assert.equal(completed.state, 'succeeded', 'old uncertain Run must not become a permanent workspace fence on a new boot')
  assert.equal(f.executions, 2, 'the old tool is never replayed')
})

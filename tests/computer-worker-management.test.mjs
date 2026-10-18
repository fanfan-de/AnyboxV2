import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createWorkerAttachmentsComponent } from '../packages/app-harness/dist/core/computer/worker-attachments.js'
import { createWorkerDialoutComponent } from '../packages/app-harness/dist/core/computer/worker-dialout.js'
import { createComputerWorkerExecutorComponent } from '../packages/app-harness/dist/core/computer/worker-component.js'
import { createComputerWorkerHttpServer } from '../packages/app-harness/dist/core/computer/worker-server.js'
import { connectLocalComputerWorker } from '../packages/app-harness/dist/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../packages/app-harness/dist/core/computer/operations-domain.js'
import { getToolById } from '../packages/app-harness/dist/core/tool/catalog.js'
import { createClientHost } from '../packages/distribution/dist/entrypoints/client-main.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const ceiling = { kind: 'computer', projects: 'all', tools: 'all' }

// Real worker ledger, executor, dialout and loopback adapter. Only OS tools and the remote HTTP peer are substitutes.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-management-')), workerDirectory = join(directory, 'worker')
  await mkdir(workerDirectory)
  const root = new Context(), credentials = new Map(), calls = [], remoteCalls = []
  let pollOnline = true
  t.after(async () => { for (const call of calls) { call.result.resolve({ output: '', exitCode: 0 }); call.done.resolve() }; await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createLocalSqliteComponent(join(workerDirectory, 'worker.sqlite')))
  await root.installComponent({ name: 'controlled-tools', apply(ctx) {
    ctx.provide('tools.bash', { execute() {
      const result = deferred(), done = deferred(), cancelled = deferred(), call = { result, done, cancelled }
      calls.push(call)
      return { result: result.promise, done: done.promise, cancel() { cancelled.resolve(); result.resolve({ output: 'cancelled', exitCode: null }) } }
    } })
    ctx.provide('tools.apply-patch', {}); ctx.provide('tools.processes', {}); ctx.provide('tools.files', {}); ctx.provide('harness.image-assets', {})
  } })
  await root.installComponent(createWorkerAttachmentsComponent({ openEntry: (service, id) => ({
    getPassword: async () => credentials.get(`${service}:${id}`), setPassword: async value => credentials.set(`${service}:${id}`, value), deleteCredential: async () => credentials.delete(`${service}:${id}`),
  }) }))
  await root.installComponent(createComputerWorkerExecutorComponent({ workerId: 'test-worker', bootId: 'test-boot' }))
  await root.installComponent(createWorkerDialoutComponent({ pollWaitMs: 10, fetch: async (url, init) => {
    remoteCalls.push(String(url))
    if (String(url).endsWith('/attach')) {
      const body = JSON.parse(init.body)
      if (body.code !== 'one-time-code') return Response.json({ error: { code: 'unit-code-invalid' } }, { status: 400 })
      return Response.json({ attachment: { attachmentId: 'remote-attachment', state: 'approved', epoch: 1, scope: ceiling }, credential: 'secret-unit-credential', instanceId: 'remote-instance' }, { status: 201 })
    }
    if (String(url).includes('/poll?')) {
      await new Promise(resolve => { const timer = setTimeout(resolve, 20); init.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
      if (!pollOnline) throw new Error('offline')
      return Response.json({ requests: [] })
    }
    if (String(url).endsWith('/revoke')) return Response.json({ ok: true })
    throw new Error('Unexpected remote request')
  } }))
  const token = 'local-control-secret-that-must-not-be-printed'
  const server = createComputerWorkerHttpServer(root, token, () => { throw new Error('management must not stop worker') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const endpoint = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid, workerId: 'test-worker', bootId: 'test-boot' }
  await writeFile(join(workerDirectory, 'endpoint.json'), JSON.stringify(endpoint))
  const port = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
  t.after(() => port.closeObserver())
  const submit = async (runId, op, attachmentId = 'remote-attachment') => {
    const owner = { runId, runOwnerEpoch: 1, attachmentId }
    await port.claimRun(owner)
    const entry = getToolById('anybox.bash'), binding = { bindingId: `binding-${runId}`, reservationId: `reservation-${runId}`, workspaceId: `workspace-${runId}`, projectId: 'project', scopeId: runId,
      computerId: 'local', computerInstanceId: 'test-worker:test-boot', instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path: directory, preparedAt: 'now' }
    const declaration = { schemaVersion: 1, operationId: op, runId, sessionId: 'session', projectId: 'project', tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
      request: { id: op, name: 'bash', arguments: { command: 'controlled' } }, workspaceId: binding.workspaceId, workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    return port.submit({ ...owner, operationId: op, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: 'test-boot' })
  }
  return { directory, workerDirectory, root, port, endpoint, calls, credentials, remoteCalls, submit, offline() { pollOnline = false } }
}
async function until(check) {
  for (let n = 0; n < 300; n++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('condition did not become true')
}

test('a client with no local harness server attaches, reads status, edits permissions and revokes through the independent worker', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const host = await createClientHost({ path: join(f.directory, 'client.sqlite'), port: 0, computer: { directory: f.workerDirectory } })
  t.after(() => host.close())
  const request = async (path, body) => {
    const response = await fetch(`${host.url}/api/client/v1/apps/agent/computer${path}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { Origin: host.url, 'content-type': 'application/json' } })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  await fetch(`${host.url}/api/client/v1/products/agent/open`, { method: 'POST', headers: { Origin: host.url, 'content-type': 'application/json' }, body: '{}' })
  assert.equal((await request('/status')).state, 'running')
  const attached = await request('/attachments', { harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling })
  assert.equal(attached.attachmentId, 'remote-attachment'); assert.equal(f.credentials.size, 1)
  await until(async () => (await request('/status')).attachments[0].connection === 'connected')
  assert.equal(host.root.get('host.access'), undefined)
  for (const service of ['models', 'harness.runs', 'computer.worker']) assert.equal(host.root.get(service), undefined)
  const status = await request('/status')
  assert.ok(!JSON.stringify(status).includes('secret')); assert.ok(!JSON.stringify(attached).includes('one-time-code'))
  await request('/attachments/remote-attachment/permissions', { ceiling: { kind: 'computer', projects: [f.directory], tools: [] } })
  await assert.rejects(f.submit('denied', 'denied-op'), { code: 'worker-scope-rejected' })
  await request('/attachments/remote-attachment/permissions', { ceiling })
  await f.submit('in-flight', 'op')
  const call = await until(() => f.calls[0])
  let returned = false
  const revoking = request('/attachments/remote-attachment/revoke', {}).then(value => { returned = true; return value })
  await call.cancelled.promise; await tick(); assert.equal(returned, false, 'revocation waits for actual tool exit')
  call.done.resolve()
  assert.equal((await revoking).state, 'revoked'); assert.equal(f.credentials.size, 0)
  await assert.rejects(f.port.claimRun({ runId: 'late', runOwnerEpoch: 1, attachmentId: 'remote-attachment' }), { code: 'worker-attachment-rejected' })
  await host.close()
  assert.equal((await f.port.status()).state, 'running', 'client close only drops observers')
  assert.ok((await readdir(f.directory)).every(name => name === 'worker' || name.startsWith('client.sqlite')))
  assert.ok(!(await readFile(join(f.workerDirectory, 'worker.sqlite'))).includes(Buffer.from('secret-unit-credential')))
})

test('permission changes block admission and wait for actual exits; concurrent revoke cannot restore access', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  await f.port.control.consumeAttachCode({ harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling })
  await f.submit('active', 'tool')
  const call = await until(() => f.calls[0])
  let settled = false
  const changed = f.port.control.updatePermissions('remote-attachment', { kind: 'computer', projects: [], tools: [] }).then(value => { settled = true; return value })
  await call.cancelled.promise
  await assert.rejects(f.port.claimRun({ runId: 'race', runOwnerEpoch: 1, attachmentId: 'remote-attachment' }), { code: 'worker-attachment-updating' })
  await tick(); assert.equal(settled, false)
  const revoke = f.port.control.revokeAttachment('remote-attachment')
  call.done.resolve()
  assert.deepEqual((await changed).ceiling, { kind: 'computer', projects: [], tools: [] })
  assert.equal((await revoke).state, 'revoked')
  await assert.rejects(f.port.control.updatePermissions('remote-attachment', ceiling), { code: 'worker-attachment-rejected' })
  assert.equal((await f.port.control.listAttachments())[0].state, 'revoked')
})

test('closing the management observer cancels its HTTP wait while the worker finishes the accepted permission change', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  await f.port.control.consumeAttachCode({ harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling })
  await f.submit('active', 'tool')
  const call = await until(() => f.calls[0])
  const observer = connectLocalComputerWorker({ directory: f.workerDirectory, autoStart: false })
  const pending = observer.control.updatePermissions('remote-attachment', { kind: 'computer', projects: [], tools: [] })
  const rejected = assert.rejects(pending)
  await call.cancelled.promise
  await observer.closeObserver(); await rejected
  assert.equal((await f.port.status()).state, 'running')
  call.done.resolve()
  await until(async () => {
    try { await f.port.claimRun({ runId: 'after-edit', runOwnerEpoch: 1, attachmentId: 'remote-attachment' }); return true } catch (error) { if (error.code !== 'worker-attachment-updating') throw error; return false }
  })
  await assert.rejects(f.submit('after-edit', 'denied'), { code: 'worker-scope-rejected' })
})

test('saved worker permissions survive restarting the attachment ledger and keep credentials private', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  await f.port.control.consumeAttachCode({ harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling })
  const narrowed = { kind: 'computer', projects: [f.directory], tools: ['anybox.bash'] }
  await f.port.control.updatePermissions('remote-attachment', narrowed)
  await f.root.fiber.dispose()
  const restored = new Context()
  try {
    await restored.installComponent(createLocalSqliteComponent(join(f.workerDirectory, 'worker.sqlite')))
    await restored.installComponent(createWorkerAttachmentsComponent({ openEntry: (service, id) => ({ getPassword: async () => f.credentials.get(`${service}:${id}`) }) }))
    const ledger = restored.get('computer.worker-attachments'), records = await ledger.list()
    assert.deepEqual(records[0].ceiling, narrowed)
    assert.equal(await ledger.credential('remote-attachment'), 'secret-unit-credential')
    assert.ok(!JSON.stringify(records).includes('secret-unit-credential'))
  } finally { await restored.fiber.dispose() }
})

function cli(args, input, cwd) {
  const child = spawn(process.execPath, ['--import', new URL('./helpers/client-role-process.mjs', import.meta.url).href,
    fileURLToPath(new URL('../packages/distribution/dist/entrypoints/anybox-main.js', import.meta.url)), 'computer-worker', ...args],
    { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANYBOX_TEST_ROLE_GUARD: 'client' } })
  let out = '', err = ''; child.stdout.on('data', value => { out += value }); child.stderr.on('data', value => { err += value })
  child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, out, err })) })
}

test('standalone management CLI handles status, attach, permissions and revoke without loading a local harness server', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const absent = join(f.directory, 'absent')
  let result = await cli(['status', absent], undefined, f.directory)
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).state, 'stopped')
  await assert.rejects(readdir(absent), { code: 'ENOENT' })
  result = await cli(['attach', f.workerDirectory], { harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling }, f.directory)
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).state, 'approved')
  assert.ok(!result.out.includes('secret') && !result.out.includes('one-time-code'))
  result = await cli(['permissions', f.workerDirectory, 'remote-attachment'], { kind: 'computer', projects: [f.directory], tools: [] }, f.directory)
  assert.equal(result.code, 0, result.err); assert.deepEqual(JSON.parse(result.out).ceiling.tools, [])
  result = await cli(['status', f.workerDirectory], undefined, f.directory)
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).attachments.length, 1)
  result = await cli(['revoke', f.workerDirectory, 'remote-attachment'], undefined, f.directory)
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).state, 'revoked')
  result = await cli(['attach', absent], { harnessUrl: 'https://remote.example', code: 'never-used', ceiling }, f.directory)
  assert.equal(result.code, 1); assert.ok(!result.err.includes('never-used'))
  await assert.rejects(readdir(absent), { code: 'ENOENT' })
})

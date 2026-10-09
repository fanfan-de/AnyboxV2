import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createHostAccessComponent } from '../dist/host/access.js'
import { createClientHost } from '../dist/host/client.js'
import { createExecutionHost } from '../dist/host/execution.js'
import { createApplicationRuntime } from '../dist/host/applications/runtime.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const directory = name => mkdtemp(join(tmpdir(), name))
async function storage(path) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(path))
  return root
}

test('managed access migrates legacy tokens, persists ownership and reconciles only the validated owner', async t => {
  const dir = await directory('anybox-desktop-managed-'), path = join(dir, 'business.sqlite')
  let root = await storage(path)
  t.after(async () => { try { await root.fiber.dispose() } finally { await rm(dir, { recursive: true, force: true }) } })
  const secret = randomBytes(32).toString('base64url'), tokenId = randomUUID(), legacyToken = `${tokenId}.${secret}`
  await root.get('local-storage').migrate('host-access', [{ version: 1, up(tx) {
    tx.execute('CREATE TABLE host_identity (id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL)')
    tx.execute('CREATE TABLE host_access_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)')
    tx.execute('INSERT INTO host_access_tokens VALUES(?,?,?,?,NULL)', [tokenId, 'CLI', createHash('sha256').update(secret).digest('hex'), new Date().toISOString()])
  } }])
  await root.installComponent(createHostAccessComponent('desktop'))
  let access = root.get('host.access')
  assert.equal(access.authenticate(`Bearer ${legacyToken}`), tokenId)
  const retained = await access.issueManaged('desktop:one', 'local'), orphan = await access.issueManaged('desktop:one', 'local')
  const other = await access.issueManaged('desktop:other', 'local'), ordinary = await access.issue('local')
  const instanceId = access.instance.instanceId
  for (const invalid of [legacyToken, ordinary.token, other.token, `${retained.record.id}.${randomBytes(32).toString('base64url')}`, 'malformed']) {
    await assert.rejects(access.reconcileManaged('desktop:one', invalid), { code: 'invalid-managed-token' })
    for (const issued of [retained, orphan, other, ordinary]) assert.equal(access.authenticate(`Bearer ${issued.token}`), issued.record.id)
  }
  await access.reconcileManaged('desktop:one', retained.token)
  assert.throws(() => access.authenticate(`Bearer ${orphan.token}`), { code: 'authentication-failed' })
  for (const issued of [retained, other, ordinary]) assert.equal(access.authenticate(`Bearer ${issued.token}`), issued.record.id)
  await assert.rejects(access.reconcileManaged('desktop:one', orphan.token), { code: 'invalid-managed-token' })
  const metadata = await access.list()
  assert.ok(metadata.every(record => !('managedOwner' in record) && !('digest' in record) && !('token' in record)))
  assert.equal(JSON.stringify(metadata).includes(retained.token), false)
  await root.fiber.dispose()
  for (const issued of [retained, orphan, other, ordinary]) assert.equal((await readFile(path)).includes(Buffer.from(issued.token.split('.')[1])), false)
  root = await storage(path)
  await root.installComponent(createHostAccessComponent('desktop'))
  access = root.get('host.access')
  assert.equal(access.instance.instanceId, instanceId)
  await access.reconcileManaged('desktop:one', undefined)
  assert.throws(() => access.authenticate(`Bearer ${retained.token}`), { code: 'authentication-failed' })
  assert.equal(access.authenticate(`Bearer ${other.token}`), other.record.id)
  assert.equal(access.authenticate(`Bearer ${ordinary.token}`), ordinary.record.id)
  assert.equal(access.authenticate(`Bearer ${legacyToken}`), tokenId)
})

test('managed reconciliation commits before observer cleanup and component shutdown joins it', async t => {
  const dir = await directory('anybox-desktop-reconcile-'), root = await storage(join(dir, 'business.sqlite'))
  const fiber = root.installComponent(createHostAccessComponent()); await fiber
  const access = root.get('host.access'), retained = await access.issueManaged('desktop', 'keep'), orphan = await access.issueManaged('desktop', 'orphan')
  const entered = deferred(), exit = deferred()
  t.after(async () => { exit.resolve(); try { await root.fiber.dispose() } finally { await rm(dir, { recursive: true, force: true }) } })
  access.onRevoked(async id => {
    assert.equal(id, orphan.record.id)
    assert.throws(() => access.authenticate(`Bearer ${orphan.token}`), { code: 'authentication-failed' })
    assert.equal(access.authenticate(`Bearer ${retained.token}`), retained.record.id)
    entered.resolve(); await exit.promise
  })
  let reconciled = false, closed = false
  const reconciling = access.reconcileManaged('desktop', retained.token).then(() => { reconciled = true })
  await entered.promise
  const closing = fiber.dispose().then(() => { closed = true })
  await tick(); assert.equal(reconciled, false); assert.equal(closed, false)
  exit.resolve(); await reconciling; await closing
})

function probeApplication(state) {
  return {
    definition: { id: 'probe', name: 'Probe', icon: 'probe' },
    http: { service: 'probe.http' },
    createRuntime: root => createApplicationRuntime(root, installation => {
      installation.install({ name: 'probe-service', apply(ctx) {
        ctx.provide('probe.http', { async handle(request, response, _url, context) {
          state.handled++
          if (state.retained) context.retainUntil(state.operationExit.promise)
          if (request.method === 'POST') { for await (const _chunk of request) {} state.entered.resolve(); await state.writeExit.promise }
          response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}')
        } })
        ctx.effect(() => async () => {
          state.disposing.resolve(); await state.cleanupExit.promise
          state.operationExit?.resolve(); state.disposed = true
          if (state.cleanupFailure) throw state.cleanupFailure
        }, 'join probe cleanup')
      } })
    }, () => { state.admissionClosed = true }),
  }
}
const probeState = () => ({ handled: 0, disposed: false, admissionClosed: false, entered: deferred(), writeExit: deferred(), disposing: deferred(), cleanupExit: deferred() })

test('desktop client transport capability protects static assets, controls and application routes before dispatch', async t => {
  const dir = await directory('anybox-desktop-transport-'), state = probeState(), transportSecret = randomBytes(32).toString('base64url')
  const host = await createClientHost({ applications: [probeApplication(state)], path: join(dir, 'client.sqlite'), port: 0, transportSecret })
  t.after(async () => { state.writeExit.resolve(); state.cleanupExit.resolve(); try { await host.close() } finally { await rm(dir, { recursive: true, force: true }) } })
  const headers = { 'X-Anybox-Desktop-Transport': transportSecret }
  for (const path of ['/', '/api/client/v1/products', '/api/client/v1/apps/probe/check']) {
    for (const supplied of [{}, { 'X-Anybox-Desktop-Transport': 'incorrect' }]) {
      const response = await fetch(host.url + path, { headers: supplied })
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'forbidden-transport')
    }
  }
  const denied = await fetch(host.url + '/api/client/v1/products/probe/open', { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403); await denied.body.cancel()
  assert.equal(host.products.get('probe').desiredEnabled, false); assert.equal(state.handled, 0)
  const staticResponse = await fetch(host.url, { headers }); assert.equal(staticResponse.status, 200)
  assert.equal((await staticResponse.text()).includes(transportSecret), false)
  const opened = await fetch(host.url + '/api/client/v1/products/probe/open', { method: 'POST', headers: { ...headers, Origin: host.url, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(opened.status, 200); await opened.body.cancel()
  const checked = await fetch(host.url + '/api/client/v1/apps/probe/check', { headers })
  assert.equal(checked.status, 200); await checked.body.cancel(); assert.equal(state.handled, 1)
  const wrongOrigin = await fetch(host.url + '/api/client/v1/apps/probe/check', { headers: { ...headers, Origin: 'https://untrusted.test' } })
  assert.equal(wrongOrigin.status, 403); await wrongOrigin.body.cancel(); assert.equal(state.handled, 1)
})

for (const kind of ['client', 'execution']) test(`${kind} prepareClose freezes admission synchronously and leaves writes and resources for close`, { timeout: 5_000 }, async t => {
  const dir = await directory(`anybox-desktop-${kind}-close-`), state = probeState()
  const host = kind === 'client'
    ? await createClientHost({ applications: [probeApplication(state)], path: join(dir, 'client.sqlite'), port: 0 })
    : await createExecutionHost({ applications: [probeApplication(state)], databasePath: join(dir, 'execution.sqlite'), port: 0 })
  t.after(async () => { state.writeExit.resolve(); state.cleanupExit.resolve(); try { await host.close() } finally { await rm(dir, { recursive: true, force: true }) } })
  await host.ready
  await host.products.open('probe')
  const headers = { Origin: host.url, 'Content-Type': 'application/json', Connection: 'close' }
  if (kind === 'execution') {
    const issued = await host.root.get('host.access').issue('test')
    headers.Authorization = `Bearer ${issued.token}`; headers['X-Anybox-Instance-Id'] = host.instance.instanceId
  }
  const response = fetch(host.url + `/api/${kind === 'client' ? 'client/v1' : 'v1'}/apps/probe/write`, { method: 'POST', headers, body: '{}' }).then(async response => { assert.equal(response.status, 200); await response.body.cancel() })
  await state.entered.promise
  const preparing = host.prepareClose()
  assert.equal(host.prepareClose(), preparing)
  assert.equal(state.admissionClosed, true)
  assert.throws(() => host.root.get('app.activity').enter('probe'), { code: 'product-unavailable' })
  await assert.rejects(host.products.open('probe'), { code: 'service-unavailable' })
  if (kind === 'execution') assert.equal(host.closing, true)
  let drained = false; void preparing.then(() => { drained = true })
  await preparing; assert.equal(drained, true); assert.equal(state.disposed, false)
  state.writeExit.resolve(); await response; await preparing
  assert.equal(state.disposed, false)
  assert.ok(host.root.get('probe.http')); assert.ok(host.root.get('local-storage'))
  const closing = host.close(); assert.equal(host.close(), closing)
  await state.disposing.promise; await tick(); assert.equal(state.disposed, false)
  state.cleanupExit.resolve(); await closing; assert.equal(state.disposed, true)
})

for (const kind of ['client', 'execution']) test(`${kind} close cancels root resources while joining an HTTP retained operation`, { timeout: 5_000 }, async t => {
  const dir = await directory(`anybox-desktop-${kind}-retained-`), state = probeState()
  state.retained = true; state.operationExit = deferred()
  const host = kind === 'client'
    ? await createClientHost({ applications: [probeApplication(state)], path: join(dir, 'client.sqlite'), port: 0 })
    : await createExecutionHost({ applications: [probeApplication(state)], databasePath: join(dir, 'execution.sqlite'), port: 0 })
  t.after(async () => { state.cleanupExit.resolve(); state.operationExit.resolve(); try { await host.close() } finally { await rm(dir, { recursive: true, force: true }) } })
  await host.ready; await host.products.open('probe')
  const headers = {}
  if (kind === 'execution') {
    const issued = await host.root.get('host.access').issue('test')
    headers.Authorization = `Bearer ${issued.token}`; headers['X-Anybox-Instance-Id'] = host.instance.instanceId
  }
  const response = await fetch(host.url + `/api/${kind === 'client' ? 'client/v1' : 'v1'}/apps/probe/retained`, { headers })
  assert.equal(response.status, 200); await response.body.cancel()
  await host.prepareClose()
  assert.equal(state.disposed, false)
  let closed = false
  const closing = host.close().then(() => { closed = true })
  await state.disposing.promise; await tick(); assert.equal(closed, false)
  state.cleanupExit.resolve(); await closing
  assert.equal(state.disposed, true); assert.equal(closed, true)
})

for (const kind of ['client', 'execution']) test(`${kind} close still disposes resources after preparation fails and aggregates both failures`, async t => {
  const dir = await directory(`anybox-desktop-${kind}-errors-`), state = probeState()
  state.cleanupExit.resolve(); state.cleanupFailure = new Error('probe cleanup failed')
  const host = kind === 'client'
    ? await createClientHost({ applications: [probeApplication(state)], path: join(dir, 'client.sqlite'), port: 0 })
    : await createExecutionHost({ applications: [probeApplication(state)], databasePath: join(dir, 'execution.sqlite'), port: 0 })
  t.after(async () => { await host.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  await host.ready; await host.products.open('probe')
  const activity = host.root.get('app.activity'), stop = activity.stop
  let first = true
  activity.stop = () => { stop(); if (first) { first = false; throw new Error('probe admission failed') } }
  await assert.rejects(host.prepareClose(), AggregateError)
  assert.equal(state.disposed, false)
  const messages = error => [error.message, ...Array.from(error.errors ?? []).flatMap(messages)]
  await assert.rejects(host.close(), error => {
    assert.ok(error instanceof AggregateError)
    const retained = messages(error)
    assert.ok(retained.includes('probe admission failed')); assert.ok(retained.includes('probe cleanup failed'))
    return true
  })
  assert.equal(state.disposed, true)
})

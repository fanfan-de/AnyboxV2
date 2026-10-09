import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../dist/host/access.js'
import { createConnectionsComponent, connectionsServiceKey } from '../dist/applications/harness/client/connections.js'
import { startClientGateway } from './helpers/client-gateway.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-desktop-pair-'))
  const roots = [], keys = new Map(), reconciled = []
  let endpoint = 'http://127.0.0.1:12345', vaultFailure = false, issued = 0
  const execution = new Context(); roots.push(execution)
  await execution.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await execution.installComponent(createHostAccessComponent('Desktop execution'))
  const access = execution.get(hostAccessServiceKey), owner = 'desktop-local'
  const pairing = {
    async getLocal(signal) { signal.throwIfAborted(); return { endpoint, instanceId: access.instance.instanceId } },
    async issue(signal) { signal.throwIfAborted(); issued++; return (await access.issueManaged(owner, 'Desktop')).token },
    async reconcile(token, signal) { signal.throwIfAborted(); reconciled.push(token); await access.reconcileManaged(owner, token) },
  }
  const openEntry = (_namespace, id) => ({
    async getPassword() { if (vaultFailure) throw new Error('locked'); return keys.get(id) },
    async setPassword(value) { if (vaultFailure) throw new Error('locked'); keys.set(id, value) },
    async deleteCredential() { keys.delete(id) },
  })
  const fetcher = async (_url, options) => {
    options.signal.throwIfAborted()
    try { access.authenticate(options.headers.Authorization) } catch { return new Response('', { status: 401 }) }
    return Response.json(access.instance)
  }
  return {
    directory, keys, access, pairing, reconciled, get issued() { return issued },
    setEndpoint(value) { endpoint = value }, failVault(value) { vaultFailure = value },
    async client(overrides = {}) {
      const root = new Context(); roots.push(root)
      await root.installComponent(createLocalSqliteComponent(join(directory, 'client.sqlite')))
      await root.installComponent(createConnectionsComponent({ openEntry, fetch: fetcher, localPairing: pairing, ...overrides }))
      return { root, connections: root.get(connectionsServiceKey) }
    },
    async close() { for (const root of roots.reverse()) await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}

test('desktop bootstrap retains identity, credentials and name, changing revision only when the local port changes', async () => {
  const f = await fixture()
  try {
    let client = await f.client()
    assert.equal((await client.connections.retryLocal()).state, 'ready')
    const initial = (await client.connections.list())[0], token = (await client.connections.acquire(initial.id)).token
    const renamed = await client.connections.save({ ...initial, name: 'My Mac', expectedRevision: initial.revision })
    assert.equal(client.connections.localStatus().connectionRevision, renamed.revision)
    await client.root.fiber.dispose()
    f.setEndpoint('http://127.0.0.1:54321')
    client = await f.client(); assert.equal((await client.connections.retryLocal()).state, 'ready')
    const updated = (await client.connections.list())[0]
    assert.equal(updated.id, initial.id); assert.equal(updated.instanceId, initial.instanceId)
    assert.equal(updated.name, 'My Mac'); assert.equal(updated.revision, renamed.revision + 1)
    assert.equal((await client.connections.acquire(updated.id)).token, token)
    assert.equal(f.issued, 1)
    await client.root.fiber.dispose()
    client = await f.client(); assert.equal((await client.connections.retryLocal()).state, 'ready')
    assert.equal((await client.connections.list())[0].revision, updated.revision)
    assert.equal(f.issued, 1)
    assert.equal(JSON.stringify(client.connections.localStatus()).includes(token), false)
    await client.root.fiber.dispose()
    assert.equal((await readFile(join(f.directory, 'client.sqlite'))).includes(Buffer.from(token)), false)
  } finally { await f.close() }
})

test('Vault unavailability preserves a valid retained token; failure does not prevent metadata reads or explicit retry', async () => {
  const f = await fixture()
  try {
    let client = await f.client(); await client.connections.retryLocal()
    const saved = (await client.connections.list())[0], token = (await client.connections.acquire(saved.id)).token
    await client.root.fiber.dispose()
    const reconciliations = f.reconciled.length
    f.failVault(true); client = await f.client()
    const failed = await client.connections.retryLocal()
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'credential-unavailable')
    assert.equal(f.reconciled.length, reconciliations); assert.equal(f.issued, 1)
    assert.equal(f.access.authenticate(`Bearer ${token}`), token.split('.')[0])
    assert.equal((await client.connections.list())[0].id, saved.id)
    f.failVault(false); assert.equal((await client.connections.retryLocal()).state, 'ready')
    assert.equal(f.issued, 1)
  } finally { await f.close() }
})

test('failed first credential save reconciles its managed orphan without exposing or storing the token', async () => {
  const f = await fixture()
  try {
    f.failVault(true)
    const client = await f.client(), failed = await client.connections.retryLocal()
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'credential-unavailable')
    assert.deepEqual(await client.connections.list(), [])
    assert.equal((await f.access.list()).filter(token => !token.revokedAt).length, 0)
    assert.equal(f.keys.size, 0)
    f.failVault(false); assert.equal((await client.connections.retryLocal()).state, 'ready')
    assert.equal((await f.access.list()).filter(token => !token.revokedAt).length, 1)
  } finally { await f.close() }
})

test('a failed managed reconciliation after commit preserves the saved credential and retry does not issue another token', async () => {
  const f = await fixture()
  let failRetain = true
  try {
    const client = await f.client({ localPairing: { ...f.pairing, async reconcile(token, signal) {
      if (token && failRetain) throw Object.assign(new Error('private host unavailable'), { code: 'local-unavailable' })
      return f.pairing.reconcile(token, signal)
    } } })
    const failed = await client.connections.retryLocal()
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'local-unavailable')
    const saved = (await client.connections.list())[0], token = (await client.connections.acquire(saved.id)).token
    assert.equal(f.access.authenticate(`Bearer ${token}`), token.split('.')[0])
    assert.equal(f.issued, 1)
    failRetain = false
    const ready = await client.connections.retryLocal()
    assert.equal(ready.state, 'ready'); assert.equal(ready.connectionId, saved.id)
    assert.equal(ready.connectionRevision, saved.revision); assert.equal(f.issued, 1)
    assert.equal((await client.connections.acquire(saved.id)).token, token)
  } finally { await f.close() }
})

test('a failed orphan cleanup is retried durably before issuing the next local credential', async () => {
  const f = await fixture()
  let failOrphanCleanup = true
  try {
    f.failVault(true)
    let client = await f.client({ localPairing: { ...f.pairing, async reconcile(token, signal) {
      if (!token && f.issued > 0 && failOrphanCleanup) throw Object.assign(new Error('private host unavailable'), { code: 'local-unavailable' })
      return f.pairing.reconcile(token, signal)
    } } })
    assert.equal((await client.connections.retryLocal()).error.code, 'credential-unavailable')
    assert.deepEqual(await client.connections.list(), [])
    const orphan = (await f.access.list()).find(token => !token.revokedAt)
    assert.ok(orphan)
    await client.root.fiber.dispose()
    f.failVault(false); failOrphanCleanup = false
    client = await f.client()
    assert.equal((await client.connections.retryLocal()).state, 'ready')
    const tokens = await f.access.list()
    assert.ok(tokens.find(token => token.id === orphan.id).revokedAt)
    assert.equal(tokens.filter(token => !token.revokedAt).length, 1)
  } finally { await f.close() }
})

test('revoked credentials recover with the same connection; changed local identity requires explicit separate connection', async () => {
  const f = await fixture()
  try {
    const client = await f.client(); await client.connections.retryLocal()
    const saved = (await client.connections.list())[0], old = (await client.connections.acquire(saved.id)).token
    await f.access.revoke(old.split('.')[0])
    assert.equal((await client.connections.retryLocal()).state, 'ready')
    const current = (await client.connections.list())[0]
    assert.equal(current.id, saved.id); assert.equal(current.revision, saved.revision + 1)
    assert.notEqual((await client.connections.acquire(saved.id)).token, old)
    const issued = f.issued, reconciliations = f.reconciled.length
    await f.access.resetIdentity()
    const failed = await client.connections.retryLocal()
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'instance-mismatch')
    assert.equal(f.issued, issued); assert.equal(f.reconciled.length, reconciliations)
    assert.equal((await client.connections.list())[0].instanceId, saved.instanceId)
  } finally { await f.close() }
})

test('unmanaged valid local credentials are replaced by an owned token without revoking unrelated access', async () => {
  const f = await fixture()
  try {
    let client = await f.client({ localPairing: undefined })
    const manual = await f.access.issue('Manual')
    const saved = await client.connections.save({ name: 'Existing', endpoint: 'http://127.0.0.1:12345', token: manual.token })
    await client.root.fiber.dispose(); client = await f.client()
    assert.equal((await client.connections.retryLocal()).state, 'ready')
    assert.equal((await client.connections.list())[0].id, saved.id)
    assert.equal(f.access.authenticate(`Bearer ${manual.token}`), manual.record.id)
    assert.notEqual((await client.connections.acquire(saved.id)).token, manual.token)
  } finally { await f.close() }
})

test('bootstrap is deduplicated, does not block readiness and shutdown waits for cancelled private work to exit', async () => {
  const f = await fixture(), entered = deferred(), exited = deferred(), release = deferred()
  let attempts = 0, signal
  try {
    const client = await f.client({ localPairing: { ...f.pairing, async getLocal(value) {
      signal = value; attempts++; entered.resolve()
      await release.promise; exited.resolve(); value.throwIfAborted()
      return f.pairing.getLocal(value)
    } } })
    await entered.promise
    const a = client.connections.retryLocal(), b = client.connections.retryLocal()
    assert.equal(a, b); assert.equal(attempts, 1)
    assert.deepEqual(await client.connections.list(), [])
    const remote = await f.access.issue('Remote')
    const saved = await client.connections.save({ name: 'Remote remains usable', endpoint: 'https://remote.test', token: remote.token })
    assert.equal((await client.connections.acquire(saved.id)).token, remote.token)
    let closed = false
    const closing = client.root.fiber.dispose().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(signal.aborted, true); assert.equal(closed, false)
    release.resolve(); await exited.promise; await closing
    assert.equal((await a).error.code, 'cancelled')
    await assert.rejects(client.connections.retryLocal(), { code: 'service-unavailable' })
  } finally { release.resolve(); await f.close() }
})

test('shutdown after local credential commit joins reconciliation without revoking the accepted credential', async () => {
  const f = await fixture(), entered = deferred(), release = deferred()
  let signal
  try {
    let client = await f.client({ localPairing: { ...f.pairing, async reconcile(token, value) {
      if (!token) return f.pairing.reconcile(token, value)
      signal = value; entered.resolve(); await release.promise; value.throwIfAborted()
      return f.pairing.reconcile(token, value)
    } } })
    await entered.promise
    const operation = client.connections.retryLocal()
    let closed = false
    const closing = client.root.fiber.dispose().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(signal.aborted, true); assert.equal(closed, false)
    release.resolve(); await closing
    assert.equal((await operation).error.code, 'cancelled')
    assert.equal((await f.access.list()).filter(token => !token.revokedAt).length, 1)
    assert.equal(f.issued, 1)
    client = await f.client(); assert.equal((await client.connections.retryLocal()).state, 'ready')
    assert.equal(f.issued, 1); assert.equal((await client.connections.list())[0].revision, 1)
  } finally { release.resolve(); await f.close() }
})

test('local gateway exposes only status and accepts empty retries; ordinary Web clients cannot invoke pairing', async () => {
  const f = await fixture(); let gateway
  try {
    const client = await f.client(); await client.connections.retryLocal()
    gateway = await startClientGateway(client.connections, { picker: { supported: true } })
    const local = await (await fetch(gateway.url + '/api/client/v1/local')).json()
    assert.equal(local.instanceId, f.access.instance.instanceId); assert.equal(local.picker, true); assert.equal(local.status.state, 'ready')
    const post = body => fetch(gateway.url + '/api/client/v1/local/retry', { method: 'POST', headers: { Origin: gateway.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post({ endpoint: 'https://other.test', token: 'secret' })).status, 400)
    assert.equal((await (await post({})).json()).state, 'ready')
    await gateway.close(); await client.root.fiber.dispose()
    const web = await f.client({ localPairing: undefined }); gateway = await startClientGateway(web.connections)
    assert.deepEqual(await (await fetch(gateway.url + '/api/client/v1/local')).json(), { instanceId: null, picker: false })
    assert.equal((await post({})).status, 403)
  } finally { await gateway?.close(); await f.close() }
})

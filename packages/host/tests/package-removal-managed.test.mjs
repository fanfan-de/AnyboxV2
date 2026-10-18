import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, rename, symlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createApplicationArchive } from '../dist/package-management/archive.js'
import { startManagedApplicationHost } from '../dist/package-management/managed-process.js'
import { planInstalledRoles } from '../dist/package-management/catalog-plan.js'

const supported = process.platform !== 'win32' && (Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 15)
async function until(work) {
  const end = Date.now() + 30_000
  while (Date.now() < end) { const value = await work(); if (value) return value; await delay(25) }
  throw Error('removal observation deadline')
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-removal-managed-')), packageDirectory = join(directory, 'applications'), clientPath = join(directory, 'client.sqlite')
  const keys = generateKeyPairSync('ed25519'), trustPolicyPath = join(directory, 'publishers.json')
  await writeFile(trustPolicyPath, JSON.stringify({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), appIds: ['one', 'two'] }] }))
  const start = () => startManagedApplicationHost({ path: clientPath, packageDirectory, executionPath: join(directory, 'execution.sqlite'), trustPolicyPath, port: 0 })
  let host = await start()
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  async function request(path, method = 'GET', data, raw = false) {
    const response = await fetch(host.url + path, { method, headers: { ...(method === 'GET' ? {} : { Origin: host.url }), ...(data === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(data === undefined ? {} : { body: raw ? data : JSON.stringify(data) }) })
    const value = await response.json()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const status = () => request('/api/client/v1/app-packages')
  const build = (appId, version) => Buffer.from(createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey,
    manifest: { schemaVersion: 1, lifecycleVersion: 1, appId, version, publisher: 'fixture', displayName: appId, applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, entries: { client: 'payload/registration.js', execution: 'payload/registration.js' }, runtimeRequirements: Object.fromEntries(['client', 'execution'].map(role => [role, { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }])) },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/registration.js', bytes: Buffer.from(`export function createRegistration(){return {definition:{id:${JSON.stringify(appId)},name:${JSON.stringify(appId)},icon:'fixture'},createRuntime(){let active=false;return {async open(){active=true},async retry(){active=true},async stop(){active=false},inspect(){return active?'active':'disabled'},closeAdmission(){},async awaitIdle(){}}}}}`) }] }))
  async function install(appId, version) {
    const bytes = build(appId, version), intent = await request('/api/client/v1/app-packages/operations', 'POST', { requestId: randomUUID(), filename: `${appId}-${version}.anybox-app`, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
    const job = await request(`/api/client/v1/app-packages/operations/${intent.id}/archive`, 'PUT', bytes, true)
    assert.equal(job.phase, 'installed')
    return job.identity
  }
  async function prepare(kind = 'activate', appIds) {
    return request('/api/client/v1/app-packages/activations', 'POST', { requestId: randomUUID(), expectedRegistryRevision: (await status()).registryRevision, kind, ...(appIds ? { appIds } : {}) })
  }
  async function commit(batch, phase = 'completed') {
    await request(`/api/client/v1/app-packages/activations/${batch.id}/commit`, 'POST', {}).catch(error => { if (host.state.phase === 'ready') throw error })
    return until(async () => {
      const value = await status().catch(() => undefined)
      return value?.activations.find(item => item.id === batch.id)?.phase === phase && host.state.phase === (phase === 'recovery-required' ? phase : 'ready') ? value : undefined
    })
  }
  return { directory, packageDirectory, clientPath, get host() { return host }, async restart() { await host.close(); host = await start() }, request, status, install, prepare, commit }
}
const container = (root, identity) => join(root, 'packages', identity.appId, identity.version, identity.digest)

test('removal planning excludes the target without importing or validating its damaged code and omits unused execution', async () => {
  const identity = { appId: 'one', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }
  const view = { revision: 1, ownerEpoch: 1, actual: [], applications: [{ appId: 'one', revision: 1, installed: [{ identity, state: 'quarantined' }], selected: identity, pending: null }] }
  const plans = await planInstalledRoles(view, { directory: '/no-such-removal-code', verification: {}, roles: ['client', 'execution'] }, { kind: 'remove', appIds: ['one'], requestId: 'remove', expectedRegistryRevision: 1 })
  assert.deepEqual(plans.map(plan => [plan.role, plan.entries]), [['client', []]])
})

test('uninstall coordinates a running application, reclaims every installed version, preserves data and other apps, and reinstall stays closed', { skip: !supported }, async t => {
  const f = await fixture(t), original = await f.install('one', '1.0.0')
  await f.install('two', '1.0.0'); await f.commit(await f.prepare())
  const second = await f.install('one', '2.0.0'); await f.commit(await f.prepare())
  await f.request('/api/client/v1/products/one/open', 'POST', {}); await f.request('/api/client/v1/products/two/open', 'POST', {})
  const data = join(f.directory, 'application-owned-business.json'), dataValue = '{"sessions":["preserved"],"remote":"unchanged"}'
  await writeFile(data, dataValue)
  const prior = await f.status(), batch = await f.prepare('remove', ['one'])
  assert.equal(batch.kind, 'remove'); assert.equal(batch.targets.length, 2)
  assert.equal((await f.request('/api/client/v1/products')).find(app => app.definition.id === 'one').desiredEnabled, true)
  const done = await f.commit(batch), facts = done.installations.find(app => app.appId === 'one')
  assert.equal(facts?.selected ?? null, null); assert.equal(facts?.pending ?? null, null)
  assert.ok(!facts || facts.installed.every(item => item.state === 'removed'))
  for (const identity of [original, second]) await assert.rejects(access(container(f.packageDirectory, identity)), { code: 'ENOENT' })
  assert.equal(await readFile(data, 'utf8'), dataValue)
  const products = await f.request('/api/client/v1/products')
  assert.deepEqual(products.map(app => app.definition.id), ['two']); assert.equal(products[0].desiredEnabled, true)
  assert.ok(done.actual.every(role => role.entries.every(entry => entry.identity.appId === 'two')))
  assert.ok(prior.actual.every(role => done.actual.every(next => next.generation !== role.generation)))
  const reinstalled = await f.install('one', '2.0.0'); assert.equal(reinstalled.digest, second.digest)
  await f.commit(await f.prepare())
  assert.equal((await f.request('/api/client/v1/products')).find(app => app.definition.id === 'one').desiredEnabled, false)
  assert.equal(await readFile(data, 'utf8'), dataValue)
  await f.host.close()
  const db = new DatabaseSync(f.clientPath, { readOnly: true })
  try { assert.equal(db.prepare('SELECT desired_enabled FROM app_product_targets WHERE id=?').get('one').desired_enabled, 0) } finally { db.close() }
})

test('an installed pending application can be removed without ever opening its runtime and leaves only the management role', { skip: !supported }, async t => {
  const f = await fixture(t), identity = await f.install('one', '1.0.0'), batch = await f.prepare('remove', ['one'])
  const done = await f.commit(batch)
  assert.equal(done.activations.find(item => item.id === batch.id).kind, 'remove')
  assert.deepEqual(await f.request('/api/client/v1/products'), [])
  assert.deepEqual(f.host.state.roles.map(role => role.role), ['client'])
  await assert.rejects(access(container(f.packageDirectory, identity)), { code: 'ENOENT' })
})

test('removing the last selected execution application proves its old role exited without starting an empty execution', { skip: !supported }, async t => {
  const f = await fixture(t), identity = await f.install('one', '1.0.0')
  await f.commit(await f.prepare())
  assert.ok(f.host.state.roles.some(role => role.role === 'execution' && role.ready && !role.exited))
  const previous = (await f.status()).actual.map(role => role.generation)
  const done = await f.commit(await f.prepare('remove', ['one']))
  assert.deepEqual(f.host.state.roles.filter(role => !role.exited).map(role => role.role), ['client'])
  assert.ok(done.actual.every(role => role.role === 'client' && !previous.includes(role.generation) && role.entries.length === 0))
  assert.deepEqual(await f.request('/api/client/v1/products'), [])
  await assert.rejects(access(container(f.packageDirectory, identity)), { code: 'ENOENT' })
})

test('unsafe code container reclamation remains recoverable and never touches its linked outside data', { skip: !supported }, async t => {
  const f = await fixture(t), identity = await f.install('one', '1.0.0')
  await f.install('two', '1.0.0')
  await f.commit(await f.prepare())
  await f.request('/api/client/v1/products/two/open', 'POST', {})
  await f.host.close()
  const executionDb = new DatabaseSync(join(f.directory, 'execution.sqlite'))
  try { executionDb.prepare('UPDATE app_product_targets SET desired_enabled=1 WHERE id=?').run('two') } finally { executionDb.close() }
  await f.restart()
  const path = container(f.packageDirectory, identity), held = `${path}.held`, outside = join(f.directory, 'outside-business')
  await writeFile(outside, 'must survive')
  await rename(path, held); await symlink(f.directory, path)
  const batch = await f.prepare('remove', ['one']), blocked = await f.commit(batch, 'recovery-required')
  assert.equal(blocked.activations.find(item => item.id === batch.id).phase, 'recovery-required')
  assert.notEqual(blocked.installations.find(item => item.appId === 'one').installed[0].state, 'removed')
  assert.equal(await readFile(outside, 'utf8'), 'must survive')
  assert.deepEqual(await f.request('/api/client/v1/products'), [])
  await rm(path); await rename(held, path)
  const resumed = await f.request(`/api/client/v1/app-packages/activations/${batch.id}/resume`, 'POST', {})
  assert.equal(resumed.protected, true)
  await f.commit(batch)
  await assert.rejects(access(path), { code: 'ENOENT' })
  assert.equal(await readFile(outside, 'utf8'), 'must survive')
  const retained = (await f.request('/api/client/v1/products')).find(app => app.definition.id === 'two')
  assert.equal(retained.desiredEnabled, true); assert.equal(retained.state, 'running')
  await f.host.close()
  for (const name of ['client', 'execution']) {
    const db = new DatabaseSync(join(f.directory, `${name}.sqlite`), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT desired_enabled FROM app_product_targets WHERE id=?').get('one').desired_enabled, 0)
      assert.equal(db.prepare('SELECT desired_enabled FROM app_product_targets WHERE id=?').get('two').desired_enabled, 1)
    } finally { db.close() }
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { fstatSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { copyFile, mkdtemp, rm, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'
import { acquirePackageUsageLock } from '../dist/package-management/usage-locks.js'

const identity = (version = '1.0.0', digest = 'a'.repeat(64), appId = 'calculator') => ({ appId, version, digest, target: { os: 'darwin', arch: 'arm64' } })
const source = { kind: 'file', reference: 'calculator.anybox-app', publisher: 'anybox' }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const code = expected => error => error?.code === expected
const rootDescriptors = directory => {
  const expected = lstatSync(directory)
  return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').filter(name => {
    try { const actual = fstatSync(Number(name)); return actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino } catch { return false }
  })
}
const fixtureRoots = new Map()
async function open(directory, wrapStorage) {
  const root = new Context()
  const storageKey = wrapStorage ? 'fixture.registry-storage' : packageRegistryStorageServiceKey
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: storageKey }))
  if (wrapStorage) await root.installComponent({ inject: [storageKey], apply(ctx, _config, deps) { ctx.provide(packageRegistryStorageServiceKey, wrapStorage(deps[storageKey])) } })
  await root.installComponent(createPackageRegistryComponent({ directory }))
  assert.equal(root.get(packageRegistryServiceKey) !== undefined, true)
  if (!fixtureRoots.has(directory)) fixtureRoots.set(directory, new Set())
  fixtureRoots.get(directory).add(root)
  return { root, service: root.get(packageRegistryServiceKey) }
}
async function fixture(t, wrapStorage) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-package-registry-'))
  const instance = await open(directory, wrapStorage)
  t.after(async () => {
    for (const root of fixtureRoots.get(directory) ?? []) await root.fiber.dispose()
    fixtureRoots.delete(directory)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, ...instance }
}
async function phase(service, operation, target) { return service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: target }) }
async function install(service, selected = identity(), requestId = `install-${selected.version}`, appRevision) {
  const before = await service.inspect()
  const revision = appRevision ?? before.applications.find(app => app.appId === selected.appId)?.revision ?? 0
  let operation = await service.begin({ requestId, kind: 'install', identity: selected, expectedAppRevision: revision })
  for (const next of ['preparing', 'prepared', 'committing']) operation = await phase(service, operation, next)
  operation = await service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: revision, source })
  return operation
}
async function select(service, operation) {
  const facts = (await service.inspect()).applications.find(app => app.appId === operation.appId)
  return service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts.revision })
}
async function reserve(service, selected = identity(), holderId = 'client', capabilities = []) {
  return service.prepareUse({ expectedRegistryRevision: (await service.inspect()).revision, role: 'web', holderId, generation: 'generation-1', entries: [{ package: selected, entry: 'web' }], capabilities })
}
async function activate(service, directory, operation) {
  operation = await select(service, operation)
  const credential = await reserve(service, operation.identity)
  const lock = acquirePackageUsageLock(directory, credential)
  await service.claim(credential); await service.ready(credential)
  operation = await phase(service, operation, 'completed')
  return { operation, credential, lock }
}
async function closeUse(service, usage) { await usage.lock.release(); await service.confirmExit({ usageId: usage.credential.usageId }) }

test('normalized request replay precedes CAS, survives restart, and never repeats side effects', async t => {
  const { directory, root, service } = await fixture(t)
  const input = { requestId: 'stable-intent', kind: 'install', identity: identity(), expectedAppRevision: 0 }
  const operation = await service.begin(input)
  const reordered = { ...input, identity: { target: { arch: 'arm64', os: 'darwin' }, digest: 'a'.repeat(64), version: '1.0.0', appId: 'calculator' }, expectedAppRevision: 999 }
  assert.deepEqual(await service.begin(reordered), operation)
  await assert.rejects(service.begin({ ...input, identity: identity('2.0.0') }), code('request-conflict'))
  await assert.rejects(service.begin({ ...input, requestId: 'other-intent' }), code('operation-conflict'))
  await assert.rejects(service.advance({ operationId: operation.id, expectedRevision: 5, phase: 'preparing' }), code('revision-conflict'))
  await root.fiber.dispose()
  const reopened = await open(directory); t.after(() => reopened.root.fiber.dispose())
  const recovered = await reopened.service.findOperation(input.requestId)
  assert.equal(recovered.phase, 'recovery-required'); assert.equal(recovered.recovery.from, 'accepted')
  assert.deepEqual(await reopened.service.begin(reordered), recovered)
  await assert.rejects(reopened.service.advance({ operationId: operation.id, expectedRevision: recovered.revision, phase: 'preparing' }), code('transition-invalid'))
  const reconciled = await reopened.service.reconcile({ operationId: operation.id, expectedRevision: recovered.revision, phase: 'failed', receipt: { inspected: true, action: 'nothing-was-committed' } })
  assert.equal(reconciled.phase, 'failed'); assert.equal(reconciled.recovery, null)
  await assert.rejects(reopened.service.begin({ ...input, requestId: 'new', expectedAppRevision: 10 }), code('revision-conflict'))
})

test('installed, pending, selected, role target and actual readiness are separate immutable facts', async t => {
  const { directory, service } = await fixture(t)
  let operation = await install(service)
  const installed = await service.inspect()
  assert.equal(installed.applications[0].revision, 1)
  assert.equal(installed.applications[0].selected, null)
  assert.deepEqual(installed.applications[0].pending, identity())
  assert.deepEqual(installed.actual, [])
  await assert.rejects(phase(service, operation, 'completed'), code('transition-invalid'))
  operation = await select(service, operation)
  const selected = await service.inspect()
  assert.equal(selected.applications[0].pending, null)
  assert.deepEqual(selected.applications[0].selected, identity())
  assert.deepEqual(selected.actual, [])
  await assert.rejects(phase(service, operation, 'completed'), code('transition-invalid'))
  const credential = await service.prepareUse({ expectedRegistryRevision: selected.revision, role: 'client', holderId: 'client', generation: 'g1', entries: [{ package: identity(), entry: 'client', desiredEnabled: false }], capabilities: [{ id: 'storage.sqlite', version: '1.0.0', package: null }] })
  assert.equal(credential.snapshot.entries[0].desiredEnabled, false)
  assert.equal(Object.isFrozen(credential.snapshot.entries[0].package.target), true)
  const lock = acquirePackageUsageLock(directory, credential)
  await service.claim(credential)
  assert.deepEqual((await service.inspect()).actual, [])
  const actual = await service.ready(credential)
  assert.deepEqual(actual.snapshot, credential.snapshot)
  operation = await phase(service, operation, 'completed')
  assert.equal(operation.phase, 'completed')
  await lock.release(); await service.confirmExit({ usageId: credential.usageId })
  assert.deepEqual((await service.inspect()).actual, [])
})

test('selection of a new version preserves old actual snapshot until its real exit', async t => {
  const { directory, service } = await fixture(t)
  const v1 = await activate(service, directory, await install(service))
  const v2identity = identity('2.0.0', 'b'.repeat(64))
  let v2 = await install(service, v2identity)
  assert.deepEqual((await service.inspect()).applications[0].selected, identity())
  assert.deepEqual((await service.inspect()).actual[0].snapshot.entries[0].package, identity())
  v2 = await select(service, v2)
  const view = await service.inspect()
  assert.deepEqual(view.applications[0].selected, v2identity)
  assert.deepEqual(view.actual[0].snapshot.entries[0].package, identity())
  assert.equal((await service.getOperation(v2.id)).phase, 'activating')
  await closeUse(service, v1)
})

test('claim requires a real held usage lock and persists only a digest of its one-time secret', async t => {
  const { directory, service } = await fixture(t)
  await select(service, await install(service))
  const credential = await reserve(service)
  await assert.rejects(service.claim(credential), code('use-lock-required'))
  const lock = acquirePackageUsageLock(directory, credential)
  await assert.rejects(service.claim({ ...credential, secret: 'wrong' }), code('use-unavailable'))
  await service.claim(credential)
  const bytes = await readFile(join(directory, 'registry.sqlite'))
  assert.equal(bytes.includes(Buffer.from(credential.secret)), false)
  const inspection = JSON.stringify(await service.inspect()) + JSON.stringify(await service.listUsages()) + JSON.stringify(await service.listOperations())
  assert.equal(inspection.includes(credential.secret), false)
  await lock.release(); await service.confirmExit({ usageId: credential.usageId })
  assert.throws(() => acquirePackageUsageLock(directory, credential), error => error.code === 'unauthorized')
})

test('revoked, outdated registry and previous owner snapshots cannot start new code use', async t => {
  const { directory, root, service } = await fixture(t)
  let operation = await select(service, await install(service))
  const revoked = await reserve(service, identity(), 'revoked')
  const revokedLock = acquirePackageUsageLock(directory, revoked)
  await service.revokeSnapshot({ snapshotId: revoked.snapshot.id, expectedRevision: 0 })
  await assert.rejects(service.claim(revoked), code('snapshot-revoked'))
  await revokedLock.release(); await service.confirmExit({ usageId: revoked.usageId })
  const stale = await reserve(service, identity(), 'stale')
  operation = await service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: (await service.inspect()).applications[0].revision })
  const staleLock = acquirePackageUsageLock(directory, stale)
  await assert.rejects(service.claim(stale), code('snapshot-stale'))
  await staleLock.release(); await service.confirmExit({ usageId: stale.usageId })
  const previousOwner = await reserve(service, identity(), 'previous-owner')
  await root.fiber.dispose()
  const reopened = await open(directory); t.after(() => reopened.root.fiber.dispose())
  const previousLock = acquirePackageUsageLock(directory, previousOwner)
  await assert.rejects(reopened.service.claim(previousOwner), code('snapshot-stale'))
  await previousLock.release(); await reopened.service.confirmExit({ usageId: previousOwner.usageId })
})

test('handoff commits the child pin before parent exit and never revokes the shared snapshot', async t => {
  const { directory, service } = await fixture(t)
  await select(service, await install(service))
  const parent = await reserve(service)
  const parentLock = acquirePackageUsageLock(directory, parent)
  await service.claim(parent); await service.ready(parent)
  const child = await service.prepareHandoff(parent, { holderId: 'execution', generation: 'next' })
  assert.equal((await service.listUsages()).find(item => item.id === child.usageId).parentId, parent.usageId)
  await parentLock.release(); await service.confirmExit({ usageId: parent.usageId })
  assert.equal((await service.listUsages()).find(item => item.id === child.usageId).state, 'reserved')
  const childLock = acquirePackageUsageLock(directory, child)
  await service.claim(child); await service.ready(child)
  assert.equal((await service.inspect()).actual[0].usage.id, child.usageId)
  await childLock.release(); await service.confirmExit({ usageId: child.usageId })
})

test('busy exit keeps the usage fenced and pinned until a later exclusive proof succeeds', async t => {
  const { directory, service } = await fixture(t)
  await select(service, await install(service))
  const credential = await reserve(service), lock = acquirePackageUsageLock(directory, credential)
  await service.claim(credential); await service.ready(credential)
  await assert.rejects(service.confirmExit({ usageId: credential.usageId }), code('version-in-use'))
  assert.equal((await service.listUsages())[0].state, 'exit-unconfirmed')
  await assert.rejects(service.claim(credential), code('use-unavailable'))
  assert.equal((await service.inspect()).actual[0].usage.state, 'exit-unconfirmed')
  await lock.release(); assert.equal((await service.confirmExit({ usageId: credential.usageId })).state, 'exited')
})

test('unknown reservation exit is never reported as an actual ready catalog', async t => {
  const { directory, service } = await fixture(t)
  await select(service, await install(service))
  const credential = await reserve(service), lock = acquirePackageUsageLock(directory, credential)
  await assert.rejects(service.confirmExit({ usageId: credential.usageId }), code('version-in-use'))
  assert.deepEqual((await service.inspect()).actual, [])
  await lock.release(); await service.confirmExit({ usageId: credential.usageId })
})

async function removalFixture(t, wrapStorage) {
  const fixture = await fixtureBase(t, wrapStorage)
  const { service, directory } = fixture
  const first = await activate(service, directory, await install(service)); await closeUse(service, first)
  const nextIdentity = identity('2.0.0', 'b'.repeat(64))
  const next = await activate(service, directory, await install(service, nextIdentity)); await closeUse(service, next)
  const capability = [{ id: 'calculator.renderer', version: '1.0.0', package: identity() }]
  const oldCredential = await reserve(service, nextIdentity, 'old-capability-holder', capability)
  const oldLock = acquirePackageUsageLock(directory, oldCredential)
  await service.claim(oldCredential); await service.ready(oldCredential)
  const old = { credential: oldCredential, lock: oldLock }
  const pendingOld = await reserve(service, nextIdentity, 'not-started', capability)
  let removal = await service.begin({ requestId: 'remove-old', kind: 'remove', identity: identity(), expectedAppRevision: (await service.inspect()).applications[0].revision })
  removal = await phase(service, removal, 'preparing'); removal = await phase(service, removal, 'prepared')
  const input = () => service.inspect().then(view => ({ operationId: removal.id, expectedRevision: removal.revision, expectedAppRevision: view.applications[0].revision }))
  return { ...fixture, old, pendingOld, removal, input }
}
const fixtureBase = fixture

test('reclamation never enters while any actual or reserved use references the version', async t => {
  const { service, old, pendingOld, input } = await removalFixture(t)
  let entered = 0
  const work = async () => { entered++; return 'deleted-code-only' }
  await assert.rejects(service.withReclamation(await input(), work), code('version-in-use'))
  await closeUse(service, old)
  await assert.rejects(service.withReclamation(await input(), work), code('version-in-use'))
  assert.equal(entered, 0)
  await service.confirmExit({ usageId: pendingOld.usageId })
  assert.equal(await service.withReclamation(await input(), work), 'deleted-code-only')
  assert.equal(entered, 1)
  const view = await service.inspect()
  assert.equal(view.applications[0].installed[0].state, 'removed')
  assert.equal((await service.findOperation('remove-old')).phase, 'completed')
})

test('failed reclamation preserves identity and requires explicit reconciliation after restart', async t => {
  const { service, root, directory, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  let entered = 0
  await assert.rejects(service.withReclamation(await input(), async () => { entered++; throw new Error('injected partial file cleanup') }), /injected/)
  assert.equal((await service.inspect()).applications[0].installed[0].state, 'reclaiming')
  const failed = await service.findOperation('remove-old')
  assert.equal(failed.phase, 'recovery-required'); assert.equal(failed.recovery.reason, 'outcome-unconfirmed')
  await root.fiber.dispose()
  const reopened = await open(directory); t.after(() => reopened.root.fiber.dispose())
  assert.equal(entered, 1)
  const recovered = await reopened.service.findOperation('remove-old')
  await assert.rejects(reopened.service.withReclamation({ operationId: recovered.id, expectedRevision: recovered.revision, expectedAppRevision: (await reopened.service.inspect()).applications[0].revision }, async () => entered++), code('transition-invalid'))
  const reconciled = await reopened.service.reconcile({ operationId: recovered.id, expectedRevision: recovered.revision, phase: 'committing', receipt: { verifiedRemainingFiles: ['code.js'] } })
  await reopened.service.withReclamation({ operationId: reconciled.id, expectedRevision: reconciled.revision, expectedAppRevision: (await reopened.service.inspect()).applications[0].revision }, async () => { entered++ })
  assert.equal(entered, 2)
})

test('host close cancels local controlled work and waits actual exit before releasing registry storage', async t => {
  const { service, root, directory, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  const started = deferred(), aborted = deferred(), exited = deferred()
  assert.equal(rootDescriptors(directory).length, 1)
  const reclamation = service.withReclamation(await input(), async (_identity, signal, anchor) => {
    const physical = lstatSync(directory)
    assert.deepEqual(anchor, { directory: realpathSync(directory), device: physical.dev, inode: physical.ino })
    assert.equal(Object.isFrozen(anchor), true)
    started.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    await exited.promise; throw new Error('cancelled after resource exit')
  })
  await started.promise
  let closed = false
  const closing = root.fiber.dispose().then(() => { closed = true })
  await aborted.promise
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  assert.equal(rootDescriptors(directory).length, 1)
  await assert.rejects(service.inspect(), code('service-closing'))
  const competing = new Context(); await assert.rejects(async () => { await competing.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey })) }, code('occupied'))
  await competing.fiber.awaitStable(); assert.equal(competing.get(packageRegistryStorageServiceKey), undefined); await competing.fiber.dispose()
  exited.resolve()
  await assert.rejects(reclamation, /cancelled after resource exit/); await closing
  assert.equal(rootDescriptors(directory).length, 0)
  const reopened = await open(directory); t.after(() => reopened.root.fiber.dispose())
  assert.equal((await reopened.service.findOperation('remove-old')).phase, 'recovery-required')
})

test('a replaced canonical registry root cannot enter reclamation through an external directory alias', async t => {
  const { service, directory, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  const expected = await input(), outside = await mkdtemp(join(tmpdir(), 'anybox-registry-outside-')), held = directory + '-pinned'
  let entered = 0, moved = false, alias = false
  try {
    await rename(directory, held); moved = true
    await symlink(outside, directory); alias = true
    await assert.rejects(service.withReclamation(expected, async () => { entered++ }), code('reclamation-root-changed'))
    assert.equal(entered, 0)
    assert.equal((await service.getOperation(expected.operationId)).phase, 'prepared')
  } finally {
    if (alias) await unlink(directory)
    if (moved) await rename(held, directory)
    await rm(outside, { recursive: true, force: true })
  }
  await service.withReclamation(expected, async () => { entered++ })
  assert.equal(entered, 1)
})

test('failed registry initialization releases its pinned physical root through the component effect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-registry-root-startup-')), root = new Context(), storageKey = 'fixture.registry-startup-storage'
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: storageKey }))
  await root.installComponent({ inject: [storageKey], apply(ctx, _config, deps) {
    ctx.provide(packageRegistryStorageServiceKey, { ...deps[storageKey], read: async () => {
      assert.equal(rootDescriptors(directory).length, 1)
      throw Error('injected registry startup failure')
    } })
  } })
  await assert.rejects(async () => { await root.installComponent(createPackageRegistryComponent({ directory })) }, /injected registry startup failure/)
  await root.fiber.awaitStable()
  assert.equal(root.get(packageRegistryServiceKey), undefined)
  assert.equal(rootDescriptors(directory).length, 0)
})

test('immutable package identity/source and corrupt persisted facts are rejected', async t => {
  const { root, directory, service } = await fixture(t)
  const first = await activate(service, directory, await install(service)); await closeUse(service, first)
  let conflicting = await service.begin({ requestId: 'replace-same-version', kind: 'install', identity: identity('1.0.0', 'b'.repeat(64)), expectedAppRevision: (await service.inspect()).applications[0].revision })
  for (const target of ['preparing', 'prepared', 'committing']) conflicting = await phase(service, conflicting, target)
  await assert.rejects(service.recordInstalled({ operationId: conflicting.id, expectedRevision: conflicting.revision, expectedAppRevision: (await service.inspect()).applications[0].revision, source }), code('identity-conflict'))
  await root.fiber.dispose()
  const sqlite = new DatabaseSync(join(directory, 'registry.sqlite'))
  sqlite.prepare('UPDATE package_registry_applications SET facts_json=?').run(JSON.stringify({ appId: 'calculator', revision: -1 }))
  sqlite.close()
  const broken = new Context()
  await broken.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await assert.rejects(async () => { await broken.installComponent(createPackageRegistryComponent({ directory })) }, code('registry-corrupt'))
  assert.equal(broken.get(packageRegistryServiceKey), undefined)
  await broken.fiber.dispose()
})

test('registry never adopts another migration domain or touches application data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-registry-domain-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  const storage = root.get(packageRegistryStorageServiceKey)
  await storage.migrate('business-data', [{ version: 1, up(tx) { tx.execute('CREATE TABLE private_business(value TEXT)'); tx.execute("INSERT INTO private_business VALUES('preserved')") } }])
  await assert.rejects(async () => { await root.installComponent(createPackageRegistryComponent({ directory })) }, code('registry-corrupt'))
  assert.equal(root.get(packageRegistryServiceKey), undefined)
  assert.equal(await storage.read(reader => reader.get('SELECT value FROM private_business').value), 'preserved')
  assert.equal(await storage.read(reader => reader.get("SELECT name FROM sqlite_master WHERE name='package_registry_meta'")), undefined)
  await root.fiber.dispose()
})

test('a running reclamation is the only writer of its operation and cannot duplicate its callback', async t => {
  const { service, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  const started = deferred(), finish = deferred()
  let entered = 0
  const work = service.withReclamation(await input(), async () => { entered++; started.resolve(); await finish.promise })
  await started.promise
  try {
    const current = await service.findOperation('remove-old')
    const facts = (await service.inspect()).applications[0]
    const expected = { operationId: current.id, expectedRevision: current.revision, expectedAppRevision: facts.revision }
    await assert.rejects(service.withReclamation(expected, async () => { entered++ }), code('operation-conflict'))
    await assert.rejects(service.advance({ ...expected, phase: 'recovery-required' }), code('operation-conflict'))
    await assert.rejects(service.reconcile({ ...expected, phase: 'committing', receipt: {} }), code('operation-conflict'))
    await assert.rejects(service.recordInstalled({ ...expected, source }), code('operation-conflict'))
    await assert.rejects(service.select(expected), code('operation-conflict'))
    assert.equal(entered, 1)
  } finally { finish.resolve(); await work }
})

test('missing historical exit anchor blocks reclamation even when ledger says exited', async t => {
  const { service, directory, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  await rm(join(directory, 'usage-locks', `${old.credential.usageId}.sqlite`))
  let entered = 0
  await assert.rejects(service.withReclamation(await input(), async () => { entered++ }), error => error.code === 'unavailable')
  assert.equal(entered, 0)
  assert.equal((await service.findOperation('remove-old')).phase, 'recovery-required')
  assert.equal((await service.inspect()).applications[0].installed[0].state, 'reclaiming')
})

test('a copied historical anchor cannot authorize reclamation even after its usage was recorded exited', async t => {
  const { service, directory, old, pendingOld, input } = await removalFixture(t)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  const path = join(directory, 'usage-locks', `${old.credential.usageId}.sqlite`)
  await rename(path, path + '.original'); await copyFile(path + '.original', path)
  let entered = 0
  await assert.rejects(service.withReclamation(await input(), async () => { entered++ }), code('unavailable'))
  assert.equal(entered, 0)
  assert.equal((await service.listUsages()).find(use => use.id === old.credential.usageId).state, 'exited')
  assert.equal((await service.findOperation('remove-old')).phase, 'recovery-required')
  assert.notEqual((await service.inspect()).applications[0].installed[0].state, 'removed')
})

test('one new ready role cannot complete activation while any known old role has unknown exit', async t => {
  const { service, directory } = await fixture(t)
  const old = await activate(service, directory, await install(service))
  const nextIdentity = identity('2.0.0', 'b'.repeat(64))
  let operation = await select(service, await install(service, nextIdentity))
  const credential = await reserve(service, nextIdentity, 'next-role'), lock = acquirePackageUsageLock(directory, credential)
  await service.claim(credential); await service.ready(credential)
  await assert.rejects(phase(service, operation, 'completed'), code('transition-invalid'))
  await assert.rejects(service.confirmExit({ usageId: old.credential.usageId }), code('version-in-use'))
  await assert.rejects(phase(service, operation, 'completed'), code('transition-invalid'))
  await old.lock.release(); await service.confirmExit({ usageId: old.credential.usageId })
  operation = await phase(service, operation, 'completed')
  assert.equal(operation.phase, 'completed')
  await lock.release(); await service.confirmExit({ usageId: credential.usageId })
})

test('registry restart preserves actual catalog with uncertain exit without waiting for foreign lifetimes', async t => {
  const { service, directory, root } = await fixture(t)
  const active = await activate(service, directory, await install(service))
  await root.fiber.dispose()
  const reopened = await open(directory)
  const actual = (await reopened.service.inspect()).actual
  assert.equal(actual.length, 1)
  assert.equal(actual[0].usage.state, 'exit-unconfirmed')
  assert.deepEqual(actual[0].snapshot, active.credential.snapshot)
  await assert.rejects(reopened.service.confirmExit({ usageId: active.credential.usageId }), code('version-in-use'))
  await reopened.root.fiber.dispose()
  await active.lock.release()
  const final = await open(directory)
  await final.service.confirmExit({ usageId: active.credential.usageId })
  assert.deepEqual((await final.service.inspect()).actual, [])
})

test('accepted commands copy caller-owned nested inputs before asynchronous work begins', async t => {
  const { service } = await fixture(t)
  const input = { requestId: 'immutable-command', kind: 'install', identity: identity(), expectedAppRevision: 0 }
  const accepted = service.begin(input)
  input.requestId = 'mutated'; input.identity.appId = 'mutated'; input.identity.target.arch = 'x64'; input.expectedAppRevision = 77
  let operation = await accepted
  assert.equal(operation.requestId, 'immutable-command'); assert.deepEqual(operation.identity, identity())
  for (const target of ['preparing', 'prepared', 'committing']) operation = await phase(service, operation, target)
  const installation = { operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 0, source: { ...source } }
  const recorded = service.recordInstalled(installation); installation.source.publisher = 'mutated'
  operation = await select(service, await recorded)
  const revision = (await service.inspect()).revision
  const reservation = { expectedRegistryRevision: revision, role: 'client', holderId: 'original-holder', generation: 'g1', entries: [{ package: identity(), entry: 'client', desiredEnabled: false }], capabilities: [{ id: 'storage.sqlite', version: '1.0.0', package: null }] }
  const reserving = service.prepareUse(reservation)
  reservation.entries[0].package.digest = 'b'.repeat(64); reservation.entries[0].desiredEnabled = true; reservation.capabilities[0].version = '2.0.0'; reservation.holderId = 'mutated'
  const credential = await reserving
  assert.deepEqual(credential.snapshot.entries[0], { package: identity(), entry: 'client', desiredEnabled: false })
  assert.equal(credential.snapshot.capabilities[0].version, '1.0.0')
  assert.equal((await service.listUsages())[0].holderId, 'original-holder')
  assert.equal((await service.inspect()).applications[0].installed[0].source.publisher, source.publisher)
  await service.confirmExit({ usageId: credential.usageId })
})

test('failed recovery receipt persistence fences this registry and never repeats unknown file effects', async t => {
  let failWrites = false
  const wrapper = storage => ({
    read: (...args) => storage.read(...args), migrate: (...args) => storage.migrate(...args),
    transaction(work, signal) {
      return storage.transaction(tx => work({ ...tx, execute(sql, values) {
        if (failWrites && sql.startsWith('INSERT INTO package_registry_operations')) {
          const operation = JSON.parse(values[2])
          if (operation.requestId === 'remove-old' && ['completed', 'recovery-required'].includes(operation.phase)) throw new Error('injected unavailable receipt persistence')
        }
        return tx.execute(sql, values)
      } }), signal)
    },
  })
  const { service, root, directory, old, pendingOld, input } = await removalFixture(t, wrapper)
  await closeUse(service, old); await service.confirmExit({ usageId: pendingOld.usageId })
  let effects = 0
  const expected = await input()
  await assert.rejects(service.withReclamation(expected, async () => { effects++; failWrites = true }), /outcome could not be recorded/)
  failWrites = false
  await assert.rejects(service.withReclamation(expected, async () => { effects++ }), code('service-closing'))
  await assert.rejects(service.inspect(), code('service-closing'))
  assert.equal(effects, 1)
  await assert.rejects(root.fiber.dispose())
  fixtureRoots.get(directory).delete(root)
  const reopened = await open(directory)
  const operation = await reopened.service.findOperation('remove-old')
  assert.equal(operation.phase, 'recovery-required'); assert.equal(operation.recovery.from, 'committing')
  assert.equal((await reopened.service.inspect()).applications[0].installed[0].state, 'reclaiming')
  await assert.rejects(reopened.service.withReclamation({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: (await reopened.service.inspect()).applications[0].revision }, async () => { effects++ }), code('transition-invalid'))
  assert.equal(effects, 1)
})

test('persisted snapshot corruption cannot redirect a live usage away from its installed package identity', async t => {
  const { service, root, directory } = await fixture(t)
  const active = await activate(service, directory, await install(service))
  const storage = root.get(packageRegistryStorageServiceKey)
  const original = await storage.read(db => db.get('SELECT snapshot_json FROM package_registry_snapshots WHERE id=?', [active.credential.snapshot.id]).snapshot_json)
  try {
    const changed = JSON.parse(original); changed.entries[0].package.digest = 'f'.repeat(64)
    await storage.transaction(db => db.execute('UPDATE package_registry_snapshots SET snapshot_json=? WHERE id=?', [JSON.stringify(changed), changed.id]))
    await assert.rejects(service.inspect(), code('registry-corrupt'))
    await assert.rejects(service.confirmExit({ usageId: active.credential.usageId }), code('registry-corrupt'))
  } finally {
    await storage.transaction(db => db.execute('UPDATE package_registry_snapshots SET snapshot_json=? WHERE id=?', [original, active.credential.snapshot.id]))
    await closeUse(service, active)
  }
})

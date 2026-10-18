import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'
import { acquirePackageUsageLock } from '../dist/package-management/usage-locks.js'
import { packageRegistryMigrations } from '../dist/package-management/migrations.js'

const code = expected => error => error?.code === expected
const identity = (appId = 'calculator', version = '1.0.0', digest = 'a'.repeat(64)) => ({ appId, version, digest, target: { os: 'darwin', arch: 'arm64' } })
const emptyRole = () => [{ role: 'client', entries: [], capabilities: [] }]
const source = { kind: 'file', reference: 'fixture.anybox-app', publisher: 'fixture' }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function open(directory) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(createPackageRegistryComponent({ directory }))
  return { root, service: root.get(packageRegistryServiceKey) }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-removal-ledger-')), roots = [], locks = []
  const reopen = async () => { const instance = await open(directory); roots.push(instance.root); return instance }
  const first = await reopen()
  const lock = credential => { const handle = acquirePackageUsageLock(directory, credential); locks.push(handle); return handle }
  t.after(async () => { for (const handle of locks) await handle.release(); for (const root of roots) await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, reopen, lock, ...first }
}
async function install(service, selected = identity(), requestId = `install-${selected.appId}-${selected.version}`) {
  const before = (await service.inspect()).applications.find(item => item.appId === selected.appId)?.revision ?? 0
  let operation = await service.begin({ requestId, kind: 'install', identity: selected, expectedAppRevision: before })
  for (const phase of ['preparing', 'prepared', 'committing']) operation = await service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase })
  return service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: before, source })
}
async function selected(f, selected = identity()) {
  let operation = await install(f.service, selected)
  const facts = (await f.service.inspect()).applications.find(item => item.appId === selected.appId)
  operation = await f.service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts.revision })
  const credential = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'client', holderId: 'first', generation: 'first', entries: [{ package: selected, entry: 'web' }] }), handle = f.lock(credential)
  await f.service.claim(credential); await f.service.ready(credential)
  await f.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' })
  await handle.release(); await f.service.confirmExit({ usageId: credential.usageId })
  return operation
}
const prepare = async (service, input = {}) => service.prepareActivation({ kind: 'remove', requestId: 'remove-1', expectedRegistryRevision: (await service.inspect()).revision, appIds: ['calculator'], roles: emptyRole(), ...input })
const commit = (service, activation) => service.commitActivation({ activationId: activation.id, expectedRevision: activation.revision, holderId: 'manager', generation: 'handoff', receipt: { guards: 'confirmed' } })
async function switchRoles(f, owner, launch) {
  const parents = launch.credentials.map(f.lock)
  await owner.root.fiber.dispose()
  const next = await f.reopen(), recovered = await next.service.getActivation(launch.activation.id)
  const adopted = await next.service.adoptActivation({ activationId: recovered.id, expectedRevision: recovered.revision, parents: launch.credentials, holderId: 'new-role', generation: 'new-generation' })
  const children = []
  let activation = adopted.activation
  for (const credential of adopted.credentials) {
    children.push(f.lock(credential)); await next.service.claim(credential); await next.service.ready(credential)
    activation = await next.service.recordActivationRoleReady({ activationId: activation.id, expectedRevision: activation.revision, usageId: credential.usageId })
  }
  for (let i = 0; i < parents.length; i++) { await parents[i].release(); await next.service.confirmExit({ usageId: launch.credentials[i].usageId }) }
  return { ...next, activation, credentials: adopted.credentials, children }
}
async function reclaim(service, target, work = async () => {}) {
  const operation = await service.getOperation(target.operationId), facts = (await service.inspect()).applications.find(item => item.appId === target.identity.appId)
  return service.withReclamation({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts.revision }, work)
}
async function reclaiming(f, owner, activation) {
  const launch = await commit(owner.service, activation), next = await switchRoles(f, owner, launch)
  next.activation = await next.service.completeActivation({ activationId: next.activation.id, expectedRevision: next.activation.revision })
  assert.equal(next.activation.phase, 'reclaiming')
  return next
}

test('remove preparation records every installed version without changing pointers or its pending install operation', async t => {
  const f = await fixture(t), v1 = identity(), v2 = identity('calculator', '2.0.0', 'b'.repeat(64))
  await selected(f, v1); const pending = await install(f.service, v2), before = await f.service.inspect()
  const activation = await prepare(f.service)
  assert.equal(activation.kind, 'remove'); assert.equal(activation.targets.length, 2); assert.deepEqual(activation.roles[0].entries, [])
  assert.deepEqual(await f.service.inspect(), before)
  assert.equal((await f.service.getOperation(pending.id)).phase, 'awaiting-activation')
  for (const target of activation.targets) { const operation = await f.service.getOperation(target.operationId); assert.equal(operation.kind, 'remove'); assert.equal(operation.phase, 'accepted') }
  assert.deepEqual(await prepare(f.service), activation)
  await assert.rejects(prepare(f.service, { kind: 'activate' }), code('request-conflict'))
  const cancelled = await f.service.recoverActivation({ activationId: activation.id, expectedRevision: activation.revision, action: 'cancel' })
  assert.equal(cancelled.activation.phase, 'cancelled'); assert.deepEqual(await f.service.inspect(), before)
  assert.equal((await f.service.getOperation(pending.id)).phase, 'awaiting-activation')
  for (const target of activation.targets) assert.equal((await f.service.getOperation(target.operationId)).phase, 'cancelled')
  assert.equal((await prepare(f.service, { requestId: 'remove-next' })).phase, 'prepared')
})

test('empty replacement client may omit the old execution role, but removal waits for its actual exit and real file callbacks', async t => {
  const f = await fixture(t), v1 = identity(), v2 = identity('calculator', '2.0.0', 'b'.repeat(64))
  await selected(f, v1); const pending = await install(f.service, v2)
  const old = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'execution', holderId: 'old-execution', generation: 'old', entries: [{ package: v1, entry: 'execution', desiredEnabled: true }] }), oldLock = f.lock(old)
  await f.service.claim(old); await f.service.ready(old)
  const activation = await prepare(f.service, { ownedUsageIds: [old.usageId] }), launch = await commit(f.service, activation)
  const facts = (await f.service.inspect()).applications[0]
  assert.equal(facts.selected, null); assert.equal(facts.pending, null)
  assert.equal((await f.service.getOperation(pending.id)).phase, 'cancelled')
  assert.ok(launch.activation.supersededUsageIds.includes(old.usageId))
  let callbacks = 0
  await assert.rejects(reclaim(f.service, activation.targets[0], async () => { callbacks++ }), code('transition-invalid'))
  assert.equal(callbacks, 0)
  const next = await switchRoles(f, f, launch)
  await assert.rejects(next.service.completeActivation({ activationId: next.activation.id, expectedRevision: next.activation.revision }), code('version-in-use'))
  assert.equal((await next.service.inspect()).actual.find(item => item.usage.id === old.usageId).usage.state, 'exit-unconfirmed')
  await oldLock.release(); await next.service.confirmExit({ usageId: old.usageId })
  const staged = await next.service.completeActivation({ activationId: next.activation.id, expectedRevision: next.activation.revision })
  assert.equal(staged.phase, 'reclaiming')
  await assert.rejects(next.service.completeRemoval({ activationId: staged.id, expectedRevision: staged.revision }), code('transition-invalid'))
  await reclaim(next.service, staged.targets[0], async () => { callbacks++ })
  await assert.rejects(next.service.completeRemoval({ activationId: staged.id, expectedRevision: staged.revision }), code('transition-invalid'))
  await reclaim(next.service, staged.targets[1], async () => { callbacks++ })
  const done = await next.service.completeRemoval({ activationId: staged.id, expectedRevision: staged.revision })
  assert.equal(done.phase, 'completed'); assert.equal(callbacks, 2)
  assert.ok((await next.service.inspect()).applications[0].installed.every(item => item.state === 'removed'))
})

test('multiple apps and quarantined versions share one removal batch and survive an owner takeover', async t => {
  const f = await fixture(t), calc = identity(), other = identity('other')
  await install(f.service, calc); await install(f.service, other)
  const facts = (await f.service.inspect()).applications.find(item => item.appId === 'other')
  await f.service.quarantineInstallation({ identity: other, expectedAppRevision: facts.revision, errorCode: 'content-changed' })
  const activation = await prepare(f.service, { appIds: ['other', 'calculator'] })
  assert.equal(activation.targets.length, 2)
  await f.root.fiber.dispose()
  const next = await f.reopen(), recovered = await next.service.getActivation(activation.id)
  assert.equal(recovered.kind, 'remove'); assert.equal(recovered.phase, 'recovery-required')
  const restored = await next.service.recoverActivation({ activationId: recovered.id, expectedRevision: recovered.revision, action: 'resume' })
  assert.equal(restored.activation.phase, 'prepared')
  const ready = await reclaiming(f, next, restored.activation)
  for (const target of ready.activation.targets) await reclaim(ready.service, target)
  assert.equal((await ready.service.completeRemoval({ activationId: ready.activation.id, expectedRevision: ready.activation.revision })).phase, 'completed')
})

test('foreign claimed use blocks removal without readiness fabrication or changes to the existing installation', async t => {
  const f = await fixture(t), target = identity()
  await selected(f, target)
  const credential = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'computer-worker', holderId: 'independent', generation: 'independent', entries: [{ package: target, entry: 'computer-worker' }] })
  f.lock(credential); await f.service.claim(credential)
  const before = await f.service.inspect(), operations = await f.service.listOperations()
  assert.deepEqual(before.actual, [])
  await assert.rejects(prepare(f.service, { ownedUsageIds: [] }), code('version-in-use'))
  assert.deepEqual(await f.service.inspect(), before); assert.deepEqual(await f.service.listOperations(), operations)
})

test('busy uncommitted installs, reimports during removal, and references to the removed app in a replacement plan are rejected', async t => {
  const f = await fixture(t), target = identity()
  await selected(f, target)
  const op = await f.service.begin({ requestId: 'in-progress', kind: 'install', identity: identity('calculator', '2.0.0', 'b'.repeat(64)), expectedAppRevision: (await f.service.inspect()).applications[0].revision })
  await assert.rejects(prepare(f.service), code('operation-conflict'))
  await f.service.advance({ operationId: op.id, expectedRevision: op.revision, phase: 'cancelled' })
  await assert.rejects(prepare(f.service, { roles: [{ role: 'client', entries: [{ package: target, entry: 'web' }] }] }), code('snapshot-stale'))
  await assert.rejects(prepare(f.service, { roles: [{ role: 'client', entries: [], capabilities: [{ id: 'external', version: '1.0.0', package: target }] }] }), code('snapshot-stale'))
  await prepare(f.service)
  let job = await f.service.acceptFileInstall({ requestId: 'reimport', filename: 'fixture.anybox-app', archiveDigest: 'c'.repeat(64), archiveSize: 100 })
  job = await f.service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'receiving' })
  job = await f.service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'verifying' })
  await assert.rejects(f.service.bindFileInstall({ installId: job.id, expectedRevision: job.revision, identity: target }), code('operation-conflict'))
})

test('partial reclamation keeps removed versions removed and resumes only through another exact role handoff', async t => {
  const f = await fixture(t), v1 = identity(), v2 = identity('calculator', '2.0.0', 'b'.repeat(64))
  await selected(f, v1); await install(f.service, v2)
  const next = await reclaiming(f, f, await prepare(f.service)), first = next.activation.targets[0], second = next.activation.targets[1]
  await reclaim(next.service, first)
  await assert.rejects(reclaim(next.service, second, async () => { throw Error('partial unlink failed') }), /partial unlink/)
  assert.equal((await next.service.getOperation(second.operationId)).phase, 'recovery-required')
  let activation = await next.service.interruptActivation({ activationId: next.activation.id, expectedRevision: next.activation.revision, errorCode: 'reclamation-failed' })
  assert.equal(activation.recovery.from, 'reclaiming')
  for (let i = 0; i < next.children.length; i++) { await next.children[i].release(); await next.service.confirmExit({ usageId: next.credentials[i].usageId }) }
  const launch = await next.service.recoverActivation({ activationId: activation.id, expectedRevision: activation.revision, action: 'resume', holderId: 'recovery-parent', generation: 'again' })
  assert.equal(launch.activation.phase, 'handoff')
  assert.equal((await next.service.getOperation(first.operationId)).phase, 'completed')
  assert.equal((await next.service.getOperation(second.operationId)).phase, 'prepared')
  const again = await switchRoles(f, next, launch)
  activation = await again.service.completeActivation({ activationId: again.activation.id, expectedRevision: again.activation.revision })
  assert.equal(activation.phase, 'reclaiming')
  let callbacks = 0
  await reclaim(again.service, second, async () => { callbacks++ })
  assert.equal((await again.service.completeRemoval({ activationId: activation.id, expectedRevision: activation.revision })).phase, 'completed')
  assert.equal(callbacks, 1)
})

test('interrupt preflights every removal target before mutating a batch with in-flight reclamation', async t => {
  const f = await fixture(t), v1 = identity(), v2 = identity('calculator', '2.0.0', 'b'.repeat(64))
  await selected(f, v1); await install(f.service, v2)
  const next = await reclaiming(f, f, await prepare(f.service)), first = next.activation.targets[0], second = next.activation.targets[1]
  const entered = deferred(), release = deferred()
  const pending = reclaim(next.service, second, async () => { entered.resolve(); await release.promise })
  await entered.promise
  const beforeBatch = await next.service.getActivation(next.activation.id), beforeFirst = await next.service.getOperation(first.operationId), beforeSecond = await next.service.getOperation(second.operationId)
  try {
    await assert.rejects(next.service.interruptActivation({ activationId: beforeBatch.id, expectedRevision: beforeBatch.revision, errorCode: 'observer-failed' }), code('operation-conflict'))
    assert.deepEqual(await next.service.getActivation(beforeBatch.id), beforeBatch)
    assert.deepEqual(await next.service.getOperation(first.operationId), beforeFirst)
    assert.deepEqual(await next.service.getOperation(second.operationId), beforeSecond)
  } finally { release.resolve() }
  await pending
  await reclaim(next.service, first)
  assert.equal((await next.service.completeRemoval({ activationId: beforeBatch.id, expectedRevision: beforeBatch.revision })).phase, 'completed')
})

test('a removed identity can be installed under a new file request without reusing the old installation operation', async t => {
  const f = await fixture(t), target = identity(), original = await install(f.service, target)
  const next = await reclaiming(f, f, await prepare(f.service))
  await reclaim(next.service, next.activation.targets[0])
  await next.service.completeRemoval({ activationId: next.activation.id, expectedRevision: next.activation.revision })
  let job = await next.service.acceptFileInstall({ requestId: 'fresh-file', filename: 'fresh.anybox-app', archiveDigest: 'd'.repeat(64), archiveSize: 200 })
  for (const phase of ['receiving', 'verifying']) job = await next.service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase })
  job = await next.service.bindFileInstall({ installId: job.id, expectedRevision: job.revision, identity: target })
  assert.equal(job.existingInstallation, false); assert.notEqual(job.operationId, original.id)
  for (const phase of ['prepared', 'committing']) job = await next.service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase })
  const operation = await next.service.getOperation(job.operationId), facts = (await next.service.inspect()).applications[0]
  await next.service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts.revision, source: { ...source, reference: 'fresh.anybox-app' } })
  const reinstalled = (await next.service.inspect()).applications[0]
  assert.equal(reinstalled.installed.length, 1); assert.equal(reinstalled.installed[0].operationId, operation.id); assert.equal(reinstalled.installed[0].state, 'installed')
  assert.equal(reinstalled.selected, null); assert.deepEqual(reinstalled.pending, target)
  assert.equal((await next.service.getOperation(original.id)).phase, 'cancelled')
  assert.equal((await next.service.getActivation(next.activation.id)).phase, 'completed')
})

test('legacy v3 activation records default to activate while the registry migrates their JSON without any side effects', async t => {
  const f = await fixture(t), target = identity()
  await install(f.service, target)
  const activation = await f.service.prepareActivation({ requestId: 'legacy-activate', expectedRegistryRevision: (await f.service.inspect()).revision, roles: [{ role: 'client', entries: [{ package: target, entry: 'web' }] }] })
  await f.root.get(packageRegistryStorageServiceKey).transaction(tx => {
    const old = JSON.parse(tx.get('SELECT activation_json FROM package_registry_activations WHERE id=?', [activation.id]).activation_json)
    delete old.kind; delete old.ownedUsageIds
    tx.execute('UPDATE package_registry_activations SET activation_json=? WHERE id=?', [JSON.stringify(old), activation.id])
    tx.execute("UPDATE schema_migrations SET version=3 WHERE domain='host-package-registry'")
  })
  await f.root.fiber.dispose()
  const next = await f.reopen(), restored = await next.service.getActivation(activation.id)
  assert.equal(restored.kind, 'activate'); assert.deepEqual(restored.ownedUsageIds, []); assert.equal(restored.phase, 'recovery-required')
  assert.equal(await next.root.get(packageRegistryStorageServiceKey).read(reader => reader.get("SELECT version FROM schema_migrations WHERE domain='host-package-registry'").version), packageRegistryMigrations.at(-1).version)
})


test('removal recovery cannot re-arm while an omitted old execution role still owns the removed application', async t => {
  const f = await fixture(t), target = identity()
  await selected(f, target)
  const old = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'execution', holderId: 'old', generation: 'old', entries: [{ package: target, entry: 'execution', desiredEnabled: true }] }), oldLock = f.lock(old)
  await f.service.claim(old); await f.service.ready(old)
  const launch = await commit(f.service, await prepare(f.service, { ownedUsageIds: [old.usageId] }))
  let activation = await f.service.interruptActivation({ activationId: launch.activation.id, expectedRevision: launch.activation.revision, errorCode: 'role-failed' })
  for (const parent of launch.credentials) await f.service.confirmExit({ usageId: parent.usageId })
  await assert.rejects(f.service.recoverActivation({ activationId: activation.id, expectedRevision: activation.revision, action: 'resume', holderId: 'recover', generation: 'recover' }), code('version-in-use'))
  assert.equal((await f.service.listUsages()).length, 3)
  await oldLock.release(); await f.service.confirmExit({ usageId: old.usageId })
  activation = (await f.service.recoverActivation({ activationId: activation.id, expectedRevision: activation.revision, action: 'resume', holderId: 'recover', generation: 'recover' })).activation
  assert.equal(activation.phase, 'handoff')
})

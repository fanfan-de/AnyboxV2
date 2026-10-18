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

const identity = (appId = 'calculator', version = '1.0.0', digest = 'a'.repeat(64)) => ({ appId, version, digest, target: { os: 'darwin', arch: 'arm64' } })
const code = value => error => error?.code === value
const source = { kind: 'file', reference: 'calculator.anybox-app', publisher: 'anybox' }
async function open(directory) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(createPackageRegistryComponent({ directory }))
  return { root, service: root.get(packageRegistryServiceKey) }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-activation-ledger-')), instances = [], locks = []
  const reopen = async () => { const instance = await open(directory); instances.push(instance); return instance }
  const instance = await reopen()
  t.after(async () => { for (const lock of locks) await lock.release(); for (const { root } of instances) await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const lock = credential => { const result = acquirePackageUsageLock(directory, credential); locks.push(result); return result }
  return { directory, reopen, lock, ...instance }
}
async function installed(service, target = identity()) {
  const facts = (await service.inspect()).applications.find(item => item.appId === target.appId)
  let operation = await service.begin({ requestId: `install-${target.appId}-${target.version}`, kind: 'install', identity: target, expectedAppRevision: facts?.revision ?? 0 })
  for (const phase of ['preparing', 'prepared', 'committing']) operation = await service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase })
  return service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts?.revision ?? 0, source })
}
const rolesFor = (target = identity()) => [{ role: 'client', entries: [{ package: target, entry: 'web' }], capabilities: [] }]
async function prepared(service, extra = {}) {
  return service.prepareActivation({ requestId: 'activation-1', expectedRegistryRevision: (await service.inspect()).revision, roles: rolesFor(), ...extra })
}
async function committed(service, activation) {
  return service.commitActivation({ activationId: activation.id, expectedRevision: activation.revision, holderId: 'supervisor', generation: 'generation-1', receipt: { allGuards: 'confirmed' } })
}
async function adopted(f, launch) {
  const parentLocks = launch.credentials.map(f.lock)
  await f.root.fiber.dispose()
  const next = await f.reopen(), current = await next.service.getActivation(launch.activation.id)
  const result = await next.service.adoptActivation({ activationId: current.id, expectedRevision: current.revision, parents: launch.credentials, holderId: 'role', generation: 'generation-2' })
  return { ...next, ...result, parentLocks }
}
async function ready(f, adopted, credential = adopted.credentials[0]) {
  const lock = f.lock(credential)
  await adopted.service.claim(credential); await adopted.service.ready(credential)
  const current = await adopted.service.getActivation(adopted.activation.id)
  const activation = await adopted.service.recordActivationRoleReady({ activationId: current.id, expectedRevision: current.revision, usageId: credential.usageId })
  return { lock, activation }
}
async function releaseParents(adopted, launch) {
  for (let i = 0; i < adopted.parentLocks.length; i++) { await adopted.parentLocks[i].release(); await adopted.service.confirmExit({ usageId: launch.credentials[i].usageId }) }
}

test('activation intent is idempotent, immutable, and cannot select before lifecycle guards commit', async t => {
  const { service } = await fixture(t)
  const operation = await installed(service), before = await service.inspect(), input = { requestId: 'activation-1', expectedRegistryRevision: before.revision, roles: rolesFor() }
  const activation = await service.prepareActivation(input)
  assert.equal(activation.phase, 'prepared'); assert.equal(Object.isFrozen(activation.roles[0].entries[0]), true)
  assert.deepEqual(await service.inspect(), before); assert.equal((await service.getOperation(operation.id)).phase, 'awaiting-activation')
  assert.deepEqual(await service.prepareActivation(input), activation)
  await assert.rejects(service.prepareActivation({ ...input, roles: [{ ...rolesFor()[0], capabilities: [{ id: 'sql', version: '1.0.0', package: null }] }] }), code('request-conflict'))
  await assert.rejects(service.prepareActivation({ ...input, requestId: 'second' }), code('operation-conflict'))
  await assert.rejects(service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: before.applications[0].revision }), code('operation-conflict'))
  await assert.rejects(service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' }), code('operation-conflict'))
  assert.equal((await service.listActivations()).length, 1)
})

test('new backend entries must remain disabled, while client roles may carry a pure web entry', async t => {
  const { service } = await fixture(t)
  await installed(service)
  for (const desiredEnabled of [true, undefined]) await assert.rejects(prepared(service, { roles: [{ role: 'client', entries: [{ package: identity(), entry: 'client', ...(desiredEnabled === undefined ? {} : { desiredEnabled }) }] }] }), code('invalid-input'))
  const activation = await prepared(service, { roles: [{ role: 'client', entries: [{ package: identity(), entry: 'client', desiredEnabled: false }] }] })
  assert.equal(activation.roles[0].entries[0].desiredEnabled, false)
  await assert.rejects(service.prepareActivation({ requestId: 'wrong-role', expectedRegistryRevision: (await service.inspect()).revision, roles: [{ role: 'execution', entries: [{ package: identity(), entry: 'web' }] }] }), code('invalid-input'))
})

test('commit atomically selects but retains pending and returns only private durable handoff reservations', async t => {
  const { service } = await fixture(t)
  const operation = await installed(service), activation = await prepared(service), launch = await committed(service, activation)
  const view = await service.inspect()
  assert.equal(launch.activation.phase, 'handoff'); assert.deepEqual(view.applications[0].selected, identity()); assert.deepEqual(view.applications[0].pending, identity()); assert.deepEqual(view.actual, [])
  assert.equal((await service.getOperation(operation.id)).phase, 'activating')
  assert.equal(launch.activation.roles[0].handoffUsageId, launch.credentials[0].usageId)
  assert.equal((await service.listUsages())[0].state, 'reserved')
  assert.equal(JSON.stringify(await service.listActivations()).includes(launch.credentials[0].secret), false)
})

test('writer takeover issues current-owner role snapshots without authorizing stale handoff snapshots', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), next = await adopted(f, launch)
  assert.equal(next.activation.phase, 'loading'); assert.equal(next.credentials[0].snapshot.ownerEpoch, launch.credentials[0].snapshot.ownerEpoch + 1)
  assert.notEqual(next.credentials[0].usageId, launch.credentials[0].usageId)
  await assert.rejects(next.service.claim(launch.credentials[0]), code('snapshot-stale'))
  await ready(f, next)
  const view = await next.service.inspect()
  assert.equal(view.actual.length, 1); assert.equal(view.actual[0].usage.id, next.credentials[0].usageId)
})

test('adoption requires every authenticated parent anchor to remain really held', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service))
  await f.root.fiber.dispose()
  const next = await f.reopen(), current = await next.service.getActivation(launch.activation.id)
  const input = { activationId: current.id, expectedRevision: current.revision, parents: launch.credentials, holderId: 'role', generation: 'generation-2' }
  await assert.rejects(next.service.adoptActivation(input), code('use-lock-required'))
  const lock = f.lock(launch.credentials[0])
  await assert.rejects(next.service.adoptActivation({ ...input, parents: [{ ...launch.credentials[0], secret: 'wrong' }] }), code('use-unavailable'))
  await lock.release()
  assert.equal((await next.service.getActivation(current.id)).phase, 'recovery-required')
})

test('all required role receipts and real parent exit are necessary for completion', async t => {
  const f = await fixture(t), target = identity()
  const operation = await installed(f.service)
  const plans = [...rolesFor(target), { role: 'execution', entries: [{ package: target, entry: 'execution', desiredEnabled: false }], capabilities: [{ id: 'storage.sqlite', version: '1.0.0', package: null }] }]
  const launch = await committed(f.service, await prepared(f.service, { roles: plans })), next = await adopted(f, launch)
  await ready(f, next, next.credentials[0])
  let current = await next.service.getActivation(next.activation.id)
  await assert.rejects(next.service.completeActivation({ activationId: current.id, expectedRevision: current.revision }), code('transition-invalid'))
  await ready(f, next, next.credentials[1]); current = await next.service.getActivation(current.id)
  await assert.rejects(next.service.completeActivation({ activationId: current.id, expectedRevision: current.revision }), code('version-in-use'))
  await releaseParents(next, launch)
  const completed = await next.service.completeActivation({ activationId: current.id, expectedRevision: current.revision })
  assert.equal(completed.phase, 'completed'); assert.equal((await next.service.inspect()).applications[0].pending, null)
  assert.equal((await next.service.getOperation(operation.id)).phase, 'completed')
})

test('an old actual role remains visible and pinned until its actual exit is confirmed', async t => {
  const f = await fixture(t), v1 = identity()
  let operation = await installed(f.service)
  operation = await f.service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: (await f.service.inspect()).applications[0].revision })
  const old = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'client', holderId: 'old-client', generation: 'old', entries: rolesFor(v1)[0].entries })
  const oldLock = f.lock(old)
  await f.service.claim(old); await f.service.ready(old)
  await f.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' })
  const v2 = identity('calculator', '2.0.0', 'b'.repeat(64)); await installed(f.service, v2)
  const launch = await committed(f.service, await prepared(f.service, { roles: rolesFor(v2) })), next = await adopted(f, launch)
  assert.ok(next.activation.supersededUsageIds.includes(old.usageId))
  assert.equal((await next.service.inspect()).actual.find(item => item.usage.id === old.usageId).usage.state, 'exit-unconfirmed')
  await ready(f, next); await releaseParents(next, launch)
  let current = await next.service.getActivation(next.activation.id)
  await assert.rejects(next.service.completeActivation({ activationId: current.id, expectedRevision: current.revision }), code('version-in-use'))
  await oldLock.release(); await next.service.confirmExit({ usageId: old.usageId })
  current = await next.service.completeActivation({ activationId: current.id, expectedRevision: current.revision })
  assert.equal(current.phase, 'completed'); assert.deepEqual((await next.service.inspect()).actual.map(item => item.snapshot.entries[0].package), [v2])
})

test('ready receipts cannot be forged from reservations or another matching but unowned usage', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), next = await adopted(f, launch)
  const input = { activationId: next.activation.id, expectedRevision: next.activation.revision, usageId: next.credentials[0].usageId }
  await assert.rejects(next.service.recordActivationRoleReady(input), code('use-unavailable'))
  const unrelated = await next.service.prepareUse({ expectedRegistryRevision: (await next.service.inspect()).revision, role: 'client', holderId: 'other-client', generation: 'other', entries: rolesFor()[0].entries })
  f.lock(unrelated); await next.service.claim(unrelated); await next.service.ready(unrelated)
  await assert.rejects(next.service.recordActivationRoleReady({ ...input, usageId: unrelated.usageId }), code('use-unavailable'))
})

test('a separate application revision cannot invalidate an already ready exact activation receipt', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), next = await adopted(f, launch)
  const lock = f.lock(next.credentials[0]); await next.service.claim(next.credentials[0]); await next.service.ready(next.credentials[0])
  await installed(next.service, identity('other'))
  const current = await next.service.getActivation(next.activation.id)
  const recorded = await next.service.recordActivationRoleReady({ activationId: current.id, expectedRevision: current.revision, usageId: next.credentials[0].usageId })
  assert.equal(recorded.roles[0].readyUsageId, next.credentials[0].usageId)
  await releaseParents(next, launch)
  assert.equal((await next.service.completeActivation({ activationId: recorded.id, expectedRevision: recorded.revision })).phase, 'completed')
  await lock.release()
})

test('interrupted activation preserves selected, pending and actual facts and never starts a second role', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), next = await adopted(f, launch)
  const actual = await ready(f, next), before = await next.service.inspect()
  let current = await next.service.getActivation(next.activation.id)
  current = await next.service.interruptActivation({ activationId: current.id, expectedRevision: current.revision, errorCode: 'role-start-failed' })
  assert.equal(current.phase, 'recovery-required'); assert.deepEqual(await next.service.inspect(), before)
  await assert.rejects(next.service.recoverActivation({ activationId: current.id, expectedRevision: current.revision, action: 'resume', holderId: 'new-role', generation: 'generation-3' }), code('version-in-use'))
  await assert.rejects(next.service.recoverActivation({ activationId: current.id, expectedRevision: current.revision, action: 'cancel' }), code('transition-invalid'))
  await actual.lock.release(); await next.service.confirmExit({ usageId: next.credentials[0].usageId }); await releaseParents(next, launch)
  const resumed = await next.service.recoverActivation({ activationId: current.id, expectedRevision: current.revision, action: 'resume', holderId: 'new-role', generation: 'generation-3' })
  assert.equal(resumed.activation.phase, 'handoff'); assert.equal(resumed.activation.roles[0].handoffUsageId, resumed.credentials[0].usageId); assert.notEqual(resumed.credentials[0].usageId, next.credentials[0].usageId)
  assert.deepEqual(resumed.activation.roles[0].usageIds, [...current.roles[0].usageIds, resumed.credentials[0].usageId])
  const recoveryParent = f.lock(resumed.credentials[0])
  await next.root.fiber.dispose()
  const replacement = await f.reopen(), pending = await replacement.service.getActivation(resumed.activation.id)
  const adoptedRecovery = await replacement.service.adoptActivation({ activationId: pending.id, expectedRevision: pending.revision, parents: resumed.credentials, holderId: 'recovery-role', generation: 'generation-4' })
  f.lock(adoptedRecovery.credentials[0]); await replacement.service.claim(adoptedRecovery.credentials[0]); await replacement.service.ready(adoptedRecovery.credentials[0])
  let latest = await replacement.service.recordActivationRoleReady({ activationId: pending.id, expectedRevision: adoptedRecovery.activation.revision, usageId: adoptedRecovery.credentials[0].usageId })
  await recoveryParent.release(); await replacement.service.confirmExit({ usageId: resumed.credentials[0].usageId })
  latest = await replacement.service.completeActivation({ activationId: latest.id, expectedRevision: latest.revision })
  assert.equal(latest.phase, 'completed')
})

test('prepared cancellation leaves the pending installation and existing operation intact', async t => {
  const { service } = await fixture(t)
  const operation = await installed(service), current = await prepared(service), before = await service.inspect()
  const cancelled = await service.recoverActivation({ activationId: current.id, expectedRevision: current.revision, action: 'cancel' })
  assert.equal(cancelled.activation.phase, 'cancelled'); assert.deepEqual(cancelled.credentials, []); assert.deepEqual(await service.inspect(), before)
  assert.equal((await service.getOperation(operation.id)).phase, 'awaiting-activation')
  assert.equal((await prepared(service, { requestId: 'next-activation' })).phase, 'prepared')
})

test('a precommit takeover requires explicit recovery and guard commit again', async t => {
  const f = await fixture(t)
  await installed(f.service); const activation = await prepared(f.service)
  await f.root.fiber.dispose()
  const next = await f.reopen(), current = await next.service.getActivation(activation.id)
  assert.equal(current.phase, 'recovery-required'); assert.equal(current.recovery.from, 'prepared')
  await assert.rejects(committed(next.service, current), code('transition-invalid'))
  const recovered = await next.service.recoverActivation({ activationId: current.id, expectedRevision: current.revision, action: 'resume' })
  assert.equal(recovered.activation.phase, 'prepared'); assert.deepEqual(recovered.credentials, [])
  assert.equal((await next.service.inspect()).applications[0].selected, null)
})

test('quarantine preserves invalid selected/pending and old actual facts while denying new code use', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), next = await adopted(f, launch)
  await ready(f, next)
  const before = await next.service.inspect(), facts = before.applications[0]
  const quarantined = await next.service.quarantineInstallation({ identity: identity(), expectedAppRevision: facts.revision, errorCode: 'archive-digest-mismatch' })
  assert.equal(quarantined.installed[0].state, 'quarantined'); assert.deepEqual(quarantined.selected, identity()); assert.deepEqual(quarantined.pending, identity())
  assert.deepEqual((await next.service.inspect()).actual, before.actual)
  assert.equal((await next.service.getActivation(next.activation.id)).phase, 'recovery-required')
  await assert.rejects(next.service.prepareUse({ expectedRegistryRevision: (await next.service.inspect()).revision, role: 'client', holderId: 'bad', generation: 'bad', entries: rolesFor()[0].entries }), code('snapshot-stale'))
})

test('corrupt activation references fail closed', async t => {
  const f = await fixture(t)
  await installed(f.service); const activation = await prepared(f.service)
  const storage = f.root.get(packageRegistryStorageServiceKey)
  assert.equal(await storage.read(reader => reader.get("SELECT version FROM schema_migrations WHERE domain='host-package-registry'").version), packageRegistryMigrations.at(-1).version)
  await storage.transaction(tx => {
    const record = JSON.parse(tx.get('SELECT activation_json FROM package_registry_activations WHERE id=?', [activation.id]).activation_json)
    record.targets[0].operationId = 'unknown-operation'
    tx.execute('UPDATE package_registry_activations SET activation_json=? WHERE id=?', [JSON.stringify(record), activation.id])
  })
  await assert.rejects(f.service.listActivations(), code('registry-corrupt'))
})


test('v2 owner and pending installation migrate in place without replaying installation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-activation-v2-')), legacy = new Context()
  await legacy.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  const storage = legacy.get(packageRegistryStorageServiceKey), at = '2026-10-17T00:00:00.000Z', target = identity()
  await storage.migrate('host-package-registry', packageRegistryMigrations.slice(0, 2))
  await storage.transaction(tx => {
    tx.execute('UPDATE package_registry_meta SET revision=4,owner_epoch=7 WHERE id=1')
    const operation = { id: 'existing-install', requestId: 'existing-request', appId: target.appId, identity: target, kind: 'install', revision: 3, phase: 'awaiting-activation', receipt: { committed: true }, recovery: null, createdAt: at, updatedAt: at }
    const facts = { appId: target.appId, revision: 2, selected: null, pending: target, installed: [{ identity: target, source, installedAt: at, operationId: operation.id, state: 'installed' }] }
    tx.execute('INSERT INTO package_registry_operations VALUES(?,?,?)', [operation.id, operation.requestId, JSON.stringify(operation)])
    tx.execute('INSERT INTO package_registry_applications VALUES(?,?)', [facts.appId, JSON.stringify(facts)])
  })
  await legacy.fiber.dispose()
  const next = await open(directory)
  t.after(async () => { await next.root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const view = await next.service.inspect()
  assert.equal(view.ownerEpoch, 8); assert.equal(view.revision, 4); assert.deepEqual(view.applications[0].pending, target)
  assert.deepEqual(await next.service.listActivations(), [])
  assert.equal((await next.service.getOperation('existing-install')).recovery.from, 'awaiting-activation')
  const activation = await prepared(next.service)
  assert.equal(activation.targets[0].operationId, 'existing-install')
  assert.equal((await committed(next.service, activation)).activation.phase, 'handoff')
})

test('a changed registry prevents guard commit and preserves selection and pending', async t => {
  const { service } = await fixture(t)
  await installed(service)
  const activation = await prepared(service), before = await service.inspect()
  await installed(service, identity('other'))
  await assert.rejects(committed(service, activation), code('revision-conflict'))
  const after = await service.inspect(), facts = after.applications.find(item => item.appId === 'calculator')
  assert.deepEqual(facts, before.applications[0]); assert.equal((await service.listUsages()).length, 0)
})

test('activation command accessors and malformed app arrays are rejected before durable intent', async t => {
  const { service } = await fixture(t)
  await installed(service)
  let evaluated = false
  // A caller-owned accessor can be rejected without evaluating it at the command boundary.
  evaluated = false
  const input = { requestId: 'unsafe', expectedRegistryRevision: (await service.inspect()).revision, roles: rolesFor(), get appIds() { evaluated = true; return ['calculator'] } }
  await assert.rejects(service.prepareActivation(input), code('invalid-input')); assert.equal(evaluated, false)
  await assert.rejects(prepared(service, { appIds: 'calculator' }), code('invalid-input'))
  assert.deepEqual(await service.listActivations(), [])
})


test('a held original handoff survives a failed new writer without authorizing overlapping attempts', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service)), first = await adopted(f, launch)
  const failedLock = f.lock(first.credentials[0]); await first.service.claim(first.credentials[0])
  await first.root.fiber.dispose()
  const second = await f.reopen(), current = await second.service.getActivation(first.activation.id)
  const input = { activationId: current.id, expectedRevision: current.revision, parents: launch.credentials, holderId: 'replacement', generation: 'generation-3' }
  await assert.rejects(second.service.adoptActivation(input), code('version-in-use'))
  await assert.rejects(second.service.confirmExit({ usageId: first.credentials[0].usageId }), code('version-in-use'))
  await failedLock.release(); await second.service.confirmExit({ usageId: first.credentials[0].usageId })
  const replacement = await second.service.adoptActivation(input)
  assert.equal(replacement.activation.phase, 'loading')
  assert.equal(replacement.credentials[0].snapshot.ownerEpoch, launch.credentials[0].snapshot.ownerEpoch + 2)
  await assert.rejects(second.service.claim(launch.credentials[0]), code('snapshot-stale'))
  assert.deepEqual(replacement.activation.roles[0].usageIds, [...first.activation.roles[0].usageIds, replacement.credentials[0].usageId])
})


test('private role validation authenticates its held current-owner usage without promoting readiness or depending on unrelated app revisions', async t => {
  const f = await fixture(t)
  await installed(f.service)
  const launch = await committed(f.service, await prepared(f.service))
  const next = await adopted(f, launch), credential = next.credentials[0]
  await assert.rejects(next.service.validateUse(credential), code('use-lock-required'))
  const lock = f.lock(credential)
  await assert.rejects(next.service.validateUse(credential), code('use-unavailable'))
  await next.service.claim(credential)
  await assert.rejects(next.service.validateUse({ ...credential, secret: 'wrong-secret' }), code('use-unavailable'))
  assert.deepEqual(await next.service.validateUse(credential), credential.snapshot)
  assert.equal((await next.service.listUsages()).find(item => item.id === credential.usageId).state, 'claimed')
  assert.deepEqual((await next.service.inspect()).actual, [])
  await next.service.ready(credential)
  await installed(next.service, identity('other'))
  assert.deepEqual(await next.service.validateUse(credential), credential.snapshot)
  assert.equal((await next.service.listUsages()).find(item => item.id === credential.usageId).state, 'ready')
  await next.root.fiber.dispose()
  const replacement = await f.reopen()
  await assert.rejects(replacement.service.validateUse(credential), code('use-unavailable'))
  await lock.release()
})


test('unmanaged claimed reservations block activation without being misreported as actual ready roles', async t => {
  const f = await fixture(t), v1 = identity()
  let operation = await installed(f.service)
  operation = await f.service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: (await f.service.inspect()).applications[0].revision })
  const initial = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'client', holderId: 'initial', generation: 'initial', entries: rolesFor()[0].entries }), initialLock = f.lock(initial)
  await f.service.claim(initial); await f.service.ready(initial)
  await f.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' })
  await initialLock.release(); await f.service.confirmExit({ usageId: initial.usageId })
  const foreign = await f.service.prepareUse({ expectedRegistryRevision: (await f.service.inspect()).revision, role: 'computer-worker', holderId: 'independent', generation: 'foreign', entries: [{ package: v1, entry: 'computer-worker', desiredEnabled: true }] }), foreignLock = f.lock(foreign)
  await f.service.claim(foreign)
  const v2 = identity('calculator', '2.0.0', 'b'.repeat(64)); await installed(f.service, v2)
  assert.deepEqual((await f.service.inspect()).actual, [])
  await assert.rejects(prepared(f.service, { roles: rolesFor(v2), ownedUsageIds: [] }), code('version-in-use'))
  assert.deepEqual(await f.service.listActivations(), [])
  await foreignLock.release(); await f.service.confirmExit({ usageId: foreign.usageId })
  assert.equal((await prepared(f.service, { roles: rolesFor(v2), ownedUsageIds: [] })).phase, 'prepared')
})

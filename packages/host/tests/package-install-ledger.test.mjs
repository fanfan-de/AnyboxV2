import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'
import { packageRegistryMigrations } from '../dist/package-management/migrations.js'

const code = expected => error => error?.code === expected
const intent = (requestId = 'upload-1', extra = {}) => ({ requestId, filename: 'calculator.anybox-app', archiveDigest: 'a'.repeat(64), archiveSize: 1234, ...extra })
const identity = (appId = 'calculator', version = '1.0.0', digest = 'b'.repeat(64)) => ({ appId, version, digest, target: { os: 'darwin', arch: 'arm64' } })
const source = { kind: 'file', reference: 'calculator.anybox-app', publisher: 'anybox' }
async function open(directory, configure) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  if (configure) await configure(root.get(packageRegistryStorageServiceKey))
  await root.installComponent(createPackageRegistryComponent({ directory }))
  return { root, service: root.get(packageRegistryServiceKey) }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-file-install-ledger-')), instances = []
  const reopen = async configure => { const instance = await open(directory, configure); instances.push(instance); return instance }
  const instance = await reopen()
  t.after(async () => { for (const { root } of instances) await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, reopen, ...instance }
}
const advance = (service, job, phase, receipt) => service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase, ...(receipt === undefined ? {} : { receipt }) })
async function verifying(service, request = intent()) {
  let job = await service.acceptFileInstall(request)
  job = await advance(service, job, 'receiving')
  return advance(service, job, 'verifying', { archiveComplete: true, archiveDigest: request.archiveDigest, archiveSize: request.archiveSize })
}
async function prepared(service, request = intent(), selected = identity()) {
  let job = await verifying(service, request)
  job = await service.bindFileInstall({ installId: job.id, expectedRevision: job.revision, identity: selected })
  return advance(service, job, 'prepared', { archiveComplete: true, registrationPrepared: true })
}
async function installed(service, request = intent(), selected = identity()) {
  let job = await prepared(service, request, selected)
  job = await advance(service, job, 'committing', { directoryCommit: 'intent' })
  const operation = await service.getOperation(job.operationId)
  const appRevision = (await service.inspect()).applications.find(item => item.appId === selected.appId)?.revision ?? 0
  await service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: appRevision, source })
  return service.getFileInstall(job.id)
}

test('acceptance is durable before bytes and replay compares exact untrusted intent before CAS', async t => {
  const { service, root, reopen } = await fixture(t)
  const input = intent('stable', { expectedAppRevision: 0 }), accepted = await service.acceptFileInstall(input)
  assert.equal(accepted.phase, 'accepted'); assert.equal(accepted.identity, null); assert.equal(accepted.operationId, null)
  assert.equal((await service.inspect()).applications.length, 0); assert.equal((await service.listOperations()).length, 0)
  assert.deepEqual(await service.acceptFileInstall({ ...input }), accepted)
  for (const change of [{ filename: 'renamed.anybox-app' }, { archiveDigest: 'c'.repeat(64) }, { archiveSize: 1235 }, { expectedAppRevision: 1 }]) {
    await assert.rejects(service.acceptFileInstall({ ...input, ...change }), code('request-conflict'))
  }
  await root.fiber.dispose()
  const reopened = await reopen(), recovered = await reopened.service.acceptFileInstall(input)
  assert.equal(recovered.id, accepted.id); assert.equal(recovered.phase, 'recovery-required'); assert.equal(recovered.recovery.from, 'accepted')
  assert.equal((await reopened.service.listOperations()).length, 0)
})

test('untrusted file metadata and command accessors are rejected without allocating an intent', async t => {
  const { service } = await fixture(t)
  for (const invalid of [{ filename: '../calc.anybox-app' }, { filename: 'a\\b' }, { archiveSize: 0 }, { archiveSize: NaN }, { archiveDigest: 'A'.repeat(64) }, { expectedAppRevision: -1 }]) {
    await assert.rejects(service.acceptFileInstall(intent('bad', invalid)), code('invalid-input'))
  }
  let read = false
  await assert.rejects(service.acceptFileInstall({ ...intent(), get filename() { read = true; return 'x' } }), code('invalid-input'))
  assert.equal(read, false); assert.deepEqual(await service.listFileInstalls(), [])
})

test('resource guard history commits before work and survives receipt replacement and takeover', async t => {
  const { service, root, reopen } = await fixture(t)
  let job = await service.acceptFileInstall(intent())
  job = await service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: job.phase, workGuardId: 'receiving-guard', receipt: { beforeRead: true } })
  assert.equal(job.phase, 'accepted'); assert.deepEqual(job.workGuardIds, ['receiving-guard'])
  job = await advance(service, job, 'receiving', { readStarted: true })
  job = await service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: job.phase, workGuardId: 'preparation-guard' })
  assert.deepEqual(job.workGuardIds, ['receiving-guard', 'preparation-guard'])
  await root.fiber.dispose()
  const reopened = await reopen()
  job = await reopened.service.getFileInstall(job.id)
  assert.equal(job.recovery.from, 'receiving')
  job = await reopened.service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: job.phase, receipt: { blocked: true } })
  assert.equal(job.recovery.from, 'receiving'); assert.deepEqual(job.workGuardIds, ['receiving-guard', 'preparation-guard'])
  job = await reopened.service.reconcileFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'cancelled', receipt: { allGuardsRevoked: true } })
  assert.deepEqual(job.workGuardIds, ['receiving-guard', 'preparation-guard'])
})

test('binding follows static verification and serializes an app before preparation, other apps proceed', async t => {
  const { service } = await fixture(t)
  let first = await verifying(service), second = await verifying(service, intent('upload-2')), other = await verifying(service, intent('upload-3'))
  first = await service.bindFileInstall({ installId: first.id, expectedRevision: first.revision, identity: identity() })
  assert.equal(first.phase, 'verifying'); assert.equal((await service.getOperation(first.operationId)).phase, 'preparing')
  await assert.rejects(service.bindFileInstall({ installId: second.id, expectedRevision: second.revision, identity: identity('calculator', '2.0.0') }), code('operation-conflict'))
  other = await service.bindFileInstall({ installId: other.id, expectedRevision: other.revision, identity: identity('other') })
  assert.notEqual(other.operationId, first.operationId)
  await assert.rejects(advance(service, second, 'prepared'), code('transition-invalid'))
  first = await advance(service, first, 'prepared')
  assert.equal((await service.getOperation(first.operationId)).phase, 'prepared')
  await assert.rejects(advance(service, { ...first, revision: first.revision - 1 }, 'committing'), code('revision-conflict'))
})

test('installed facts, paired operation and file job commit atomically without selection or app startup', async t => {
  const { service } = await fixture(t)
  const job = await installed(service), operation = await service.getOperation(job.operationId), view = await service.inspect()
  assert.equal(job.phase, 'installed'); assert.equal(operation.phase, 'awaiting-activation')
  assert.equal(view.applications[0].installed.length, 1); assert.deepEqual(view.applications[0].pending, identity())
  assert.equal(view.applications[0].selected, null); assert.deepEqual(view.actual, [])
  assert.equal(job.receipt.directoryCommit, 'intent')
})

test('committing cannot be cancelled, faked installed or failed without an explicit recovery observation', async t => {
  const { service } = await fixture(t)
  let job = await prepared(service)
  await assert.rejects(advance(service, job, 'installed'), code('transition-invalid'))
  job = await advance(service, job, 'committing')
  for (const phase of ['installed', 'cancelled', 'failed']) await assert.rejects(advance(service, job, phase), code('transition-invalid'))
  job = await advance(service, job, 'recovery-required', { directoryCommit: 'unknown' })
  assert.equal((await service.getOperation(job.operationId)).phase, 'recovery-required')
  await assert.rejects(service.reconcileFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'installed', receipt: { guessed: true } }), code('transition-invalid'))
  assert.equal((await service.inspect()).applications.length, 0)
})

test('precommit cancellation atomically releases only its own paired operation and keeps safe error codes', async t => {
  const { service } = await fixture(t)
  let job = await prepared(service)
  await assert.rejects(service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'failed', errorCode: '/private/path: Error' }), code('invalid-input'))
  job = await service.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'cancelled', receipt: { cleanup: 'confirmed' }, errorCode: 'operation-cancelled' })
  assert.equal((await service.getOperation(job.operationId)).phase, 'cancelled'); assert.equal(job.errorCode, 'operation-cancelled')
  const next = await prepared(service, intent('new-attempt'), identity('calculator', '2.0.0'))
  assert.equal(next.phase, 'prepared'); assert.equal((await service.inspect()).applications.length, 0)
})

test('takeover leaves received work pending explicit recovery and retains bound identity and receipts', async t => {
  const { service, root, reopen } = await fixture(t)
  const received = await verifying(service, intent('unbound')), preparedJob = await prepared(service, intent('bound'))
  await root.fiber.dispose()
  const reopened = await reopen(), recovered = await reopened.service.getFileInstall(preparedJob.id)
  assert.equal(recovered.phase, 'recovery-required'); assert.equal(recovered.recovery.from, 'prepared')
  assert.deepEqual(recovered.identity, identity()); assert.equal(recovered.receipt.registrationPrepared, true)
  assert.equal((await reopened.service.getOperation(recovered.operationId)).phase, 'recovery-required')
  await assert.rejects(advance(reopened.service, recovered, 'committing'), code('transition-invalid'))
  const ready = await reopened.service.reconcileFileInstall({ installId: recovered.id, expectedRevision: recovered.revision, phase: 'prepared', receipt: { directoryInspected: true } })
  assert.equal(ready.phase, 'prepared'); assert.equal((await reopened.service.getOperation(ready.operationId)).phase, 'prepared')
  const unbound = await reopened.service.getFileInstall(received.id)
  await assert.rejects(reopened.service.reconcileFileInstall({ installId: unbound.id, expectedRevision: unbound.revision, phase: 'prepared', receipt: {} }), code('transition-invalid'))
  const verification = await reopened.service.reconcileFileInstall({ installId: unbound.id, expectedRevision: unbound.revision, phase: 'verifying', receipt: { archiveComplete: true } })
  assert.equal(verification.identity, null); assert.equal(verification.operationId, null)
})

test('installed file job remains terminal on boot while activation operation becomes recoverable', async t => {
  const { service, root, reopen } = await fixture(t)
  const job = await installed(service)
  await root.fiber.dispose()
  const reopened = await reopen(), after = await reopened.service.getFileInstall(job.id)
  assert.deepEqual(after, job)
  assert.equal((await reopened.service.getOperation(job.operationId)).phase, 'recovery-required')
  assert.equal((await reopened.service.inspect()).applications[0].installed.length, 1)
})

test('same identity reimport retains original installation and pending pointer after independent verification', async t => {
  const { service } = await fixture(t)
  const first = await installed(service), before = await service.inspect()
  let repeated = await prepared(service, intent('reimport', { filename: 'renamed.anybox-app' }))
  assert.equal(repeated.existingInstallation, true); assert.equal(repeated.operationId, first.operationId)
  assert.equal((await service.getOperation(first.operationId)).phase, 'awaiting-activation')
  repeated = await advance(service, repeated, 'installed', { existingDirectoryVerified: true })
  assert.equal(repeated.phase, 'installed'); assert.deepEqual(await service.inspect(), before)
  assert.deepEqual((await service.inspect()).applications[0].installed[0].source, source)
  let changed = await verifying(service, intent('different-digest'))
  await assert.rejects(service.bindFileInstall({ installId: changed.id, expectedRevision: changed.revision, identity: identity('calculator', '1.0.0', 'c'.repeat(64)) }), code('identity-conflict'))
})

test('expected application revision is checked only once the verified identity is available', async t => {
  const { service } = await fixture(t)
  const accepted = await verifying(service, intent('stale-app-revision', { expectedAppRevision: 12 }))
  assert.equal(accepted.identity, null)
  await assert.rejects(service.bindFileInstall({ installId: accepted.id, expectedRevision: accepted.revision, identity: identity() }), code('revision-conflict'))
  assert.equal((await service.listOperations()).length, 0)
})

test('v1 registry migrates in place with its owner epoch and previously accepted operation intact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-file-install-v1-'))
  const legacy = new Context()
  await legacy.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await legacy.get(packageRegistryStorageServiceKey).migrate('host-package-registry', packageRegistryMigrations.slice(0, 1))
  await legacy.get(packageRegistryStorageServiceKey).transaction(tx => {
    tx.execute('UPDATE package_registry_meta SET owner_epoch=7 WHERE id=1')
    const operation = { id: 'legacy-operation', requestId: 'legacy-request', appId: 'legacy', kind: 'install', identity: identity('legacy'), revision: 3, phase: 'accepted', receipt: { original: true }, recovery: null, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' }
    tx.execute('INSERT INTO package_registry_operations VALUES(?,?,?)', [operation.id, operation.requestId, JSON.stringify(operation)])
  })
  await legacy.fiber.dispose()
  const instance = await open(directory)
  t.after(async () => { await instance.root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await instance.service.inspect()).ownerEpoch, 8)
  const preserved = await instance.service.findOperation('legacy-request')
  assert.equal(preserved.revision, 4); assert.equal(preserved.recovery.from, 'accepted'); assert.equal(preserved.receipt.original, true)
  assert.equal((await instance.service.acceptFileInstall(intent())).phase, 'accepted')
  const schemaVersion = await instance.root.get(packageRegistryStorageServiceKey).read(reader => reader.get("SELECT version FROM schema_migrations WHERE domain='host-package-registry'").version)
  assert.equal(schemaVersion, packageRegistryMigrations.at(-1).version)
})

test('corrupt file job references cannot redirect a trusted package identity', async t => {
  const { service, root } = await fixture(t)
  const job = await prepared(service)
  await root.get(packageRegistryStorageServiceKey).transaction(tx => {
    const record = JSON.parse(tx.get('SELECT install_json FROM package_registry_file_installs WHERE id=?', [job.id]).install_json)
    record.identity.digest = 'd'.repeat(64)
    tx.execute('UPDATE package_registry_file_installs SET install_json=? WHERE id=?', [JSON.stringify(record), job.id])
  })
  await assert.rejects(service.listFileInstalls(), code('registry-corrupt'))
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createUnitAttachmentsComponent } from '../dist/applications/harness/core/unit/component.js'
import { unitAttachmentsServiceKey } from '../dist/applications/harness/core/unit/port.js'
import { approveAttachment, attachCodeExpiry, fullScope, localAttachment, localComputerUnitId, localModelsUnitId, revokeAttachment,
  scopeWithin, validateRunUnitBindings, validateUnitScope } from '../dist/applications/harness/core/unit/domain.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { installComputerServices, installComputerWorkerStub } from './helpers/computer-services.mjs'
import { nativeRegistration } from './helpers/native-records.mjs'
import { ids, modelSnapshot } from './helpers/controlled-models.mjs'

const localUnits = [{ unitKind: 'models', unitId: localModelsUnitId }, { unitKind: 'computer', unitId: localComputerUnitId }]

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-unit-attachments-'))
  const roots = new Set()
  let clock = Date.parse('2026-10-14T00:00:00.000Z'), next = 0
  t.after(async () => {
    try { for (const root of roots) await root.fiber.dispose() }
    finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  const inputs = { now: () => new Date(clock).toISOString(), newId: () => `id-${++next}` }
  return { inputs, advance(ms) { clock += ms }, async open(options = { localUnits }) {
    const root = new Context()
    roots.add(root)
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createUnitAttachmentsComponent(inputs, options))
    return { root, db: root.get('local-storage'), units: root.get(unitAttachmentsServiceKey), async close() {
      try { await root.fiber.dispose() } finally { roots.delete(root) }
    } }
  } }
}

test('scope rules and attachment transitions are pure', () => {
  const all = fullScope('computer')
  assert.equal(scopeWithin({ kind: 'computer', projects: ['/work'], tools: ['anybox.bash'] }, all), true)
  assert.equal(scopeWithin(all, { kind: 'computer', projects: ['/work'], tools: 'all' }), false)
  assert.equal(scopeWithin({ kind: 'models', access: 'manage', configurations: 'all' }, { kind: 'models', access: 'execute', configurations: 'all' }), false)
  assert.equal(scopeWithin({ kind: 'models', access: 'execute', configurations: ['default'] }, { kind: 'models', access: 'execute', configurations: ['default', 'other'] }), true)
  assert.equal(scopeWithin({ kind: 'models', access: 'execute', configurations: 'all' }, all), false)
  assert.throws(() => validateUnitScope({ kind: 'computer', projects: 'all' }), { code: 'unit-invalid' })
  assert.throws(() => validateUnitScope({ kind: 'models', access: 'owner', configurations: 'all' }), { code: 'unit-invalid' })
  assert.throws(() => validateUnitScope({ kind: 'computer', projects: ['/a', '/a'], tools: 'all' }), { code: 'unit-invalid' })
  assert.equal(attachCodeExpiry('2026-10-14T00:00:00.000Z', undefined), '2026-10-14T00:10:00.000Z')
  assert.throws(() => attachCodeExpiry('2026-10-14T00:00:00.000Z', 1000), { code: 'unit-invalid' })
  assert.throws(() => attachCodeExpiry('now', undefined), { code: 'unit-invalid' })
  const local = localAttachment('models', localModelsUnitId, 't0')
  assert.equal(local.attachmentId, 'local:models'); assert.equal(local.state, 'approved'); assert.equal(local.epoch, 1); assert.equal(local.credential, 'none')
  assert.throws(() => approveAttachment(local, { unitId: 'x', contractVersion: '1', capabilities: null, ceiling: fullScope('models'), at: 't1' }), { code: 'unit-attachment-state' })
  const revoked = revokeAttachment(local, 't1')
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.epoch, 2); assert.equal(revokeAttachment(revoked, 't2'), revoked)
  assert.throws(() => validateRunUnitBindings({ schemaVersion: 1, models: { attachmentId: 'a', unitKind: 'computer', unitId: 'u', epoch: 1 },
    computer: { attachmentId: 'b', unitKind: 'computer', unitId: 'u', epoch: 1 } }), { code: 'unit-invalid' })
  assert.throws(() => validateRunUnitBindings({ schemaVersion: 2 }), { code: 'unit-invalid' })
})

test('local units are approved idempotently at startup and keep their identity across restarts', async t => {
  const owner = await fixture(t)
  let f = await owner.open()
  const first = await f.units.list()
  assert.deepEqual(first.map(a => [a.attachmentId, a.unitKind, a.origin, a.state, a.unitId, a.epoch, a.credential, a.scope]), [
    ['local:computer', 'computer', 'local', 'approved', localComputerUnitId, 1, 'none', fullScope('computer')],
    ['local:models', 'models', 'local', 'approved', localModelsUnitId, 1, 'none', fullScope('models')]])
  const models = await f.units.local('models'), computer = await f.units.local('computer')
  assert.deepEqual(models.binding, { attachmentId: 'local:models', unitKind: 'models', unitId: localModelsUnitId, epoch: 1, bootId: 'id-1' })
  assert.deepEqual(computer.binding, { attachmentId: 'local:computer', unitKind: 'computer', unitId: localComputerUnitId, epoch: 1 })
  assert.deepEqual((await f.units.listEvents('local:models')).map(event => [event.kind, event.epoch]), [['created', 1], ['approved', 1]])
  await assert.rejects(f.units.revoke('local:models'), { code: 'unit-attachment-local' })
  await f.close()
  f = await owner.open()
  assert.deepEqual(await f.units.list(), first)
  assert.equal((await f.units.local('models')).binding.bootId, 'id-2')
  assert.equal((await f.units.listEvents('local:models')).length, 2)
  await assert.rejects(f.units.local('other'), { code: 'unit-invalid' })
  await f.close()
  const partial = await owner.open({ localUnits: [{ unitKind: 'models', unitId: localModelsUnitId }] })
  await assert.rejects(partial.units.local('computer'), { code: 'unit-attachment-missing' })
  assert.equal((await partial.units.list()).length, 2, 'an unlisted local attachment stays in the ledger')
})

test('attach codes are consumed once under the unit ceiling; revocation bumps the epoch and fixed references stop matching', async t => {
  const owner = await fixture(t), f = await owner.open()
  const requested = { kind: 'computer', projects: ['/work'], tools: ['anybox.bash'] }
  const { attachment: pending, code } = await f.units.createAttachCode({ unitKind: 'computer', scope: requested })
  assert.equal(pending.state, 'pending'); assert.equal(pending.origin, 'remote'); assert.equal(pending.unitId, null); assert.equal(pending.credential, 'none')
  assert.equal(pending.codeExpiresAt, '2026-10-14T00:10:00.000Z')
  assert.equal(typeof code, 'string'); assert.ok(code.length >= 32)
  assert.ok(!JSON.stringify(await f.units.list()).includes(code), 'codes are stored only as digests')
  await assert.rejects(f.units.createAttachCode({ unitKind: 'models', scope: requested }), { code: 'unit-invalid' })
  await assert.rejects(f.units.createAttachCode({ unitKind: 'computer', scope: requested, ttlMs: 10 }), { code: 'unit-invalid' })
  const attach = (overrides = {}) => f.units.attach({ code, unitKind: 'computer', unitId: 'laptop', contractVersion: '1', ceiling: fullScope('computer'), ...overrides })
  await assert.rejects(attach({ code: 'wrong' }), { code: 'unit-code-invalid' })
  await assert.rejects(attach({ unitKind: 'models', ceiling: fullScope('models') }), { code: 'unit-kind-mismatch' })
  await assert.rejects(attach({ ceiling: { kind: 'computer', projects: ['/other'], tools: 'all' } }), { code: 'unit-scope-exceeded' })
  await assert.rejects(attach({ unitId: localComputerUnitId }), { code: 'unit-already-attached' })
  assert.equal((await f.units.get(pending.attachmentId)).state, 'pending', 'rejected consumption leaves the code pending')
  const { attachment: approved, credential } = await attach({ capabilities: { tools: ['anybox.bash'] }, ceiling: { kind: 'computer', projects: ['/work', '/other'], tools: 'all' } })
  assert.equal(approved.state, 'approved'); assert.equal(approved.unitId, 'laptop'); assert.deepEqual(approved.scope, requested)
  assert.equal(approved.credential, 'issued'); assert.equal(approved.codeExpiresAt, null); assert.deepEqual(approved.capabilities, { tools: ['anybox.bash'] })
  assert.equal(typeof credential, 'string')
  assert.ok(!JSON.stringify(await f.units.get(approved.attachmentId)).includes(credential), 'credentials are stored only as digests')
  await assert.rejects(attach({ unitId: 'other' }), { code: 'unit-code-invalid' })
  const binding = { attachmentId: approved.attachmentId, unitKind: 'computer', unitId: 'laptop', epoch: 1 }
  assert.equal(await f.db.transaction(tx => f.units.requireApprovedIn(tx, binding).attachmentId), approved.attachmentId)
  const revoked = await f.units.revoke(approved.attachmentId)
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.epoch, 2); assert.equal(revoked.revokedAt, owner.inputs.now())
  assert.deepEqual(await f.units.revoke(approved.attachmentId), revoked)
  await assert.rejects(f.db.transaction(tx => f.units.requireApprovedIn(tx, binding)), { code: 'unit-attachment-mismatch' })
  const local = async () => ({ schemaVersion: 1, models: (await f.units.local('models')).binding, computer: (await f.units.local('computer')).binding })
  await f.units.verify(await local())
  await assert.rejects(f.units.verify({ ...await local(), computer: binding }), { code: 'unit-attachment-mismatch' })
  await assert.rejects(f.units.verify({ ...await local(), models: { ...(await local()).models, epoch: 2 } }), { code: 'unit-attachment-mismatch' })
  assert.deepEqual((await f.units.listEvents(approved.attachmentId)).map(event => [event.kind, event.epoch]), [['created', 1], ['approved', 1], ['revoked', 2]])
  await assert.rejects(f.units.revoke('missing'), { code: 'unit-attachment-missing' })

  const expiring = await f.units.createAttachCode({ unitKind: 'models', scope: { kind: 'models', access: 'execute', configurations: ['default'] }, ttlMs: 60_000 })
  owner.advance(60_001)
  await assert.rejects(f.units.attach({ code: expiring.code, unitKind: 'models', unitId: 'gateway', contractVersion: '1', ceiling: fullScope('models') }), { code: 'unit-code-expired' })
  assert.equal((await f.units.get(expiring.attachment.attachmentId)).state, 'pending')
  assert.equal((await f.units.revoke(expiring.attachment.attachmentId)).state, 'revoked')
  const units = f.units
  await f.close()
  await assert.rejects(units.list(), { code: 'unit-attachments-closed' })
})

test('the acceptance transaction fixes local unit references and rejects stale ones', async t => {
  const root = new Context(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-unit-accept-')))
  const inputs = { now: () => '2026-10-14T00:00:00.000Z', newId: ids() }, agents = [{ id: 'assistant', modelId: 'default', instructions: 'Fixed' }]
  t.after(async () => { try { await root.fiber.dispose() } finally { rmSync(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await installComputerWorkerStub(root)
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  await installComputerServices(root, inputs)
  await root.installComponent(createSessionComponent(inputs, agents))
  const project = await root.get('harness.projects').openProject(directory)
  const session = await root.get('harness.sessions').createSession(project.id, 'assistant')
  const units = root.get(unitAttachmentsServiceKey), records = root.get('harness.session-runs')
  const bindings = { schemaVersion: 1, models: (await units.local('models')).binding, computer: (await units.local('computer')).binding }
  const input = { sessionId: session.id, parentNodeId: null, input: 'hello', idempotencyKey: 'one' }
  await assert.rejects(records.registerRun('stale', input, 'now', [], modelSnapshot(),
    { ...nativeRegistration(input), units: { ...bindings, computer: { ...bindings.computer, epoch: 2 } } }), { code: 'unit-attachment-mismatch' })
  assert.equal(await records.getRun('stale'), undefined)
  const accepted = await records.registerRun('run', input, 'now', [], modelSnapshot(), { ...nativeRegistration(input), units: bindings })
  assert.deepEqual(accepted.run.units, bindings)
  assert.deepEqual((await root.get('harness.sessions').getRun('run')).units, bindings)
  const second = { ...input, idempotencyKey: 'two' }
  const legacy = await records.registerRun('legacy', second, 'now', [], modelSnapshot(), nativeRegistration(second))
  assert.equal(legacy.run.units, undefined, 'fixtures without unit references still register')
})

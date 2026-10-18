import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createUnitAttachmentsComponent } from '../packages/app-harness/dist/core/unit/component.js'
import { unitAttachmentsServiceKey } from '../packages/app-harness/dist/core/unit/port.js'
import { fullScope, localComputerUnitId, localModelsUnitId, parseUnitAuthorization, secretMatches, unitAuthorization } from '../packages/app-harness/dist/core/unit/domain.js'
import { createUnitTransportComponent, unitTransportServiceKey } from '../packages/app-harness/dist/core/unit/transport-component.js'
import { transportLimits, unitConnected, validateUnitRegistration, validateUnitReplies } from '../packages/app-harness/dist/core/unit/transport-domain.js'
import { createWorkerRouterComponent } from '../packages/app-harness/dist/core/computer/worker-router.js'
import { computerWorkerServiceKey } from '../packages/app-harness/dist/core/computer/worker-port.js'
import { createApplicationCatalog } from '../packages/host/dist/applications/registration.js'
import { harnessDefinition, harnessServerHttp } from '../packages/app-harness/dist/registration.js'

const localUnits = [{ unitKind: 'models', unitId: localModelsUnitId }, { unitKind: 'computer', unitId: localComputerUnitId }]
const registration = { unitId: 'laptop', bootId: 'boot-1', platform: 'linux', architecture: 'x64', waitMs: 0 }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-unit-transport-')), root = new Context()
  let clock = Date.parse('2026-10-14T00:00:00.000Z'), next = 0
  const inputs = { now: () => new Date(clock).toISOString(), newId: () => `id-${++next}` }
  t.after(async () => { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits }))
  await root.installComponent(createUnitTransportComponent(inputs))
  const units = root.get(unitAttachmentsServiceKey), transport = root.get(unitTransportServiceKey)
  const { code } = await units.createAttachCode({ unitKind: 'computer', scope: fullScope('computer') })
  const { attachment, credential } = await units.attach({ code, unitKind: 'computer', unitId: 'laptop', contractVersion: 'computer-worker-1', ceiling: fullScope('computer') })
  return { root, units, transport, attachment, credential, advance: ms => { clock += ms } }
}

test('transport rules are pure: authorization headers, registrations, replies and connectivity', () => {
  assert.deepEqual(parseUnitAuthorization('Unit abc:' + 'x'.repeat(32)), { attachmentId: 'abc', credential: 'x'.repeat(32) })
  assert.deepEqual(parseUnitAuthorization(unitAuthorization('with:colon', 'y'.repeat(32))), { attachmentId: 'with:colon', credential: 'y'.repeat(32) })
  for (const header of [undefined, 'Bearer abc', 'Unit abc', 'Unit :' + 'x'.repeat(32), 'Unit abc:short', 'Unit abc:' + 'x'.repeat(31) + '!']) {
    assert.throws(() => parseUnitAuthorization(header), { code: 'unit-credential-invalid' }, String(header))
  }
  assert.equal(secretMatches('secret', '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b'), true)
  assert.equal(secretMatches('other', '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b'), false)
  assert.equal(secretMatches('secret', null), false)
  assert.deepEqual(validateUnitRegistration({ unitId: 'u', bootId: 'b', platform: 'darwin', architecture: 'arm64' }), { unitId: 'u', bootId: 'b', platform: 'darwin', architecture: 'arm64', waitMs: transportLimits.defaultWaitMs })
  assert.throws(() => validateUnitRegistration({ ...registration, waitMs: transportLimits.maxWaitMs + 1 }), { code: 'unit-transport-invalid' })
  assert.throws(() => validateUnitRegistration({ ...registration, extra: 1 }), { code: 'unit-transport-invalid' })
  assert.throws(() => validateUnitRegistration({ ...registration, bootId: '' }), { code: 'unit-transport-invalid' })
  assert.deepEqual(validateUnitReplies([{ requestId: 'r', value: null }, { requestId: 's', error: { code: 'worker-invalid', category: 'invalid-request' } }]),
    [{ requestId: 'r', value: null }, { requestId: 's', error: { code: 'worker-invalid', category: 'invalid-request' } }])
  assert.throws(() => validateUnitReplies([{ requestId: 'r' }]), { code: 'unit-transport-invalid' })
  assert.throws(() => validateUnitReplies([{ requestId: 'r', value: 1 }, { requestId: 'r', value: 2 }]), { code: 'unit-transport-invalid' })
  assert.throws(() => validateUnitReplies([{ requestId: 'r', error: { code: 'x', extra: true } }]), { code: 'unit-transport-invalid' })
  const connection = { attachmentId: 'a', unitId: 'u', bootId: 'b', platform: 'linux', architecture: 'x64', lastSeenAt: '2026-10-14T00:00:00.000Z', polling: false }
  assert.equal(unitConnected(connection, '2026-10-14T00:00:30.000Z'), true)
  assert.equal(unitConnected(connection, '2026-10-14T00:00:45.000Z'), false)
  assert.equal(unitConnected({ ...connection, polling: true }, '2026-10-14T01:00:00.000Z'), true)
  assert.equal(unitConnected(undefined, '2026-10-14T00:00:00.000Z'), false)
})

test('the host dispatches unit routes without device-token authentication only under the application path', () => {
  const catalog = createApplicationCatalog([{ definition: harnessDefinition, http: harnessServerHttp, createRuntime() { throw new Error('unused') } }])
  assert.deepEqual(catalog.route('/api/v1/apps/agent/units/unit/poll', '/api/v1'), { application: catalog.applications[0], path: '/units/unit/poll', selfAuthenticated: true })
  assert.equal(catalog.route('/api/v1/apps/agent/units/attachments', '/api/v1').selfAuthenticated, false)
  assert.equal(catalog.route('/api/v1/apps/agent/units/unitary', '/api/v1').selfAuthenticated, false)
  assert.equal(catalog.route('/api/v1/units/unit/poll', '/api/v1'), undefined, 'unit routes have no legacy alias')
  assert.equal(catalog.route('/api/v1/sessions', '/api/v1').selfAuthenticated, false)
  assert.throws(() => createApplicationCatalog([{ definition: { ...harnessDefinition, id: 'bad' }, http: { service: 's', legacyRoutes: [{ prefix: '/api/v1/units', stripPrefix: '/api/v1' }], selfAuthenticated: ['/units/unit'] }, createRuntime() {} }]), /self-authenticated/)
})

test('unit credentials authenticate only approved attachments and requests travel through claimed polls and replies', async t => {
  const f = await fixture(t)
  const authorization = unitAuthorization(f.attachment.attachmentId, f.credential)
  assert.equal((await f.transport.authenticate(authorization)).attachmentId, f.attachment.attachmentId)
  await assert.rejects(f.transport.authenticate(unitAuthorization(f.attachment.attachmentId, 'x'.repeat(43))), { code: 'unit-credential-invalid' })
  await assert.rejects(f.transport.authenticate(unitAuthorization('local:computer', 'x'.repeat(43))), { code: 'unit-credential-invalid' }, 'local attachments have no credential')
  await assert.rejects(f.transport.authenticate('Bearer token'), { code: 'unit-credential-invalid' })
  assert.deepEqual(await f.transport.poll(f.attachment.attachmentId, registration), [])
  assert.deepEqual(f.transport.connection(f.attachment.attachmentId), { attachmentId: f.attachment.attachmentId, unitId: 'laptop', bootId: 'boot-1', platform: 'linux', architecture: 'x64', lastSeenAt: '2026-10-14T00:00:00.000Z', polling: false, connected: true })
  assert.equal(f.transport.connection('unknown'), undefined)

  const pending = f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} })
  const failing = f.transport.request(f.attachment.attachmentId, { kind: 'submit', payload: { operationId: 'op' } })
  const [first, second] = await f.transport.poll(f.attachment.attachmentId, registration)
  assert.deepEqual([first.kind, first.payload, second.kind, second.payload], ['info', {}, 'submit', { operationId: 'op' }])
  assert.deepEqual(await f.transport.poll(f.attachment.attachmentId, registration), [], 'claimed requests are not delivered twice')
  f.transport.reply(f.attachment.attachmentId, [{ requestId: 'unknown', value: 1 }, { requestId: first.requestId, value: { workerId: 'laptop' } }, { requestId: second.requestId, error: { code: 'worker-owner-rejected', name: 'ComputerWorkerError', category: 'invalid-request' } }])
  assert.deepEqual(await pending, { workerId: 'laptop' })
  await assert.rejects(failing, error => error.code === 'worker-owner-rejected' && error.name === 'ComputerWorkerError' && error.category === 'invalid-request' && error.remote === true)
  assert.throws(() => f.transport.reply(f.attachment.attachmentId, [{ requestId: 'x' }]), { code: 'unit-transport-invalid' })

  // A waiting poll wakes when a request arrives; an idle poll returns empty after its wait.
  const waiting = f.transport.poll(f.attachment.attachmentId, { ...registration, waitMs: 5_000 })
  assert.equal(f.transport.connection(f.attachment.attachmentId).polling, true)
  const late = f.transport.request(f.attachment.attachmentId, { kind: 'claim', payload: { runId: 'r' } })
  const [claimed] = await waiting
  assert.equal(claimed.kind, 'claim')
  f.transport.reply(f.attachment.attachmentId, [{ requestId: claimed.requestId, value: null }])
  assert.equal(await late, null)
  assert.deepEqual(await f.transport.poll(f.attachment.attachmentId, { ...registration, waitMs: 20 }), [])

  // Nobody claims: unavailable after the claim window; aborted callers stop waiting at once; a new boot abandons the previous boot's claims.
  await assert.rejects(f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} }, { claimTimeoutMs: 20 }), { code: 'unit-unavailable' })
  const controller = new AbortController()
  const aborted = f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, { code: 'unit-request-aborted' })
  assert.deepEqual(await f.transport.poll(f.attachment.attachmentId, registration), [], 'aborted requests leave the queue')
  const orphan = f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} })
  assert.equal((await f.transport.poll(f.attachment.attachmentId, registration)).length, 1)
  assert.deepEqual(await f.transport.poll(f.attachment.attachmentId, { ...registration, bootId: 'boot-2' }), [])
  await assert.rejects(orphan, { code: 'unit-claimed-unavailable' })
  const slow = f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} }, { replyTimeoutMs: 20 })
  await f.transport.poll(f.attachment.attachmentId, { ...registration, bootId: 'boot-2' })
  await assert.rejects(slow, { code: 'unit-reply-timeout' })
  const cancelledPoll = new AbortController()
  const abortedPoll = f.transport.poll(f.attachment.attachmentId, { ...registration, bootId: 'boot-2', waitMs: 5_000 }, cancelledPoll.signal)
  const unclaimed = f.transport.request(f.attachment.attachmentId, { kind: 'info', payload: {} }, { claimTimeoutMs: 5_000 })
  cancelledPoll.abort()
  assert.deepEqual(await abortedPoll, [], 'a poll whose caller disconnected claims nothing')
  assert.equal((await f.transport.poll(f.attachment.attachmentId, { ...registration, bootId: 'boot-2' })).length, 1)

  // Revocation stops authentication; closing rejects everything still waiting.
  await f.units.revoke(f.attachment.attachmentId)
  await assert.rejects(f.transport.authenticate(authorization), { code: 'unit-attachment-state' })
  const waitingPoll = f.transport.poll(f.attachment.attachmentId, { ...registration, bootId: 'boot-2', waitMs: 5_000 })
  const transport = f.transport
  await f.root.fiber.dispose()
  assert.deepEqual(await waitingPoll, [])
  await assert.rejects(unclaimed, { code: 'unit-transport-closed' })
  await assert.rejects(transport.request('a', { kind: 'info', payload: {} }), { code: 'unit-transport-closed' })
  await assert.rejects(transport.poll('a', registration), { code: 'unit-transport-closed' })
})


test('a claimed submit keeps later owner and observation failures uncertain after a boot change', async t => {
  const f = await fixture(t)
  await f.root.installComponent(createWorkerRouterComponent({ local: false, claimTimeoutMs: 20, replyTimeoutMs: 100 }))
  const worker = f.root.get(computerWorkerServiceKey), attachmentId = f.attachment.attachmentId
  await f.transport.poll(attachmentId, registration)
  const submitted = worker.submit({ attachmentId, runId: 'run', runOwnerEpoch: 1, operationId: 'op', kind: 'tool', declarationDigest: 'digest' })
  void submitted.catch(() => {})
  assert.equal((await f.transport.poll(attachmentId, registration))[0].kind, 'submit')
  await f.transport.poll(attachmentId, { ...registration, bootId: 'boot-2' })
  await assert.rejects(submitted, { code: 'worker-unavailable' }, 'a new boot cannot disprove execution of a claimed submit')
  f.advance(45_000)
  await assert.rejects(worker.claimRun({ attachmentId, runId: 'run', runOwnerEpoch: 2 }), { code: 'worker-unavailable' }, 'lost owner observation does not erase an ambiguous submission')
  await assert.rejects(worker.get({ attachmentId, runId: 'run', runOwnerEpoch: 2, operationId: 'op' }), { code: 'worker-unavailable' })
  await assert.rejects(worker.submit({ attachmentId, runId: 'run', runOwnerEpoch: 2, operationId: 'run:computer-close-scope', kind: 'close-scope', declarationDigest: 'close' }), { code: 'worker-unavailable' })
  await assert.rejects(worker.claimRun({ attachmentId, runId: 'fresh', runOwnerEpoch: 1 }), { code: 'worker-unreachable' }, 'a new Run that never reached a unit still fails admission')
})

test('a pre-aborted remote query never enters the transport mailbox', async t => {
  const f = await fixture(t)
  await f.root.installComponent(createWorkerRouterComponent({ local: false }))
  const attachmentId = f.attachment.attachmentId, controller = new AbortController()
  await f.transport.poll(attachmentId, registration)
  controller.abort()
  await assert.rejects(f.root.get(computerWorkerServiceKey).query({ attachmentId, query: { kind: 'stat', path: '/project' } }, controller.signal), { code: 'worker-observer-closed' })
  assert.deepEqual(await f.transport.poll(attachmentId, registration), [])
})

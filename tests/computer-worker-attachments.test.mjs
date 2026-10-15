import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../dist/host/access.js'
import { createUnitAttachmentsComponent } from '../dist/applications/harness/core/unit/component.js'
import { unitAttachmentsServiceKey } from '../dist/applications/harness/core/unit/port.js'
import { fullScope, localComputerUnitId, localModelsUnitId, unitAuthorization } from '../dist/applications/harness/core/unit/domain.js'
import { createUnitTransportComponent, unitTransportServiceKey } from '../dist/applications/harness/core/unit/transport-component.js'
import { openComputerWorker } from '../dist/applications/harness/core/computer/worker-server.js'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { ceilingPermits, localWorkerAttachment, validateHarnessUrl, validateWorkerAttachment } from '../dist/applications/harness/core/computer/worker-attachments-domain.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { nodeCommand } from './helpers/native-shell.mjs'

const terminal = state => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
const memoryEntries = () => {
  const memory = new Map()
  return { memory, openEntry: (service, id) => ({ getPassword: async () => memory.get(`${service}:${id}`), setPassword: async value => { memory.set(`${service}:${id}`, value) }, deleteCredential: async () => memory.delete(`${service}:${id}`) }) }
}
async function until(check, message, limit = 10_000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`timed out: ${message}`)
}

/** A remote harness server: attachment ledger, unit transport and the real authenticated listener; nothing else of the core. */
async function harnessServer(t, directory) {
  const root = new Context()
  const inputs = { now: () => new Date().toISOString(), newId: (() => { let n = 0; return () => `remote-${++n}` })() }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'remote.sqlite')))
  await root.installComponent(createHostAccessComponent('remote harness'))
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [{ unitKind: 'models', unitId: localModelsUnitId }, { unitKind: 'computer', unitId: localComputerUnitId }] }))
  await root.installComponent(createUnitTransportComponent(inputs))
  const access = root.get(hostAccessServiceKey), units = root.get(unitAttachmentsServiceKey), transport = root.get(unitTransportServiceKey)
  const commands = {
    instanceId: () => access.instance.instanceId,
    listUnitAttachments: () => units.list(), createUnitAttachCode: input => units.createAttachCode(input), revokeUnitAttachment: id => units.revoke(id),
    attachUnit: input => units.attach(input), authenticateUnit: header => transport.authenticate(header),
    pollUnit: (id, registration, signal) => transport.poll(id, registration, signal), replyUnit: (id, replies) => transport.reply(id, replies),
    listAgents: () => [],
  }
  const web = await startHarnessServerHttp(commands, 0, { access })
  const { token } = await access.issue('owner')
  t.after(async () => { await web.close(); await root.fiber.dispose() })
  const owner = (method, path, body) => fetch(`${web.url}/api/v1/apps/agent${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-anybox-instance-id': access.instance.instanceId, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { root, web, units, transport, access, token, owner }
}

test('worker attachment rules are pure: harness URLs, ceilings and records', () => {
  assert.equal(validateHarnessUrl('https://harness.example.com/'), 'https://harness.example.com')
  assert.equal(validateHarnessUrl('https://harness.example.com/anybox/'), 'https://harness.example.com/anybox')
  assert.equal(validateHarnessUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001')
  for (const value of ['http://harness.example.com', 'https://user:pw@h.example', 'https://h.example/?x=1', 'ftp://h.example', '', 'not a url']) assert.throws(() => validateHarnessUrl(value), { code: 'worker-attachment-invalid' }, value)
  const ceiling = { kind: 'computer', projects: ['/work/app'], tools: ['anybox.bash'] }
  assert.equal(ceilingPermits(ceiling, { path: '/work/app', toolId: 'anybox.bash' }), true)
  assert.equal(ceilingPermits(ceiling, { path: '/work/app/sub', toolId: 'anybox.bash' }), true)
  assert.equal(ceilingPermits(ceiling, { path: '/work/application', toolId: 'anybox.bash' }), false)
  assert.equal(ceilingPermits(ceiling, { path: '/work/app', toolId: 'anybox.apply_patch' }), false)
  assert.equal(ceilingPermits(fullScope('computer'), { path: '/anywhere', toolId: 'codex.exec_command' }), true)
  const local = localWorkerAttachment('t0')
  assert.equal(local.attachmentId, 'local:computer'); assert.equal(local.state, 'approved'); assert.deepEqual(local.ceiling, fullScope('computer'))
  assert.throws(() => validateWorkerAttachment({ ...local, ceiling: { kind: 'computer', projects: ['relative'], tools: 'all' } }), { code: 'worker-attachment-invalid' })
  assert.throws(() => validateWorkerAttachment({ ...local, state: 'pending' }), { code: 'worker-attachment-invalid' })
})

test('a worker serves a remote harness server through dial-out under the device owner\'s ceiling, and either side can revoke', { timeout: 120_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-attach-')))
  const allowed = join(directory, 'allowed'), other = join(directory, 'other')
  await mkdir(allowed); await mkdir(other)
  const remote = await harnessServer(t, directory)
  const { memory, openEntry } = memoryEntries()
  const worker = await openComputerWorker(join(directory, 'worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200 } })
  const local = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  t.after(async () => { await local.closeObserver(); await worker.close(); await rm(directory, { recursive: true, force: true }) })
  assert.deepEqual(await local.control.listAttachments(), [])

  // Attach: the harness server owner issues a code; the device owner consumes it with a ceiling narrower than the request is allowed to exceed.
  const ceiling = { kind: 'computer', projects: [allowed], tools: ['anybox.bash'] }
  const issued = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: { kind: 'computer', projects: [allowed], tools: ['anybox.bash'] } })).json()
  await assert.rejects(local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: 'wrong', ceiling }), { code: 'unit-code-invalid' })
  await assert.rejects(local.control.consumeAttachCode({ harnessUrl: 'http://192.0.2.1', code: issued.code, ceiling }), { code: 'worker-attachment-invalid' })
  const attached = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: issued.code, ceiling })
  assert.equal(attached.attachmentId, issued.attachment.attachmentId); assert.equal(attached.state, 'approved'); assert.equal(attached.instanceId, remote.access.instance.instanceId)
  assert.deepEqual(attached.ceiling, ceiling); assert.equal(attached.harnessUrl, remote.web.url)
  assert.equal([...memory.keys()].length, 1, 'the credential is stored in the system credential namespace')
  assert.ok(!JSON.stringify(await local.control.listAttachments()).includes(memory.values().next().value), 'listing never returns the credential')
  const serverSide = await remote.units.get(attached.attachmentId)
  assert.equal(serverSide.state, 'approved'); assert.equal(serverSide.unitId, worker.endpoint.workerId); assert.equal(serverSide.contractVersion, 'computer-worker-1')
  assert.equal(serverSide.capabilities.platform, process.platform)
  assert.equal((await until(() => remote.transport.connection(attached.attachmentId)?.connected, 'unit polls')), true)
  assert.ok(['connecting', 'connected'].includes((await local.control.listAttachments())[0].connection))
  await until(async () => (await local.control.listAttachments())[0].connection === 'connected', 'first poll completes')
  const connection = remote.transport.connection(attached.attachmentId)
  assert.equal(connection.unitId, worker.endpoint.workerId); assert.equal(connection.bootId, worker.endpoint.bootId); assert.equal(connection.platform, process.platform)

  // Requests travel through the mailbox; the unit derives the authorization from the attachment that delivered them.
  const id = attached.attachmentId
  const request = (kind, payload) => remote.transport.request(id, { kind, payload })
  assert.deepEqual(await request('info', {}), { workerId: worker.endpoint.workerId, bootId: worker.endpoint.bootId, platform: process.platform, architecture: process.arch })
  const owner = { runId: 'remote-run', runOwnerEpoch: 1, attachmentId: 'local:computer' }
  assert.equal(await request('claim', owner), null, 'the payload attachment is ignored; the delivering attachment owns the Run')
  await assert.rejects(local.claimRun({ ...owner, attachmentId: 'local:computer' }), { code: 'worker-owner-rejected' }, 'the loopback owner cannot take over a remote attachment\'s Run')
  await assert.rejects(local.claimRun({ runId: 'bogus', runOwnerEpoch: 1, attachmentId: 'nope' }), { code: 'worker-attachment-rejected' })
  const binding = path => ({ bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: 'remote', computerInstanceId: `${worker.endpoint.workerId}:${worker.endpoint.bootId}`, instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path, preparedAt: 'now' })
  const tool = (operationId, toolId, args, path) => {
    const entry = getToolById(toolId)
    const declaration = { schemaVersion: 1, operationId, runId: owner.runId, sessionId: 'session', projectId: 'project', tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
      request: { id: `call-${operationId}`, name: entry.definition.name, arguments: args }, workspaceId: 'workspace', workspaceRevision: 0, computerId: 'remote', spec: { providerId: 'remote', platform: process.platform, architecture: process.arch } }
    return { ...owner, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding: binding(path), workerBootId: worker.endpoint.bootId }
  }
  await assert.rejects(request('submit', tool('outside', 'anybox.bash', { command: 'touch escaped' }, other)), { code: 'worker-scope-rejected' })
  await assert.rejects(request('submit', tool('patch', 'anybox.apply_patch', { patch: '*** Begin Patch\n*** End Patch\n' }, allowed)), { code: 'worker-scope-rejected' })
  if (process.platform === 'win32') {
    assert.deepEqual(await request('query', { query: { kind: 'stat', path: allowed.toUpperCase() } }), { kind: 'stat', directory: true, canonical: allowed }, 'case aliases use actual filesystem identity')
    const escape = join(allowed, 'outside-junction')
    await symlink(other, escape, 'junction')
    await assert.rejects(request('query', { query: { kind: 'stat', path: escape } }), { code: 'worker-scope-rejected' })
    await assert.rejects(request('submit', tool('junction-outside', 'anybox.bash', { command: 'touch escaped' }, escape)), { code: 'worker-scope-rejected' })
  }
  await assert.rejects(readFile(join(other, 'escaped')), { code: 'ENOENT' })
  const run = tool('inside', 'anybox.bash', { command: nodeCommand("const value = 'remote ' + process.cwd(); require('node:fs').writeFileSync('marker.txt', value); process.stdout.write(value)", true) }, allowed)
  const accepted = await request('submit', run)
  assert.equal(accepted.state, 'queued'); assert.equal(typeof accepted.receipt, 'string')
  let fact = accepted
  while (!terminal(fact.state)) fact = await request('get', { ...owner, operationId: 'inside', known: { state: fact.state, receipt: fact.receipt } })
  assert.equal(fact.state, 'succeeded'); assert.equal(fact.receipt, accepted.receipt); assert.equal(fact.executeCount, 1)
  assert.equal(fact.observation.result.stdout, `remote ${allowed}`)
  assert.equal(await readFile(join(allowed, 'marker.txt'), 'utf8'), `remote ${allowed}`)
  await assert.rejects(local.get({ ...owner, operationId: 'inside' }), { code: 'worker-owner-rejected' }, 'another attachment cannot read the Run\'s facts')
  await assert.rejects(request('shutdown', {}), { code: 'worker-request-unsupported' })
  const close = { ...owner, operationId: 'close', kind: 'close-scope', declarationDigest: 'close' }
  await request('submit', close)
  await until(async () => terminal((await request('get', { ...owner, operationId: 'close' })).state), 'scope closes')

  // Device-owner revocation: acceptance stops, the credential is deleted, the harness server learns it, and new requests find no unit.
  const revoked = await local.control.revokeAttachment(id)
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.connection, 'revoked')
  assert.equal(memory.size, 0, 'the credential leaves the system credential namespace')
  assert.equal((await until(async () => (await remote.units.get(id)).state === 'revoked', 'server learns the revocation')), true)
  assert.deepEqual(await local.control.revokeAttachment(id), revoked, 'revocation is idempotent')
  await assert.rejects(remote.transport.request(id, { kind: 'info', payload: {} }, { claimTimeoutMs: 400 }), { code: 'unit-unavailable' })
  await assert.rejects(local.claimRun({ runId: 'after', runOwnerEpoch: 1, attachmentId: id }), { code: 'worker-attachment-rejected' })
  await assert.rejects(local.control.revokeAttachment('local:computer'), { code: 'worker-attachment-local' })
  await assert.rejects(local.control.revokeAttachment('missing'), { code: 'worker-attachment-missing' })

  // Harness-server-side revocation: the next poll is refused, the unit drops the credential and stops accepting for that attachment.
  const second = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: fullScope('computer') })).json()
  const again = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: second.code, ceiling: fullScope('computer') })
  assert.notEqual(again.attachmentId, id)
  assert.equal(memory.size, 1)
  await until(() => remote.transport.connection(again.attachmentId)?.connected, 'second attachment polls')
  await remote.owner('POST', `/units/attachments/${encodeURIComponent(again.attachmentId)}/revoke`, {})
  const view = await until(async () => (await local.control.listAttachments()).find(item => item.attachmentId === again.attachmentId && item.state === 'revoked'), 'unit observes the revocation')
  assert.equal(view.connection, 'revoked')
  assert.equal(memory.size, 0)
  assert.equal((await remote.units.get(again.attachmentId)).epoch, 2)

  // Unit routes never accept the device token, owner routes never accept a unit credential, and the legacy alias does not exist.
  const bearer = await fetch(`${remote.web.url}/api/v1/apps/agent/units/unit/poll?unitId=u&bootId=b&platform=linux&architecture=x64&waitMs=0`, { headers: { authorization: `Bearer ${remote.token}`, 'x-anybox-instance-id': remote.access.instance.instanceId } })
  assert.equal(bearer.status, 401); assert.equal((await bearer.json()).error.code, 'unit-credential-invalid')
  const unitOnOwnerRoute = await fetch(`${remote.web.url}/api/v1/apps/agent/units/attachments`, { headers: { authorization: unitAuthorization(id, 'x'.repeat(43)), 'x-anybox-instance-id': remote.access.instance.instanceId } })
  assert.equal(unitOnOwnerRoute.status, 401); assert.equal((await unitOnOwnerRoute.json()).error.code, 'authentication-failed')
  assert.equal((await fetch(`${remote.web.url}/api/v1/units/unit/poll`)).status, 401, 'legacy paths stay owner-authenticated and have no unit alias')
  const badAttach = await fetch(`${remote.web.url}/api/v1/apps/agent/units/unit/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x', unitKind: 'computer', unitId: 'u', contractVersion: '1', ceiling: fullScope('computer') }) })
  assert.equal(badAttach.status, 409); assert.equal((await badAttach.json()).error.code, 'unit-code-invalid')
})

test('a worker restart keeps approved attachments and resumes dial-out from the stored credential', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-attach-restart-'))
  const remote = await harnessServer(t, directory)
  const { memory, openEntry } = memoryEntries()
  let worker = await openComputerWorker(join(directory, 'worker'), { openEntry, dialout: { pollWaitMs: 300 } })
  t.after(async () => { await worker.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const issued = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: fullScope('computer') })).json()
  const local = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  const attached = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: issued.code, ceiling: fullScope('computer') })
  await until(() => remote.transport.connection(attached.attachmentId)?.connected, 'first boot polls')
  const firstBoot = worker.endpoint.bootId
  await local.closeObserver()
  await worker.close()
  worker = await openComputerWorker(join(directory, 'worker'), { openEntry, dialout: { pollWaitMs: 300 } })
  assert.notEqual(worker.endpoint.bootId, firstBoot)
  const connection = await until(() => { const c = remote.transport.connection(attached.attachmentId); return c?.connected && c.bootId === worker.endpoint.bootId ? c : undefined }, 'second boot polls with the stored credential')
  assert.equal(connection.unitId, worker.endpoint.workerId)
  assert.deepEqual(await remote.transport.request(attached.attachmentId, { kind: 'info', payload: {} }), { workerId: worker.endpoint.workerId, bootId: worker.endpoint.bootId, platform: process.platform, architecture: process.arch })
  assert.equal(memory.size, 1)
  const relink = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  assert.equal((await relink.control.listAttachments())[0].connection, 'connected')
  await relink.closeObserver()
})

test('unit credentials round-trip through the real system keyring', { skip: !process.env.ANYBOX_KEYRING_TESTS, timeout: 120_000 }, async t => {
  const { AsyncEntry } = await import('@napi-rs/keyring')
  const directory = await mkdtemp(join(tmpdir(), 'anybox-worker-attach-keyring-'))
  const remote = await harnessServer(t, directory)
  const namespace = `anybox.computer-worker.test.${randomUUID()}`
  const worker = await openComputerWorker(join(directory, 'worker'), { credentialNamespace: namespace, dialout: { pollWaitMs: 300 } })
  const local = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  let entry
  t.after(async () => { try { await local.closeObserver(); await worker.close() } finally { await entry?.deleteCredential().catch(() => {}); await rm(directory, { recursive: true, force: true }) } })
  const issued = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: fullScope('computer') })).json()
  const attached = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: issued.code, ceiling: fullScope('computer') })
  entry = new AsyncEntry(namespace, `unit-attachment/${attached.attachmentId}`, { linux: { store: 'secret-service' } })
  const credential = await entry.getPassword()
  assert.equal(typeof credential, 'string'); assert.ok(credential.length >= 32)
  assert.equal((await remote.transport.authenticate(unitAuthorization(attached.attachmentId, credential))).attachmentId, attached.attachmentId)
  await until(() => remote.transport.connection(attached.attachmentId)?.connected, 'unit polls with the keyring credential')
  await local.control.revokeAttachment(attached.attachmentId)
  assert.equal(await entry.getPassword(), null)
})

test('attach repeats only failures that prove the request never left: connect refusals are retried, ambiguous failures surface at once', { timeout: 60_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-attach-retry-')))
  const remote = await harnessServer(t, directory)
  const { openEntry } = memoryEntries()
  const failures = [], attempts = []
  const flaky = async (url, init) => {
    if (String(url).endsWith('/units/unit/attach')) { attempts.push(Date.now()); const next = failures.shift(); if (next) throw next }
    return fetch(url, init)
  }
  const worker = await openComputerWorker(join(directory, 'worker'), { openEntry, dialout: { pollWaitMs: 300, fetch: flaky } })
  const local = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  t.after(async () => { await local.closeObserver(); await worker.close(); await rm(directory, { recursive: true, force: true }) })
  const connectRefused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  const socketReset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
  const ceiling = fullScope('computer')
  // Two refusals, then the real request: one attachment, one consumed code.
  failures.push(connectRefused(), connectRefused())
  const first = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: ceiling })).json()
  const attached = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: first.code, ceiling })
  assert.equal(attached.state, 'approved'); assert.equal(attempts.length, 3)
  assert.equal((await remote.units.get(attached.attachmentId)).state, 'approved')
  // An ambiguous failure (the request may already have been sent) is never repeated; nothing reached the harness server, so the code survives.
  attempts.length = 0; failures.push(socketReset())
  const second = await (await remote.owner('POST', '/units/attach-codes', { unitKind: 'computer', scope: ceiling })).json()
  await assert.rejects(local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: second.code, ceiling }), { code: 'worker-attach-unreachable' })
  assert.equal(attempts.length, 1)
  // Refusals beyond the attempt budget surface too; the untouched code can still be consumed afterwards.
  attempts.length = 0; failures.push(connectRefused(), connectRefused(), connectRefused())
  await assert.rejects(local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: second.code, ceiling }), { code: 'worker-attach-unreachable' })
  assert.equal(attempts.length, 3)
  // One unit holds one attachment per harness server: release the first before consuming the untouched second code.
  await local.control.revokeAttachment(attached.attachmentId)
  const again = await local.control.consumeAttachCode({ harnessUrl: remote.web.url, code: second.code, ceiling })
  assert.equal(again.state, 'approved'); assert.notEqual(again.attachmentId, attached.attachmentId)
})

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../dist/host/access.js'
import { hostHttpServiceKey } from '../dist/host/component.js'
import { parseHarnessServerConfig } from '../dist/applications/harness/server-config.js'
import { installHarnessServerCore } from '../dist/applications/harness/core/index.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { imageAssetsServiceKey } from '../dist/applications/harness/core/image/port.js'
import { createUnitAttachmentsComponent } from '../dist/applications/harness/core/unit/component.js'
import { unitAttachmentsServiceKey } from '../dist/applications/harness/core/unit/port.js'
import { fullScope, localComputerUnitId, localModelsUnitId } from '../dist/applications/harness/core/unit/domain.js'
import { createUnitTransportComponent, unitTransportServiceKey } from '../dist/applications/harness/core/unit/transport-component.js'
import { createWorkerRouterComponent } from '../dist/applications/harness/core/computer/worker-router.js'
import { computerInstanceProviderServiceKey, computerServiceKey } from '../dist/applications/harness/core/computer/port.js'
import { computerWorkerServiceKey, localComputerWorkerControlServiceKey } from '../dist/applications/harness/core/computer/worker-port.js'
import { unitComputerId, computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { openComputerWorker } from '../dist/applications/harness/core/computer/worker-server.js'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'
import { createFixtureApplicationApiComponent } from './helpers/application-api.mjs'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { controlledModels } from './helpers/controlled-models.mjs'

const unix = process.platform !== 'win32'
const terminal = state => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
const memoryEntries = () => {
  const memory = new Map()
  return { memory, openEntry: (service, id) => ({ getPassword: async () => memory.get(`${service}:${id}`), setPassword: async value => { memory.set(`${service}:${id}`, value) }, deleteCredential: async () => memory.delete(`${service}:${id}`) }) }
}
async function until(check, message, limit = 15_000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`timed out: ${message}`)
}
const spec = { providerId: 'unit', platform: process.platform, architecture: process.arch }

test('startup configuration selects the Computer unit form without reading any unit', () => {
  assert.deepEqual(parseHarnessServerConfig({}).computerUnit, { kind: 'local' })
  assert.deepEqual(parseHarnessServerConfig({ ANYBOX_COMPUTER_UNIT: 'local' }).computerUnit, { kind: 'local' })
  assert.deepEqual(parseHarnessServerConfig({ ANYBOX_COMPUTER_UNIT: 'remote', ANYBOX_COMPUTER_ATTACHMENT: 'att-1' }).computerUnit, { kind: 'remote', attachmentId: 'att-1' })
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_COMPUTER_UNIT: 'remote' }), /ANYBOX_COMPUTER_ATTACHMENT/)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_COMPUTER_UNIT: 'cloud' }), /ANYBOX_COMPUTER_UNIT/)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_COMPUTER_UNIT: 'remote', ANYBOX_COMPUTER_ATTACHMENT: 'local:computer' }), /local/)
})

test('the worker router installs without a reachable unit and reports unavailability at admission', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-unit-proxy-offline-')), root = new Context()
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const inputs = { now: () => new Date().toISOString(), newId: (() => { let n = 0; return () => `id-${++n}` })() }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [{ unitKind: 'models', unitId: localModelsUnitId }] }))
  await root.installComponent(createUnitTransportComponent(inputs))
  const started = Date.now()
  await root.installComponent(createWorkerRouterComponent({ local: false, claimTimeoutMs: 150 }))
  assert.ok(Date.now() - started < 1_000, 'apply does not wait for the unit')
  const worker = root.get(computerWorkerServiceKey), provider = root.get(computerInstanceProviderServiceKey)
  assert.equal(provider.providerId, 'unit'); assert.deepEqual(provider.providerIds, ['unit'])
  await assert.rejects(worker.info(), { code: 'worker-attachment-rejected' }, 'the remote form has no local worker to describe')
  await assert.rejects(worker.claimRun({ runId: 'r', runOwnerEpoch: 1, attachmentId: 'ghost' }), { code: 'worker-unreachable' })
  await assert.rejects(worker.claimRun({ runId: 'r', runOwnerEpoch: 1, attachmentId: 'local:computer' }), { code: 'worker-attachment-rejected' }, 'the remote form has no local worker')
  await assert.rejects(worker.get({ runId: 'r', runOwnerEpoch: 1, attachmentId: 'ghost', operationId: 'op' }), { code: 'worker-unreachable' })
  await assert.rejects(worker.query({ attachmentId: 'ghost', query: { kind: 'stat', path: '/tmp' } }), { code: 'worker-unreachable' })
  await assert.rejects(worker.shutdown(), { code: 'worker-remote-control' })
  const activation = provider.activate({ resource: { computerId: unitComputerId('ghost'), spec, activationRevision: 1, createdAt: 'now' }, activationId: 'a1' })
  await assert.rejects(activation.result, { code: 'computer-unavailable' }); await activation.done
  const local = provider.activate({ resource: { computerId: 'local', spec: { ...spec, providerId: 'local' }, activationRevision: 1, createdAt: 'now' }, activationId: 'a2' })
  await assert.rejects(local.result, { code: 'computer-unavailable' }); await local.done
  const cancelled = provider.activate({ resource: { computerId: unitComputerId('ghost'), spec, activationRevision: 1, createdAt: 'now' }, activationId: 'a3' })
  cancelled.cancel('test'); await assert.rejects(cancelled.result, { code: 'computer-cancelled' }); await cancelled.done
})

/** A remote harness server's attachment ledger, transport and authenticated listener, with the proxy on the same root. */
async function remoteHarness(t, directory, proxyOptions) {
  const root = new Context()
  const inputs = { now: () => new Date().toISOString(), newId: (() => { let n = 0; return () => `remote-${++n}` })() }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'remote.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'remote-images') }))
  await root.installComponent(createHostAccessComponent('remote harness'))
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [{ unitKind: 'models', unitId: localModelsUnitId }] }))
  await root.installComponent(createUnitTransportComponent(inputs))
  const access = root.get(hostAccessServiceKey), units = root.get(unitAttachmentsServiceKey), transport = root.get(unitTransportServiceKey), images = root.get(imageAssetsServiceKey)
  const commands = { instanceId: () => access.instance.instanceId, listAgents: () => [],
    listUnitAttachments: () => units.list(), createUnitAttachCode: input => units.createAttachCode(input), revokeUnitAttachment: id => units.revoke(id),
    attachUnit: input => units.attach(input), authenticateUnit: header => transport.authenticate(header),
    pollUnit: (id, registration, signal) => transport.poll(id, registration, signal), replyUnit: (id, replies) => transport.reply(id, replies),
    importImage: (scope, bytes, signal) => images.importImage({ scopeId: scope, bytes }, signal) }
  const web = await startHarnessServerHttp(commands, 0, { access })
  t.after(async () => { await web.close(); await root.fiber.dispose() })
  const { code } = await units.createAttachCode({ unitKind: 'computer', scope: fullScope('computer') })
  const { memory, openEntry } = memoryEntries()
  const worker = await openComputerWorker(join(directory, 'unit-worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200 } })
  const local = connectLocalComputerWorker({ directory: join(directory, 'unit-worker') })
  t.after(async () => { await local.closeObserver(); await worker.close() })
  const attached = await local.control.consumeAttachCode({ harnessUrl: web.url, code, ceiling: fullScope('computer') })
  await until(() => transport.connection(attached.attachmentId)?.connected, 'unit polls')
  const proxyFiber = root.installComponent(createWorkerRouterComponent({ local: false, ...proxyOptions })); await proxyFiber
  return { root, web, units, transport, worker, local, attached, memory, proxyFiber, inputs, images }
}

test('the router routes by attachment and its Effect abandons only local observations while the unit keeps executing', { skip: !unix, timeout: 120_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-unit-proxy-effect-')))
  const f = await remoteHarness(t, directory)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const worker = f.root.get(computerWorkerServiceKey)
  const activation = f.root.get(computerInstanceProviderServiceKey).activate({ resource: { computerId: unitComputerId(f.attached.attachmentId), spec, activationRevision: 1, createdAt: 'now' }, activationId: 'a' })
  assert.deepEqual(await activation.result, { providerRef: `${f.worker.endpoint.workerId}:${f.worker.endpoint.bootId}`, platform: process.platform, architecture: process.arch }); await activation.done
  // The read-only query surface answers from the unit under its ceiling and never touches the operation ledger.
  const listed = await worker.query({ attachmentId: f.attached.attachmentId, query: { kind: 'list', root: directory, path: '' } })
  assert.equal(listed.kind, 'list'); assert.ok(listed.entries.some(entry => entry.name === 'unit-worker' && entry.kind === 'directory'))
  const stat = await worker.query({ attachmentId: f.attached.attachmentId, query: { kind: 'stat', path: directory } })
  assert.deepEqual(stat, { kind: 'stat', directory: true, canonical: directory })
  assert.deepEqual(await worker.query({ attachmentId: f.attached.attachmentId, query: { kind: 'stat', path: join(directory, 'missing') } }), { kind: 'stat', directory: false, canonical: null })
  await assert.rejects(worker.query({ attachmentId: f.attached.attachmentId, query: { kind: 'read', root: directory, path: '../escape' } }), { code: 'file-invalid', name: 'ProjectFileError' })
  const owner = { runId: 'remote-run', runOwnerEpoch: 1, attachmentId: f.attached.attachmentId }
  await worker.claimRun(owner); await worker.claimRun(owner)
  const entry = getToolById('anybox.bash')
  const binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: unitComputerId(f.attached.attachmentId), computerInstanceId: `${f.worker.endpoint.workerId}:${f.worker.endpoint.bootId}`, instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path: directory, preparedAt: 'now' }
  const declaration = { schemaVersion: 1, operationId: 'slow', runId: owner.runId, sessionId: 'session', projectId: 'project', tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
    request: { id: 'call-slow', name: 'bash', arguments: { command: 'sleep 1; echo finished > slow.txt; cat slow.txt' } }, workspaceId: 'workspace', workspaceRevision: 0, computerId: binding.computerId, spec }
  const submission = { ...owner, operationId: 'slow', kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: f.worker.endpoint.bootId }
  const accepted = await worker.submit(submission)
  assert.equal(accepted.state, 'queued')
  const retried = await worker.submit(submission)
  assert.equal(retried.receipt, accepted.receipt, 'retries return the original receipt through the transport'); assert.equal(retried.declarationDigest, accepted.declarationDigest)
  const observing = worker.get({ ...owner, operationId: 'slow' })
  await f.proxyFiber.dispose()
  await assert.rejects(observing, { code: 'worker-observer-closed' })
  await assert.rejects(worker.get({ ...owner, operationId: 'slow' }), { code: 'worker-observer-closed' })
  await until(async () => existsSync(join(directory, 'slow.txt')), 'the unit keeps executing after the proxy is gone')
  const again = f.root.installComponent(createWorkerRouterComponent({ local: false })); await again
  const replacement = f.root.get(computerWorkerServiceKey)
  let fact = await replacement.get({ ...owner, operationId: 'slow' })
  while (!terminal(fact.state)) fact = await replacement.get({ ...owner, operationId: 'slow' })
  assert.equal(fact.state, 'succeeded'); assert.equal(fact.receipt, accepted.receipt); assert.equal(fact.executeCount, 1)
  assert.equal(fact.observation.result.stdout, 'finished\n')
  await assert.rejects(replacement.get({ ...owner, attachmentId: 'other', operationId: 'slow' }), { code: 'worker-unreachable' }, 'another attachment has no unit behind it')
  await assert.rejects(f.local.get({ ...owner, attachmentId: 'local:computer', operationId: 'slow' }), { code: 'worker-owner-rejected' })

  // Byte channel: a tool image is pushed to the harness server before the fact is reported; only the receipt crosses the network.
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  await writeFile(join(directory, 'image.png'), png)
  const imageOwner = { runId: 'image-run', runOwnerEpoch: 1, attachmentId: f.attached.attachmentId }
  await replacement.claimRun(imageOwner)
  const view = getToolById('codex.view_image')
  const imageDeclaration = { ...declaration, operationId: 'image', runId: imageOwner.runId, tool: { toolId: view.toolId, version: view.version, definition: view.definition },
    request: { id: 'call-image', name: view.definition.name, arguments: { path: 'image.png' } } }
  const imageSubmission = { ...imageOwner, operationId: 'image', kind: 'tool', declaration: imageDeclaration, declarationDigest: computerDeclarationDigest(imageDeclaration),
    binding: { ...binding, scopeId: imageOwner.runId, bindingId: 'image-binding', reservationId: 'image-reservation' }, imageInput: true, workerBootId: f.worker.endpoint.bootId }
  let imageFact = await replacement.submit(imageSubmission)
  while (!terminal(imageFact.state)) imageFact = await replacement.get({ ...imageOwner, operationId: 'image' })
  assert.equal(imageFact.state, 'succeeded', JSON.stringify(imageFact.error ?? null))
  assert.equal(imageFact.sessionId, 'session')
  assert.equal(imageFact.images.length, 1)
  const [delivered] = imageFact.images
  assert.equal(delivered.base64, undefined, 'no base64 crosses the unit transport')
  const sha256 = createHash('sha256').update(png).digest('hex')
  assert.deepEqual(delivered.pushed, { assetId: delivered.pushed.assetId, sha256, byteLength: png.byteLength, mimeType: 'image/png' })
  assert.equal(delivered.ref.sha256, sha256)
  const [described] = await f.images.describe('session', [delivered.pushed.assetId])
  assert.equal(described.sha256, sha256); assert.equal(described.byteLength, png.byteLength); assert.equal(typeof described.expiresAt, 'string', 'the pushed bytes are a draft until the Run retains them')
  const stored = await f.images.readImage('session', delivered.pushed.assetId)
  assert.deepEqual(Buffer.from(await stored.result), png); await stored.done
  const again2 = await replacement.get({ ...imageOwner, operationId: 'image' })
  assert.deepEqual(again2.images[0].pushed, delivered.pushed, 'repeated facts quote the same receipt instead of pushing again')
  const read = await replacement.query({ attachmentId: f.attached.attachmentId, query: { kind: 'read', root: directory, path: 'slow.txt' } })
  assert.equal(read.kind, 'read'); assert.equal(read.preview.text, 'finished\n'); assert.equal(read.preview.canReference, true)
  const found = await replacement.query({ attachmentId: f.attached.attachmentId, query: { kind: 'search', root: directory, query: 'slow' } })
  assert.deepEqual(found, { kind: 'search', search: { paths: ['slow.txt'], incomplete: false } })
  const bytesRoute = await fetch(`${f.web.url}/api/v1/apps/agent/units/unit/bytes?scope=session`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-anybox-sha256': sha256, 'x-anybox-byte-length': String(png.byteLength) }, body: png })
  assert.equal(bytesRoute.status, 401, 'the byte channel requires the unit credential')
})

test('a harness server in the remote Computer form runs Bash and Apply Patch on an attached worker and fails admission while the unit is offline', { skip: !unix, timeout: 180_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-unit-proxy-run-')))
  const projectDirectory = join(directory, 'project'); await mkdir(projectDirectory)
  const root = new Context()
  const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Execute tools with their declared contracts.' }]
  let script = []
  const models = controlledModels({ call(input) {
    const result = (async () => {
      // Later Runs carry earlier tool results in their history; only a tool result at the tail answers the current call.
      if (input.messages.at(-1)?.role === 'tool') return { status: 'completed', text: 'done', toolCalls: [] }
      const next = script.shift()
      return next ? { status: 'completed', text: '', toolCalls: [next] } : { status: 'completed', text: 'nothing', toolCalls: [] }
    })()
    void result.catch(() => {})
    return { result, done: Promise.resolve(), cancel() {} }
  } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(models.component())
  await root.installComponent(createHostAccessComponent('remote harness'))
  const localWorkerDirectory = join(directory, 'never-started-local-worker')
  let core = await installHarnessServerCore(root, { agents, localWorkerDirectory })
  const httpFiber = root.installComponent(createFixtureApplicationApiComponent(root, core.api.listAgents(), 0, { authenticated: true })); await httpFiber
  const web = root.get(hostHttpServiceKey)
  const { memory, openEntry } = memoryEntries()
  let worker = await openComputerWorker(join(directory, 'unit-worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200 } })
  const local = connectLocalComputerWorker({ directory: join(directory, 'unit-worker') })
  t.after(async () => {
    try { await core.close() } finally {
      await local.closeObserver(); await worker.close().catch(() => {}); await httpFiber.dispose(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true })
    }
  })
  const { code } = await core.api.createUnitAttachCode({ unitKind: 'computer', scope: fullScope('computer') })
  const attached = await local.control.consumeAttachCode({ harnessUrl: web.url, code, ceiling: fullScope('computer') })
  await until(() => root.get(unitTransportServiceKey).connection(attached.attachmentId)?.connected, 'unit polls the local-form harness server')
  // Reassemble in the remote form, as a restart with ANYBOX_COMPUTER_UNIT=remote would.
  await core.close()
  assert.equal(existsSync(localWorkerDirectory), false, 'the local form never started its own worker')
  core = await installHarnessServerCore(root, { agents, localWorkerDirectory, computerUnit: { kind: 'remote', attachmentId: attached.attachmentId, claimTimeoutMs: 400 } })
  assert.equal(root.get(localComputerWorkerControlServiceKey), undefined, 'the remote form has no local worker')
  assert.equal(root.get(computerInstanceProviderServiceKey).providerId, 'unit')
  await assert.rejects(root.get(unitAttachmentsServiceKey).local('computer'), { code: 'unit-attachment-missing' }, 'the remote form declares no local Computer unit; the earlier local-form row stays in the ledger')
  await until(() => root.get(unitTransportServiceKey).connection(attached.attachmentId)?.connected, 'unit reconnects to the reassembled transport')
  const api = core.api
  const selection = await api.getAgentTools('assistant')
  await api.setAgentTools('assistant', { toolIds: ['anybox.bash', 'anybox.apply_patch'], expectedRevision: selection.revision })
  assert.deepEqual(await root.get(computerWorkerServiceKey).query({ attachmentId: attached.attachmentId, query: { kind: 'stat', path: projectDirectory } }), { kind: 'stat', directory: true, canonical: projectDirectory })
  const project = await api.openProject(projectDirectory), session = await api.createSession(project.id, 'assistant')
  assert.equal(project.computerAttachmentId, attached.attachmentId, 'the remote form binds new projects to its configured attachment by default')
  assert.equal((await api.listProjects()).find(item => item.id === project.id).available, true, 'availability is answered by the unit')

  script = [{ id: 'call-bash', name: 'bash', arguments: { command: 'printf remote > out.txt; cat out.txt' } }]
  const first = await api.startRun({ sessionId: session.id, parentNodeId: null, input: 'run bash', idempotencyKey: 'bash' })
  assert.equal(first.units.computer.attachmentId, attached.attachmentId)
  const bashRun = await api.waitRun(first.id)
  const diagnostics = async () => JSON.stringify({ error: bashRun.error ?? null, events: await api.getRunEvents(first.id),
    operations: await root.get('local-storage').read(reader => reader.all('SELECT operation_id, state, error_json, binding_json FROM harness_computer_operations')) })
  assert.equal(bashRun.status, 'completed', await diagnostics())
  assert.equal(await readFile(join(projectDirectory, 'out.txt'), 'utf8'), 'remote')
  const bashEvents = await api.getRunEvents(first.id)
  assert.ok(bashEvents.some(event => event.kind === 'tool-observed' && event.name === 'bash' && event.result.stdout === 'remote'))
  // Project files of a remote-bound project are searched, previewed, prepared and browsed through the unit's query surface.
  const joinedCall = async call => { try { return await call.result } finally { await call.done } }
  assert.deepEqual(await joinedCall(api.searchProjectFiles(session.id, 'out')), { paths: ['out.txt'], incomplete: false })
  const preview = await joinedCall(api.previewProjectFile(session.id, { kind: 'project-file', path: 'out.txt' }))
  assert.equal(preview.text, 'remote'); assert.equal(preview.canReference, true)
  const [prepared] = await joinedCall(api.prepareProjectFiles(session.id, 'remote-key', [{ kind: 'project-file', path: 'out.txt' }]))
  assert.equal(prepared.path, 'out.txt'); assert.equal(prepared.byteLength, 6)
  const snapshot = await joinedCall(api.getFileSnapshot(session.id, prepared.snapshotId))
  assert.equal(snapshot.text, 'remote', 'the captured bytes came through the unit and are stored on the harness server')
  const tree = await joinedCall(api.openProjectFileTree(session.id, '', 'owner'))
  assert.ok(tree.entries.some(entry => entry.path === 'out.txt' && entry.kind === 'file'), JSON.stringify(tree))
  await api.closeProjectFileTree(session.id, 'owner', tree.cursorId)
  const computers = await root.get(computerServiceKey).list()
  assert.deepEqual(computers.map(c => [c.computerId, c.spec]), [[unitComputerId(attached.attachmentId), spec]])

  script = [{ id: 'call-patch', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** Add File: patched.txt\n+from the remote unit\n*** End Patch\n' } }]
  const second = await api.startRun({ sessionId: session.id, parentNodeId: bashRun.resultNodeId, input: 'patch', idempotencyKey: 'patch' })
  const patchRun = await api.waitRun(second.id)
  assert.equal(patchRun.status, 'completed', JSON.stringify(patchRun.error ?? null))
  const patchEvents = await api.getRunEvents(second.id)
  assert.ok(patchEvents.some(event => event.kind === 'tool-observed' && event.name === 'apply_patch'), JSON.stringify(patchEvents))
  assert.equal(await readFile(join(projectDirectory, 'patched.txt'), 'utf8'), 'from the remote unit\n', JSON.stringify(patchEvents))
  assert.equal(memory.size, 1, 'the credential stays in the unit\'s credential namespace')

  // Unit offline: the project it serves is unavailable, so Run admission is refused at once instead of waiting on the unit.
  await local.closeObserver(); await worker.close()
  await until(() => !root.get(unitTransportServiceKey).connection(attached.attachmentId)?.connected, 'the transport notices the unit is gone', 60_000)
  script = [{ id: 'call-offline', name: 'bash', arguments: { command: 'touch never.txt' } }]
  const refusedAt = Date.now()
  await assert.rejects(api.startRun({ sessionId: session.id, parentNodeId: patchRun.resultNodeId, input: 'offline', idempotencyKey: 'offline' }), { code: 'project-unavailable' })
  assert.ok(Date.now() - refusedAt < 2_000, 'an offline unit is reported without waiting for a claim window')
  assert.equal((await api.listProjects()).find(item => item.id === project.id).available, false)
  assert.equal(existsSync(join(projectDirectory, 'never.txt')), false)
  // The unit returns: a later Run finds it again through the same attachment.
  worker = await openComputerWorker(join(directory, 'unit-worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200 } })
  await until(() => { const c = root.get(unitTransportServiceKey).connection(attached.attachmentId); return c?.connected && c.bootId === worker.endpoint.bootId }, 'unit returns')
  script = [{ id: 'call-back', name: 'bash', arguments: { command: 'printf back > back.txt' } }]
  const fourth = await api.startRun({ sessionId: session.id, parentNodeId: patchRun.resultNodeId, input: 'back', idempotencyKey: 'back' })
  const back = await api.waitRun(fourth.id)
  assert.equal(back.status, 'completed', JSON.stringify(back.error ?? null))
  assert.equal(await readFile(join(projectDirectory, 'back.txt'), 'utf8'), 'back')
})

test('the local form serves local projects over loopback and remote-bound projects through their unit', { skip: !unix, timeout: 180_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-router-mixed-')))
  const localProject = join(directory, 'local-project'), remoteProject = join(directory, 'remote-project'), outside = join(directory, 'outside')
  await mkdir(localProject); await mkdir(remoteProject); await mkdir(outside)
  const root = new Context()
  const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Execute tools with their declared contracts.' }]
  let script = []
  const models = controlledModels({ call(input) {
    const result = (async () => {
      if (input.messages.at(-1)?.role === 'tool') return { status: 'completed', text: 'done', toolCalls: [] }
      const next = script.shift()
      return next ? { status: 'completed', text: '', toolCalls: [next] } : { status: 'completed', text: 'nothing', toolCalls: [] }
    })()
    void result.catch(() => {})
    return { result, done: Promise.resolve(), cancel() {} }
  } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(models.component())
  await root.installComponent(createHostAccessComponent('mixed harness'))
  const localWorkerDirectory = join(directory, 'local-worker')
  const core = await installHarnessServerCore(root, { agents, localWorkerDirectory, computerUnit: { kind: 'local', claimTimeoutMs: 2_000 } })
  const httpFiber = root.installComponent(createFixtureApplicationApiComponent(root, core.api.listAgents(), 0, { authenticated: true })); await httpFiber
  const web = root.get(hostHttpServiceKey)
  const { openEntry } = memoryEntries()
  const unit = await openComputerWorker(join(directory, 'unit-worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200 } })
  const unitControl = connectLocalComputerWorker({ directory: join(directory, 'unit-worker') })
  t.after(async () => {
    try { await core.close() } finally {
      await unitControl.closeObserver(); await unit.close().catch(() => {})
      const localWorker = connectLocalComputerWorker({ directory: localWorkerDirectory })
      await localWorker.shutdown().catch(() => {}); await localWorker.closeObserver()
      await httpFiber.dispose(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true })
    }
  })
  const ceiling = { kind: 'computer', projects: [remoteProject], tools: 'all' }
  const { code } = await core.api.createUnitAttachCode({ unitKind: 'computer', scope: ceiling })
  const attached = await unitControl.control.consumeAttachCode({ harnessUrl: web.url, code, ceiling })
  await until(() => root.get(unitTransportServiceKey).connection(attached.attachmentId)?.connected, 'unit polls')
  const api = core.api
  const selection = await api.getAgentTools('assistant')
  await api.setAgentTools('assistant', { toolIds: ['anybox.bash'], expectedRevision: selection.revision })
  // Projects bind to a Computer attachment; the same path on different units is two projects, and the unit's ceiling applies to remote ones.
  const local = await api.openProject(localProject)
  assert.equal(local.computerAttachmentId, 'local:computer')
  const remote = await api.openProject(remoteProject, { computerAttachmentId: attached.attachmentId })
  assert.equal(remote.computerAttachmentId, attached.attachmentId); assert.equal(remote.path, remoteProject); assert.equal(remote.available, true)
  await assert.rejects(api.openProject(outside, { computerAttachmentId: attached.attachmentId }), { code: 'project-unavailable' }, 'the unit refuses directories outside its ceiling')
  await assert.rejects(api.openProject(remoteProject, { computerAttachmentId: 'nope' }), { code: 'project-unavailable' })
  const sameLocal = await api.openProject(remoteProject)
  assert.notEqual(sameLocal.id, remote.id); assert.equal(sameLocal.computerAttachmentId, 'local:computer')
  assert.equal(existsSync(localWorkerDirectory), false, 'registering and listing projects never starts the local worker')
  // Runs execute on the worker of their project's binding.
  const localSession = await api.createSession(local.id, 'assistant'), remoteSession = await api.createSession(remote.id, 'assistant')
  script = [{ id: 'call-local', name: 'bash', arguments: { command: 'printf local > where.txt' } }]
  const localRun = await api.waitRun((await api.startRun({ sessionId: localSession.id, parentNodeId: null, input: 'go', idempotencyKey: 'local' })).id)
  assert.equal(localRun.status, 'completed', JSON.stringify(localRun.error ?? null)); assert.equal(localRun.units.computer.attachmentId, 'local:computer')
  assert.equal(await readFile(join(localProject, 'where.txt'), 'utf8'), 'local')
  assert.equal(existsSync(join(localWorkerDirectory, 'worker.sqlite')), true, 'the local Run ran on this harness server\'s own worker')
  script = [{ id: 'call-remote', name: 'bash', arguments: { command: 'printf remote > where.txt' } }]
  const remoteRun = await api.waitRun((await api.startRun({ sessionId: remoteSession.id, parentNodeId: null, input: 'go', idempotencyKey: 'remote' })).id)
  assert.equal(remoteRun.status, 'completed', JSON.stringify(remoteRun.error ?? null)); assert.equal(remoteRun.units.computer.attachmentId, attached.attachmentId)
  assert.equal(await readFile(join(remoteProject, 'where.txt'), 'utf8'), 'remote')
  const computers = await root.get(computerServiceKey).list()
  assert.deepEqual(computers.map(c => [c.computerId, c.spec.providerId]).sort(), [['local', 'local'], [unitComputerId(attached.attachmentId), 'unit']])
  // Reads of the remote-bound project go through the unit as well.
  const joinedCall = async call => { try { return await call.result } finally { await call.done } }
  assert.deepEqual(await joinedCall(api.searchProjectFiles(remoteSession.id, 'where')), { paths: ['where.txt'], incomplete: false })
  assert.equal((await joinedCall(api.previewProjectFile(remoteSession.id, { kind: 'project-file', path: 'where.txt' }))).text, 'remote')
})

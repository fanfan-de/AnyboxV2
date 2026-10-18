import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { failure, json } from '@anybox/application-api/node'
import { createApplicationCatalog } from '../dist/applications/registration.js'
import { startApplicationHttpServer } from '../dist/http-server.js'
import { createApplicationArchive } from '../dist/package-management/archive.js'
import { encodeApplicationDirectory } from '../dist/package-management/directory-format.js'
import { createMinimumHost } from '../dist/main.js'

const base = '/api/client/v1/app-packages'
const identity = { appId: 'calculator', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }
const time = '2026-10-17T00:00:00.000Z'
const job = (phase = 'accepted', extra = {}) => ({ id: 'install-1', requestId: 'request-1', filename: 'calculator.anybox-app', archiveDigest: createHash('sha256').update('zip').digest('hex'), archiveSize: 3,
  expectedAppRevision: null, revision: 1, phase, identity: null, operationId: null, existingInstallation: false, workGuardIds: ['install-private-guard'], receipt: { path: '/private/server/staging', secret: 'PRIVATE_TOKEN' }, errorCode: null, recovery: null, createdAt: time, updatedAt: time, ...extra })
const intent = { requestId: 'request-1', filename: 'calculator.anybox-app', archiveDigest: createHash('sha256').update('zip').digest('hex'), archiveSize: 3 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function listener(t, input = {}) {
  let current = input.access
  const calls = { resolutions: 0, accept: [], receive: [], cancel: [], recover: [] }
  const installer = input.installer ?? {
    list: async () => [job()], get: async id => id === 'install-1' ? job() : undefined,
    accept: async value => { calls.accept.push(value); return job() },
    receive: async (id, request, options) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); calls.receive.push({ id, bytes: Buffer.concat(chunks), options }); return job('installed', { identity }) },
    cancel: async id => { calls.cancel.push(id); return job('cancelled') }, recover: async (id, value) => { calls.recover.push({ id, value }); return job('recovery-required', { errorCode: 'installation-work-exit-unconfirmed', recovery: { from: 'verifying', reason: 'owner-restarted' } }) },
  }
  const registry = { inspect: async () => ({ applications: [], actual: [{ snapshot: 'PRIVATE_SNAPSHOT' }] }), listFileInstalls: async () => [job()] }
  if (current === undefined && input.manager !== false) current = { registry, installer, trustedPublisherCount: 1 }
  const server = await startApplicationHttpServer({ catalog: input.catalog ?? createApplicationCatalog([]), service: input.service ?? (() => undefined), base: input.base ?? '/api/client/v1',
    access: input.hostAccess, transportSecret: input.transportSecret, packageManagement: () => { calls.resolutions++; return current } })
  t.after(() => server.close())
  async function call(path = base, options = {}) {
    const headers = { ...(options.method && options.method !== 'GET' ? { Origin: server.url } : {}), ...options.headers }
    const response = await fetch(server.url + path, { ...options, headers }); return { response, data: await response.json() }
  }
  return { server, calls, installer, registry, call, setAccess(value) { current = value } }
}

test('an unavailable manager reports empty lifecycle status without exposing another service', async t => {
  const f = await listener(t, { manager: false })
  const { response, data } = await f.call()
  assert.equal(response.status, 200); assert.deepEqual(data, { available: false, trustedPublisherCount: 0, registryRevision: 0, browserLifecycleAvailable: false, lifecycleAvailable: false, actual: [], installations: [], operations: [], activations: [] })
  const denied = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent) })
  assert.equal(denied.response.status, 503); assert.equal(denied.data.error.code, 'package-installation-unavailable')
})

test('status and operation reads project only public installation facts and resolve services afresh', async t => {
  const f = await listener(t)
  f.setAccess({ trustedPublisherCount: 2, registry: { inspect: async () => ({ applications: [{ appId: 'calculator', revision: 2, installed: [{ identity, state: 'installed', installedAt: time, operationId: 'PRIVATE_OPERATION', source: { kind: 'file', reference: '/private/archive', publisher: 'fixture' } }], selected: null, pending: identity }], actual: ['PRIVATE_ACTUAL'] }), listFileInstalls: async () => [] }, installer: {
    ...f.installer, list: async () => [job('recovery-required', { identity, errorCode: 'installation-work-exit-unconfirmed', recovery: { from: 'verifying', reason: 'owner-restarted' } }), job('accepted', { id: 'install-2', requestId: 'request-2' })],
  } })
  const { data } = await f.call()
  assert.equal(data.available, true); assert.equal(data.trustedPublisherCount, 2)
  assert.deepEqual(data.installations[0].installed[0].source, { publisher: 'fixture' })
  assert.deepEqual(data.operations[0].error, { code: 'installation-work-exit-unconfirmed' })
  assert.deepEqual(data.installations[0].pending, identity); assert.equal(data.installations[0].selected, null)
  const serialized = JSON.stringify(data)
  assert.doesNotMatch(serialized, /PRIVATE_|\/private\/|workGuardIds|receipt/)
  const filtered = await f.call(`${base}?requestId=request-2`); assert.deepEqual(filtered.data.operations.map(item => item.id), ['install-2'])
  f.setAccess(undefined); assert.equal((await f.call()).data.available, false)
  assert.equal(f.calls.resolutions, 3)
})

test('strict install schemas reject server paths, URLs, policy, malformed metadata and unsupported queries before acceptance', async t => {
  const f = await listener(t)
  for (const change of [{ path: '/etc/package' }, { url: 'https://external.test/x' }, { verification: {} }, { trustedPublishers: [] }, { requestId: '../unsafe' }, { filename: '../x.anybox-app' }, { filename: 'file.zip' }, { archiveDigest: 'bad' }, { archiveSize: '3' }, { archiveSize: -1 }, { expectedAppRevision: -1 }, { sourceFormat: 'git' }, { sourceFormat: null }, { localTrust: true }, { sourceFormat: 'directory', localTrust: 'yes' }, { sourceFormat: 'directory', filename: '/server/app', localTrust: true }]) {
    const rejected = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...intent, ...change }) })
    assert.equal(rejected.response.status, 400, JSON.stringify(change))
  }
  assert.equal(f.calls.accept.length, 0)
  assert.equal((await f.call(`${base}?path=/private`)).response.status, 400)
  assert.equal((await f.call(`${base}?requestId=a&requestId=b`)).response.status, 400)
  assert.equal((await f.call(`${base}/operations/install-1?path=ignored`)).response.status, 400)
  assert.equal((await f.call(`${base}/operations/%2Funsafe`)).response.status, 400)
  assert.equal((await f.call(`${base}/operations/%ZZ`)).response.status, 400)
  const tooLarge = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...intent, archiveSize: 256 * 1024 * 1024 + 1 }) })
  assert.equal(tooLarge.response.status, 413)
})

test('directory acceptance carries only a browser-content format and explicit local trust without accepting a server path', async t => {
  const f = await listener(t), input = { ...intent, filename: 'calculator', sourceFormat: 'directory', localTrust: true }
  const accepted = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(accepted.response.status, 202); assert.deepEqual(f.calls.accept, [input])
  const uploaded = await f.call(`${base}/operations/install-1/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('zip') })
  assert.equal(uploaded.response.status, 202); assert.equal(f.calls.receive.length, 1)
  for (const extra of [{ path: '/server/app' }, { url: 'https://external.invalid/repo' }, { command: 'npm run build' }]) {
    const rejected = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, ...extra }) })
    assert.equal(rejected.response.status, 400)
  }
  assert.equal(f.calls.accept.length, 1)
})

test('acceptance, raw upload, reads, cancellation and explicit recovery stay in the lifecycle API', async t => {
  const f = await listener(t)
  const accepted = await f.call(`${base}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent) })
  assert.equal(accepted.response.status, 202); assert.equal(accepted.data.phase, 'accepted'); assert.deepEqual(f.calls.accept, [intent])
  const uploaded = await f.call(`${base}/operations/install-1/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('zip') })
  assert.equal(uploaded.response.status, 202); assert.equal(uploaded.data.phase, 'installed'); assert.deepEqual(f.calls.receive[0].bytes, Buffer.from('zip'))
  const read = await f.call(`${base}/operations/install-1`); assert.equal(read.response.status, 200); assert.equal(read.data.id, 'install-1'); assert.equal('receipt' in read.data, false)
  assert.equal((await f.call(`${base}/operations/unknown`)).response.status, 404)
  const cancelled = await f.call(`${base}/operations/install-1/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(cancelled.data.phase, 'cancelled')
  for (const action of ['inspect', 'resume', 'discard']) assert.equal((await f.call(`${base}/operations/install-1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })).response.status, 200)
  assert.deepEqual(f.calls.cancel, ['install-1']); assert.deepEqual(f.calls.recover.map(item => item.value.action), ['inspect', 'resume', 'discard'])
  assert.equal((await f.call(`${base}/operations/install-1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"resume","path":"/private"}' })).response.status, 400)
  assert.equal((await f.call(`${base}/operations/install-1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).response.status, 400)
})

test('upload rejects multipart, encoded bytes and a declared size mismatch before consuming the installer', async t => {
  const f = await listener(t)
  for (const headers of [{ 'Content-Type': 'multipart/form-data' }, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }]) {
    assert.equal((await f.call(`${base}/operations/install-1/archive`, { method: 'PUT', headers, body: 'zip' })).response.status, 415)
  }
  assert.equal((await f.call(`${base}/operations/install-1/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'longer' })).response.status, 400)
  assert.equal(f.calls.receive.length, 0)
})

test('Host, Origin, fetch metadata and desktop transport reject package requests before service resolution', async t => {
  const secret = 'private-transport', f = await listener(t, { transportSecret: secret })
  for (const headers of [{}, { 'X-Anybox-Desktop-Transport': 'wrong' }, { 'X-Anybox-Desktop-Transport': secret, Origin: 'https://external.invalid' }, { 'X-Anybox-Desktop-Transport': secret, 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.call(base, { headers })).response.status, 403, JSON.stringify(headers))
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(f.server.url + base, { headers: { 'X-Anybox-Desktop-Transport': secret, Host: 'external.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) }); request.on('error', reject); request.end()
  })
  assert.equal(wrongHost, 403)
  assert.equal(f.calls.resolutions, 0)
  const valid = await f.call(base, { headers: { 'X-Anybox-Desktop-Transport': secret } }); assert.equal(valid.response.status, 200)
  const missingOrigin = await fetch(f.server.url + `${base}/operations`, { method: 'POST', headers: { 'X-Anybox-Desktop-Transport': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(intent) })
  assert.equal(missingOrigin.status, 403); await missingOrigin.body.cancel(); assert.equal(f.calls.resolutions, 1)
})

test('execution listeners and unit self-authentication cannot enter the client package manager', async t => {
  const execution = await listener(t, { base: '/api/v1' })
  assert.equal((await execution.call(base)).response.status, 404); assert.equal(execution.calls.resolutions, 0)
  let principal
  const catalog = createApplicationCatalog([{ definition: { id: 'probe', name: 'Probe', icon: 'probe' }, createRuntime() { throw Error('not opened') }, http: { service: 'probe.http', selfAuthenticated: ['/unit'] } }])
  const f = await listener(t, { catalog, hostAccess: { instance: { instanceId: 'instance' }, onRevoked: () => () => {}, authenticate() { throw failure(401, 'authentication-required') } }, service: () => ({ async handle(_request, response, _url, context) { principal = context.principal; json(response, 200, { ok: true }) } }) })
  assert.equal((await f.call('/api/client/v1/apps/probe/unit/app-packages')).response.status, 200); assert.equal(principal, 'unit')
  assert.equal((await f.call(base)).response.status, 401); assert.equal(f.calls.resolutions, 0)
})

test('a body-complete upload survives response disconnect and remains observable without repeated receive', { timeout: 5000 }, async t => {
  const received = deferred(), exit = deferred(), done = deferred(); let current = job(), receives = 0
  t.after(() => exit.resolve())
  const f = await listener(t, { installer: { list: async () => [current], get: async () => current, async receive(_id, request, options) {
    receives++; for await (const _chunk of request) {} current = job('verifying'); received.resolve()
    await exit.promise; assert.equal(options.signal.aborted, false); current = job('installed', { identity }); done.resolve(); return current
  } } })
  const upload = httpRequest(f.server.url + `${base}/operations/install-1/archive`, { method: 'PUT', headers: { Origin: f.server.url, 'Content-Type': 'application/octet-stream', 'Content-Length': '3' } })
  upload.on('error', () => {}); upload.end('zip')
  await received.promise; upload.destroy()
  assert.equal((await f.call()).data.operations[0].phase, 'verifying'); assert.equal(receives, 1)
  exit.resolve(); await done.promise
  assert.equal((await f.call()).data.operations[0].phase, 'installed'); assert.equal(receives, 1)
})

test('cancel response waits for the installer actual exit and keeps its accepted request singular', async t => {
  const entered = deferred(), exit = deferred(); let cancelled = 0
  t.after(() => exit.resolve())
  const f = await listener(t, { installer: { async cancel() { cancelled++; entered.resolve(); await exit.promise; return job('cancelled') } } })
  let responded = false
  const request = f.call(`${base}/operations/install-1/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(value => { responded = true; return value })
  await entered.promise; await tick(); assert.equal(responded, false)
  exit.resolve(); assert.equal((await request).data.phase, 'cancelled'); assert.equal(cancelled, 1)
})

test('a real signed local-file upload persists only installed and pending facts without selecting or starting an app', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-http-file-install-'))
  let host
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }) })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), target = { os: process.platform, arch: process.arch }
  const bytes = createApplicationArchive({ manifest: { schemaVersion: 1, appId: 'calculator', version: '1.0.0', displayName: 'Calculator', publisher: 'http-fixture', applicationApi: '^0.1.0', target, web: { entry: 'payload/app.js', assets: 'payload/assets.json' } },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/app.js', bytes: Buffer.from('export async function mount(){throw Error("UI must never open during install")}') }, { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/calculator/1.0.0/app.js', file: 'payload/app.js', type: 'text/javascript' }] })) }], keyId: 'fixture', privateKey })
  host = await createMinimumHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0, packageTrustPolicy: { trustedPublishers: [{ publisher: 'http-fixture', keyId: 'fixture', publicKey, appIds: ['calculator'] }] } })
  const initial = await (await fetch(host.url + base)).json()
  assert.equal(initial.available, true); assert.equal(initial.trustedPublisherCount, 1); assert.deepEqual(initial.installations, [])
  const request = { requestId: 'signed-http-install', filename: 'calculator.anybox-app', archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length }
  const accepted = await fetch(host.url + `${base}/operations`, { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  assert.equal(accepted.status, 202); const operation = await accepted.json()
  const uploaded = await fetch(host.url + `${base}/operations/${operation.id}/archive`, { method: 'PUT', headers: { Origin: host.url, 'Content-Type': 'application/octet-stream' }, body: bytes })
  assert.equal(uploaded.status, 202); assert.equal((await uploaded.json()).phase, 'installed')
  const status = await (await fetch(host.url + base)).json()
  assert.equal(status.installations.length, 1); assert.equal(status.installations[0].selected, null); assert.equal(status.installations[0].pending.appId, 'calculator')
  assert.equal(status.installations[0].installed[0].state, 'installed'); assert.equal(status.operations[0].phase, 'installed')
  const facts = await host.packages.inspect(); assert.deepEqual(facts.actual, []); assert.deepEqual(host.products.list(), [])
  for (const service of ['models', 'models.settings', 'harness.sessions', 'harness.runs', 'client.connections']) assert.equal(host.root.get(service), undefined)
})

test('a real explicitly trusted folder upload installs without publisher keys or a signature and stays closed', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-http-directory-install-')); let host
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }) })
  const target = { os: process.platform, arch: process.arch }, manifest = { schemaVersion: 1, appId: 'calculator', version: '1.0.0', displayName: 'Calculator', publisher: 'local-agent', applicationApi: '^0.1.0', target, web: { entry: 'payload/app.js', assets: 'payload/assets.json' } }
  const entries = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
    { path: 'licenses/LICENSE', bytes: Buffer.from('MIT') },
    { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') },
    { path: 'payload/app.js', bytes: Buffer.from('export async function mount(){throw Error("UI must stay closed during install")}') },
    { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/calculator/1.0.0/app.js', file: 'payload/app.js', type: 'text/javascript' }] })) },
  ]
  const bytes = encodeApplicationDirectory(entries)
  host = await createMinimumHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0 })
  const send = (path, body, type = 'application/json') => fetch(host.url + path, { method: path.endsWith('/archive') ? 'PUT' : 'POST', headers: { Origin: host.url, 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body })
  const initial = await fetch(host.url + base).then(response => response.json()); assert.equal(initial.trustedPublisherCount, 0)
  const accepted = await send(`${base}/operations`, { requestId: 'unsigned-directory', filename: 'calculator', sourceFormat: 'directory', localTrust: true, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
  assert.equal(accepted.status, 202); const operation = await accepted.json()
  assert.equal(operation.sourceFormat, 'directory'); assert.equal(operation.localTrust, true)
  const uploaded = await send(`${base}/operations/${operation.id}/archive`, bytes, 'application/octet-stream')
  assert.equal(uploaded.status, 202); assert.equal((await uploaded.json()).phase, 'installed')
  const status = await fetch(host.url + base).then(response => response.json())
  assert.equal(status.installations[0].selected, null); assert.equal(status.installations[0].pending.appId, 'calculator'); assert.equal(status.operations[0].phase, 'installed')
  assert.deepEqual((await host.packages.inspect()).actual, []); assert.deepEqual(host.products.list(), [])
  for (const path of ['/host/web/package-directory.js', '/host/package-management/directory-format.js']) { const response = await fetch(host.url + path); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /from ['"]node:/) }
})

test('minimum host close joins an active HTTP upload and persists cancellation before closing registry admission', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-http-close-install-')), options = { path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0 }
  let host, upload
  t.after(async () => { upload?.destroy(); await host?.close(); await rm(directory, { recursive: true, force: true }) })
  host = await createMinimumHost(options)
  const accepted = await fetch(host.url + `${base}/operations`, { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify(intent) })
  assert.equal(accepted.status, 202); const operation = await accepted.json()
  upload = httpRequest(host.url + `${base}/operations/${operation.id}/archive`, { method: 'PUT', headers: { Origin: host.url, 'Content-Type': 'application/octet-stream', 'Content-Length': '3' } })
  const uploadClosed = new Promise(resolve => upload.once('close', resolve)); upload.on('error', () => {}); upload.write('z')
  const deadline = Date.now() + 5000
  while ((await host.installer.get(operation.id)).phase !== 'receiving') { assert.ok(Date.now() < deadline, 'upload never entered receiving'); await new Promise(resolve => setTimeout(resolve, 10)) }
  await host.close(); await uploadClosed
  host = await createMinimumHost(options)
  const result = await host.installer.get(operation.id)
  assert.equal(result.phase, 'cancelled'); assert.equal(result.errorCode, 'service-closing')
  assert.deepEqual((await host.packages.inspect()).applications, []); assert.deepEqual(host.products.list(), [])
  const control = await (await fetch(host.url + base)).json(); assert.equal(control.operations[0].phase, 'cancelled')
})

const activation = (phase = 'prepared') => ({ id: 'activation-1', requestId: 'apply-1', revision: 1, registryRevision: 7, ownerEpoch: 3, kind: 'activate', phase,
  targets: [{ identity, previousSelected: null, operationId: 'PRIVATE_OPERATION' }], roles: [{ role: 'client', entries: [{ package: identity, entry: 'client' }], capabilities: [], handoffUsageId: 'PRIVATE_HANDOFF', usageIds: ['PRIVATE_USAGE'], readyUsageId: phase === 'completed' ? 'PRIVATE_READY' : null }],
  supersededUsageIds: ['PRIVATE_OLD_USAGE'], receipt: { private: '/private/launch/path', credential: 'PRIVATE_SECRET' }, errorCode: null, recovery: null, createdAt: time, updatedAt: time })

test('activation API uses two strict lifecycle stages and exposes no launch credentials or private receipts', async t => {
  const calls = [], f = await listener(t)
  const manager = { available: true, isPrepared: id => id === 'activation-1', list: async () => [activation()], get: async id => id === 'activation-1' ? activation() : undefined,
    prepare: async input => { calls.push(['prepare', input]); return activation() }, commit: async id => { calls.push(['commit', id]); return activation('handoff') }, cancel: async id => { calls.push(['cancel', id]); return activation('cancelled') }, resume: async id => { calls.push(['resume', id]); return activation('recovery-required') } }
  f.setAccess({ registry: { inspect: async () => ({ revision: 7, applications: [], actual: [] }), listFileInstalls: async () => [] }, trustedPublisherCount: 1, activation: manager })
  const state = await f.call(); assert.equal(state.data.registryRevision, 7); assert.equal(state.data.lifecycleAvailable, true)
  assert.doesNotMatch(JSON.stringify(state.data), /PRIVATE_|receipt|usageIds|ownerEpoch|\/private\//)
  const prepared = await f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'apply-1', expectedRegistryRevision: 7, appIds: ['calculator'] }) })
  assert.equal(prepared.response.status, 202); assert.equal(prepared.data.phase, 'prepared'); assert.equal(prepared.data.protected, true); assert.deepEqual(prepared.data.roles, [{ role: 'client', ready: false }])
  assert.equal((await f.call(`${base}/activations/activation-1`)).data.phase, 'prepared')
  assert.equal((await f.call(`${base}/activations/missing`)).response.status, 404)
  for (const action of ['commit', 'cancel', 'resume']) assert.equal((await f.call(`${base}/activations/activation-1/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).response.status, 202)
  assert.deepEqual(calls, [['prepare', { requestId: 'apply-1', expectedRegistryRevision: 7, appIds: ['calculator'] }], ['commit', 'activation-1'], ['cancel', 'activation-1'], ['resume', 'activation-1']])
  for (const body of [{ requestId: 'apply-2', expectedRegistryRevision: -1 }, { requestId: 'apply-2', expectedRegistryRevision: 7, appIds: ['calculator', 'calculator'] }, { requestId: 'apply-2', expectedRegistryRevision: 7, command: 'restart' }, { requestId: 'apply-2', expectedRegistryRevision: 7, snapshot: { secret: 'x' } }]) assert.equal((await f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).response.status, 400)
  assert.equal((await f.call(`${base}/activations/activation-1/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' })).response.status, 400)
})

test('busy lifecycle guards return a stable conflict without exposing business or native error details', async t => {
  const f = await listener(t)
  f.setAccess({ trustedPublisherCount: 1, activation: { available: true, async prepare() { throw Object.assign(new Error('PRIVATE_RUN_DETAIL'), { code: 'product-busy' }) } } })
  const result = await f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'busy-apply', expectedRegistryRevision: 7 }) })
  assert.equal(result.response.status, 409); assert.deepEqual(result.data, { error: { code: 'product-busy' } })
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE/)
})

test('a real client root closes its registered page stream before sequential HTTP component cleanup can block the page owner', { timeout: 10000 }, async t => {
  const { createClientHost } = await import('../dist/client.js'), directory = await mkdtemp(join(tmpdir(), 'anybox-client-pages-close-'))
  let host, reader
  t.after(async () => { await reader?.cancel().catch(() => {}); await host?.close(); await rm(directory, { recursive: true, force: true }) })
  host = await createClientHost({ applications: [], path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0,
    packageManager: { roles: ['client'], async freeze() {}, async release() {}, async handoff() {} } })
  const response = await fetch(host.url + base + '/pages/root-close-page/events'); assert.equal(response.status, 200)
  reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /connected/)
  await host.close(); assert.equal((await reader.read()).done, true)
  await assert.rejects(fetch(host.url + base))
})

test('uninstall requires explicit remove kind and a nonempty app set, with lifecycle-only safe receipts', async t => {
  const inputs = [], f = await listener(t)
  f.setAccess({ trustedPublisherCount: 0, activation: { available: true, isPrepared: () => true, async prepare(input) { inputs.push(input); return { ...activation('reclaiming'), kind: input.kind ?? 'activate' } } } })
  const post = body => f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  for (const extra of [{ kind: 'remove' }, { kind: 'remove', appIds: [] }, { kind: 'remove', appIds: ['calculator', 'calculator'] }, { kind: 'delete', appIds: ['calculator'] }, { kind: 'remove', appIds: ['calculator'], deleteData: true }]) assert.equal((await post({ requestId: 'remove-1', expectedRegistryRevision: 7, ...extra })).response.status, 400)
  const result = await post({ requestId: 'remove-1', expectedRegistryRevision: 7, kind: 'remove', appIds: ['calculator', 'notes'] })
  assert.equal(result.response.status, 202); assert.equal(result.data.kind, 'remove'); assert.equal(result.data.phase, 'reclaiming')
  assert.deepEqual(inputs, [{ requestId: 'remove-1', expectedRegistryRevision: 7, kind: 'remove', appIds: ['calculator', 'notes'] }])
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_|receipt|usageIds|ownerEpoch|\/private\//)
  const activate = await post({ requestId: 'apply-1', expectedRegistryRevision: 7, appIds: ['calculator'] }); assert.equal(activate.data.kind, 'activate')
})
test('external version use and reclamation failures are stable conflicts without private details', async t => {
  const f = await listener(t)
  for (const code of ['version-in-use', 'use-unavailable', 'reclamation-root-changed', 'package-reclamation-failed', 'package-reclamation-directory-changed']) {
    f.setAccess({ trustedPublisherCount: 0, activation: { available: true, async prepare() { throw Object.assign(new Error('/private/app/data'), { code }) } } })
    const result = await f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'remove-1', expectedRegistryRevision: 7, kind: 'remove', appIds: ['calculator'] }) })
    assert.equal(result.response.status, 409); assert.deepEqual(result.data, { error: { code } })
  }
})

test('unsupported secure reclamation reports a stable unavailable result instead of an internal failure', async t => {
  const f = await listener(t)
  f.setAccess({ trustedPublisherCount: 0, activation: { available: true, async prepare() { throw Object.assign(new Error('PRIVATE_HANDLE_DETAIL'), { code: 'reclamation-root-unavailable' }) } } })
  const result = await f.call(`${base}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'remove-unsupported', expectedRegistryRevision: 7, kind: 'remove', appIds: ['calculator'] }) })
  assert.equal(result.response.status, 409); assert.deepEqual(result.data, { error: { code: 'reclamation-root-unavailable' } })
})

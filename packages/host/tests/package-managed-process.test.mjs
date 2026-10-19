import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createClientHost } from '../dist/client.js'
import { createApplicationArchive } from '../dist/package-management/archive.js'
import { runOnlinePackageInstallCommand } from '../dist/package-management/online-install-command.js'
import { startManagedApplicationHost } from '../dist/package-management/managed-process.js'
import { acquirePackageUsageLock, tryAcquirePackageUsageExitLock } from '../dist/package-management/usage-locks.js'

async function fixture(t, settings, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-process-'))
  let roleConfigPath
  if (settings) { roleConfigPath = join(directory, 'fixture.json'); await writeFile(roleConfigPath, JSON.stringify(settings)) }
  const host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory: directory, port: 0, roles: ['client'], roleConfigPath, clientEntry: new URL('./helpers/managed-role-fixture.mjs', import.meta.url), ...options })
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  return { host, directory }
}
async function until(work) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await delay(15) }
  throw new Error('managed role observation deadline')
}
async function events(directory) { return (await readFile(join(directory, 'managed-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
const body = async (host, route = '/fixture') => { const response = await fetch(host.url + route); return { status: response.status, value: await response.json() } }

test('the parent owns a stable proxy and one requested role without opening application storage', async t => {
  const { host } = await fixture(t)
  assert.equal(host.state.phase, 'ready'); assert.equal(host.state.roles.length, 1); assert.equal(host.state.roles[0].role, 'client')
  const response = await body(host)
  assert.equal(response.status, 200); assert.equal(response.value.generation, host.state.roles[0].generation)
  const pid = response.value.pid
  assert.notEqual(pid, process.pid)
  await host.close(); assert.equal(host.state.phase, 'closed')
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  await host.close()
})

test('activation replaces the owned client while preserving origin and continuous parent usage protection', async t => {
  const { host, directory } = await fixture(t), original = await body(host), origin = host.url
  await fetch(origin + '/fixture/stage', { method: 'POST', headers: { Origin: origin } }).catch(() => {})
  const replacement = await until(async () => {
    const response = await body(host).catch(() => undefined)
    return response?.status === 200 && response.value.generation !== original.value.generation && host.state.phase === 'ready' ? response.value : undefined
  })
  assert.equal(host.url, origin); assert.notEqual(replacement.pid, original.value.pid)
  assert.throws(() => process.kill(original.value.pid, 0), error => error.code === 'ESRCH')
  const observations = await events(directory)
  assert.equal(observations.filter(item => item.kind === 'start').length, 2)
  assert.equal(observations.find(item => item.kind === 'old-parent-before-adoption').held, true)
  assert.deepEqual(Object.fromEntries(Object.entries(observations.find(item => item.kind === 'new-parent-before-claim')).filter(([key]) => ['held', 'oldHeld'].includes(key))), { held: true, oldHeld: false })
  assert.equal(observations.find(item => item.kind === 'finished').previousExited, true)
  assert.equal(observations.find(item => item.kind === 'finished').usageHeld, true)
  assert.equal(tryAcquirePackageUsageExitLock(directory, replacement.usageId), undefined)
  await host.close()
  const exited = tryAcquirePackageUsageExitLock(directory, replacement.usageId)
  assert.ok(exited); await exited.release()
})

test('a failed replacement creates only an empty recovery manager and never replays activation', async t => {
  const { host, directory } = await fixture(t, { crashOnRestart: true })
  await fetch(host.url + '/fixture/stage', { method: 'POST', headers: { Origin: host.url } }).catch(() => {})
  await until(() => host.state.phase === 'recovery-required')
  const failed = await body(host)
  assert.equal(failed.status, 200); assert.notEqual(host.state.errorCode, null)
  const first = (await events(directory)).filter(item => item.kind === 'start').length
  await delay(100)
  assert.equal((await events(directory)).filter(item => item.kind === 'start').length, first)
  assert.equal(first, 3); assert.notEqual(host.state.activationId, null)
  assert.equal((await events(directory)).filter(item => item.kind === 'start' && item.activation).length, 1)
  await host.close(); assert.equal(host.state.phase, 'closed')
})

test('a client cannot use the peer-only registry forwarding channel for arbitrary operations', async t => {
  const { host } = await fixture(t)
  const response = await fetch(host.url + '/fixture/registry', { method: 'POST', headers: { Origin: host.url } })
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'registry-unavailable')
})

test('invalid role and path configuration is rejected before a child or proxy is created', async () => {
  for (const change of [{ path: '' }, { packageDirectory: '\0' }, { roles: [] }, { roles: ['execution'] }, { roles: ['client', 'client'] }, { roles: ['client', 'computer-worker'] }, { port: -1 }, { clientEntry: new URL('https://example.com/adapter.js') }]) {
    await assert.rejects(startManagedApplicationHost({ path: '/tmp/unused-client', packageDirectory: '/tmp/unused-packages', ...change }), error => error.code === 'invalid-startup')
  }
})


test('manager SIGKILL closes its private child channel and the owned role actually exits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-parent-kill-'))
  const parent = fork(new URL('./helpers/managed-parent-fixture.mjs', import.meta.url), [join(directory, 'client.sqlite'), directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] })
  const exited = new Promise(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })))
  let childPid
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    await exited
    if (childPid) await until(() => { try { process.kill(childPid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
    await rm(directory, { recursive: true, force: true })
  })
  const ready = await new Promise((resolve, reject) => { parent.once('message', resolve); parent.once('error', reject); parent.once('exit', () => reject(new Error('manager exited before ready'))) })
  const response = await fetch(ready.url + '/fixture'), value = await response.json()
  childPid = value.pid
  assert.notEqual(childPid, parent.pid)
  parent.kill('SIGKILL')
  assert.equal((await exited).signal, 'SIGKILL')
  await until(() => { try { process.kill(childPid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
})


test('the fixed production role starts an empty host without starting an unused execution process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-empty-'))
  const host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0 })
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const response = await fetch(host.url + '/api/client/v1/app-packages'), status = await response.json()
  assert.equal(response.status, 200); assert.equal(status.available, true); assert.deepEqual(status.installations, [])
  assert.deepEqual(host.state.roles.map(item => item.role), ['client'])
  await host.close(); assert.equal(host.state.phase, 'closed')
})

test('a legacy unverifiable usage anchor preserves exit uncertainty while the real host falls back to readable empty management', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-legacy-anchor-')), packageDirectory = join(directory, 'applications')
  const options = { path: join(directory, 'client.sqlite'), packageDirectory, port: 0, roles: ['client'] }
  let seed, host, lock
  t.after(async () => { await lock?.release(); await seed?.close(); await host?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  seed = await createClientHost({ ...options, applications: [] })
  const registry = seed.packages, identity = { appId: 'legacy', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }
  let operation = await registry.begin({ requestId: 'install-legacy', kind: 'install', identity, expectedAppRevision: 0 })
  for (const phase of ['preparing', 'prepared', 'committing']) operation = await registry.advance({ operationId: operation.id, expectedRevision: operation.revision, phase })
  operation = await registry.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 0, source: { kind: 'file', reference: 'legacy-fixture', publisher: 'fixture' } })
  operation = await registry.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 1 })
  const credential = await registry.prepareUse({ expectedRegistryRevision: (await registry.inspect()).revision, role: 'client', entries: [{ package: identity, entry: 'client' }], holderId: 'legacy-role', generation: 'legacy-boot' })
  lock = acquirePackageUsageLock(packageDirectory, credential)
  await registry.claim(credential); await registry.ready(credential)
  await registry.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' })
  await lock.release(); lock = undefined; await seed.close(); seed = undefined
  const anchorPath = join(packageDirectory, 'usage-locks', `${credential.usageId}.sqlite`), anchor = new DatabaseSync(anchorPath)
  try {
    anchor.exec('BEGIN EXCLUSIVE; ALTER TABLE package_usage_identity RENAME TO current_identity; CREATE TABLE package_usage_identity (id INTEGER PRIMARY KEY, secret_digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0); INSERT INTO package_usage_identity SELECT id,secret_digest,revoked FROM current_identity; DROP TABLE current_identity; PRAGMA user_version=1; COMMIT')
  } finally { anchor.close() }
  const original = await readFile(anchorPath)
  host = await startManagedApplicationHost(options)
  assert.equal(host.state.phase, 'recovery-required'); assert.equal(host.state.errorCode, 'package-role-exit-unconfirmed')
  const response = await fetch(host.url + '/api/client/v1/app-packages'), facts = await response.json()
  assert.equal(response.status, 200); assert.equal(facts.available, true)
  assert.deepEqual(facts.installations[0].installed[0].identity, identity)
  assert.deepEqual(facts.installations[0].selected, identity)
  assert.equal(facts.actual.find(item => item.generation === 'legacy-boot').state, 'exit-unconfirmed')
  assert.deepEqual(await fetch(host.url + '/api/client/v1/products').then(response => response.json()), [])
  const blocked = await fetch(host.url + '/api/client/v1/app-packages/activations', { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'blocked-legacy-exit', expectedRegistryRevision: facts.registryRevision }) })
  assert.equal(blocked.ok, false)
  assert.deepEqual(await readFile(anchorPath), original, 'management must not rewrite or adopt the legacy anchor')
  await host.close()
})


const supportsNodePreparation = process.platform !== 'win32' && (Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 15)
test('signed client and execution roles activate through HTTP, preserve both immutable generations, and leave new application business closed', { skip: !supportsNodePreparation }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-two-role-')), packageDirectory = join(directory, 'applications'), marker = join(directory, 'business-opened')
  const keys = generateKeyPairSync('ed25519'), trustPolicyPath = join(directory, 'publishers.json')
  await writeFile(trustPolicyPath, JSON.stringify({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), appIds: ['fixture'] }] }))
  const host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory, executionPath: join(directory, 'execution.sqlite'), trustPolicyPath, port: 0 })
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const origin = host.url
  const call = async (path, method = 'GET', data, type = 'application/json') => {
    const response = await fetch(origin + path, { method, headers: { ...(method === 'GET' ? {} : { Origin: origin }), ...(data === undefined ? {} : { 'Content-Type': type }) }, ...(data === undefined ? {} : { body: type === 'application/json' ? JSON.stringify(data) : data }) })
    const value = await response.json()
    assert.ok(response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const status = () => call('/api/client/v1/app-packages')
  const build = version => {
    const code = `import {writeFileSync} from 'node:fs';export function createRegistration(){return {definition:{id:'fixture',name:'Fixture',icon:'fixture',description:${JSON.stringify(version)}},createRuntime(){writeFileSync(${JSON.stringify(marker)},'opened');throw Error('business-must-remain-closed')}}}`
    const manifest = { schemaVersion: 1, lifecycleVersion: 1, appId: 'fixture', version, publisher: 'fixture', displayName: 'Fixture', applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, entries: { client: 'payload/registration.js', execution: 'payload/registration.js' }, runtimeRequirements: Object.fromEntries(['client', 'execution'].map(role => [role, { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }])) }
    return Buffer.from(createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey, manifest, files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/registration.js', bytes: Buffer.from(code) }] }))
  }
  const install = async version => {
    const bytes = build(version), intent = await call('/api/client/v1/app-packages/operations', 'POST', { requestId: randomUUID(), filename: `fixture-${version}.anybox-app`, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
    const job = await call(`/api/client/v1/app-packages/operations/${intent.id}/archive`, 'PUT', bytes, 'application/octet-stream')
    assert.equal(job.phase, 'installed')
    return job.identity
  }
  const activate = async version => {
    const before = await status(), activation = await call('/api/client/v1/app-packages/activations', 'POST', { requestId: randomUUID(), expectedRegistryRevision: before.registryRevision })
    assert.equal(activation.phase, 'prepared')
    await call(`/api/client/v1/app-packages/activations/${activation.id}/commit`, 'POST', {}).catch(error => { if (host.state.phase === 'ready') throw error })
    const done = await until(async () => {
      if (host.state.phase === 'failed') throw new Error(`managed activation failed: ${JSON.stringify(host.state)}`)
      if (host.state.phase !== 'ready') return false
      const value = await status().catch(() => undefined)
      return value?.activations.some(item => item.id === activation.id && item.phase === 'completed') ? value : false
    })
    assert.equal(done.installations[0].selected.version, version); assert.equal(done.installations[0].pending, null)
    assert.deepEqual(done.actual.map(item => item.role).sort(), ['client', 'execution'])
    assert.ok(done.actual.every(item => item.state === 'ready' && item.entries[0].identity.version === version))
    const products = await call('/api/client/v1/products')
    assert.equal(products.length, 1); assert.equal(products[0].desiredEnabled, false); assert.equal(products[0].state, 'disabled'); assert.equal(products[0].definition.description, version)
    await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
    return done
  }
  const first = await install('1.0.0'), pending = await status()
  assert.equal(pending.installations[0].selected, null); assert.deepEqual(pending.actual, [])
  const firstReady = await activate('1.0.0'), firstGenerations = firstReady.actual.map(item => item.generation).sort()
  const second = await install('2.0.0'), updating = await status()
  assert.equal(updating.installations[0].pending.version, '2.0.0'); assert.equal(updating.installations[0].selected.version, '1.0.0')
  assert.ok(updating.actual.every(item => item.entries[0].identity.version === '1.0.0'))
  const secondReady = await activate('2.0.0')
  assert.notDeepEqual(secondReady.actual.map(item => item.generation).sort(), firstGenerations)
  assert.equal(secondReady.installations[0].installed.length, 2); assert.notEqual(first.digest, second.digest)
  assert.equal(host.url, origin); assert.deepEqual(host.state.roles.map(item => item.role).sort(), ['client', 'execution'])
  await host.close()
  await writeFile(join(packageDirectory, 'packages', 'fixture', second.version, second.digest, 'application', 'payload', 'registration.js'), 'export const corrupted = true')
  const repair = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory, executionPath: join(directory, 'execution.sqlite'), trustPolicyPath, port: 0 })
  t.after(() => repair.close())
  assert.equal(repair.state.phase, 'recovery-required')
  const quarantined = await fetch(repair.url + '/api/client/v1/app-packages').then(response => response.json())
  assert.equal(quarantined.installations[0].installed.find(item => item.identity.digest === second.digest).state, 'quarantined')
  assert.deepEqual(await fetch(repair.url + '/api/client/v1/products').then(response => response.json()), [])
  assert.deepEqual(repair.state.roles.map(item => item.role), ['client'])
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT')
  await repair.close()
})


test('quit inspection holds all owned role guards and fences independent launches until release', async t => {
  const { host, directory } = await fixture(t)
  assert.deepEqual(await host.inspectForQuit(), { busy: false })
  assert.deepEqual(await host.inspectForQuit(), { busy: false })
  const launch = async () => {
    const response = await fetch(host.url + '/fixture/launch', { method: 'POST', headers: { Origin: host.url } })
    assert.equal(response.status, 409)
    return response.json()
  }
  assert.equal((await launch()).code, 'role-launch-unavailable')
  assert.equal((await events(directory)).filter(item => item.kind === 'freeze').length, 1)
  await host.releaseQuit()
  assert.equal((await events(directory)).filter(item => item.kind === 'release').length, 1)
  assert.equal((await launch()).code, 'unsupported-operation')
  assert.deepEqual(await host.inspect(), { busy: false })
  assert.equal((await events(directory)).filter(item => item.kind === 'release').length, 2)
})

test('busy quit inspection releases its launch fence and leaves the role running', async t => {
  const { host } = await fixture(t, { busyOnFreeze: true })
  assert.deepEqual(await host.inspectForQuit(), { busy: true })
  const response = await fetch(host.url + '/fixture/launch', { method: 'POST', headers: { Origin: host.url } })
  assert.equal((await response.json()).code, 'unsupported-operation')
  assert.equal((await body(host)).status, 200)
})

test('independent launch failures before child creation release the managed parent reservation while the host remains running', async t => {
  for (const kind of ['trust-policy', 'runtime', 'fork']) await t.test(kind, async t => {
    const { host, directory } = await fixture(t, { independentReservation: true }, kind === 'trust-policy' ? { trustPolicyPath: join(tmpdir(), randomUUID(), 'missing-policy.json') } : {})
    let restore = () => {}
    if (kind === 'runtime') {
      const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
      Object.defineProperty(process.versions, 'electron', { value: 'fixture', configurable: true })
      restore = () => { if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete process.versions.electron }
    } else if (kind === 'fork') {
      // Reach the injected pre-spawn failure independently of the platform's
      // installed-role support gate; no real child may start in this case.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
      const mock = t.mock.method(childProcess, 'fork', () => { throw Object.assign(Error('fork rejected before spawn'), { code: 'fixture-fork-failed' }) })
      syncBuiltinESMExports()
      restore = () => { mock.mock.restore(); syncBuiltinESMExports(); Object.defineProperty(process, 'platform', platform) }
    }
    try {
      const response = await fetch(host.url + '/fixture/launch', { method: 'POST', headers: { Origin: host.url } })
      assert.equal(response.status, 409)
      const result = await response.json()
      if (kind === 'runtime') assert.equal(result.code, 'package-role-runtime-unavailable')
      if (kind === 'fork') assert.equal(result.code, 'fixture-fork-failed')
      const reservation = (await events(directory)).find(item => item.kind === 'launch-reserved')
      assert.ok(reservation)
      const proof = tryAcquirePackageUsageExitLock(directory, reservation.usageId)
      assert.ok(proof, 'a launch that never created a worker must not retain a SHARED parent lock')
      await proof.release()
      assert.equal(host.state.phase, 'ready')
      assert.equal((await body(host)).status, 200)
    } finally { restore() }
  })
})


test('recovery management accepts fresh credentials for the same activation only after an explicit resume', async t => {
  const { host, directory } = await fixture(t, { crashOnRestart: true, crashOnce: true })
  await fetch(host.url + '/fixture/stage', { method: 'POST', headers: { Origin: host.url } }).catch(() => {})
  await until(() => host.state.phase === 'recovery-required')
  const id = host.state.activationId
  assert.ok(id)
  await delay(50)
  assert.equal((await events(directory)).filter(item => item.kind === 'start' && item.activation).length, 1)
  await fetch(host.url + '/fixture/resume?id=' + id, { method: 'POST', headers: { Origin: host.url } }).catch(() => {})
  await until(() => host.state.phase === 'ready' && host.state.activationId === null)
  assert.equal(host.state.errorCode, null)
  assert.equal((await events(directory)).filter(item => item.kind === 'start' && item.activation).length, 2)
  assert.equal((await events(directory)).filter(item => item.kind === 'finished').length, 1)
})

test('an app launches only its declared independent worker and host close leaves that worker alive', { skip: !supportsNodePreparation }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-managed-independent-')), packageDirectory = join(directory, 'applications'), descriptor = join(directory, 'worker.json')
  const keys = generateKeyPairSync('ed25519'), trustPolicyPath = join(directory, 'publishers.json'), appId = 'independent-fixture'
  await writeFile(trustPolicyPath, JSON.stringify({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), appIds: [appId] }] }))
  let worker
  const host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory, trustPolicyPath, port: 0 })
  t.after(async () => {
    await host.close().catch(() => {})
    if (worker) {
      await fetch(worker.url + '/stop', { method: 'POST' }).catch(() => {})
      await until(() => { try { process.kill(worker.pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
    }
    await rm(directory, { recursive: true, force: true })
  })
  const call = async (path, method = 'GET', data, type = 'application/json') => {
    const response = await fetch(host.url + path, { method, headers: { ...(method === 'GET' ? {} : { Origin: host.url }), ...(data === undefined ? {} : { 'Content-Type': type }) }, ...(data === undefined ? {} : { body: type === 'application/json' ? JSON.stringify(data) : data }) })
    const value = await response.json()
    assert.ok(response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const status = () => call('/api/client/v1/app-packages')
  const registration = `export function createRegistration(context){return {definition:{id:${JSON.stringify(appId)},name:'Independent fixture',icon:'fixture'},createRuntime(){let state='disabled';return {async open(){await context.startRole('computer-worker',{args:[${JSON.stringify(descriptor)}],ownership:'independent'});state='active'},async retry(){await this.open()},async stop(){state='disabled'},inspect(){return state},closeAdmission(){},async awaitIdle(){}}}}}`
  const workerMain = `import{createServer}from'node:http';import{writeFileSync}from'node:fs';export async function main(args){const server=createServer((req,res)=>{res.end('ok');if(req.url==='/stop')setImmediate(()=>server.close(()=>process.exit(0)))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));writeFileSync(args[0],JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port}));}`
  const build = version => Buffer.from(createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey,
    manifest: { schemaVersion: 1, lifecycleVersion: 1, appId, version, publisher: 'fixture', displayName: 'Independent fixture', applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, entries: { client: 'payload/registration.js', computerWorker: 'payload/worker.js' }, runtimeRequirements: Object.fromEntries(['client', 'computerWorker'].map(role => [role, { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }])) },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/registration.js', bytes: Buffer.from(registration) }, { path: 'payload/worker.js', bytes: Buffer.from(workerMain) }] }))
  const install = async version => {
    const bytes = build(version), job = await call('/api/client/v1/app-packages/operations', 'POST', { requestId: randomUUID(), filename: `fixture-${version}.anybox-app`, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
    assert.equal((await call(`/api/client/v1/app-packages/operations/${job.id}/archive`, 'PUT', bytes, 'application/octet-stream')).phase, 'installed')
  }
  await install('1.0.0')
  const before = await status(), activation = await call('/api/client/v1/app-packages/activations', 'POST', { requestId: randomUUID(), expectedRegistryRevision: before.registryRevision })
  await call(`/api/client/v1/app-packages/activations/${activation.id}/commit`, 'POST', {}).catch(() => {})
  await until(async () => { const value = await status().catch(() => undefined); return value?.activations.some(item => item.id === activation.id && item.phase === 'completed') })
  assert.equal((await call('/api/client/v1/products'))[0].desiredEnabled, false)
  const product = await call(`/api/client/v1/products/${appId}/open`, 'POST', {})
  assert.equal(product.state, 'running'); assert.equal(product.desiredEnabled, true)
  worker = JSON.parse(await readFile(descriptor, 'utf8'))
  assert.equal((await fetch(worker.url)).status, 200)
  const ready = await status()
  assert.ok(ready.actual.some(item => item.role === 'computer-worker' && item.state === 'ready'))
  assert.deepEqual(host.state.roles.map(item => item.role), ['client'])
  await install('2.0.0')
  const pending = await status(), blocked = await fetch(host.url + '/api/client/v1/app-packages/activations', { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedRegistryRevision: pending.registryRevision }) })
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error.code, 'version-in-use')
  const uninstallBlocked = await fetch(host.url + '/api/client/v1/app-packages/activations', { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'remove', appIds: [appId], requestId: randomUUID(), expectedRegistryRevision: pending.registryRevision }) })
  assert.equal(uninstallBlocked.status, 409); assert.equal((await uninstallBlocked.json()).error.code, 'version-in-use')
  assert.equal((await call('/api/client/v1/products'))[0].desiredEnabled, true)
  const unchanged = await status()
  assert.equal(unchanged.installations[0].selected.version, '1.0.0')
  assert.ok(unchanged.actual.some(item => item.role === 'computer-worker' && item.state === 'ready'))
  await host.close()
  assert.equal((await fetch(worker.url)).status, 200)
  await fetch(worker.url + '/stop', { method: 'POST' })
  await until(() => { try { process.kill(worker.pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
})


test('an initial role fault falls back once to an explicitly empty management process after real exit', async t => {
  const { host, directory } = await fixture(t, { crashInitialOnce: true })
  assert.equal(host.state.phase, 'recovery-required'); assert.notEqual(host.state.errorCode, null); assert.equal(host.state.activationId, null)
  assert.equal((await body(host)).status, 200)
  const starts = (await events(directory)).filter(item => item.kind === 'start')
  assert.equal(starts.length, 2); assert.equal(starts[0].managementOnly, false); assert.equal(starts[1].managementOnly, true)
  assert.throws(() => process.kill(starts[0].pid, 0), error => error.code === 'ESRCH')
  await delay(50)
  assert.equal((await events(directory)).filter(item => item.kind === 'start').length, 2)
  await host.close()
})


test('a rejected parent anchor acquisition returns the commit error before entering empty management recovery', async t => {
  const { host, directory } = await fixture(t, { blockStageAnchor: true })
  const original = (await body(host)).value
  await fetch(host.url + '/fixture/stage', { method: 'POST', headers: { Origin: host.url } }).catch(() => {})
  await until(() => host.state.phase === 'recovery-required')
  assert.ok(host.state.activationId); assert.notEqual(host.state.errorCode, null)
  const management = (await body(host)).value
  assert.notEqual(management.pid, original.pid)
  assert.throws(() => process.kill(original.pid, 0), error => error.code === 'ESRCH')
  const observations = await events(directory), errorIndex = observations.findIndex(item => item.kind === 'stage-error'), closedIndex = observations.findIndex(item => item.kind === 'closing')
  assert.ok(errorIndex >= 0); assert.ok(closedIndex > errorIndex)
  assert.equal(observations.filter(item => item.kind === 'start' && item.activation).length, 0)
  assert.equal(observations.filter(item => item.kind === 'start').at(-1).managementOnly, true)
  const id = host.state.activationId
  await fetch(host.url + '/fixture/resume?id=' + id, { method: 'POST', headers: { Origin: host.url } }).catch(() => {})
  await until(() => host.state.phase === 'ready' && host.state.activationId === null)
  assert.equal(host.state.errorCode, null)
  assert.equal((await events(directory)).filter(item => item.kind === 'start' && item.activation).length, 1)
})


test('an Agent-created unsigned folder installs online, activates, survives source removal and restart, and uninstalls through the real manager', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-agent-folder-')), source = join(directory, 'notes'), packageDirectory = join(directory, 'applications')
  const options = { path: join(directory, 'client.sqlite'), packageDirectory, port: 0, roles: ['client'] }
  let host = await startManagedApplicationHost(options)
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  await mkdir(join(source, 'payload'), { recursive: true })
  const code = 'export async function mount(container){const editor=document.createElement("textarea");editor.placeholder="Agent notes";container.append(editor);return {setActive(){},canClose:()=>true,async dispose(){editor.remove()}}}'
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ schemaVersion: 1, appId: 'notes', version: '1.0.0', publisher: 'local-agent', displayName: 'Agent Notes', applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, web: { entry: 'payload/app.js', assets: 'payload/assets.json' } }))
  await writeFile(join(source, 'payload', 'app.js'), code)
  await writeFile(join(source, 'payload', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/notes/1.0.0/app.js', file: 'payload/app.js', type: 'text/javascript' }] }))
  const stdout = [], stderr = []
  assert.equal(await runOnlinePackageInstallCommand(['install', source, '--endpoint', host.url, '--trust-local', '--request-id', 'agent-notes-v1'], { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }), 0, stderr.join(''))
  const installed = JSON.parse(stdout[0]); assert.equal(installed.phase, 'installed')
  await rm(source, { recursive: true })
  const call = async (path, data) => {
    const response = await fetch(host.url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: host.url, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    const result = await response.json()
    assert.ok(response.ok, JSON.stringify(result)); return result
  }
  const status = () => call('/api/client/v1/app-packages')
  assert.equal((await status()).trustedPublisherCount, 0)
  const change = async kind => {
    const before = await status()
    const batch = await call('/api/client/v1/app-packages/activations', { requestId: randomUUID(), expectedRegistryRevision: before.registryRevision, ...(kind === 'remove' ? { kind, appIds: ['notes'] } : {}) })
    await call(`/api/client/v1/app-packages/activations/${batch.id}/commit`, {}).catch(error => { if (host.state.phase === 'failed') throw error })
    return until(async () => { if (host.state.phase === 'failed') throw Error(JSON.stringify(host.state)); if (host.state.phase !== 'ready') return false; const result = await status().catch(() => undefined); return result?.activations.some(item => item.id === batch.id && item.phase === 'completed') ? result : false })
  }
  const active = await change('activate')
  assert.equal(active.installations[0].selected.appId, 'notes'); assert.equal(active.installations[0].pending, null)
  assert.equal(await fetch(host.url + '/apps/notes/1.0.0/app.js').then(response => response.text()), code)
  assert.deepEqual(host.state.roles.map(item => item.role), ['client'])
  await host.close()
  host = await startManagedApplicationHost(options)
  assert.equal((await status()).installations[0].selected.digest, installed.identity.digest)
  assert.equal(await fetch(host.url + '/apps/notes/1.0.0/app.js').then(response => response.text()), code)
  const removed = await change('remove')
  assert.equal(removed.installations[0].installed[0].state, 'removed')
  await assert.rejects(access(join(packageDirectory, 'packages', 'notes', '1.0.0', installed.identity.digest)), error => error.code === 'ENOENT')
})

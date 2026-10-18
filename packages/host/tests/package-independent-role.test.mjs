import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createApplicationArchive, verifyApplicationArchive } from '../dist/package-management/archive.js'
import { currentApplicationRuntimeProfile } from '../dist/package-management/policy.js'
import { launchIndependentInstalledRole } from '../dist/package-management/independent-role.js'
import { prepareUsageLock, tryAcquirePackageUsageExitLock } from '../dist/package-management/usage-locks.js'

const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const verification = { target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { computerWorker: currentApplicationRuntimeProfile() }, trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey, appIds: ['calculator'] }] }
const isUnix = process.platform !== 'win32' && !process.versions.electron
const hash = value => createHash('sha256').update(value).digest('hex')
const live = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const joinRole = async role => { let timer; try { return await Promise.race([role.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('independent role exit timed out')), 5000) })]) } finally { clearTimeout(timer) } }
async function setup(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-independent-role-')), uses = [], children = []
  t.after(async () => { for (const child of children) { if (live(child.pid)) process.kill(child.pid, 'SIGTERM'); await joinRole(child) } await rm(directory, { recursive: true, force: true }) })
  const bytes = createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey, manifest: { schemaVersion: 1, lifecycleVersion: 1, appId: 'calculator', version: '1.0.0', publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target: verification.target, entries: { computerWorker: 'payload/main.js' }, runtimeRequirements: { computerWorker: { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' } } }, files: [{ path: 'payload/main.js', bytes: Buffer.from(source) }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'licenses/LICENSE', bytes: Buffer.from('MIT test fixture') }] }), archive = verifyApplicationArchive(bytes, verification)
  const container = join(directory, 'packages', 'calculator', '1.0.0', archive.identity.digest), application = join(container, 'application')
  await mkdir(application, { recursive: true })
  for (const file of [...archive.files, ...['manifest.json', 'files.json', 'signature.json'].map(path => ({ path, mode: 420 }))]) { const path = join(application, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, archive.readFile(file.path)); await chmod(path, file.mode) }
  await writeFile(join(container, 'archive.anybox-app'), bytes); await writeFile(join(container, 'receipt.json'), JSON.stringify({ schemaVersion: 1, identity: archive.identity, archiveDigest: archive.archiveDigest, archiveSize: archive.archiveSize }))
  const snapshot = { id: randomUUID(), revision: 0, registryRevision: 1, ownerEpoch: 1, role: 'computer-worker', entries: [{ package: archive.identity, entry: 'computer-worker' }], capabilities: [], revoked: false }, credential = { usageId: randomUUID(), secret: randomUUID(), snapshot }
  prepareUsageLock(directory, credential.usageId, hash(credential.secret))
  const registry = { async claim(input) { assert.equal(input.usageId, credential.usageId); assert.equal(tryAcquirePackageUsageExitLock(directory, input.usageId), undefined); uses.push('claim'); return snapshot }, async ready(input) { assert.equal(tryAcquirePackageUsageExitLock(directory, input.usageId), undefined); uses.push('ready'); return { snapshot, usage: { id: input.usageId, state: 'ready' } } } }
  return { directory, credential, uses, async launch(args, changes = {}) { const child = await launchIndependentInstalledRole({ directory, credential, verification, args, registry, ...changes }); children.push(child); return child }, proof() { return tryAcquirePackageUsageExitLock(directory, credential.usageId) } }
}

test('independent signed worker keeps its actual process pin after parent IPC is detached and releases only at real process exit', { skip: !isUnix }, async t => {
  const env = await setup(t, "import{writeFileSync}from'node:fs';export async function main(args){const timer=setInterval(()=>{},1000);process.once('SIGTERM',()=>clearInterval(timer));writeFileSync(args[0],JSON.stringify({pid:process.pid,args}));process.once('disconnect',()=>writeFileSync(args[1],'independent'))}"), marker = join(env.directory, 'worker-started.json'), disconnected = join(env.directory, 'disconnected')
  const role = await env.launch([marker, disconnected])
  assert.deepEqual(env.uses, ['claim', 'ready']); assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, role.pid)
  for (let i = 0; i < 100; i++) { try { assert.equal(await readFile(disconnected, 'utf8'), 'independent'); break } catch (error) { if (i === 99) throw error; await wait(5) } }
  assert.equal(live(role.pid), true); assert.equal(env.proof(), undefined)
  process.kill(role.pid, 'SIGTERM'); assert.equal((await joinRole(role)).code, 0)
  const proof = env.proof(); assert.ok(proof); proof.revoke(); await proof.release()
})

test('startup rejection confirms real child exit before releasing its parent pin and never marks ready', { skip: !isUnix }, async t => {
  const env = await setup(t, "export async function main(){throw Object.assign(new Error('fixture'),{code:'fixture-start-failed'})}")
  await assert.rejects(env.launch([]), error => error.code === 'fixture-start-failed' && error.exitConfirmed === true)
  assert.deepEqual(env.uses, ['claim']); const proof = env.proof(); assert.ok(proof); proof.revoke(); await proof.release()
})

test('validation before process creation reports confirmed absence and does not claim or retain its usage', { skip: !isUnix }, async t => {
  const env = await setup(t, 'export async function main(){}')
  for (const changes of [{ startupTimeoutMs: 0 }, { args: ['invalid\0argument'] }, { directory: join(env.directory, 'missing') }]) {
    await assert.rejects(env.launch([], changes), error => error.exitConfirmed === true)
    assert.deepEqual(env.uses, [])
    const proof = env.proof(); assert.ok(proof); await proof.release()
  }
})

test('synchronous fork failure preserves unconfirmed cleanup when its parent anchor cannot confirm release', { skip: !isUnix }, async t => {
  const env = await setup(t, 'export async function main(){}')
  const close = DatabaseSync.prototype.close
  let rejectedClose = false
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function () {
    const result = close.call(this)
    if (!rejectedClose) { rejectedClose = true; throw Error('fixture close returned an unknown outcome') }
    return result
  })
  const forkMock = t.mock.method(childProcess, 'fork', () => { throw Object.assign(Error('fork rejected'), { code: 'fixture-fork-failed' }) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(env.launch([]), error => error.code === 'package-role-exit-unconfirmed' && error.exitConfirmed === false && error.errors.some(cause => cause.code === 'release-failed'))
    assert.equal(rejectedClose, true)
    assert.deepEqual(env.uses, [])
  } finally { closeMock.mock.restore(); forkMock.mock.restore(); syncBuiltinESMExports() }
})

test('startup timeout joins the actual worker process group before returning confirmed failure', { skip: !isUnix }, async t => {
  const env = await setup(t, 'export async function main(){await new Promise(()=>{})}')
  await assert.rejects(env.launch([], { startupTimeoutMs: 100 }), error => error.code === 'package-role-startup-timeout' && error.exitConfirmed === true)
  const proof = env.proof(); assert.ok(proof); proof.revoke(); await proof.release()
})

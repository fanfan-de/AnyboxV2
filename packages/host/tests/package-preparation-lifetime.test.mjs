import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApplicationArchive, verifyApplicationArchive } from '../dist/package-management/archive.js'
import { prepareApplicationArchive } from '../dist/package-management/preparation.js'
import { acquirePackageUsageLock, prepareUsageLock, tryAcquirePackageUsageExitLock } from '../dist/package-management/usage-locks.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const target = { os: process.platform, arch: process.arch }
const runtime = { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }
const trusted = { target, applicationApiVersion: '0.1.0', runtimeProfiles: { client: { ...runtime, node: process.versions.node } }, trustedPublishers: [{ publisher: 'lifetime-fixture', keyId: 'lifetime-key', publicKey, appIds: ['lifetime-fixture'] }] }
const [major, minor] = process.versions.node.split('.').map(Number)
const supported = process.platform !== 'win32' && !process.versions.electron && (major > 22 || major === 22 && minor >= 15)
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
async function eventually(read, description, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause() }
  assert.fail(description)
}
function makeArchive(source) {
  return createApplicationArchive({
    manifest: { schemaVersion: 1, appId: 'lifetime-fixture', version: '1.0.0', publisher: 'lifetime-fixture', displayName: 'Lifetime fixture', applicationApi: '^0.1.0', target,
      entries: { client: 'payload/client.js' }, runtimeRequirements: { client: runtime } },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT test fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/client.js', bytes: Buffer.from(source) }],
    keyId: 'lifetime-key', privateKey,
  })
}
const registration = `return {definition:{id:'lifetime-fixture',name:'Lifetime fixture',icon:'fixture'},createRuntime(){throw Error('runtime must never be initialized')}}`
function waitingFactory(marker, release, descendant = false) {
  const startDescendant = descendant ? `const child=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});` : 'const child=undefined;'
  // Publish readiness only after its JSON is complete; existence is the reader's signal.
  return `import {existsSync,writeFileSync,renameSync} from 'node:fs';import {resolve} from 'node:path';import {spawn} from 'node:child_process';export async function createRegistration(){${startDescendant}writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({pid:process.pid,descendantPid:child?.pid,temporary:resolve(import.meta.dirname,'../..')}));renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});await new Promise(done=>{const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);done()}},10)});${registration}}`
}
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-preparation-lifetime-'))
  const lifetime = { directory, usageId: 'preparation-work', secret: 'isolated-preparation-work-secret' }
  prepareUsageLock(directory, lifetime.usageId, createHash('sha256').update(lifetime.secret).digest('hex'))
  return { directory, lifetime }
}
async function killOwnedGroup(pid) {
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

// Bounds below only detect hung tests. Reclamation authority always comes from an
// actual EXCLUSIVE anchor transaction; neither elapsed time nor PID state grants it.
test('preparation child keeps its work SHARED lock after parent release and stale credentials fail before factory import', { skip: !supported, timeout: 15_000 }, async t => {
  const { directory, lifetime } = workspace(t), marker = join(directory, 'factory.json'), release = join(directory, 'factory.release')
  const held = acquirePackageUsageLock(directory, lifetime)
  const controller = new AbortController()
  let preparing, temporary
  t.after(async () => {
    controller.abort(); await preparing?.catch(() => {}); await held.release()
    const cleanupProof = await eventually(() => tryAcquirePackageUsageExitLock(directory, lifetime.usageId), 'preparation cleanup could not prove actual work exit')
    cleanupProof.revoke(); await cleanupProof.release()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })
  preparing = prepareApplicationArchive(verifyApplicationArchive(makeArchive(waitingFactory(marker, release)), trusted), { lifetime, signal: controller.signal, timeoutMs: 10_000 })
  void preparing.catch(() => {})
  const child = await eventually(() => existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')), 'preparation factory never started')
  temporary = child.temporary
  assert.equal(tryAcquirePackageUsageExitLock(directory, lifetime.usageId), undefined)
  await held.release()
  assert.equal(tryAcquirePackageUsageExitLock(directory, lifetime.usageId), undefined, 'the preparation child still owns the actual read lock')
  writeFileSync(release, 'finish')
  const result = await preparing
  assert.equal(result.roles.client.status, 'prepared')
  const proof = tryAcquirePackageUsageExitLock(directory, lifetime.usageId)
  assert.ok(proof, 'successful preparation has joined actual child and process-group exit')
  proof.revoke(); await proof.release()
  assert.throws(() => acquirePackageUsageLock(directory, lifetime), { code: 'unauthorized' })
  const lateMarker = join(directory, 'late-factory-imported')
  const late = verifyApplicationArchive(makeArchive(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(lateMarker)},'imported');export function createRegistration(){${registration}}`), trusted)
  await assert.rejects(prepareApplicationArchive(late, { lifetime }), error => ['unauthorized', 'package-preparation-lifetime-unavailable'].includes(error?.code))
  assert.equal(existsSync(lateMarker), false, 'a revoked preparation credential cannot even import the signed factory module')
  assert.equal(existsSync(temporary), false, 'preparation only removes temporary bytes after exit')
})

test('manager SIGKILL disconnects pending preparation and recovery waits for actual anchor exit proof', { skip: !supported, timeout: 15_000 }, async t => {
  const { directory, lifetime } = workspace(t), marker = join(directory, 'orphan-factory.json'), release = join(directory, 'never-release')
  const bytes = makeArchive(waitingFactory(marker, release, true))
  const manager = spawn(process.execPath, [fileURLToPath(new URL('./helpers/package-preparation-manager.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(manager, 'exit')
  let stderr = '', preparingPid, descendantPid, temporary, provedExit = false
  manager.stderr.on('data', data => { stderr += data.toString() })
  t.after(async () => {
    if (manager.exitCode === null && manager.signalCode === null) manager.kill('SIGKILL')
    await exited
    if (!provedExit && preparingPid) await killOwnedGroup(preparingPid)
    if (preparingPid && !provedExit) {
      const cleanupProof = await eventually(() => tryAcquirePackageUsageExitLock(directory, lifetime.usageId), `owned preparation cleanup has no exit proof: ${stderr}`)
      cleanupProof.revoke(); await cleanupProof.release(); provedExit = true
    }
    if (!provedExit) {
      const cleanupProof = await eventually(() => tryAcquirePackageUsageExitLock(directory, lifetime.usageId), 'manager cleanup could not prove work exit')
      cleanupProof.revoke(); await cleanupProof.release(); provedExit = true
    }
    if (temporary && provedExit) rmSync(temporary, { recursive: true, force: true })
    if (provedExit) rmSync(directory, { recursive: true, force: true })
  })
  const first = once(manager, 'message')
  manager.send({ archive: bytes.toString('base64'), publicKey: publicKey.export({ format: 'pem', type: 'spki' }), lifetime })
  const [ready] = await Promise.race([first, exited.then(() => { throw new Error(`manager exited before readiness: ${stderr}`) })])
  assert.equal(ready.type, 'manager-locked')
  const child = await eventually(() => existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')), `preparation never reached pending factory: ${stderr}`)
  preparingPid = child.pid; descendantPid = child.descendantPid; temporary = child.temporary
  assert.ok(Number.isSafeInteger(descendantPid), 'the preparation factory started an owned same-group descendant')
  assert.equal(tryAcquirePackageUsageExitLock(directory, lifetime.usageId), undefined)
  manager.kill('SIGKILL')
  const [code, signal] = await exited
  assert.equal(code, null); assert.equal(signal, 'SIGKILL')
  const proof = await eventually(() => tryAcquirePackageUsageExitLock(directory, lifetime.usageId), 'disconnected preparation did not relinquish its actual SHARED lock')
  proof.revoke(); await proof.release(); provedExit = true
  assert.throws(() => acquirePackageUsageLock(directory, lifetime), { code: 'unauthorized' })
  // Supplemental process observation checks the crash guard itself; the anchor
  // transaction above, rather than this PID observation, authorizes recovery.
  for (const [pid, label] of [[preparingPid, 'preparation process'], [descendantPid, 'owned descendant']]) {
    await eventually(() => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }, `${label} survived manager IPC disconnection`)
  }
})

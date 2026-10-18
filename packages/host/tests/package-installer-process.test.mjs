import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { createPackageInstallerComponent, packageInstallerServiceKey } from '../dist/package-management/installer.js'
import { createApplicationArchive, verifyApplicationArchive, encodeApplicationDirectory } from '../dist/package-management/archive.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'

const unix = process.platform !== 'win32'
const { privateKey, publicKey } = generateKeyPairSync('ed25519'), target = { os: process.platform, arch: process.arch }
const verification = { target, applicationApiVersion: '0.1.0', trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture-key', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), appIds: ['calculator'] }] }
const archive = Buffer.from(createApplicationArchive({ keyId: 'fixture-key', privateKey,
  manifest: { schemaVersion: 1, appId: 'calculator', version: '1.0.0', publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target, web: { entry: 'payload/web/app.js', assets: 'payload/assets.json' } },
  files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/web/app.js', bytes: Buffer.from('export const value=1') }, { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/calculator/1.0.0/app.js', file: 'payload/web/app.js', type: 'text/javascript' }] })) }],
}))
const dist = pathToFileURL(fileURLToPath(new URL('../dist/', import.meta.url))).href
// A pending promise alone does not keep Node alive at the accepted boundary.
// The fixture holds the event loop until its parent injects the actual SIGKILL.
const childScript = `
  import {readFile} from 'node:fs/promises'; import {createReadStream} from 'node:fs'; import {Context} from '@nya/core';
  import {createLocalSqliteComponent} from '@anybox/storage-sqlite/sqlite';
  import {createPackageRegistryComponent} from ${JSON.stringify(dist + 'package-management/component.js')};
  import {createPackageInstallerComponent,packageInstallerServiceKey} from ${JSON.stringify(dist + 'package-management/installer.js')};
  import {packageRegistryStorageServiceKey} from ${JSON.stringify(dist + 'package-management/port.js')};
  const input=JSON.parse(await readFile(process.argv[1],'utf8')),root=new Context();
  await root.installComponent(createLocalSqliteComponent(input.directory+'/registry.sqlite',{serviceKey:packageRegistryStorageServiceKey}));
  await root.installComponent(createPackageRegistryComponent({directory:input.directory}));
  await root.installComponent(createPackageInstallerComponent({directory:input.directory,verification:input.verification,onBoundary:async(boundary,job)=>{if(input.boundary==='factory-wait'&&boundary==='verified')process.send({boundary:'factory-preparing',job});if(boundary===input.boundary){process.send({boundary,job});await new Promise(()=>{setInterval(()=>{},1000)});}}}));
  const installer=root.get(packageInstallerServiceKey),job=await installer.accept(input.intent);
  await installer.receive(job.id,createReadStream(input.archive));
  await root.fiber.dispose();
`
async function killAt(t, boundary, changes = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'anybox-installer-process-')), directory = join(temporary, 'applications'), archivePath = join(temporary, 'source.anybox-app'), config = join(temporary, 'fixture.json')
  await mkdir(directory); const bytes = changes.archive ?? archive; await writeFile(archivePath, bytes)
  await writeFile(config, JSON.stringify({ directory, archive: archivePath, boundary, verification: changes.verification ?? verification, intent: { requestId: `crash-${boundary}`, filename: 'calculator.anybox-app', archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length, ...changes.intent } }))
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, config], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = '', exited = false
  child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString() })
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) }))
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await exit; await rm(temporary, { recursive: true, force: true }) })
  let timeout
  const message = new Promise((resolve, reject) => { child.once('error', reject); child.once('message', resolve); timeout = setTimeout(() => reject(new Error(`child did not reach ${boundary}: ${stderr}`)), 10_000) })
  const state = await Promise.race([message, exit.then(result => { throw new Error(`child exited early: ${JSON.stringify(result)} ${stderr}`) })]).finally(() => clearTimeout(timeout))
  assert.equal(state.boundary, boundary === 'factory-wait' ? 'factory-preparing' : boundary)
  if (changes.beforeKill) await changes.beforeKill({ temporary, directory, job: state.job, manager: child })
  child.kill('SIGKILL'); assert.equal((await exit).signal, 'SIGKILL')
  return { directory, job: state.job, source: archivePath }
}
async function reopen(t, directory, policy = verification) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(createPackageRegistryComponent({ directory }))
  await root.installComponent(createPackageInstallerComponent({ directory, verification: policy }))
  t.after(() => root.fiber.dispose())
  return { registry: root.get(packageRegistryServiceKey), installer: root.get(packageInstallerServiceKey) }
}
for (const boundary of ['accepted', 'received', 'after-rename', 'before-ledger']) test(`SIGKILL at ${boundary} preserves durable facts and recovery never blindly replays upload or activation`, { skip: !unix }, async t => {
  const killed = await killAt(t, boundary), { registry, installer } = await reopen(t, killed.directory), recovered = await installer.get(killed.job.id)
  assert.equal(recovered.phase, 'recovery-required')
  assert.deepEqual((await registry.inspect()).applications, [])
  assert.equal((await installer.recover(recovered.id, { action: 'inspect' })).revision, recovered.revision)
  if (boundary === 'accepted') {
    assert.equal((await installer.recover(recovered.id, { action: 'resume' })).phase, 'recovery-required')
    assert.equal((await installer.recover(recovered.id, { action: 'discard' })).phase, 'cancelled')
  } else {
    const installed = await installer.recover(recovered.id, { action: 'resume' })
    assert.equal(installed.phase, 'installed', JSON.stringify(installed))
    const facts = (await registry.inspect()).applications[0]
    assert.equal(facts.installed.length, 1); assert.equal(facts.selected, null); assert.deepEqual(facts.pending, installed.identity)
    await access(join(killed.directory, 'packages', installed.identity.appId, installed.identity.version, installed.identity.digest, 'archive.anybox-app'))
    assert.equal((await registry.getOperation(installed.operationId)).phase, 'awaiting-activation')
  }
})

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const preparationSupported = unix && !process.versions.electron && (nodeMajor > 22 || nodeMajor === 22 && nodeMinor >= 15)
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
async function eventually(read, message) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause() }; assert.fail(message) }
test('SIGKILL during a synchronous preparation factory retains job-owned bytes until the child SHARED guard actually exits', { skip: !preparationSupported, timeout: 15_000 }, async t => {
  const { tryAcquirePackageUsageExitLock } = await import('../dist/package-management/usage-locks.js')
  const markerRoot = await mkdtemp(join(tmpdir(), 'anybox-installer-preparing-')), marker = join(markerRoot, 'factory.json'), release = join(markerRoot, 'release')
  let child, guardPid, provedExit = false, killed
  t.after(async () => {
    if (child && !provedExit) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (guardPid) try { process.kill(guardPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (killed) { const proof = await eventually(() => tryAcquirePackageUsageExitLock(killed.directory, killed.job.workGuardIds[0]), 'owned synchronous preparation cleanup cannot prove exit'); await proof.release(); provedExit = true }
    }
    await rm(markerRoot, { recursive: true, force: true })
  })
  const runtime = { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }, policy = { ...verification, runtimeProfiles: { client: { ...runtime, node: process.versions.node } } }
  const bytes = Buffer.from(createApplicationArchive({ keyId: 'fixture-key', privateKey,
    manifest: { schemaVersion: 1, appId: 'calculator', version: '1.0.0', publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target, entries: { client: 'payload/client.js' }, runtimeRequirements: { client: runtime } },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/client.js', bytes: Buffer.from(`import {existsSync,writeFileSync,renameSync} from 'node:fs';import {resolve} from 'node:path';export function createRegistration(){writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({pid:process.pid,temporary:resolve(import.meta.dirname,'../..')}));renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});while(!existsSync(${JSON.stringify(release)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)};return {definition:{id:'calculator',name:'Calculator',icon:'calculator'},createRuntime(){throw Error('business must never open')}}}`) }],
  }))
  killed = await killAt(t, 'factory-wait', { archive: bytes, verification: policy, async beforeKill({ manager }) {
    child = await eventually(async () => { try { return JSON.parse(await readFile(marker, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return false; throw error } }, 'preparation factory never entered its synchronous wait')
    const match = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).find(parts => parts && Number(parts[2]) === manager.pid && parts[3].endsWith('/package-management/preparation-guard.js'))
    assert.ok(match, 'owned preparation monitor must exist before the pure factory starts'); guardPid = Number(match[1])
    // Pause only our disposable group and monitor so the recovery test deterministically observes actual outstanding work.
    process.kill(-child.pid, 'SIGSTOP'); process.kill(guardPid, 'SIGSTOP')
  } })
  const { registry, installer } = await reopen(t, killed.directory, policy), job = await installer.get(killed.job.id)
  assert.ok(child.temporary.startsWith(join(await realpath(killed.directory), 'staging', job.id, 'preparation') + '/'), child.temporary)
  assert.equal(tryAcquirePackageUsageExitLock(killed.directory, job.workGuardIds[0]), undefined)
  for (const action of ['resume', 'discard']) {
    const blocked = await installer.recover(job.id, { action })
    assert.equal(blocked.phase, 'recovery-required'); assert.equal(blocked.errorCode, 'installation-work-exit-unconfirmed')
    await access(child.temporary)
  }
  await writeFile(release, 'finish')
  process.kill(-child.pid, 'SIGCONT'); process.kill(guardPid, 'SIGCONT')
  const proof = await eventually(() => tryAcquirePackageUsageExitLock(killed.directory, job.workGuardIds[0]), 'preparation did not actually release its resource guard after manager disconnect')
  await proof.release(); provedExit = true
  assert.equal((await installer.recover(job.id, { action: 'discard' })).phase, 'cancelled')
  await assert.rejects(access(join(killed.directory, 'staging', job.id)), error => error?.code === 'ENOENT')
  await assert.rejects(access(child.temporary), error => error?.code === 'ENOENT')
  assert.deepEqual((await registry.inspect()).applications, [])
})


for (const boundary of ['received', 'after-rename', 'before-ledger']) test(`unsigned directory SIGKILL at ${boundary} resumes from owned snapshot after the original source is gone`, { skip: !unix }, async t => {
  const verified = verifyApplicationArchive(archive, verification)
  const bytes = Buffer.from(encodeApplicationDirectory(['manifest.json', ...verified.filePaths].map(path => ({ path, bytes: verified.readFile(path), mode: verified.files.find(file => file.path === path)?.mode ?? 420 }))))
  const policy = { ...verification, trustedPublishers: [] }
  const killed = await killAt(t, boundary, { archive: bytes, verification: policy, intent: { filename: 'calculator', sourceFormat: 'directory', localTrust: true } })
  await rm(killed.source)
  const { registry, installer } = await reopen(t, killed.directory, policy)
  const current = await installer.get(killed.job.id)
  assert.equal(current.phase, 'recovery-required'); assert.equal(current.sourceFormat, 'directory'); assert.equal(current.localTrust, true)
  const result = await installer.recover(current.id, { action: 'resume' })
  assert.equal(result.phase, 'installed', JSON.stringify(result))
  assert.deepEqual(await readFile(join(killed.directory, 'packages', result.identity.appId, result.identity.version, result.identity.digest, 'directory.snapshot')), bytes)
  assert.equal((await registry.inspect()).applications[0].selected, null)
  assert.equal((await registry.getOperation(result.operationId)).phase, 'awaiting-activation')
})

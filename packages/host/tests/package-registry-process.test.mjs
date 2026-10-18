import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'

const selected = { appId: 'notes', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }
async function open(directory) {
  const root = new Context()
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
    await root.installComponent(createPackageRegistryComponent({ directory }))
    return { root, service: root.get(packageRegistryServiceKey), close: () => root.fiber.dispose() }
  } catch (error) { await root.fiber.dispose().catch(() => {}); throw error }
}
async function start(code, directory) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code, directory], { cwd: globalThis.process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''
  process.stderr.on('data', data => { errors += data })
  const first = await Promise.race([
    once(process, 'message').then(([message]) => message),
    once(process, 'exit').then(() => { throw new Error(`fixture exited before ready: ${errors}`) }),
  ])
  return { process, first }
}
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit'); process.kill('SIGKILL'); await exited
}

test('a registry writer is exclusive across processes and SIGKILL takeover preserves operations without replay', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-registry-process-'))
  let child, owner
  t.after(async () => { await stop(child); await owner?.close(); await rm(directory, { recursive: true, force: true }) })
  const code = `
    import { Context } from '@nya/core';
    import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite';
    import { createPackageRegistryComponent } from '@anybox/host/package-management/component';
    import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '@anybox/host/package-management/port';
    import { join } from 'node:path';
    const directory=process.argv[1], root=new Context();
    await root.installComponent(createLocalSqliteComponent(join(directory,'registry.sqlite'),{serviceKey:packageRegistryStorageServiceKey}));
    await root.installComponent(createPackageRegistryComponent({directory}));
    const service=root.get(packageRegistryServiceKey);
    const operation=await service.begin({requestId:'durable-request',kind:'install',identity:${JSON.stringify(selected)},expectedAppRevision:0});
    process.send({id:operation.id,epoch:(await service.inspect()).ownerEpoch});
    setInterval(()=>{},1000);
  `
  const started = await start(code, directory); child = started.process
  await assert.rejects(open(directory), { code: 'occupied' })
  await stop(child)
  owner = await open(directory)
  const recovered = await owner.service.findOperation('durable-request')
  assert.equal(recovered.id, started.first.id); assert.equal(recovered.phase, 'recovery-required')
  assert.equal(recovered.recovery.from, 'accepted')
  const duplicate = await owner.service.begin({ requestId: 'durable-request', kind: 'install', identity: selected, expectedAppRevision: 999 })
  assert.equal(duplicate.id, recovered.id); assert.equal(duplicate.phase, 'recovery-required')
  assert.ok((await owner.service.inspect()).ownerEpoch > started.first.epoch)
  assert.deepEqual((await owner.service.inspect()).applications, [])
})

test('a child code-use lock outlives the manager and blocks exit confirmation until actual process exit', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-registry-child-use-'))
  let owner, child
  t.after(async () => { await stop(child); await owner?.close(); await rm(directory, { recursive: true, force: true }) })
  owner = await open(directory)
  let operation = await owner.service.begin({ requestId: 'install', kind: 'install', identity: selected, expectedAppRevision: 0 })
  for (const phase of ['preparing', 'prepared', 'committing']) operation = await owner.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase })
  operation = await owner.service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 0, source: { kind: 'file', reference: 'controlled-fixture', publisher: 'anybox-test' } })
  operation = await owner.service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 1 })
  const view = await owner.service.inspect()
  const credential = await owner.service.prepareUse({ expectedRegistryRevision: view.revision, role: 'client', holderId: 'child', generation: 'boot-one', entries: [{ package: selected, entry: 'client', desiredEnabled: true }] })
  const code = `
    import { acquirePackageUsageLock } from '@anybox/host/package-management/usage-locks';
    process.send('waiting');
    process.once('message',credential=>{globalThis.usage=acquirePackageUsageLock(process.argv[1],credential);process.send('locked')});
    setInterval(()=>{},1000);
  `
  const started = await start(code, directory); child = started.process
  const locked = once(child, 'message'); child.send(credential); assert.equal((await locked)[0], 'locked')
  await owner.service.claim(credential); await owner.service.ready(credential)
  operation = await owner.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'completed' })
  await owner.close()
  owner = await open(directory)
  const actual = (await owner.service.inspect()).actual
  assert.equal(actual.length, 1); assert.equal(actual[0].usage.state, 'exit-unconfirmed')
  await assert.rejects(owner.service.confirmExit({ usageId: credential.usageId }), { code: 'version-in-use' })
  await stop(child)
  const exited = await owner.service.confirmExit({ usageId: credential.usageId })
  assert.equal(exited.state, 'exited'); assert.deepEqual((await owner.service.inspect()).actual, [])
})

test('manager takeover cannot confirm a live child exit through a copied replacement anchor', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-registry-replaced-use-'))
  let owner, child
  t.after(async () => { await stop(child); await owner?.close(); await rm(directory, { recursive: true, force: true }) })
  owner = await open(directory)
  let operation = await owner.service.begin({ requestId: 'install', kind: 'install', identity: selected, expectedAppRevision: 0 })
  for (const phase of ['preparing', 'prepared', 'committing']) operation = await owner.service.advance({ operationId: operation.id, expectedRevision: operation.revision, phase })
  operation = await owner.service.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 0, source: { kind: 'file', reference: 'fixture', publisher: 'fixture' } })
  await owner.service.select({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 1 })
  const credential = await owner.service.prepareUse({ expectedRegistryRevision: (await owner.service.inspect()).revision, role: 'client', holderId: 'child', generation: 'old', entries: [{ package: selected, entry: 'client' }] })
  const started = await start(`
    import { acquirePackageUsageLock } from '@anybox/host/package-management/usage-locks';
    process.send('waiting');
    process.once('message', credential => { globalThis.lock = acquirePackageUsageLock(process.argv[1], credential); process.send('locked') });
    setInterval(() => {}, 1000);
  `, directory)
  child = started.process
  const locked = once(child, 'message'); child.send(credential); assert.equal((await locked)[0], 'locked')
  await owner.service.claim(credential); await owner.service.ready(credential)
  const path = join(directory, 'usage-locks', `${credential.usageId}.sqlite`)
  await rename(path, path + '.original'); await copyFile(path + '.original', path)
  await owner.close(); owner = await open(directory)
  await assert.rejects(owner.service.confirmExit({ usageId: credential.usageId }), { code: 'unavailable' })
  assert.equal((await owner.service.listUsages()).find(use => use.id === credential.usageId).state, 'exit-unconfirmed')
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
  await rm(path); await rename(path + '.original', path)
  await assert.rejects(owner.service.confirmExit({ usageId: credential.usageId }), { code: 'version-in-use' })
  await stop(child)
  assert.equal((await owner.service.confirmExit({ usageId: credential.usageId })).state, 'exited')
})

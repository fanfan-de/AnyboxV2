import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, link, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createClientHost } from '../dist/client.js'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'
import { acquirePackageUsageLock, prepareUsageLock } from '../dist/package-management/usage-locks.js'

test('the client composes an empty installation registry separately from static applications and control data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-package-host-'))
  let host
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }) })
  host = await createClientHost({ applications: [], path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications') })
  const first = await host.packages.inspect()
  assert.deepEqual(first.applications, []); assert.deepEqual(first.actual, [])
  assert.notEqual(host.root.get('local-storage'), host.root.get(packageRegistryStorageServiceKey))
  assert.deepEqual(await host.root.get('local-storage').read(db => db.all('SELECT domain FROM schema_migrations').map(row => row.domain)), ['app-products'])
  const domains = await host.root.get(packageRegistryStorageServiceKey).read(db => db.all('SELECT domain FROM schema_migrations').map(row => row.domain))
  assert.equal(domains.length, 1); assert.notEqual(domains[0], 'app-products')
  assert.equal((await fetch(host.url)).status, 200)
  for (const service of ['harness.runs', 'models', 'claude-agent.runs', 'client.connections']) assert.equal(host.root.get(service), undefined)
  await assert.rejects(createClientHost({ applications: [], path: join(directory, 'other.sqlite'), packageDirectory: join(directory, 'applications') }), { code: 'occupied' })
  const packages = host.packages
  await host.close()
  await assert.rejects(packages.inspect(), { code: 'service-closing' })
  host = await createClientHost({ applications: [], path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications') })
  const next = await host.packages.inspect()
  assert.ok(next.ownerEpoch > first.ownerEpoch); assert.deepEqual(next.applications, [])
})

test('registry path aliases are rejected before changing the existing control database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-package-alias-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'control', 'registry.sqlite')
  const first = await createClientHost({ applications: [], path })
  await first.root.get('local-storage').transaction(db => { db.execute('CREATE TABLE retained (value TEXT)'); db.execute('INSERT INTO retained VALUES (?)', ['original']) })
  await first.close()
  for (const alias of ['hard', 'symbolic']) {
    const target = join(directory, alias)
    if (alias === 'symbolic' && process.platform === 'win32') await symlink(dirname(path), target, 'junction')
    else {
      await mkdir(target)
      if (alias === 'hard') await link(path, join(target, 'registry.sqlite'))
      else await symlink(path, join(target, 'registry.sqlite'), 'file')
    }
    await assert.rejects(createClientHost({ applications: [], path, packageDirectory: target }), /must be different files/)
  }
  const reopened = await createClientHost({ applications: [], path })
  try { assert.equal(await reopened.root.get('local-storage').read(db => db.get('SELECT value FROM retained').value), 'original') }
  finally { await reopened.close() }
})

test('registry configuration mutation cannot redirect real usage exit proofs to a different directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-package-config-'))
  const root = new Context()
  let lock
  t.after(async () => { await lock?.release(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const original = join(directory, 'original'), other = join(directory, 'other')
  const config = { directory: original, now: () => '2026-10-17T00:00:00.000Z' }
  const component = createPackageRegistryComponent(config)
  await root.installComponent(createLocalSqliteComponent(join(original, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(component)
  const service = root.get(packageRegistryServiceKey)
  const view = await service.inspect()
  config.directory = other; config.now = () => { throw new Error('late configuration must not be read') }
  const credential = await service.prepareUse({ expectedRegistryRevision: view.revision, role: 'client', holderId: 'original-holder', generation: 'one', entries: [] })
  lock = acquirePackageUsageLock(original, credential)
  await service.claim(credential)
  prepareUsageLock(other, credential.usageId, createHash('sha256').update(credential.secret).digest('hex'))
  await assert.rejects(service.confirmExit({ usageId: credential.usageId }), { code: 'version-in-use' })
  assert.equal((await service.listUsages())[0].state, 'exit-unconfirmed')
  await lock.release()
  assert.equal((await service.confirmExit({ usageId: credential.usageId })).state, 'exited')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, rename, symlink, link, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { reclaimRemovedApplicationPackages } from '../dist/package-management/reclamation.js'

const identity = (version = '1.0.0', digest = 'a'.repeat(64), appId = 'calculator') => ({ appId, version, digest, target: { os: 'darwin', arch: 'arm64' } })
const code = expected => error => error?.code === expected
const absent = path => assert.rejects(access(path), code('ENOENT'))
async function fixture(t, values = [identity(), identity('2.0.0', 'b'.repeat(64))]) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-code-reclamation-')))
  const initialRoot = await lstat(directory), anchor = { directory, device: initialRoot.dev, inode: initialRoot.ino }
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(directory + '.original', { recursive: true, force: true }) })
  const path = item => join(directory, 'packages', item.appId, item.version, item.digest)
  for (const item of values) {
    await mkdir(join(path(item), 'application/payload'), { recursive: true })
    // Damaged or partially deleted metadata must not prevent code-only reclamation.
    await writeFile(join(path(item), 'receipt.json'), '{"path":"../../business.sqlite"}')
    await writeFile(join(path(item), 'archive.anybox-app'), 'invalid archive bytes')
    await writeFile(join(path(item), 'application/payload/code.js'), 'export const value = 1')
  }
  await mkdir(join(directory, 'usage-locks')); await writeFile(join(directory, 'usage-locks/anchor'), 'keep actual lifetime anchors')
  await writeFile(join(directory, 'business.sqlite'), 'application business data')
  const installations = values.map((item, index) => ({ identity: item, state: index ? 'quarantined' : 'installed' }))
  const facts = { appId: values[0].appId, revision: 3, installed: installations, selected: null, pending: null }
  const operations = values.map((item, index) => ({ id: `remove-${index}`, appId: item.appId, identity: item, kind: 'remove', phase: 'prepared', revision: 0 }))
  const batch = { id: 'remove-batch', kind: 'remove', phase: 'reclaiming', revision: 2, targets: values.map((item, index) => ({ identity: item, operationId: operations[index].id })) }
  const state = { beforeWork: undefined, completed: 0, guarded: [], batch, facts, operations }
  const registry = {
    async getActivation(id) { assert.equal(id, batch.id); return structuredClone(batch) },
    async getOperation(id) { return structuredClone(operations.find(item => item.id === id)) },
    async inspect() { return structuredClone({ applications: [facts] }) },
    async withReclamation(input, work) {
      const operation = operations.find(item => item.id === input.operationId), installation = installations.find(item => item.identity.digest === operation.identity.digest)
      assert.equal(input.expectedRevision, operation.revision); assert.equal(input.expectedAppRevision, facts.revision)
      state.guarded.push(operation.identity)
      try {
        operation.phase = 'committing'; installation.state = 'reclaiming'
        await state.beforeWork?.(operation.identity)
        await work(operation.identity, new AbortController().signal, anchor)
        operation.phase = 'completed'; operation.revision++; installation.state = 'removed'; facts.revision++
      } catch (error) { operation.phase = 'recovery-required'; operation.revision++; throw error }
    },
    async completeRemoval(input) { assert.equal(input.expectedRevision, batch.revision); assert.ok(installations.every(item => item.state === 'removed')); assert.ok(operations.every(item => item.phase === 'completed')); state.completed++; batch.phase = 'completed'; batch.revision++; return structuredClone(batch) },
  }
  return { directory, path, registry, state, anchor, async reclaim() { return reclaimRemovedApplicationPackages({ directory, registry, activationId: batch.id }) }, resume() { batch.phase = 'reclaiming'; for (const operation of operations) if (operation.phase === 'recovery-required') operation.phase = 'prepared'; state.beforeWork = undefined } }
}

test('reclamation removes all recorded versions including quarantined content and preserves business, other apps and usage anchors', async t => {
  const f = await fixture(t), other = identity('1.0.0', 'c'.repeat(64), 'other')
  await mkdir(f.path(other), { recursive: true }); await writeFile(join(f.path(other), 'keep'), 'other application')
  const result = await f.reclaim()
  assert.equal(result.phase, 'completed'); assert.equal(f.state.completed, 1); assert.equal(f.state.guarded.length, 2)
  for (const target of result.targets) await absent(f.path(target.identity))
  assert.equal(await readFile(join(f.directory, 'business.sqlite'), 'utf8'), 'application business data')
  assert.equal(await readFile(join(f.directory, 'usage-locks/anchor'), 'utf8'), 'keep actual lifetime anchors')
  assert.equal(await readFile(join(f.path(other), 'keep'), 'utf8'), 'other application')
})

test('internal symbolic and hard links are unlinked without reading, rewriting or deleting their external targets', async t => {
  const f = await fixture(t, [identity()]), outside = join(f.directory, 'business.sqlite'), payload = join(f.path(identity()), 'application/payload')
  await symlink(outside, join(payload, 'symbolic')); await link(outside, join(payload, 'hard'))
  assert.equal((await f.reclaim()).phase, 'completed')
  assert.equal(await readFile(outside, 'utf8'), 'application business data')
})

test('a version container or any ancestor that is a symbolic alias is rejected before deletion', async t => {
  for (const selected of ['container', 'app']) {
    const f = await fixture(t, [identity()]), target = selected === 'container' ? f.path(identity()) : join(f.directory, 'packages/calculator'), original = target + '.original'
    await rename(target, original); await symlink(original, target)
    await assert.rejects(f.reclaim(), code('package-reclamation-path-unsafe'))
    assert.equal(await readFile(join(original, selected === 'container' ? 'application/payload/code.js' : '1.0.0/' + 'a'.repeat(64) + '/application/payload/code.js'), 'utf8'), 'export const value = 1')
    assert.equal(f.state.completed, 0); assert.equal(f.state.guarded.length, 0)
  }
})

test('captured root, application ancestor and container identities are rechecked after the registry guard awaits', async t => {
  for (const selected of ['root', 'app', 'container']) {
    const f = await fixture(t, [identity()]), target = selected === 'root' ? f.directory : selected === 'app' ? join(f.directory, 'packages/calculator') : f.path(identity()), original = target + '.original'
    f.state.beforeWork = async () => { await rename(target, original); await mkdir(target); await writeFile(join(target, 'preserve'), 'replacement must survive') }
    await assert.rejects(f.reclaim(), code('package-reclamation-directory-changed'))
    assert.equal(await readFile(join(target, 'preserve'), 'utf8'), 'replacement must survive')
    assert.equal(f.state.operations[0].phase, 'recovery-required'); assert.equal(f.state.completed, 0)
    const codeFile = selected === 'container' ? 'application/payload/code.js' : selected === 'app' ? '1.0.0/' + 'a'.repeat(64) + '/application/payload/code.js' : 'packages/calculator/1.0.0/' + 'a'.repeat(64) + '/application/payload/code.js'
    assert.equal(await readFile(join(original, codeFile), 'utf8'), 'export const value = 1')
  }
})

test('partial batch failure stays incomplete and explicit retry skips removed versions', async t => {
  const f = await fixture(t), second = identity('2.0.0', 'b'.repeat(64)), target = f.path(second), original = target + '.original'
  f.state.beforeWork = async item => { if (item.version === second.version) { await rename(target, original); await mkdir(target); await writeFile(join(target, 'preserve'), 'replacement') } }
  await assert.rejects(f.reclaim(), code('package-reclamation-directory-changed'))
  await absent(f.path(identity())); assert.equal(f.state.facts.installed[0].state, 'removed'); assert.equal(f.state.completed, 0)
  assert.equal(f.state.facts.installed[1].state, 'reclaiming'); assert.equal(f.state.operations[1].phase, 'recovery-required')
  await rm(target, { recursive: true }); await rename(original, target); f.resume()
  assert.equal((await f.reclaim()).phase, 'completed'); assert.equal(f.state.guarded.length, 3)
})

test('a missing immutable container can be reconciled but a new replacement after the missing observation is preserved', async t => {
  const f = await fixture(t, [identity()]), target = f.path(identity())
  await rm(target, { recursive: true })
  f.state.beforeWork = async () => { await mkdir(target); await writeFile(join(target, 'preserve'), 'late replacement') }
  await assert.rejects(f.reclaim(), code('package-reclamation-directory-changed'))
  assert.equal(await readFile(join(target, 'preserve'), 'utf8'), 'late replacement')
  await rm(target, { recursive: true }); f.resume()
  assert.equal((await f.reclaim()).phase, 'completed'); assert.equal(f.state.operations[0].phase, 'completed')
})

test('a registry exit refusal prevents all file effects and interrupted callbacks do not claim removal', async t => {
  const f = await fixture(t, [identity()]), target = join(f.path(identity()), 'application/payload/code.js')
  f.registry.withReclamation = async () => { throw Object.assign(Error('actual usage remains'), { code: 'version-in-use' }) }
  await assert.rejects(f.reclaim(), code('version-in-use')); assert.equal(await readFile(target, 'utf8'), 'export const value = 1')
  f.registry.withReclamation = async (_input, work) => { const controller = new AbortController(); controller.abort(); await work(identity(), controller.signal, f.anchor) }
  await assert.rejects(f.reclaim(), code('package-reclamation-interrupted')); assert.equal(await readFile(target, 'utf8'), 'export const value = 1'); assert.equal(f.state.completed, 0)
})

test('only a reclaiming removal batch with exact matching operation identities may delete files', async t => {
  const f = await fixture(t, [identity()])
  f.state.batch.phase = 'loading'; await assert.rejects(f.reclaim(), code('transition-invalid'))
  f.state.batch.phase = 'reclaiming'; f.state.batch.kind = 'activate'; await assert.rejects(f.reclaim(), code('transition-invalid'))
  f.state.batch.kind = 'remove'; f.state.operations[0].identity = identity('3.0.0', 'd'.repeat(64)); await assert.rejects(f.reclaim(), code('registry-corrupt'))
  assert.equal(f.state.guarded.length, 0); assert.equal(f.state.completed, 0)
})

test('a root replaced before adapter capture cannot redirect deletion into an external matching package tree', async t => {
  const f = await fixture(t, [identity()]), external = await realpath(await mkdtemp(join(tmpdir(), 'anybox-reclamation-external-'))), held = f.directory + '.original'
  t.after(() => rm(external, { recursive: true, force: true }))
  const externalContainer = join(external, 'packages/calculator/1.0.0', 'a'.repeat(64))
  await mkdir(externalContainer, { recursive: true }); await writeFile(join(externalContainer, 'preserve'), 'external matching identity must survive')
  await rename(f.directory, held); await symlink(external, f.directory)
  await assert.rejects(f.reclaim(), code('package-reclamation-directory-changed'))
  assert.equal(await readFile(join(externalContainer, 'preserve'), 'utf8'), 'external matching identity must survive')
  assert.equal(await readFile(join(held, 'packages/calculator/1.0.0', 'a'.repeat(64), 'application/payload/code.js'), 'utf8'), 'export const value = 1')
  assert.equal(f.state.completed, 0); assert.equal(f.state.facts.installed[0].state, 'reclaiming')
})

test('destructive callbacks require the registry original root anchor rather than trusting a fresh capture', async t => {
  for (const anchor of [undefined, { directory: '/elsewhere', device: 1, inode: 1 }]) {
    const f = await fixture(t, [identity()])
    f.registry.withReclamation = (_input, work) => work(identity(), new AbortController().signal, anchor)
    await assert.rejects(f.reclaim(), code('package-reclamation-directory-changed'))
    assert.equal(await readFile(join(f.path(identity()), 'application/payload/code.js'), 'utf8'), 'export const value = 1')
    assert.equal(f.state.completed, 0)
  }
})

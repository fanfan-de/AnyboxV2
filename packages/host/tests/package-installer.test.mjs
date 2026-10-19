import { symbolicAlias } from './helpers/filesystem-alias.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { createPackageInstallerComponent, packageInstallerServiceKey } from '../dist/package-management/installer.js'
import { createApplicationArchive, verifyApplicationArchive, encodeApplicationDirectory } from '../dist/package-management/archive.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from '../dist/package-management/port.js'
import { verifyInstalledApplicationContainer } from '../dist/package-management/loader-files.js'
import { prepareUsageLock, acquirePackageUsageLock } from '../dist/package-management/usage-locks.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const hash = input => createHash('sha256').update(input).digest('hex')
const target = { os: process.platform, arch: process.arch }
const verification = () => ({ target, applicationApiVersion: '0.1.0', trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture-key', publicKey, appIds: ['calculator'] }] })
function archive({ version = '1.0.0', code = 'export const value=1', appId = 'calculator' } = {}) {
  const prefix = `/apps/${appId}/${version}`
  return Buffer.from(createApplicationArchive({ keyId: 'fixture-key', privateKey,
    manifest: { schemaVersion: 1, appId, version, publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target, web: { entry: 'payload/web/app.js', assets: 'payload/assets.json' } },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/web/app.js', bytes: Buffer.from(code) }, { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }] })) }],
  }))
}
async function setup(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'anybox-installer-'))
  let root
  const start = async (changes = {}) => {
    root = new Context()
    await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
    await root.installComponent(createPackageRegistryComponent({ directory }))
    await root.installComponent(createPackageInstallerComponent({ directory, verification: verification(), ...options, ...changes }))
    return { registry: root.get(packageRegistryServiceKey), installer: root.get(packageInstallerServiceKey) }
  }
  let current = await start()
  t.after(async () => { try { await root.fiber.dispose() } catch (error) { if (!options.expectCleanupError) throw error } finally { await rm(directory, { recursive: true, force: true }) } })
  return { directory, get root() { return root }, get registry() { return current.registry }, get installer() { return current.installer }, async reopen(changes) { await root.fiber.dispose(); current = await start(changes); return current } }
}
const intent = (bytes, requestId = 'request-one', filename = 'calculator.anybox-app') => ({ requestId, filename, archiveDigest: hash(bytes), archiveSize: bytes.length })
const upload = (installer, job, bytes) => installer.receive(job.id, Readable.from([bytes.subarray(0, 23), bytes.subarray(23)]))
const final = (directory, identity) => join(directory, 'packages', identity.appId, identity.version, identity.digest)
const absent = path => assert.rejects(access(path), error => error?.code === 'ENOENT')

test('local installation streams verified bytes, retains signed metadata and commits pending without activating business', async t => {
  const env = await setup(t), bytes = archive(), accepted = await env.installer.accept(intent(bytes))
  assert.equal(accepted.phase, 'accepted'); assert.equal(accepted.identity, null)
  assert.equal((await env.registry.inspect()).applications.length, 0)
  const result = await upload(env.installer, accepted, bytes)
  assert.equal(result.phase, 'installed'); assert.ok(result.operationId); assert.equal(result.workGuardIds.length, 1)
  const view = await env.registry.inspect(), facts = view.applications[0]
  assert.equal(facts.installed.length, 1); assert.deepEqual(facts.pending, result.identity); assert.equal(facts.selected, null); assert.deepEqual(view.actual, [])
  const operation = await env.registry.getOperation(result.operationId)
  assert.equal(operation.phase, 'awaiting-activation')
  const path = final(env.directory, result.identity)
  assert.deepEqual(await readFile(join(path, 'archive.anybox-app')), bytes)
  const verified = verifyApplicationArchive(bytes, verification())
  for (const name of ['manifest.json', 'files.json', 'signature.json', ...verified.filePaths]) assert.deepEqual(await readFile(join(path, 'application', name)), Buffer.from(verified.readFile(name)))
  assert.deepEqual(await readdir(join(env.directory, 'staging')), [])
  for (const service of ['harness.runs', 'models', 'claude-agent.runs', 'client.connections']) assert.equal(env.root.get(service), undefined)
})

test('durable admission idempotency precedes bytes and terminal retry never creates another version or operation', async t => {
  const env = await setup(t), bytes = archive()
  const first = await env.installer.accept(intent(bytes))
  assert.equal((await env.installer.accept(intent(bytes))).id, first.id)
  await assert.rejects(env.installer.accept({ ...intent(bytes), archiveSize: bytes.length + 1 }), { code: 'request-conflict' })
  const installed = await upload(env.installer, first, bytes)
  assert.equal((await env.installer.accept(intent(bytes))).id, first.id)
  assert.equal((await env.registry.listOperations()).length, 1)
  assert.equal((await upload(env.installer, installed, bytes)).phase, 'installed')
  const again = await env.installer.accept(intent(bytes, 'new-request', 'renamed.anybox-app'))
  const reused = await upload(env.installer, again, bytes)
  assert.equal(reused.phase, 'installed'); assert.equal(reused.existingInstallation, true)
  assert.equal((await env.registry.inspect()).applications[0].installed[0].source.reference, 'calculator.anybox-app')
  assert.equal((await env.registry.listOperations()).length, 1)
})

test('partial, oversized, digest-mismatched and unauthorized uploads never become installation facts', async t => {
  const env = await setup(t), bytes = archive()
  for (const [name, body, change] of [['short', bytes.subarray(0, -1), {}], ['large', Buffer.concat([bytes, Buffer.from('x')]), {}], ['digest', bytes, { archiveDigest: '0'.repeat(64) }], ['publisher', archive({ appId: 'unauthorized' }), {}]]) {
    const accepted = await env.installer.accept({ ...intent(name === 'publisher' ? body : bytes, name), ...change })
    const result = await upload(env.installer, accepted, body)
    assert.equal(result.phase, 'failed', `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.identity, null)
    await absent(join(env.directory, 'staging', result.id))
  }
  assert.deepEqual((await env.registry.inspect()).applications, [])
})

test('same version with different signed content is rejected while the installed container remains byte-for-byte unchanged', async t => {
  const env = await setup(t), bytes = archive(), first = await upload(env.installer, await env.installer.accept(intent(bytes)), bytes)
  const changed = archive({ code: 'export const value=2' }), rejected = await upload(env.installer, await env.installer.accept(intent(changed, 'different-content')), changed)
  assert.equal(rejected.phase, 'failed'); assert.equal(rejected.errorCode, 'identity-conflict')
  assert.deepEqual(await readFile(join(final(env.directory, first.identity), 'archive.anybox-app')), bytes)
  assert.equal((await env.registry.inspect()).applications[0].installed.length, 1)
})

test('cancel waits for the producer resource exit before reporting cancellation or removing staging', async t => {
  const env = await setup(t), bytes = archive(), accepted = await env.installer.accept(intent(bytes))
  let finish, cancelled = false, next
  const source = { chunks: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 20); await new Promise(resolve => { next = resolve }); if (!cancelled) yield bytes.subarray(20) } }, cancel() { cancelled = true; next?.(); setTimeout(() => finish(), 50) }, done: new Promise(resolve => { finish = resolve }) }
  const work = env.installer.receive(accepted.id, source)
  while (!next) await new Promise(resolve => setTimeout(resolve, 2))
  let returned = false
  const cancel = env.installer.cancel(accepted.id).then(result => { returned = true; return result })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(returned, false)
  assert.equal((await cancel).phase, 'cancelled'); assert.equal((await work).phase, 'cancelled')
  await absent(join(env.directory, 'staging', accepted.id)); assert.deepEqual((await env.registry.inspect()).applications, [])
})

test('rename-before-ledger interruption retains immutable files and explicit recovery revalidates them without selecting the app', async t => {
  let interrupted = false
  const env = await setup(t, { onBoundary(boundary) { if (boundary === 'after-rename' && !interrupted) { interrupted = true; throw Object.assign(new Error('injected'), { code: 'injected-interruption' }) } } }), bytes = archive()
  const first = await upload(env.installer, await env.installer.accept(intent(bytes)), bytes)
  assert.equal(first.phase, 'recovery-required'); assert.deepEqual((await env.registry.inspect()).applications, [])
  assert.deepEqual(await readFile(join(final(env.directory, first.identity), 'archive.anybox-app')), bytes)
  assert.equal((await env.installer.recover(first.id, { action: 'discard' })).phase, 'recovery-required')
  await env.reopen({ onBoundary: undefined })
  const result = await env.installer.recover(first.id, { action: 'resume' })
  assert.equal(result.phase, 'installed', JSON.stringify(result)); assert.equal(result.workGuardIds.length, 2)
  const facts = (await env.registry.inspect()).applications[0]
  assert.deepEqual(facts.pending, result.identity); assert.equal(facts.selected, null)
})

test('interruption after staging cleanup but before ledger recovers from retained committed archive', async t => {
  let interrupted = false
  const env = await setup(t, { onBoundary(boundary) { if (boundary === 'before-ledger' && !interrupted) { interrupted = true; throw Object.assign(new Error('injected'), { code: 'injected-interruption' }) } } }), bytes = archive()
  const first = await upload(env.installer, await env.installer.accept(intent(bytes)), bytes)
  assert.equal(first.phase, 'recovery-required'); await absent(join(env.directory, 'staging', first.id))
  await env.reopen({ onBoundary: undefined })
  assert.equal((await env.installer.recover(first.id, { action: 'resume' })).phase, 'installed')
})

test('recovery never trusts a corrupt, missing or symlink-substituted committed payload', async t => {
  for (const variant of ['corrupt', 'missing', 'symlink']) {
    const env = await setup(t, { onBoundary(boundary) { if (boundary === 'after-rename') throw Object.assign(new Error('injected'), { code: 'injected-interruption' }) } }), bytes = archive()
    const first = await upload(env.installer, await env.installer.accept(intent(bytes)), bytes), path = join(final(env.directory, first.identity), 'application', 'payload/web/app.js')
    if (variant === 'corrupt') await writeFile(path, 'export const value=9')
    else { await rm(path); if (variant === 'symlink') await symbolicAlias(join(env.directory, 'outside.js'), path) }
    await env.reopen({ onBoundary: undefined })
    const result = await env.installer.recover(first.id, { action: 'resume' })
    assert.equal(result.phase, 'recovery-required', variant)
    assert.deepEqual((await env.registry.inspect()).applications, [])
    await access(final(env.directory, first.identity))
  }
})

test('old work guards block explicit resume and discard until actual exit, then remain permanently revoked', async t => {
  const env = await setup(t), bytes = archive(), accepted = await env.installer.accept(intent(bytes)), secret = 'test-secret', guard = `install-guard-test`
  let job = await env.registry.advanceFileInstall({ installId: accepted.id, expectedRevision: accepted.revision, phase: 'accepted', workGuardId: guard })
  prepareUsageLock(env.directory, guard, hash(secret))
  const held = acquirePackageUsageLock(env.directory, { usageId: guard, secret })
  t.after(() => held.release())
  job = await env.registry.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'recovery-required' })
  const blocked = await env.installer.recover(job.id, { action: 'discard' })
  assert.equal(blocked.phase, 'recovery-required'); assert.equal(blocked.errorCode, 'installation-work-exit-unconfirmed')
  await held.release()
  assert.equal((await env.installer.recover(job.id, { action: 'discard' })).phase, 'cancelled')
  assert.throws(() => acquirePackageUsageLock(env.directory, { usageId: guard, secret }), { code: 'unauthorized' })
})

test('unknown staging is reported without adoption or deletion and a staging symlink is never followed', async t => {
  const env = await setup(t, { expectCleanupError: true }), bytes = archive()
  await mkdir(join(env.directory, 'staging', 'orphan')); await writeFile(join(env.directory, 'staging', 'orphan', 'evidence'), 'retain')
  assert.deepEqual(await env.installer.inspectOrphans(), ['orphan'])
  const job = await env.installer.accept(intent(bytes)), outside = join(env.directory, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'retained'), 'outside')
  await symbolicAlias(outside, join(env.directory, 'staging', job.id))
  // Unsafe cleanup is fenced and retained; no resource is claimed to have exited.
  const result = await upload(env.installer, job, bytes)
  assert.equal(result.phase, 'recovery-required')
  assert.equal(await readFile(join(outside, 'retained'), 'utf8'), 'outside')
  assert.equal(await readFile(join(env.directory, 'staging', 'orphan', 'evidence'), 'utf8'), 'retain')
  // This intentionally records a cleanup fence; clear the malicious job link only for test teardown.
  await rm(join(env.directory, 'staging', job.id))
  await assert.rejects(env.root.fiber.dispose())
})


function directorySnapshot(bytes, { unsigned = false } = {}) {
  const verified = verifyApplicationArchive(bytes, verification())
  return Buffer.from(encodeApplicationDirectory([...verified.metadataPaths, ...verified.filePaths]
    .filter(path => !unsigned || path !== 'files.json' && path !== 'signature.json')
    .map(path => ({ path, bytes: verified.readFile(path), mode: verified.files.find(file => file.path === path)?.mode ?? 420 }))))
}
const directoryIntent = (bytes, requestId = 'directory-one', localTrust = true) => ({ ...intent(bytes, requestId, 'calculator'), sourceFormat: 'directory', localTrust })

test('explicitly trusted unsigned directory installs without publisher keys and reloads its own fixed copy', async t => {
  const env = await setup(t, { verification: { ...verification(), trustedPublishers: [] } }), bytes = directorySnapshot(archive(), { unsigned: true })
  const result = await upload(env.installer, await env.installer.accept(directoryIntent(bytes)), bytes)
  assert.equal(result.phase, 'installed', JSON.stringify(result))
  assert.equal(result.localTrust, true); assert.equal(result.sourceFormat, 'directory')
  const path = final(env.directory, result.identity)
  assert.deepEqual((await readdir(path)).sort(), ['application', 'directory.snapshot', 'receipt.json'])
  assert.deepEqual(await readFile(join(path, 'directory.snapshot')), bytes)
  const loaded = await verifyInstalledApplicationContainer(env.directory, result.identity, { ...verification(), trustedPublishers: [] })
  assert.equal(loaded.archive.signature, null)
  assert.deepEqual(loaded.archive.metadataPaths, ['manifest.json', 'files.json'])
  const view = await env.registry.inspect()
  assert.equal(view.applications[0].installed[0].source.kind, 'directory')
  assert.equal(view.applications[0].selected, null)
  assert.deepEqual(view.actual, [])
  await env.reopen({ verification: { ...verification(), trustedPublishers: [] } })
  assert.equal((await env.installer.recover(result.id, { action: 'resume' })).phase, 'installed')
  await writeFile(join(path, 'application', 'payload/web/app.js'), 'export const tampered=true')
  await assert.rejects(verifyInstalledApplicationContainer(env.directory, result.identity, { ...verification(), trustedPublishers: [] }), { code: 'package-loader-content-changed' })
})

test('directory trust and source format are explicit immutable intent, never a signature bypass for archives', async t => {
  const env = await setup(t), bytes = directorySnapshot(archive(), { unsigned: true })
  const denied = await upload(env.installer, await env.installer.accept(directoryIntent(bytes, 'no-local', false)), bytes)
  assert.equal(denied.phase, 'failed'); assert.equal(denied.errorCode, 'publisher-not-authorized')
  const wrongFormat = await upload(env.installer, await env.installer.accept(intent(bytes, 'wrong-source')), bytes)
  assert.equal(wrongFormat.phase, 'failed'); assert.equal(wrongFormat.errorCode, 'installation-source-format-mismatch')
  await assert.rejects(env.installer.accept({ ...intent(archive(), 'archive-trust'), localTrust: true }), { code: 'invalid-input' })
  for (const change of [{ localTrust: false }, { sourceFormat: 'archive', localTrust: false }]) {
    await env.installer.accept(directoryIntent(bytes, 'fixed-intent'))
    await assert.rejects(env.installer.accept({ ...directoryIntent(bytes, 'fixed-intent'), ...change }), { code: 'request-conflict' })
  }
  assert.deepEqual((await env.registry.inspect()).applications, [])
})

test('signed directory and optional ZIP reuse the same identity in either order without replacing the original container', async t => {
  for (const folderFirst of [false, true]) {
    const env = await setup(t), zip = archive(), folder = directorySnapshot(zip)
    const [firstBytes, secondBytes] = folderFirst ? [folder, zip] : [zip, folder]
    const [firstIntent, secondIntent] = folderFirst ? [directoryIntent(folder, 'folder', false), intent(zip, 'zip')] : [intent(zip, 'zip'), directoryIntent(folder, 'folder', false)]
    const first = await upload(env.installer, await env.installer.accept(firstIntent), firstBytes)
    const before = await readFile(join(final(env.directory, first.identity), 'receipt.json'))
    const second = await upload(env.installer, await env.installer.accept(secondIntent), secondBytes)
    assert.equal(second.phase, 'installed', JSON.stringify(second)); assert.equal(second.existingInstallation, true)
    assert.deepEqual(second.identity, first.identity)
    assert.deepEqual(await readFile(join(final(env.directory, first.identity), 'receipt.json')), before)
    assert.equal((await env.registry.inspect()).applications[0].installed.length, 1)
  }
})

test('cross-format reimport retains its own input until the installed receipt commits and can explicitly resume', async t => {
  let interrupt = false
  const env = await setup(t, { onBoundary(boundary, job) { if (interrupt && boundary === 'before-ledger' && job.existingInstallation) throw Object.assign(new Error('interrupted'), { code: 'injected-interruption' }) } }), zip = archive(), folder = directorySnapshot(zip)
  const first = await upload(env.installer, await env.installer.accept(intent(zip)), zip)
  interrupt = true
  const duplicate = await upload(env.installer, await env.installer.accept(directoryIntent(folder, 'folder', false)), folder)
  assert.equal(duplicate.phase, 'recovery-required')
  assert.deepEqual(await readFile(join(env.directory, 'staging', duplicate.id, 'directory.snapshot')), folder)
  await env.reopen({ onBoundary: undefined })
  const resumed = await env.installer.recover(duplicate.id, { action: 'resume' })
  assert.equal(resumed.phase, 'installed', JSON.stringify(resumed)); assert.equal(resumed.existingInstallation, true)
  assert.deepEqual(resumed.identity, first.identity)
})

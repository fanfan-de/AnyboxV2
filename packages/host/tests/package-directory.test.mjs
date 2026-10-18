import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  assertVerifiedApplicationArchive, createApplicationArchive, createApplicationArchiveZip,
  createApplicationDirectory, decodeApplicationDirectory, encodeApplicationDirectory,
  isApplicationDirectorySnapshot, verifyApplicationArchive, verifyApplicationDirectory, verifyApplicationPackage,
} from '../dist/package-management/archive.js'
import { readApplicationDirectory } from '../dist/package-management/directory.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const bytes = value => Buffer.from(value)
const digest = input => createHash('sha256').update(input).digest('hex')
const manifest = { schemaVersion: 1, appId: 'fixture', version: '1.0.0', publisher: 'fixture-publisher', displayName: 'Fixture', applicationApi: '^0.1.0', target: { os: 'darwin', arch: 'arm64' }, web: { entry: 'payload/web/app.js' } }
const input = () => ({ manifest, files: [{ path: 'payload/web/app.js', bytes: bytes('throw new Error("must not execute")') }, { path: 'licenses/LICENSE', bytes: bytes('MIT fixture license') }], keyId: 'release-1', privateKey })
const options = () => ({ trustedPublishers: [{ publisher: 'fixture-publisher', keyId: 'release-1', publicKey, appIds: ['fixture'] }], target: manifest.target, applicationApiVersion: '0.1.0' })
const localEntries = () => [{ path: 'manifest.json', bytes: bytes(JSON.stringify(manifest)) }, ...input().files]
const failure = code => error => error?.code === code
async function materialize(root, entries) {
  for (const entry of entries) {
    const target = join(root, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.bytes)
    await chmod(target, entry.mode ?? 420)
  }
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'anybox-directory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('signed directories and optional ZIP distribution share exact immutable content identity', () => {
  const entries = createApplicationDirectory(input())
  const directory = verifyApplicationDirectory(entries, options())
  const archive = verifyApplicationArchive(createApplicationArchive(input()), options())
  assertVerifiedApplicationArchive(directory)
  assert.deepEqual(directory.identity, archive.identity)
  assert.deepEqual(directory.manifest, archive.manifest)
  assert.deepEqual(directory.signature, archive.signature)
  assert.deepEqual(directory.files, archive.files)
  assert.deepEqual(directory.metadataPaths, ['manifest.json', 'files.json', 'signature.json'])
  const snapshot = encodeApplicationDirectory(entries)
  assert.ok(isApplicationDirectorySnapshot(snapshot))
  assert.deepEqual(snapshot, encodeApplicationDirectory([...entries].reverse()))
  assert.equal(directory.archiveDigest, digest(snapshot))
  assert.equal(directory.archiveSize, snapshot.length)
  assert.deepEqual(verifyApplicationPackage(snapshot, options()).identity, archive.identity)
  entries[3].bytes.fill(0)
  directory.readFile('payload/web/app.js').fill(0)
  assert.deepEqual(Buffer.from(directory.readFile('payload/web/app.js')), input().files[0].bytes)
})

test('local unsigned directory admission requires explicit trust and creates its own identity and index', () => {
  const entries = localEntries()
  assert.throws(() => verifyApplicationDirectory(entries, options()), failure('publisher-not-authorized'))
  const directory = verifyApplicationDirectory(entries, { ...options(), allowUnsignedLocal: true, trustedPublishers: [] })
  assert.equal(directory.signature, null)
  assert.deepEqual(directory.metadataPaths, ['manifest.json', 'files.json'])
  const index = JSON.parse(Buffer.from(directory.readFile('files.json')).toString())
  assert.equal(index.files.length, 2)
  assert.equal(index.files[1].sha256, digest(input().files[0].bytes))
  assert.notEqual(directory.identity.digest, verifyApplicationArchive(createApplicationArchive(input()), options()).identity.digest)
  const materialized = directory.metadataPaths.map(path => ({ path, bytes: directory.readFile(path) })).concat(directory.files.map(file => ({ path: file.path, bytes: directory.readFile(file.path), mode: file.mode })))
  assert.deepEqual(verifyApplicationDirectory(materialized, { ...options(), allowUnsignedLocal: true }).identity, directory.identity)
  const minimal = verifyApplicationDirectory(entries.filter(entry => !entry.path.startsWith('licenses/')), { ...options(), allowUnsignedLocal: true })
  assert.equal(minimal.files.length, 1)
  assert.throws(() => verifyApplicationArchive(createApplicationArchiveZip(entries), { ...options(), allowUnsignedLocal: true }))
})

test('unsigned trust never replaces publisher verification when a signature is present', () => {
  const entries = createApplicationDirectory(input())
  assert.throws(() => verifyApplicationDirectory(entries, { ...options(), trustedPublishers: [], allowUnsignedLocal: true }), failure('publisher-not-authorized'))
  const tampered = entries.map(entry => entry.path === 'signature.json' ? { ...entry, bytes: bytes('{"schemaVersion":1,"keyId":"release-1","signature":"broken"}') } : entry)
  assert.throws(() => verifyApplicationDirectory(tampered, { ...options(), allowUnsignedLocal: true }), failure('invalid-signature'))
  const signed = verifyApplicationDirectory(entries, options())
  const stripped = verifyApplicationDirectory(entries.filter(entry => entry.path !== 'signature.json'), { ...options(), allowUnsignedLocal: true })
  assert.notEqual(stripped.identity.digest, signed.identity.digest)
})

test('directory framing bounds allocations, rejects aliases and unknown files, and validates full closure', () => {
  const entries = localEntries(), snapshot = encodeApplicationDirectory(entries)
  assert.deepEqual(encodeApplicationDirectory(decodeApplicationDirectory(snapshot)), snapshot)
  assert.throws(() => decodeApplicationDirectory(snapshot.subarray(0, snapshot.length - 1)), failure('invalid-directory'))
  assert.throws(() => decodeApplicationDirectory(Buffer.concat([snapshot, bytes('x')])), failure('invalid-directory'))
  assert.throws(() => decodeApplicationDirectory(snapshot, { limits: { archiveBytes: snapshot.length - 1 } }), failure('archive-size-limit'))
  assert.throws(() => encodeApplicationDirectory(entries, { limits: { metadataBytes: 1 } }), failure('expanded-size-limit'))
  assert.throws(() => encodeApplicationDirectory([...entries, { path: 'payload/Web/x.js', bytes: bytes('x') }]), failure('duplicate-path'))
  assert.throws(() => encodeApplicationDirectory([...entries, { path: 'README.md', bytes: bytes('x') }]), failure('unindexed-path'))
  let accessed = false
  assert.throws(() => encodeApplicationDirectory([...entries, { get path() { accessed = true; return 'payload/getter.js' }, bytes: bytes('x') }]), failure('invalid-directory'))
  assert.equal(accessed, false)
  assert.throws(() => verifyApplicationDirectory([...entries, { path: 'payload/unindexed.js', bytes: bytes('x') }], options()), failure('publisher-not-authorized'))
  const signed = createApplicationDirectory(input())
  assert.throws(() => verifyApplicationDirectory([...signed, { path: 'payload/unindexed.js', bytes: bytes('x') }], options()), failure('unindexed-path'))
  const controller = new AbortController(); controller.abort()
  assert.throws(() => encodeApplicationDirectory(entries, { signal: controller.signal }), error => error.name === 'AbortError')
})

test('unsigned directories without an index use the same ordinary modes through CLI and browser transport', async t => {
  const root = await temporary(t), entries = localEntries()
  await materialize(root, entries)
  await chmod(join(root, 'payload/web/app.js'), 0o755)
  const localSnapshot = await readApplicationDirectory(root)
  const browserSnapshot = encodeApplicationDirectory(entries.map(entry => ({ ...entry, mode: 420 })))
  assert.deepEqual(localSnapshot, browserSnapshot)
  assert.deepEqual(verifyApplicationPackage(localSnapshot, { ...options(), allowUnsignedLocal: true }).identity, verifyApplicationPackage(browserSnapshot, { ...options(), allowUnsignedLocal: true }).identity)
  const signed = createApplicationDirectory({ ...input(), files: input().files.map(file => ({ ...file, mode: file.path.startsWith('payload/') ? 493 : 420 })) })
  await materialize(root, signed)
  const explicit = verifyApplicationPackage(await readApplicationDirectory(root), options())
  assert.equal(explicit.files.find(file => file.path.startsWith('payload/')).mode, 493)
  await chmod(join(root, 'payload/web/app.js'), 0o644)
  const mismatched = await readApplicationDirectory(root)
  assert.throws(() => verifyApplicationPackage(mismatched, options()), failure('file-integrity-mismatch'))
})

test('filesystem directories are copied without altering source files or requiring compression', async t => {
  const root = await temporary(t), entries = createApplicationDirectory(input())
  await materialize(root, entries)
  const snapshot = await readApplicationDirectory(root)
  assert.deepEqual(snapshot, encodeApplicationDirectory(entries))
  assert.deepEqual(verifyApplicationPackage(snapshot, options()).identity, verifyApplicationArchive(createApplicationArchive(input()), options()).identity)
  assert.deepEqual(await readFile(join(root, 'payload/web/app.js')), input().files[0].bytes)
  const local = await temporary(t)
  await materialize(local, localEntries())
  assert.equal(verifyApplicationPackage(await readApplicationDirectory(local), { ...options(), allowUnsignedLocal: true }).signature, null)
})

test('filesystem directory reader rejects links, hard links, unknown empty directories and oversized files', async t => {
  const root = await temporary(t)
  await materialize(root, localEntries())
  await symlink(join(root, 'payload/web/app.js'), join(root, 'payload/link.js'))
  await assert.rejects(readApplicationDirectory(root), failure('unsafe-file-kind'))
  await rm(join(root, 'payload/link.js'))
  await link(join(root, 'payload/web/app.js'), join(root, 'payload/hard.js'))
  await assert.rejects(readApplicationDirectory(root), failure('unsafe-file-kind'))
  await rm(join(root, 'payload/hard.js'))
  await mkdir(join(root, 'payload/unused'))
  await assert.rejects(readApplicationDirectory(root), failure('unindexed-path'))
  await rm(join(root, 'payload/unused'), { recursive: true })
  await assert.rejects(readApplicationDirectory(root, { limits: { fileBytes: 1 } }), failure('expanded-size-limit'))
  const alias = `${root}-link`
  await symlink(root, alias); t.after(() => rm(alias, { force: true }))
  await assert.rejects(readApplicationDirectory(alias), failure('unsafe-file-kind'))
})

test('directory reading joins cancellation and refuses source mutations during capture', async t => {
  const root = await temporary(t)
  await materialize(root, localEntries())
  let checks = 0
  const aborted = new Error('cancelled while reading')
  await assert.rejects(readApplicationDirectory(root, { signal: { throwIfAborted() { if (++checks === 10) throw aborted } } }), error => error === aborted)
  const target = join(root, 'payload/web/app.js')
  checks = 0
  // Hooks execute at explicit cancellation boundaries, while the directory/file handles are live.
  await assert.rejects(readApplicationDirectory(root, { signal: { throwIfAborted() {
    if (++checks > 15) writeFileSync(target, `changed source ${checks}`)
  } } }), error => error?.code === 'directory-source-changed')
})

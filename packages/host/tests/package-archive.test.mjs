import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'
import {
  applicationArchiveCrc32, applicationArchivePath, applicationArchiveSigningMessage,
  assertVerifiedApplicationArchive, createApplicationArchive, createApplicationArchiveZip,
  parseApplicationArchiveJson, verifyApplicationArchive,
} from '../dist/package-management/archive.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const manifest = () => ({ schemaVersion: 1, appId: 'fixture', version: '1.0.0', publisher: 'fixture-publisher', displayName: 'Fixture', applicationApi: '^0.1.0', target: { os: 'darwin', arch: 'arm64' }, web: { entry: 'payload/web/app.js' } })
const bytes = value => Buffer.from(value)
const hash = input => createHash('sha256').update(input).digest('hex')
const files = () => [{ path: 'licenses/LICENSE', bytes: bytes('MIT fixture license') }, { path: 'payload/web/app.js', bytes: bytes('throw new Error("must never execute during verification")') }]
const options = () => ({ trustedPublishers: [{ publisher: 'fixture-publisher', keyId: 'release-1', publicKey, appIds: ['fixture'] }], target: { os: 'darwin', arch: 'arm64' }, applicationApiVersion: '0.1.0' })
const archive = (changes = {}) => createApplicationArchive({ manifest: manifest(), files: files(), privateKey, keyId: 'release-1', ...changes })
const failure = code => error => error?.code === code

function signedRaw({ manifestBytes = bytes(JSON.stringify(manifest())), indexBytes, payload = files(), signature, extra = [] } = {}) {
  indexBytes ??= bytes(JSON.stringify({ schemaVersion: 1, files: payload.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes), mode: file.mode ?? 420 })) }))
  const sig = signature ?? sign(null, applicationArchiveSigningMessage(manifestBytes, indexBytes), privateKey).toString('base64')
  return createApplicationArchiveZip([{ path: 'manifest.json', bytes: manifestBytes }, { path: 'files.json', bytes: indexBytes }, { path: 'signature.json', bytes: bytes(JSON.stringify({ schemaVersion: 1, keyId: 'release-1', signature: sig })) }, ...payload, ...extra])
}
function records(input) {
  const data = Buffer.from(input)
  const centralStart = data.readUInt32LE(data.length - 6)
  const result = []
  let central = centralStart
  while (central < data.length - 22) {
    const length = data.readUInt16LE(central + 28)
    const local = data.readUInt32LE(central + 42)
    result.push({ path: data.subarray(central + 46, central + 46 + length).toString(), local, central, size: data.readUInt32LE(central + 24), nameSize: length })
    central += 46 + length
  }
  return { data, centralStart, records: result }
}
function mutate(input, fn) { const parsed = records(input); fn(parsed); return parsed.data }
function compressedZip(input, trailing = false) {
  const original = records(input)
  const locals = [], centrals = []
  let offset = 0
  for (const item of original.records) {
    const local = Buffer.from(original.data.subarray(item.local, item.local + 30 + item.nameSize))
    const central = Buffer.from(original.data.subarray(item.central, item.central + 46 + item.nameSize))
    const data = original.data.subarray(item.local + 30 + item.nameSize, item.local + 30 + item.nameSize + item.size)
    const compressed = Buffer.concat([deflateRawSync(data), ...(trailing ? [bytes('junk')] : [])])
    local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18)
    central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(offset, 42)
    locals.push(local, compressed); centrals.push(central)
    offset += local.length + compressed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.from(original.data.subarray(-22))
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

test('signed UI-only archive verifies without importing code or requiring Node, SQL or Nya', () => {
  const input = archive()
  const result = verifyApplicationArchive(input, options())
  assertVerifiedApplicationArchive(result)
  assert.deepEqual(result.roleCompatibility, { web: { compatible: true, reasons: [] } })
  assert.equal(result.manifest.entries, undefined)
  assert.equal(result.archiveDigest, hash(input))
  assert.match(result.identity.digest, /^[a-f0-9]{64}$/)
  assert.notEqual(result.identity.digest, result.archiveDigest)
  assert.equal(result.identity.appId, 'fixture')
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.manifest.web) && Object.isFrozen(result.files))
  assert.throws(() => assertVerifiedApplicationArchive({ ...result }), failure('unverified-archive'))
})

test('verified metadata and backing payload cannot be changed through caller buffers or reads', () => {
  const input = Buffer.from(archive())
  const result = verifyApplicationArchive(input, options())
  const original = result.readFile('payload/web/app.js')
  result.readFile('payload/web/app.js').fill(0)
  input.fill(0)
  assert.deepEqual(result.readFile('payload/web/app.js'), original)
  assert.throws(() => { result.files[0].size = 0 }, TypeError)
  assert.throws(() => result.readFile('unknown'), failure('unknown-file'))
})

test('deterministic writer signs complete raw-byte manifest and index', () => {
  assert.deepEqual(archive(), archive())
  const input = archive()
  const changed = mutate(input, ({ data, records }) => {
    const entry = records.find(item => item.path === 'manifest.json')
    const start = entry.local + 30 + entry.nameSize
    const body = Buffer.from(data.subarray(start, start + entry.size))
    body[body.indexOf('Fixture')] = 'f'.charCodeAt(0)
    body.copy(data, start)
    const crc = applicationArchiveCrc32(body)
    data.writeUInt32LE(crc, entry.local + 14); data.writeUInt32LE(crc, entry.central + 16)
  })
  assert.throws(() => verifyApplicationArchive(changed, options()), failure('invalid-signature'))
  const whitespace = bytes(` ${JSON.stringify(manifest())}\n`)
  assert.doesNotThrow(() => verifyApplicationArchive(signedRaw({ manifestBytes: whitespace }), options()))
})

test('publisher keys are external, scoped to app ID, unambiguous and Ed25519 only', () => {
  const input = archive()
  assert.throws(() => verifyApplicationArchive(input, { ...options(), trustedPublishers: [] }), failure('publisher-not-authorized'))
  assert.throws(() => verifyApplicationArchive(input, { ...options(), trustedPublishers: [{ ...options().trustedPublishers[0], appIds: ['*'] }] }), failure('publisher-not-authorized'))
  assert.throws(() => verifyApplicationArchive(input, { ...options(), trustedPublishers: [options().trustedPublishers[0], options().trustedPublishers[0]] }), failure('publisher-not-authorized'))
  const other = generateKeyPairSync('ed25519')
  assert.throws(() => verifyApplicationArchive(input, { ...options(), trustedPublishers: [{ ...options().trustedPublishers[0], publicKey: other.publicKey }] }), failure('invalid-signature'))
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.throws(() => verifyApplicationArchive(input, { ...options(), trustedPublishers: [{ ...options().trustedPublishers[0], publicKey: rsa.publicKey }] }), failure('invalid-signature'))
})

test('malformed, duplicate-key, extra-field and unknown-version metadata are rejected', () => {
  assert.throws(() => verifyApplicationArchive(signedRaw({ manifestBytes: bytes(JSON.stringify(manifest()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')) }), options()), failure('duplicate-json-key'))
  assert.throws(() => verifyApplicationArchive(signedRaw({ manifestBytes: bytes(JSON.stringify({ ...manifest(), executable: 'bad' })) }), options()), failure('unknown-metadata-field'))
  assert.throws(() => verifyApplicationArchive(signedRaw({ manifestBytes: bytes(JSON.stringify({ ...manifest(), schemaVersion: 2 })) }), options()), failure('unsupported-schema'))
  assert.throws(() => parseApplicationArchiveJson(Uint8Array.from([0xff])), failure('invalid-json'))
  assert.throws(() => parseApplicationArchiveJson(bytes('{"a":1,"\\u0061":2}')), failure('duplicate-json-key'))
  assert.throws(() => parseApplicationArchiveJson(bytes('{"a":1e1000}')), failure('invalid-json'))
  assert.throws(() => parseApplicationArchiveJson(bytes('\ufeff{}')), failure('invalid-json'))
})

test('platform and application API mismatches are rejected before preparation', () => {
  assert.throws(() => verifyApplicationArchive(archive(), { ...options(), target: { os: 'win32', arch: 'x64' } }), failure('target-incompatible'))
  assert.throws(() => verifyApplicationArchive(archive(), { ...options(), applicationApiVersion: '1.0.0' }), failure('application-api-incompatible'))
})

test('Node runtime and native constraints are evaluated per role; unsupported worker leaves client usable', () => {
  const value = { ...manifest(), entries: { client: 'payload/client.js', computerWorker: 'payload/worker.js' }, runtimeRequirements: { client: { profile: 'node-1', sharedRuntime: 'nya-1', node: '>=24', nodeApi: 9, modules: '137', sqlite: true }, computerWorker: { profile: 'unix-worker', libc: 'glibc', platforms: ['darwin', 'linux'] } } }
  const input = archive({ manifest: value, files: [...files(), { path: 'payload/client.js', bytes: bytes('export function createRegistration(){}') }, { path: 'payload/worker.js', bytes: bytes('throw new Error("unsupported worker never imported")') }] })
  const result = verifyApplicationArchive(input, { ...options(), runtimeProfiles: { client: { profile: 'node-1', sharedRuntime: 'nya-1', node: '24.16.0', nodeApi: 10, modules: '137', sqlite: true }, computerWorker: { profile: 'node-1', platform: 'win32' } } })
  assert.equal(result.roleCompatibility.client.compatible, true)
  assert.deepEqual(result.roleCompatibility.computerWorker.reasons, ['runtime-profile-incompatible', 'libc-incompatible', 'runtime-platform-incompatible'])
  const unavailable = verifyApplicationArchive(input, options())
  assert.deepEqual(unavailable.roleCompatibility.client.reasons, ['runtime-unavailable'])
  const incompatible = verifyApplicationArchive(input, { ...options(), runtimeProfiles: { client: { profile: 'node-2', node: '22.0.0', nodeApi: 8, modules: '127' } } })
  assert.equal(incompatible.roleCompatibility.client.reasons.length, 6)
})

test('declared Node entries need matching runtime declarations; web and capabilities stay optional', () => {
  assert.throws(() => archive({ manifest: { ...manifest(), entries: { client: 'payload/client.js' } } }), failure('missing-runtime-requirement'))
  assert.throws(() => archive({ manifest: { ...manifest(), runtimeRequirements: { execution: { profile: 'node' } } } }), failure('missing-runtime-requirement'))
  assert.throws(() => archive({ manifest: { ...manifest(), capabilityRequirements: { web: { required: { 'storage.sqlite': '^1' }, optional: { 'storage.sqlite': '^1' } } } } }), failure('duplicate-capability'))
  assert.throws(() => archive({ manifest: { ...manifest(), web: undefined } }), failure('missing-entry'))
  assert.throws(() => verifyApplicationArchive(archive({ manifest: { ...manifest(), web: { entry: 'payload/missing.js' } } }), options()), failure('missing-entry-file'))
})

test('all indexed payload bytes, sizes and execution modes must match', () => {
  const payload = files()
  const index = { schemaVersion: 1, files: payload.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes), mode: 420 })) }
  for (const patch of [{ sha256: '0'.repeat(64) }, { size: payload[1].bytes.length + 1 }, { mode: 493 }]) {
    const changed = structuredClone(index); Object.assign(changed.files[1], patch)
    assert.throws(() => verifyApplicationArchive(signedRaw({ payload, indexBytes: bytes(JSON.stringify(changed)) }), options()), failure('file-integrity-mismatch'))
  }
  assert.throws(() => verifyApplicationArchive(signedRaw({ extra: [{ path: 'payload/unindexed.js', bytes: bytes('ignored?') }] }), options()), failure('unindexed-path'))
  assert.throws(() => verifyApplicationArchive(archive({ files: [payload[1]] }), options()), failure('unindexed-path'))
})

test('cross-platform paths, parent-file conflicts, Unicode and case aliases are rejected', () => {
  for (const path of ['/payload/a', 'payload/../x', 'payload/./x', 'payload//x', 'payload/C:\\x', 'payload/con.txt', 'payload/COM¹.txt', 'payload/LPT².js', 'payload/com³', 'payload/x.', 'payload/x ', 'payload/%2e%2e/x', 'payload/e\u0301', 'payload/a\u202eb']) assert.throws(() => applicationArchivePath(path))
  assert.throws(() => createApplicationArchiveZip([{ path: 'payload/a', bytes: bytes('') }, { path: 'payload/A', bytes: bytes('') }]), failure('duplicate-path'))
  assert.throws(() => createApplicationArchiveZip([{ path: 'payload/A/x', bytes: bytes('') }, { path: 'payload/a/y', bytes: bytes('') }]), failure('duplicate-path'))
  assert.throws(() => createApplicationArchiveZip([{ path: 'payload/a/b', bytes: bytes('') }, { path: 'payload/a', bytes: bytes('') }]), failure('path-kind-conflict'))
  assert.throws(() => createApplicationArchiveZip([{ path: 'payload/a', bytes: bytes('') }, { path: 'payload/a/b', bytes: bytes('') }]), failure('path-kind-conflict'))
  const unsafe = mutate(archive(), ({ data, records }) => {
    const file = records.find(item => item.path === 'payload/web/app.js')
    const replacement = bytes('payload/../app.js_')
    assert.equal(replacement.length, file.nameSize)
    replacement.copy(data, file.central + 46); replacement.copy(data, file.local + 30)
  })
  assert.throws(() => verifyApplicationArchive(unsafe, options()), failure('unsafe-path'))
})

test('ZIP links, device files, metadata modes and local/central mismatches are rejected', () => {
  for (const mode of [0o120777, 0o020644, 0o040755]) {
    const changed = mutate(archive(), ({ data, records }) => data.writeUInt32LE((mode << 16) >>> 0, records.at(-1).central + 38))
    assert.throws(() => verifyApplicationArchive(changed, options()), failure('unsafe-file-kind'))
  }
  const metadataMode = mutate(archive(), ({ data, records }) => data.writeUInt32LE((0o100755 << 16) >>> 0, records[0].central + 38))
  assert.throws(() => verifyApplicationArchive(metadataMode, options()), failure('invalid-metadata-mode'))
  const local = mutate(archive(), ({ data, records }) => data.writeUInt32LE(1, records.at(-1).local + 14))
  assert.throws(() => verifyApplicationArchive(local, options()), failure('zip-local-mismatch'))
  const crc = mutate(archive(), ({ data, records }) => { const file = records.at(-1); data[file.local + 30 + file.nameSize] ^= 1 })
  assert.throws(() => verifyApplicationArchive(crc, options()), failure('file-crc-mismatch'))
})

test('ZIP encrypted, descriptor, duplicate, prepended, appended and ZIP64 forms are rejected', () => {
  for (const bit of [1, 8]) {
    const changed = mutate(archive(), ({ data, records }) => data.writeUInt16LE(0x800 | bit, records[0].central + 8))
    assert.throws(() => verifyApplicationArchive(changed, options()), failure('unsupported-zip-feature'))
  }
  assert.throws(() => verifyApplicationArchive(Buffer.concat([bytes('prefix'), archive()]), options()))
  assert.throws(() => verifyApplicationArchive(Buffer.concat([archive(), bytes('suffix')]), options()))
  const zip64 = Buffer.from(archive()); zip64.writeUInt16LE(65535, zip64.length - 12)
  assert.throws(() => verifyApplicationArchive(zip64, options()), failure('invalid-zip'))
  const duplicate = mutate(archive(), ({ data, records }) => {
    const first = records.find(item => item.path === 'manifest.json')
    const second = records.find(item => item.path === 'signature.json')
    // Duplicate names cannot be hidden as central-directory aliases or overlapping local records.
    data.writeUInt32LE(first.local, second.central + 42)
  })
  assert.throws(() => verifyApplicationArchive(duplicate, options()), failure('unsupported-zip-feature'))
  const alias = mutate(archive({ files: [...files(), { path: 'payload/web/bpp.js', bytes: bytes('') }] }), ({ data, records }) => {
    const file = records.find(item => item.path === 'payload/web/bpp.js')
    bytes('payload/web/APP.js').copy(data, file.central + 46)
    bytes('payload/web/APP.js').copy(data, file.local + 30)
  })
  assert.throws(() => verifyApplicationArchive(alias, options()), failure('duplicate-path'))
})

test('bounded deflate verifies and rejects trailing compressed bytes and compression bombs', () => {
  const compressed = compressedZip(archive())
  assert.equal(verifyApplicationArchive(compressed, options()).manifest.appId, 'fixture')
  assert.throws(() => verifyApplicationArchive(compressedZip(archive(), true), options()), failure('zip-compressed-trailing-data'))
  const bomb = compressedZip(archive({ files: [...files(), { path: 'payload/big.txt', bytes: Buffer.alloc(100_000, 65) }] }))
  assert.throws(() => verifyApplicationArchive(bomb, options()), failure('expanded-size-limit'))
  const malformedPayload = mutate(compressed, ({ data, records }) => {
    const file = records.find(item => item.path === 'payload/web/app.js')
    data[file.local + 30 + file.nameSize] = 0xff
  })
  assert.throws(() => verifyApplicationArchive(malformedPayload, { ...options(), trustedPublishers: [] }), failure('publisher-not-authorized'))
  assert.throws(() => verifyApplicationArchive(malformedPayload, options()), failure('invalid-compression'))
})

test('archive, metadata, file count, per-file and total bounds apply before allocation or extraction', () => {
  const input = archive()
  assert.throws(() => verifyApplicationArchive(input, { ...options(), limits: { archiveBytes: input.length - 1 } }), failure('archive-size-limit'))
  for (const limits of [{ metadataBytes: 16 }, { fileBytes: 8 }, { expandedBytes: 200 }]) assert.throws(() => verifyApplicationArchive(input, { ...options(), limits }), failure('expanded-size-limit'))
  assert.throws(() => verifyApplicationArchive(input, { ...options(), limits: { files: 1 } }), failure('invalid-zip'))
  assert.throws(() => verifyApplicationArchive(input, { ...options(), limits: { files: 0 } }), failure('invalid-limits'))
  const controller = new AbortController(); controller.abort()
  assert.throws(() => verifyApplicationArchive(input, { ...options(), signal: controller.signal }), { name: 'AbortError' })
})

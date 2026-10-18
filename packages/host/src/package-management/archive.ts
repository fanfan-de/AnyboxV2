import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { satisfies, valid, validRange } from 'semver'
import type { ApplicationArchiveFile, ApplicationArchiveLimits, ApplicationArchiveManifest, ApplicationArchiveRole, ApplicationArchiveRoleCompatibility, ApplicationArchiveRuntimeProfile, ApplicationArchiveRuntimeRequirement, ApplicationDirectoryEntry, CreateApplicationArchiveInput, VerifiedApplicationArchive, VerifyApplicationArchiveOptions, VerifyApplicationPackageOptions } from './archive-types.js'

import { addApplicationArchivePath as addPath, applicationArchiveFailure, applicationArchiveLimits as limitsFor, applicationArchivePath, decodeApplicationDirectory, encodeApplicationDirectory, isApplicationDirectorySnapshot } from './directory-format.js'

export type * from './archive-types.js'
export { applicationArchiveFailure, applicationArchiveLimits, applicationArchivePath, defaultApplicationArchiveLimits, decodeApplicationDirectory, encodeApplicationDirectory, isApplicationDirectorySnapshot } from './directory-format.js'

const roles = ['client', 'execution', 'computerWorker'] as const
const nodePlatforms = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'netbsd'] as const
const metadata = new Set(['manifest.json', 'files.json', 'signature.json'])
const domain = Buffer.from('Anybox Application Package v1\0', 'utf8')
const verifiedArchives = new WeakSet<object>()
function reject(code: string): never { throw applicationArchiveFailure(code) }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject('invalid-metadata')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) reject('unknown-metadata-field')
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) reject('invalid-metadata')
  return value
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) reject('invalid-metadata')
  return value
}
function semverRange(value: unknown): string {
  const result = text(value)
  if (!validRange(result)) reject('invalid-compatibility')
  return result
}
function integer(value: unknown, maximum = 0xffffffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) reject('invalid-metadata')
  return value
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function payloadPath(value: unknown): string {
  const result = applicationArchivePath(value)
  if (!result.startsWith('payload/')) reject('invalid-entry-path')
  return result
}

/** Reject duplicate JSON members before parsing, and never replace the signed raw bytes. */
export function parseApplicationArchiveJson(bytes: Uint8Array): unknown {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return reject('invalid-json') }
  let offset = 0
  let nodes = 0
  const whitespace = (): void => { while (/[\x20\t\r\n]/.test(source[offset] ?? '\0')) offset++ }
  const string = (): string => {
    if (source[offset] !== '"') reject('invalid-json')
    const begin = offset++
    while (offset < source.length) {
      const next = source[offset++]
      if (next === '\\') { offset++; continue }
      if (next === '"') {
        try { return JSON.parse(source.slice(begin, offset)) as string } catch { return reject('invalid-json') }
      }
    }
    return reject('invalid-json')
  }
  const value = (depth: number): void => {
    if (depth > 48 || ++nodes > 250_000) reject('json-limit')
    whitespace()
    if (source[offset] === '"') { string(); return }
    if (source[offset] === '{') {
      offset++; whitespace(); const members = new Set<string>()
      if (source[offset] === '}') { offset++; return }
      for (;;) {
        whitespace(); const member = string()
        if (members.has(member)) reject('duplicate-json-key')
        members.add(member); whitespace()
        if (source[offset++] !== ':') reject('invalid-json')
        value(depth + 1); whitespace()
        const delimiter = source[offset++]
        if (delimiter === '}') return
        if (delimiter !== ',') reject('invalid-json')
      }
    }
    if (source[offset] === '[') {
      offset++; whitespace()
      if (source[offset] === ']') { offset++; return }
      for (;;) {
        value(depth + 1); whitespace(); const delimiter = source[offset++]
        if (delimiter === ']') return
        if (delimiter !== ',') reject('invalid-json')
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset))
    if (!match) reject('invalid-json')
    offset += match[0].length
    if (!Number.isFinite(Number(match[0])) && !['true', 'false', 'null'].includes(match[0])) reject('invalid-json')
  }
  value(0); whitespace()
  if (offset !== source.length) reject('invalid-json')
  try { return JSON.parse(source) } catch { return reject('invalid-json') }
}

function validateRuntime(value: unknown): ApplicationArchiveRuntimeRequirement {
  const input = object(value)
  keys(input, ['profile', 'sharedRuntime', 'node', 'nodeApi', 'modules', 'sqlite', 'libc', 'platforms'])
  name(input.profile)
  if (input.sharedRuntime !== undefined) name(input.sharedRuntime)
  if (input.node !== undefined) semverRange(input.node)
  if (input.nodeApi !== undefined && integer(input.nodeApi, 1000) < 1) reject('invalid-compatibility')
  if (input.modules !== undefined && !/^[1-9][0-9]{0,4}$/.test(text(input.modules))) reject('invalid-compatibility')
  if (input.sqlite !== undefined && typeof input.sqlite !== 'boolean') reject('invalid-compatibility')
  if (input.libc !== undefined && input.libc !== 'glibc' && input.libc !== 'musl') reject('invalid-compatibility')
  if (input.platforms !== undefined && (!Array.isArray(input.platforms) || !input.platforms.length || input.platforms.length > nodePlatforms.length || new Set(input.platforms).size !== input.platforms.length || input.platforms.some(platform => !nodePlatforms.includes(platform as typeof nodePlatforms[number])))) reject('invalid-compatibility')
  return input as unknown as ApplicationArchiveRuntimeRequirement
}

export function validateApplicationArchiveManifest(value: unknown): ApplicationArchiveManifest {
  const input = object(value)
  keys(input, ['schemaVersion', 'appId', 'version', 'publisher', 'displayName', 'applicationApi', 'target', 'entries', 'web', 'runtimeRequirements', 'capabilityRequirements', 'dataCompatibility', 'lifecycleVersion'])
  if (input.schemaVersion !== 1) reject('unsupported-schema')
  if (input.lifecycleVersion !== undefined && input.lifecycleVersion !== 1) reject('lifecycle-version-unsupported')
  name(input.appId); name(input.publisher); text(input.displayName)
  if (valid(text(input.version)) !== input.version) reject('invalid-version')
  semverRange(input.applicationApi)
  const target = object(input.target)
  keys(target, ['os', 'arch'])
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(text(target.os)) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(text(target.arch))) reject('invalid-target')
  const entries = input.entries === undefined ? {} : object(input.entries)
  keys(entries, roles)
  for (const entry of Object.values(entries)) if (!/\.(?:mjs|js)$/.test(payloadPath(entry))) reject('invalid-entry-path')
  if (input.web !== undefined) {
    const web = object(input.web); keys(web, ['entry', 'assets', 'styles'])
    if (!/\.(?:mjs|js)$/.test(payloadPath(web.entry))) reject('invalid-entry-path')
    if (web.assets !== undefined) payloadPath(web.assets)
    if (web.styles !== undefined) {
      if (!Array.isArray(web.styles) || web.styles.length > 256) reject('invalid-entry-path')
      const styles = new Set<string>()
      for (const style of web.styles) {
        const path = payloadPath(style)
        if (!path.endsWith('.css') || styles.has(path)) reject('invalid-entry-path')
        styles.add(path)
      }
    }
  }
  if (!Object.keys(entries).length && input.web === undefined) reject('missing-entry')
  const runtime = input.runtimeRequirements === undefined ? {} : object(input.runtimeRequirements)
  keys(runtime, roles)
  for (const role of roles) {
    if ((entries[role] !== undefined) !== (runtime[role] !== undefined)) reject('missing-runtime-requirement')
    if (runtime[role] !== undefined) validateRuntime(runtime[role])
  }
  if (input.capabilityRequirements !== undefined) {
    const requirements = object(input.capabilityRequirements); keys(requirements, [...roles, 'web'])
    for (const [role, raw] of Object.entries(requirements)) {
      if (role === 'web' ? input.web === undefined : entries[role] === undefined) reject('capability-without-entry')
      const requirement = object(raw); keys(requirement, ['required', 'optional'])
      const claimed = new Set<string>()
      for (const group of Object.values(requirement)) {
        for (const [id, range] of Object.entries(object(group))) {
          if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) reject('invalid-capability')
          semverRange(range)
          if (claimed.has(id)) reject('duplicate-capability')
          claimed.add(id)
        }
      }
    }
  }
  if (input.dataCompatibility !== undefined) payloadPath(input.dataCompatibility)
  return freeze(input as unknown as ApplicationArchiveManifest)
}

export function applicationArchiveSigningMessage(manifestBytes: Uint8Array, filesBytes: Uint8Array): Uint8Array {
  return Buffer.concat([domain, createHash('sha256').update(manifestBytes).digest(), createHash('sha256').update(filesBytes).digest()])
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let value = n
  for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[n] = value >>> 0
}
export function applicationArchiveCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}
interface ZipFile { readonly bytes: Buffer; readonly mode: 420 | 493 }
function unzipContent(compressed: Buffer, method: number, size: number, crc: number): Buffer {
  let bytes: Buffer
  if (method === 0) bytes = compressed
  else {
    try {
      // Node returns { buffer, engine } for info:true; older @types/node omits that overload.
      const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (inflated.engine.bytesWritten !== compressed.length) reject('zip-compressed-trailing-data')
      bytes = inflated.buffer
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'zip-compressed-trailing-data') throw error
      return reject('invalid-compression')
    }
  }
  if (bytes.length !== size || applicationArchiveCrc32(bytes) !== crc) reject('file-crc-mismatch')
  return bytes
}
function readZip(archive: Buffer, limits: ApplicationArchiveLimits, signal?: AbortSignal): Map<string, ZipFile> {
  signal?.throwIfAborted()
  if (archive.length > limits.archiveBytes || archive.length < 22) reject('archive-size-limit')
  const end = archive.length - 22
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 20) !== 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) reject('invalid-zip')
  const count = archive.readUInt16LE(end + 10)
  const centralSize = archive.readUInt32LE(end + 12)
  const centralStart = archive.readUInt32LE(end + 16)
  if (count !== archive.readUInt16LE(end + 8) || count < 4 || count > limits.files + 3 || count === 0xffff || centralStart + centralSize !== end) reject('invalid-zip')
  let cursor = centralStart
  let localCursor = 0
  let expanded = 0
  const result = new Map<string, ZipFile>()
  const paths = new Set<string>()
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted()
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) reject('invalid-zip')
    const creator = archive.readUInt16LE(cursor + 4)
    const needed = archive.readUInt16LE(cursor + 6)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameSize = archive.readUInt16LE(cursor + 28)
    const extraSize = archive.readUInt16LE(cursor + 30)
    const commentSize = archive.readUInt16LE(cursor + 32)
    const attributes = archive.readUInt32LE(cursor + 38)
    const local = archive.readUInt32LE(cursor + 42)
    if (needed !== 20 || creator >>> 8 !== 3 || flags !== 0x800 || method !== 0 && method !== 8 || extraSize || commentSize || archive.readUInt16LE(cursor + 34) || archive.readUInt16LE(cursor + 36) || attributes & 0xffff || local !== localCursor || nameSize < 1 || cursor + 46 + nameSize > end) reject('unsupported-zip-feature')
    const unixMode = attributes >>> 16
    if (unixMode !== 0o100644 && unixMode !== 0o100755) reject('unsafe-file-kind')
    let path: string
    try { path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(archive.subarray(cursor + 46, cursor + 46 + nameSize)) } catch { return reject('unsafe-path') }
    applicationArchivePath(path); addPath(paths, path)
    if (!metadata.has(path) && !path.startsWith('payload/') && !path.startsWith('licenses/')) reject('unindexed-path')
    if (metadata.has(path) && unixMode !== 0o100644) reject('invalid-metadata-mode')
    const sizeLimit = metadata.has(path) ? limits.metadataBytes : limits.fileBytes
    if (size > sizeLimit || (expanded += size) > limits.expandedBytes || compressedSize === 0 && size > 0 || size > Math.max(compressedSize, 1) * limits.compressionRatio || method === 0 && size !== compressedSize) reject('expanded-size-limit')
    if (local + 30 + nameSize > centralStart || archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(local + 4) !== needed || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || archive.readUInt32LE(local + 10) !== archive.readUInt32LE(cursor + 12) || archive.readUInt32LE(local + 14) !== crc || archive.readUInt32LE(local + 18) !== compressedSize || archive.readUInt32LE(local + 22) !== size || archive.readUInt16LE(local + 26) !== nameSize || archive.readUInt16LE(local + 28) !== 0 || !archive.subarray(local + 30, local + 30 + nameSize).equals(archive.subarray(cursor + 46, cursor + 46 + nameSize))) reject('zip-local-mismatch')
    const contentStart = local + 30 + nameSize
    localCursor = contentStart + compressedSize
    if (localCursor > centralStart) reject('invalid-zip')
    const compressed = archive.subarray(contentStart, localCursor)
    // Only the three small metadata records are read before publisher authorization.
    // Payload inflate/CRC work starts after a valid content signature is established.
    let content: Buffer | undefined
    result.set(path, {
      get bytes(): Buffer { return content ??= unzipContent(compressed, method, size, crc) },
      mode: (unixMode & 0o777) as 420 | 493,
    })
    cursor += 46 + nameSize
  }
  if (cursor !== end || localCursor !== centralStart || ![...metadata].every(path => result.has(path))) reject('invalid-zip')
  return result
}

function compatibility(requirement: ApplicationArchiveRuntimeRequirement, runtime: ApplicationArchiveRuntimeProfile | undefined): ApplicationArchiveRoleCompatibility {
  const reasons: string[] = []
  if (!runtime) reasons.push('runtime-unavailable')
  else {
    if (requirement.profile !== runtime.profile) reasons.push('runtime-profile-incompatible')
    if (requirement.sharedRuntime !== undefined && requirement.sharedRuntime !== runtime.sharedRuntime) reasons.push('shared-runtime-incompatible')
    if (requirement.node !== undefined && (!runtime.node || !valid(runtime.node) || !satisfies(runtime.node, requirement.node))) reasons.push('node-version-incompatible')
    if (requirement.nodeApi !== undefined && (!Number.isSafeInteger(runtime.nodeApi) || runtime.nodeApi! < requirement.nodeApi)) reasons.push('node-api-incompatible')
    if (requirement.modules !== undefined && requirement.modules !== runtime.modules) reasons.push('node-abi-incompatible')
    if (requirement.sqlite && !runtime.sqlite) reasons.push('sqlite-unavailable')
    if (requirement.libc !== undefined && requirement.libc !== runtime.libc) reasons.push('libc-incompatible')
    if (requirement.platforms !== undefined && (!runtime.platform || !requirement.platforms.includes(runtime.platform))) reasons.push('runtime-platform-incompatible')
  }
  return freeze({ compatible: !reasons.length, reasons })
}

export function assertVerifiedApplicationArchive(value: unknown): asserts value is VerifiedApplicationArchive {
  if (!value || typeof value !== 'object' || !verifiedArchives.has(value)) reject('unverified-archive')
}

/** Static validation only: no archive module, native library, npm script or business factory is imported. */
export function verifyApplicationArchive(input: Uint8Array, options: VerifyApplicationArchiveOptions): VerifiedApplicationArchive {
  const limits = limitsFor(options.limits)
  options.signal?.throwIfAborted()
  if (!(input instanceof Uint8Array) || input.length > limits.archiveBytes) reject('archive-size-limit')
  const bytes = Buffer.from(input)
  const zip = readZip(bytes, limits, options.signal)
  return verifyContent(zip, bytes, options, limits, false)
}

function verifyContent(zip: Map<string, ZipFile>, bytes: Uint8Array, options: VerifyApplicationPackageOptions, limits: ApplicationArchiveLimits, allowUnsigned: boolean): VerifiedApplicationArchive {
  const manifestBytes = zip.get('manifest.json')!.bytes
  const manifest = validateApplicationArchiveManifest(parseApplicationArchiveJson(manifestBytes))
  let filesBytes = zip.get('files.json')?.bytes
  const signatureFile = zip.get('signature.json')
  const unsigned = !signatureFile
  if (unsigned && !allowUnsigned) reject('publisher-not-authorized')
  if (!filesBytes) {
    if (!unsigned) reject('invalid-file-index')
    const records = [...zip].filter(([path]) => !metadata.has(path)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    filesBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: records.map(([path, file]) => ({ path, size: file.bytes.length, sha256: hash(file.bytes), mode: file.mode })) }))
    if (filesBytes.length > limits.metadataBytes || [...zip.values()].reduce((size, file) => size + file.bytes.length, filesBytes.length) > limits.expandedBytes) reject('expanded-size-limit')
    zip.set('files.json', { bytes: filesBytes, mode: 420 })
  }
  let signature: Record<string, unknown> | null = null
  let message: Uint8Array
  if (unsigned) {
    message = Buffer.concat([Buffer.from('Anybox Local Application v1\0'), createHash('sha256').update(manifestBytes).digest(), createHash('sha256').update(filesBytes).digest()])
  } else {
    signature = object(parseApplicationArchiveJson(signatureFile.bytes))
    keys(signature, ['schemaVersion', 'keyId', 'signature'])
    if (signature.schemaVersion !== 1) reject('unsupported-schema')
    name(signature.keyId)
    if (typeof signature.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature)) reject('invalid-signature')
    if (Buffer.from(signature.signature, 'base64').toString('base64') !== signature.signature) reject('invalid-signature')
    const matches = options.trustedPublishers.filter(policy => policy.publisher === manifest.publisher && policy.keyId === signature!.keyId && policy.appIds.includes(manifest.appId))
    if (matches.length !== 1) reject('publisher-not-authorized')
    message = applicationArchiveSigningMessage(manifestBytes, filesBytes)
    try {
      const publicKey = typeof matches[0].publicKey === 'string' ? createPublicKey(matches[0].publicKey) : matches[0].publicKey
      if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, message, publicKey, Buffer.from(signature.signature, 'base64'))) reject('invalid-signature')
    } catch { return reject('invalid-signature') }
  }
  if (manifest.target.os !== options.target.os || manifest.target.arch !== options.target.arch) reject('target-incompatible')
  if (!valid(options.applicationApiVersion) || !satisfies(options.applicationApiVersion, manifest.applicationApi)) reject('application-api-incompatible')
  const index = object(parseApplicationArchiveJson(filesBytes))
  keys(index, ['schemaVersion', 'files'])
  if (index.schemaVersion !== 1 || !Array.isArray(index.files) || index.files.length < 1 || index.files.length > limits.files) reject('invalid-file-index')
  const indexed = new Set<string>()
  const files: ApplicationArchiveFile[] = []
  for (const raw of index.files) {
    options.signal?.throwIfAborted()
    const file = object(raw); keys(file, ['path', 'size', 'sha256', 'mode'])
    const path = applicationArchivePath(file.path); addPath(indexed, path)
    if (metadata.has(path) || !path.startsWith('payload/') && !path.startsWith('licenses/')) reject('invalid-file-index')
    integer(file.size, limits.fileBytes)
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || file.mode !== 420 && file.mode !== 493) reject('invalid-file-index')
    const actual = zip.get(path)
    if (!actual || actual.bytes.length !== file.size || actual.mode !== file.mode || hash(actual.bytes) !== file.sha256) reject('file-integrity-mismatch')
    files.push(freeze({ path, size: file.size, sha256: file.sha256, mode: file.mode } as ApplicationArchiveFile))
  }
  if (zip.size !== files.length + (unsigned ? 2 : 3) || !unsigned && !files.some(file => file.path.startsWith('licenses/'))) reject('unindexed-path')
  const references: string[] = Object.values(manifest.entries ?? {})
  if (manifest.web) { references.push(manifest.web.entry, ...manifest.web.styles ?? []); if (manifest.web.assets) references.push(manifest.web.assets) }
  if (manifest.dataCompatibility) references.push(manifest.dataCompatibility)
  for (const path of references) if (!zip.has(path)) reject('missing-entry-file')
  const roleCompatibility: Partial<Record<ApplicationArchiveRole | 'web', ApplicationArchiveRoleCompatibility>> = {}
  for (const role of roles) if (manifest.entries?.[role]) roleCompatibility[role] = compatibility(manifest.runtimeRequirements![role]!, options.runtimeProfiles?.[role])
  if (manifest.web) roleCompatibility.web = freeze({ compatible: true, reasons: [] })
  const result: VerifiedApplicationArchive = Object.freeze({
    manifest,
    identity: freeze({ appId: manifest.appId, version: manifest.version, digest: hash(message), target: { ...manifest.target } }),
    signature: signature ? freeze({ schemaVersion: 1 as const, keyId: signature.keyId as string, signature: signature.signature as string }) : null,
    metadataPaths: Object.freeze([...metadata].filter(path => zip.has(path))),
    files: Object.freeze(files), filePaths: Object.freeze(files.map(file => file.path)),
    roleCompatibility: freeze(roleCompatibility), archiveDigest: hash(bytes), archiveSize: bytes.length,
    readFile(path: string): Uint8Array { const file = zip.get(path); if (!file) return reject('unknown-file'); return Uint8Array.from(file.bytes) },
  })
  verifiedArchives.add(result)
  return result
}

/** A directory uses exactly the same signed metadata and payload validation as ZIP. */
export function verifyApplicationDirectory(entries: readonly ApplicationDirectoryEntry[], options: VerifyApplicationPackageOptions): VerifiedApplicationArchive {
  const limits = limitsFor(options.limits)
  const bytes = encodeApplicationDirectory(entries, options)
  return verifyDirectorySnapshot(bytes, options, limits)
}

function verifyDirectorySnapshot(bytes: Uint8Array, options: VerifyApplicationPackageOptions, limits: ApplicationArchiveLimits): VerifiedApplicationArchive {
  const content = new Map<string, ZipFile>()
  for (const entry of decodeApplicationDirectory(bytes, options)) content.set(entry.path, { bytes: Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength), mode: entry.mode ?? 420 })
  return verifyContent(content, bytes, options, limits, options.allowUnsignedLocal === true)
}

/** Input transport is detected from its fixed magic; ZIP never inherits local directory trust. */
export function verifyApplicationPackage(input: Uint8Array, options: VerifyApplicationPackageOptions): VerifiedApplicationArchive {
  if (!isApplicationDirectorySnapshot(input)) return verifyApplicationArchive(input, options)
  const limits = limitsFor(options.limits)
  options.signal?.throwIfAborted()
  if (input.length > limits.archiveBytes) reject('archive-size-limit')
  return verifyDirectorySnapshot(Buffer.from(input), options, limits)
}

/** Reproducible restricted ZIP writer, also used to create adversarial test fixtures. */
export function createApplicationArchiveZip(files: readonly { readonly path: string; readonly bytes: Uint8Array; readonly mode?: 420 | 493 }[]): Uint8Array {
  if (files.length > 65534) reject('archive-size-limit')
  const local: Buffer[] = []
  const central: Buffer[] = []
  const paths = new Set<string>()
  let offset = 0
  for (const file of files) {
    const path = applicationArchivePath(file.path); addPath(paths, path)
    const nameBytes = Buffer.from(path)
    const content = Buffer.from(file.bytes)
    const mode = file.mode ?? 420
    if (mode !== 420 && mode !== 493 || content.length > 0xffffffff) reject('invalid-file-mode')
    const crc = applicationArchiveCrc32(content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(content.length, 22); header.writeUInt16LE(nameBytes.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(content.length, 20); record.writeUInt32LE(content.length, 24); record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    local.push(header, nameBytes, content); central.push(record, nameBytes)
    offset += header.length + nameBytes.length + content.length
    if (offset > 0xffffffff) reject('archive-size-limit')
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

/** Build-time only. Installation never runs npm, signs code or accepts a key carried by an archive. */
export function createApplicationDirectory(input: CreateApplicationArchiveInput): readonly ApplicationDirectoryEntry[] {
  const manifestBytes = Buffer.from(JSON.stringify(input.manifest))
  validateApplicationArchiveManifest(parseApplicationArchiveJson(manifestBytes))
  name(input.keyId)
  const paths = new Set<string>()
  const files = [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    const path = applicationArchivePath(file.path); addPath(paths, path)
    if (!path.startsWith('payload/') && !path.startsWith('licenses/')) reject('unindexed-path')
    const bytes = Buffer.from(file.bytes)
    const mode = file.mode ?? 420
    if (mode !== 420 && mode !== 493) reject('invalid-file-mode')
    return { path, bytes, mode }
  })
  const filesBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: files.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes), mode: file.mode })) }))
  const key = typeof input.privateKey === 'string' ? createPrivateKey(input.privateKey) : input.privateKey
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') reject('invalid-signing-key')
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, keyId: input.keyId, signature: sign(null, applicationArchiveSigningMessage(manifestBytes, filesBytes), key).toString('base64') }))
  return [
    { path: 'manifest.json', bytes: manifestBytes }, { path: 'files.json', bytes: filesBytes }, { path: 'signature.json', bytes: signatureBytes }, ...files,
  ]
}

export function createApplicationArchive(input: CreateApplicationArchiveInput): Uint8Array {
  return createApplicationArchiveZip(createApplicationDirectory(input))
}


import type { ApplicationArchiveLimits, ApplicationDirectoryEntry, ApplicationDirectoryOptions } from './archive-types.js'

export type { ApplicationDirectoryEntry, ApplicationDirectoryOptions } from './archive-types.js'

const encoder = new TextEncoder()
const magic = encoder.encode('Anybox Application Directory v1\0')
const metadata = new Set(['manifest.json', 'files.json', 'signature.json'])
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object
const byteLengthFor = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const byteOffsetFor = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const bufferFor = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
export const defaultApplicationArchiveLimits: Readonly<ApplicationArchiveLimits> = Object.freeze({
  archiveBytes: 256 * 1024 * 1024, expandedBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024, metadataBytes: 4 * 1024 * 1024,
  files: 30_000, compressionRatio: 200,
})

export function applicationArchiveFailure(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`Application archive: ${code}`), { code })
}
function reject(code: string): never { throw applicationArchiveFailure(code) }
export function applicationArchiveLimits(input?: Partial<ApplicationArchiveLimits>): ApplicationArchiveLimits {
  const limits = { ...defaultApplicationArchiveLimits, ...input }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) reject('invalid-limits')
  if (limits.files > 65532) reject('invalid-limits')
  return limits
}
/** Identical names are accepted on every host, including Windows aliases. */
export function applicationArchivePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) reject('invalid-metadata')
  if (new TextDecoder().decode(encoder.encode(value)) !== value) reject('unsafe-path')
  if (value !== value.normalize('NFC') || value.startsWith('/') || /[<>:"\\|?*%\u0080-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) reject('unsafe-path')
  if (value.split('/').some(part => !part || part === '.' || part === '..' || encoder.encode(part).length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part.normalize('NFKC')))) reject('unsafe-path')
  return value
}
/** Register file names and implicit directories while rejecting case/Unicode aliases. */
export function addApplicationArchivePath(paths: Set<string>, value: string): void {
  const keyFor = (input: string): string => input.normalize('NFKC').toLowerCase()
  const key = keyFor(value)
  if (paths.has(key)) reject('duplicate-path')
  if (paths.has(`${key}/`)) reject('path-kind-conflict')
  const parts = value.split('/')
  for (let index = 1; index < parts.length; index++) {
    const spelling = parts.slice(0, index).join('/')
    const parent = keyFor(spelling)
    if (paths.has(parent)) reject('path-kind-conflict')
    if (paths.has(`${parent}/`) && !paths.has(`\0${spelling}`)) reject('duplicate-path')
    paths.add(`${parent}/`); paths.add(`\0${spelling}`)
  }
  paths.add(key)
}
function checkEntry(entry: ApplicationDirectoryEntry, paths: Set<string>, limits: ApplicationArchiveLimits): { path: Uint8Array; mode: 420 | 493 } {
  const path = applicationArchivePath(entry.path)
  addApplicationArchivePath(paths, path)
  if (!metadata.has(path) && !path.startsWith('payload/') && !path.startsWith('licenses/')) reject('unindexed-path')
  const mode = entry.mode ?? 420
  if (mode !== 420 && mode !== 493) reject('invalid-file-mode')
  if (metadata.has(path) && mode !== 420) reject('invalid-metadata-mode')
  if (!(entry.bytes instanceof Uint8Array) || entry.bytes.length > (metadata.has(path) ? limits.metadataBytes : limits.fileBytes)) reject('expanded-size-limit')
  return { path: encoder.encode(path), mode }
}
function captureEntry(input: unknown): ApplicationDirectoryEntry {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) reject('invalid-directory')
  const fields = Object.getOwnPropertyDescriptors(input)
  if (Object.keys(fields).some(key => !['path', 'bytes', 'mode'].includes(key) || !('value' in fields[key])) || !fields.path || !fields.bytes) reject('invalid-directory')
  const path = fields.path.value as unknown, raw = fields.bytes.value as unknown, mode = fields.mode?.value as unknown
  if (typeof path !== 'string' || !(raw instanceof Uint8Array) || mode !== undefined && mode !== 420 && mode !== 493) reject('invalid-directory')
  // Use intrinsic typed-array accessors so a subclass cannot hide its actual allocation.
  const bytes = new Uint8Array(bufferFor.call(raw) as ArrayBuffer, byteOffsetFor.call(raw) as number, byteLengthFor.call(raw) as number)
  return { path, bytes, mode: mode as 420 | 493 | undefined }
}

/** Deterministic, uncompressed transport snapshot; no ZIP or user packaging step is involved. */
export function encodeApplicationDirectory(entries: readonly ApplicationDirectoryEntry[], options: ApplicationDirectoryOptions = {}): Uint8Array {
  const limits = applicationArchiveLimits(options.limits)
  options.signal?.throwIfAborted()
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > limits.files + 3) reject('invalid-directory')
  const ordered: ApplicationDirectoryEntry[] = []
  for (let index = 0; index < entries.length; index++) {
    options.signal?.throwIfAborted()
    const field = Object.getOwnPropertyDescriptor(entries, String(index))
    if (!field || !('value' in field)) reject('invalid-directory')
    ordered.push(captureEntry(field.value))
  }
  ordered.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const paths = new Set<string>()
  let expanded = 0, size = magic.length + 4
  const records = ordered.map(entry => {
    options.signal?.throwIfAborted()
    const record = checkEntry(entry, paths, limits)
    expanded += entry.bytes.length; size += 12 + record.path.length + entry.bytes.length
    if (expanded > limits.expandedBytes) reject('expanded-size-limit')
    if (size > limits.archiveBytes) reject('archive-size-limit')
    return { entry, ...record }
  })
  if (!paths.has('manifest.json')) reject('invalid-directory')
  const result = new Uint8Array(size)
  result.set(magic)
  const view = new DataView(result.buffer)
  view.setUint32(magic.length, records.length, true)
  let offset = magic.length + 4
  for (const { entry, path, mode } of records) {
    options.signal?.throwIfAborted()
    view.setUint32(offset, path.length, true); view.setUint32(offset + 4, mode, true); view.setUint32(offset + 8, entry.bytes.length, true)
    offset += 12; result.set(path, offset); offset += path.length; result.set(entry.bytes, offset); offset += entry.bytes.length
  }
  return result
}

export function isApplicationDirectorySnapshot(bytes: Uint8Array): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

/** Decode bounded regular files only; order and framing must be the canonical encoding. */
export function decodeApplicationDirectory(input: Uint8Array, options: ApplicationDirectoryOptions = {}): readonly ApplicationDirectoryEntry[] {
  const limits = applicationArchiveLimits(options.limits)
  options.signal?.throwIfAborted()
  if (!(input instanceof Uint8Array) || input.length > limits.archiveBytes) reject('archive-size-limit')
  if (!isApplicationDirectorySnapshot(input) || input.length < magic.length + 4) reject('invalid-directory')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const count = view.getUint32(magic.length, true)
  if (count < 2 || count > limits.files + 3) reject('invalid-directory')
  const paths = new Set<string>(), entries: ApplicationDirectoryEntry[] = []
  let offset = magic.length + 4, expanded = 0, previous: string | undefined
  for (let index = 0; index < count; index++) {
    options.signal?.throwIfAborted()
    if (offset + 12 > input.length) reject('invalid-directory')
    const nameSize = view.getUint32(offset, true), mode = view.getUint32(offset + 4, true), size = view.getUint32(offset + 8, true)
    offset += 12
    if (!nameSize || nameSize > 4096 || offset + nameSize + size > input.length) reject('invalid-directory')
    let path: string
    try { path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.subarray(offset, offset + nameSize)) } catch { return reject('unsafe-path') }
    offset += nameSize
    if (previous !== undefined && previous >= path) reject('invalid-directory-order')
    previous = path
    const entry = { path, mode: mode as 420 | 493, bytes: input.subarray(offset, offset + size) }
    checkEntry(entry, paths, limits)
    if ((expanded += size) > limits.expandedBytes) reject('expanded-size-limit')
    entries.push({ ...entry, bytes: Uint8Array.from(entry.bytes) }); offset += size
  }
  if (offset !== input.length || !paths.has('manifest.json')) reject('invalid-directory')
  return entries
}

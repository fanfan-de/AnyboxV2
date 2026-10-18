import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { defaultApplicationArchiveLimits, verifyApplicationPackage, isApplicationDirectorySnapshot, type VerifiedApplicationArchive, type VerifyApplicationArchiveOptions } from './archive.js'
import { identityKey, identity as captureIdentity } from './domain.js'
import type { PackageIdentity } from './port.js'
import { packageSourceFilename } from './package-source.js'

export const loaderFailure = (code: string): Error & { readonly code: string } => Object.assign(new Error(`Package loader: ${code}`), { code })
function fail(code: string): never { throw loaderFailure(code) }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino

/** Safe lifecycle attribution, without application errors or private paths in the identity. */
export function installedPackageError(error: unknown, identity: PackageIdentity): Error & { readonly packageIdentity: PackageIdentity; readonly code?: string } {
  const packageIdentity = captureIdentity(identity)
  const original = error instanceof Error ? error : new Error('Installed application could not load')
  try { Object.defineProperty(original, 'packageIdentity', { value: packageIdentity, enumerable: true, configurable: true }); return original as Error & { readonly packageIdentity: PackageIdentity } }
  catch {
    const code = Object.getOwnPropertyDescriptor(original, 'code')?.value
    return Object.assign(new Error('Installed application could not load', { cause: original }), { packageIdentity, ...(typeof code === 'string' ? { code } : {}) })
  }
}
const corruptionCodes = new Set([
  'package-loader-content-changed', 'package-loader-content-missing', 'package-loader-directory-changed', 'package-loader-directory-unsafe',
  'package-loader-file-changed', 'package-loader-file-unsafe', 'package-loader-identity-mismatch', 'package-loader-path-unsafe',
  'package-loader-receipt-invalid', 'package-loader-unindexed-content', 'package-loader-module-changed',
  'file-crc-mismatch', 'file-integrity-mismatch', 'invalid-signature', 'duplicate-json-key', 'duplicate-path', 'invalid-compression',
  'invalid-entry-path', 'invalid-file-index', 'invalid-file-mode', 'invalid-json', 'invalid-metadata', 'invalid-metadata-mode',
  'invalid-target', 'invalid-version', 'invalid-zip', 'missing-entry', 'missing-entry-file', 'missing-runtime-requirement',
  'path-kind-conflict', 'unindexed-path', 'unknown-file', 'unknown-metadata-field', 'unsafe-file-kind', 'unsafe-path',
  'unsupported-schema', 'unsupported-zip-feature', 'zip-compressed-trailing-data', 'zip-local-mismatch',
  'capability-without-entry', 'duplicate-capability', 'invalid-capability', 'invalid-compatibility',
  'installation-source-format-mismatch', 'invalid-directory', 'invalid-directory-order',
])
/** Runtime/ABI, trust-policy, capability and stale-snapshot failures are not disk corruption. */
export function isInstalledPackageCorruption(error: unknown): error is Error & { readonly packageIdentity: PackageIdentity; readonly code: string } {
  if (!error || typeof error !== 'object') return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value, identity = Object.getOwnPropertyDescriptor(error, 'packageIdentity')?.value
  if (typeof code !== 'string' || !corruptionCodes.has(code)) return false
  try { captureIdentity(identity); return true } catch { return false }
}

/** Old signed worker adapters predate durable role launch and cannot be activated safely. */
export function assertInstalledApplicationLifecycle(archive: VerifiedApplicationArchive): void {
  if (archive.manifest.entries?.computerWorker && archive.manifest.lifecycleVersion !== 1) throw installedPackageError(loaderFailure('package-lifecycle-upgrade-required'), archive.identity)
}

/** Read-only verification of a committed container. Loading never repairs or creates files. */
export async function verifyInstalledApplicationContainer(directory: string, identity: PackageIdentity, options: VerifyApplicationArchiveOptions): Promise<{ readonly directory: string; readonly archive: VerifiedApplicationArchive }> {
  try { return await verifyContainer(directory, identity, options) } catch (error) {
    // Only this read-only package filesystem boundary can turn a native missing
    // path into package corruption. Application factories may use the same errno
    // for their own configuration or data and must remain ordinary failures.
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
    const normalized = code === 'ENOENT' ? loaderFailure('package-loader-content-missing') : code === 'ENOTDIR' || code === 'ELOOP' ? loaderFailure('package-loader-path-unsafe') : error
    throw installedPackageError(normalized, identity)
  }
}
async function verifyContainer(directory: string, identity: PackageIdentity, options: VerifyApplicationArchiveOptions): Promise<{ readonly directory: string; readonly archive: VerifiedApplicationArchive }> {
  const rootPath = await realpath(resolve(directory)), root = await lstat(rootPath)
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(rootPath) !== rootPath) fail('package-loader-directory-unsafe')
  const container = join(rootPath, 'packages', identity.appId, identity.version, identity.digest)
  const within = (path: string) => { const name = relative(rootPath, resolve(path)); if (name === '..' || name.startsWith('..' + sep)) fail('package-loader-path-unsafe'); return name }
  async function directoryAt(path: string): Promise<void> {
    const current = await lstat(rootPath)
    if (!current.isDirectory() || current.isSymbolicLink() || !same(root, current) || await realpath(rootPath) !== rootPath) fail('package-loader-directory-changed')
    let parent = rootPath
    for (const part of within(path).split(sep).filter(Boolean)) {
      parent = join(parent, part); const info = await lstat(parent)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('package-loader-path-unsafe')
    }
  }
  async function read(path: string, maximum: number): Promise<Buffer> {
    await directoryAt(join(path, '..'))
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > maximum) fail('package-loader-file-unsafe')
      const bytes = await file.readFile(), after = await file.stat()
      if (!same(before, after) || before.size !== bytes.length || after.size !== bytes.length || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) fail('package-loader-file-changed')
      return bytes
    } finally { await file.close() }
  }
  await directoryAt(container)
  let receipt: { schemaVersion: number; identity: PackageIdentity; archiveDigest: string; archiveSize: number; sourceFormat?: 'archive' | 'directory' }
  try { receipt = JSON.parse((await read(join(container, 'receipt.json'), 16_384)).toString('utf8')) } catch { return fail('package-loader-receipt-invalid') }
  if (receipt.sourceFormat !== undefined && receipt.sourceFormat !== 'archive' && receipt.sourceFormat !== 'directory') fail('package-loader-receipt-invalid')
  const sourceName = packageSourceFilename(receipt)
  const bytes = await read(join(container, sourceName), options.limits?.archiveBytes ?? defaultApplicationArchiveLimits.archiveBytes)
  if (isApplicationDirectorySnapshot(bytes) !== (receipt.sourceFormat === 'directory')) fail('package-loader-receipt-invalid')
  // Local unsigned content has its own identity domain. The exact trusted
  // snapshot identity below prevents removing a signed package's signature.
  const archive = verifyApplicationPackage(bytes, { ...options, allowUnsignedLocal: receipt.sourceFormat === 'directory' })
  if (identityKey(archive.identity) !== identityKey(identity)) fail('package-loader-identity-mismatch')
  if (receipt.schemaVersion !== 1 || identityKey(receipt.identity) !== identityKey(identity) || receipt.archiveDigest !== archive.archiveDigest || receipt.archiveSize !== archive.archiveSize) fail('package-loader-receipt-invalid')
  const expected = new Map(archive.files.map(file => [file.path, { size: file.size, sha256: file.sha256, mode: file.mode }]))
  for (const name of archive.metadataPaths) { const bytes = archive.readFile(name); expected.set(name, { size: bytes.length, sha256: hash(bytes), mode: 420 }) }
  const seen = new Set<string>()
  async function tree(path: string, prefix = ''): Promise<void> {
    await directoryAt(path)
    for (const name of await readdir(path)) {
      const local = prefix ? `${prefix}/${name}` : name, child = join(path, name), info = await lstat(child)
      if (info.isSymbolicLink()) fail('package-loader-file-unsafe')
      if (info.isDirectory()) { if (![...expected.keys()].some(path => path.startsWith(local + '/'))) fail('package-loader-unindexed-content'); await tree(child, local) }
      else {
        const item = expected.get(local)
        if (!item || !info.isFile() || info.nlink !== 1 || info.size !== item.size || (info.mode & 0o777) !== item.mode) fail('package-loader-content-changed')
        if (hash(await read(child, item.size)) !== item.sha256) fail('package-loader-content-changed')
        seen.add(local)
      }
    }
  }
  if (JSON.stringify((await readdir(container)).sort()) !== JSON.stringify(['application', sourceName, 'receipt.json'].sort())) fail('package-loader-unindexed-content')
  const application = join(container, 'application'); await tree(application)
  if (seen.size !== expected.size) fail('package-loader-content-missing')
  return Object.freeze({ directory: application, archive })
}

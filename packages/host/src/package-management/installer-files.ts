import { packageFileModeMatches, syncPackageDirectory } from './filesystem-platform.js'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { defaultApplicationArchiveLimits, verifyApplicationPackage, isApplicationDirectorySnapshot, type VerifiedApplicationArchive, type VerifyApplicationArchiveOptions } from './archive.js'
import { identityKey } from './domain.js'
import type { PackageFileInstall, PackageIdentity } from './port.js'
import { packageSourceFilename } from './package-source.js'

export const installerFailure = (code: string): Error & { code: string } => Object.assign(new Error(`Package installer: ${code}`), { code })
function fail(code: string): never { throw installerFailure(code) }
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino
export interface InstallationFiles {
  readonly directory: string
  stage(job: PackageFileInstall): string
  final(identity: PackageIdentity): string
  assertRoot(): Promise<void>
  exists(path: string): Promise<boolean>
  ensureDirectory(path: string): Promise<void>
  openNew(path: string, mode?: number): Promise<FileHandle>
  writeNew(path: string, bytes: Uint8Array, mode?: number): Promise<void>
  read(path: string, max: number): Promise<Buffer>
  syncDirectory(path: string): Promise<void>
  discard(job: PackageFileInstall): Promise<void>
  discardWork(job: PackageFileInstall): Promise<void>
  listOrphans(jobs: readonly PackageFileInstall[]): Promise<readonly string[]>
  candidate(job: PackageFileInstall, archive: VerifiedApplicationArchive, bytes: Uint8Array, signal: AbortSignal): Promise<string>
  verifyContainer(path: string, job: PackageFileInstall, options: VerifyApplicationArchiveOptions): Promise<VerifiedApplicationArchive>
  commit(path: string, job: PackageFileInstall, archive: VerifiedApplicationArchive, options: VerifyApplicationArchiveOptions): Promise<void>
}

/** All effects stay below one captured physical directory; aliases and non-regular files are rejected. */
export async function createInstallationFiles(input: string): Promise<InstallationFiles> {
  const directory = await realpath(resolve(input)), root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) fail('installation-directory-unsafe')
  const underRoot = (path: string) => {
    const value = relative(directory, resolve(path))
    if (value === '..' || value.startsWith('..' + sep) || resolve(path) !== directory && !value) fail('installation-path-unsafe')
    return value
  }
  async function assertRoot() {
    const current = await lstat(directory)
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, root) || await realpath(directory) !== directory) fail('installation-directory-replaced')
  }
  async function assertDirectory(path: string) {
    await assertRoot(); const parts = underRoot(path).split(sep).filter(Boolean)
    let current = directory
    for (const part of parts) {
      current = join(current, part); const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('installation-path-unsafe')
    }
  }
  async function exists(path: string) {
    try { await assertDirectory(dirname(path)); const info = await lstat(path); if (info.isSymbolicLink()) fail('installation-path-unsafe'); return true } catch (error) { if (missing(error)) return false; throw error }
  }
  async function ensureDirectory(path: string) {
    await assertRoot(); const parts = underRoot(path).split(sep).filter(Boolean)
    let current = directory
    for (const part of parts) {
      current = join(current, part)
      let created = false
      try { await mkdir(current, { mode: 0o700 }); created = true } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('installation-path-unsafe')
      if (created) {
        const parent = await open(dirname(current), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { if (!(await parent.stat()).isDirectory()) fail('installation-path-unsafe'); await syncPackageDirectory(parent) } finally { await parent.close() }
      }
    }
  }
  async function openNew(path: string, mode = 0o600) {
    await ensureDirectory(dirname(path)); await assertDirectory(dirname(path))
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1) fail('installation-file-unsafe')
      await handle.chmod(mode)
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  async function writeNew(path: string, bytes: Uint8Array, mode = 0o600) {
    const handle = await openNew(path, mode)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  }
  async function read(path: string, maximum: number) {
    await assertDirectory(dirname(path))
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > maximum) fail('installation-file-unsafe')
      const bytes = await handle.readFile(), after = await handle.stat()
      if (!sameFile(before, after) || before.size !== bytes.length || after.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('installation-file-changed')
      return bytes
    } finally { await handle.close() }
  }
  async function syncDirectory(path: string) {
    await assertDirectory(path)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if (!(await handle.stat()).isDirectory()) fail('installation-path-unsafe'); await syncPackageDirectory(handle) } finally { await handle.close() }
  }
  const stage = (job: PackageFileInstall) => join(directory, 'staging', job.id)
  const final = (identity: PackageIdentity) => join(directory, 'packages', identity.appId, identity.version, identity.digest)
  async function removeKnownTree(path: string) {
    await assertDirectory(dirname(path))
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) fail('installation-cleanup-unsafe')
    if (info.isDirectory()) {
      await assertDirectory(path)
      for (const item of await readdir(path)) await removeKnownTree(join(path, item))
      await assertDirectory(path); await rmdir(path)
    } else await unlink(path)
  }
  async function discard(job: PackageFileInstall) {
    const path = stage(job)
    if (await exists(path)) { await removeKnownTree(path); await syncDirectory(dirname(path)) }
  }
  async function discardWork(job: PackageFileInstall) {
    const path = stage(job)
    if (!await exists(path)) return
    for (const name of ['candidate', 'preparation']) { const owned = join(path, name); if (await exists(owned)) await removeKnownTree(owned) }
    await syncDirectory(path)
  }
  async function listOrphans(jobs: readonly PackageFileInstall[]) {
    await assertDirectory(join(directory, 'staging'))
    const known = new Set(jobs.map(job => job.id))
    return Object.freeze((await readdir(join(directory, 'staging'))).filter(name => !known.has(name)).sort())
  }
  async function candidate(job: PackageFileInstall, archive: VerifiedApplicationArchive, bytes: Uint8Array, signal: AbortSignal) {
    const path = join(stage(job), 'candidate')
    if (await exists(path)) fail('installation-staging-conflict')
    await ensureDirectory(path)
    signal.throwIfAborted(); await writeNew(join(path, packageSourceFilename(job)), bytes)
    const application = join(path, 'application'); await ensureDirectory(application)
    for (const file of [...archive.files, ...archive.metadataPaths.map(path => ({ path, mode: 420 as const }))]) {
      signal.throwIfAborted(); await writeNew(join(application, file.path), archive.readFile(file.path), file.mode)
    }
    signal.throwIfAborted()
    await writeNew(join(path, 'receipt.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, installId: job.id, identity: archive.identity, archiveDigest: archive.archiveDigest, archiveSize: archive.archiveSize, ...(job.sourceFormat === 'directory' ? { sourceFormat: 'directory' } : {}) })))
    // Flush every created directory, bottom-up, before the version directory can become visible.
    const directories: string[] = []
    async function collect(current: string) { directories.push(current); for (const item of await readdir(current, { withFileTypes: true })) if (item.isDirectory()) await collect(join(current, item.name)) }
    await collect(path); for (const item of directories.reverse()) await syncDirectory(item)
    return path
  }
  async function verifyContainer(path: string, job: PackageFileInstall, options: VerifyApplicationArchiveOptions) {
    if (!job.identity) fail('installation-identity-missing')
    await assertDirectory(path)
    let receipt: { schemaVersion: number; identity: PackageIdentity; archiveDigest: string; archiveSize: number; sourceFormat?: 'archive' | 'directory' }
    try { receipt = JSON.parse((await read(join(path, 'receipt.json'), 16_384)).toString('utf8')) } catch { return fail('installation-receipt-corrupt') }
    if (receipt.sourceFormat !== undefined && receipt.sourceFormat !== 'archive' && receipt.sourceFormat !== 'directory') fail('installation-receipt-corrupt')
    const sourceName = packageSourceFilename(receipt)
    const bytes = await read(join(path, sourceName), job.existingInstallation ? options.limits?.archiveBytes ?? defaultApplicationArchiveLimits.archiveBytes : job.archiveSize)
    if (isApplicationDirectorySnapshot(bytes) !== (receipt.sourceFormat === 'directory')) fail('installation-source-format-mismatch')
    if (!job.existingInstallation && ((receipt.sourceFormat ?? 'archive') !== (job.sourceFormat ?? 'archive') || bytes.length !== job.archiveSize || hash(bytes) !== job.archiveDigest)) fail('installation-archive-changed')
    // An installed local identity has a distinct content domain. Reverification
    // cannot downgrade a signed identity by deleting its signature or policy.
    const archive = verifyApplicationPackage(bytes, { ...options, allowUnsignedLocal: receipt.sourceFormat === 'directory' && (job.existingInstallation || job.localTrust === true) })
    if (identityKey(archive.identity) !== identityKey(job.identity)) fail('installation-identity-conflict')
    if (receipt.schemaVersion !== 1 || identityKey(receipt.identity) !== identityKey(archive.identity) || receipt.archiveDigest !== archive.archiveDigest || receipt.archiveSize !== archive.archiveSize) fail('installation-receipt-corrupt')
    const expected = new Map([...archive.files.map(file => [file.path, { size: file.size, hash: file.sha256, mode: file.mode }] as const), ...archive.metadataPaths.map(path => { const bytes = archive.readFile(path); return [path, { size: bytes.length, hash: hash(bytes), mode: 420 }] as const })])
    const seen = new Set<string>()
    async function checkTree(current: string, prefix: string) {
      await assertDirectory(current)
      for (const item of await readdir(current, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${item.name}` : item.name, file = join(current, item.name)
        const info = await lstat(file)
        if (info.isSymbolicLink()) fail('installation-file-unsafe')
        if (info.isDirectory()) { if (![...expected.keys()].some(path => path.startsWith(name + '/'))) fail('installation-unindexed-content'); await checkTree(file, name) }
        else {
          const entry = expected.get(name)
          if (!entry || !info.isFile() || info.nlink !== 1 || info.size !== entry.size || !packageFileModeMatches(info.mode, entry.mode)) fail('installation-content-changed')
          if (hash(await read(file, entry.size)) !== entry.hash) fail('installation-content-changed')
          seen.add(name)
        }
      }
    }
    const contents = (await readdir(path)).sort()
    if (JSON.stringify(contents) !== JSON.stringify(['application', sourceName, 'receipt.json'].sort())) fail('installation-unindexed-content')
    await checkTree(join(path, 'application'), '')
    if (seen.size !== expected.size) fail('installation-content-missing')
    return archive
  }
  async function commit(path: string, job: PackageFileInstall, archive: VerifiedApplicationArchive, options: VerifyApplicationArchiveOptions) {
    const destination = final(archive.identity), version = dirname(destination)
    await ensureDirectory(version)
    if ((await readdir(version)).some(name => name !== archive.identity.digest)) fail('installation-version-conflict')
    if (await exists(destination)) { await verifyContainer(destination, job, options); return }
    await verifyContainer(path, job, options)
    await assertDirectory(dirname(path)); await assertDirectory(version)
    await rename(path, destination); await syncDirectory(version); await syncDirectory(dirname(path))
  }
  await ensureDirectory(join(directory, 'staging')); await ensureDirectory(join(directory, 'packages'))
  return { directory, stage, final, assertRoot, exists, ensureDirectory, openNew, writeNew, read, syncDirectory, discard, discardWork, listOrphans, candidate, verifyContainer, commit }
}

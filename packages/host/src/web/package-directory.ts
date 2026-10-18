import { applicationArchivePath, defaultApplicationArchiveLimits, encodeApplicationDirectory } from '../package-management/directory-format.js'

export interface BrowserApplicationDirectory {
  readonly name: string
  readonly size: number
  readonly files: readonly { readonly path: string; readonly file: File }[]
}
const metadata = new Set(['manifest.json', 'files.json', 'signature.json'])
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) fail('installation-cancelled') }

/** Accept one browser-selected root, never a path on the server filesystem. */
export function browserApplicationDirectory(files: readonly File[]): BrowserApplicationDirectory {
  const limits = defaultApplicationArchiveLimits
  if (!files.length || files.length > limits.files + 3) fail('directory-file-limit')
  let root: string | undefined, size = 0
  const paths = new Set<string>()
  const entries = files.map(file => {
    const relative = applicationArchivePath(file.webkitRelativePath)
    const separator = relative.indexOf('/')
    if (separator < 1) fail('directory-root-required')
    const name = relative.slice(0, separator), path = applicationArchivePath(relative.slice(separator + 1))
    if (root !== undefined && root !== name) fail('directory-root-required')
    root = name
    if (!metadata.has(path) && !path.startsWith('payload/') && !path.startsWith('licenses/')) fail('directory-layout-invalid')
    const key = path.normalize('NFKC').toLowerCase()
    if (paths.has(key)) fail('duplicate-path')
    paths.add(key)
    const maximum = metadata.has(path) ? limits.metadataBytes : limits.fileBytes
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) fail('directory-file-limit')
    size += file.size
    if (size > limits.archiveBytes) fail('archive-size-limit')
    return { path, file }
  })
  if (!entries.some(entry => entry.path === 'manifest.json')) fail('directory-metadata-required')
  return { name: root!, size, files: entries }
}

/** Browser File objects omit POSIX permissions; the signed index supplies each file's declared mode. */
export async function readBrowserApplicationDirectory(directory: BrowserApplicationDirectory, signal?: AbortSignal): Promise<File> {
  aborted(signal)
  const indexFile = directory.files.find(entry => entry.path === 'files.json')?.file
  const indexBytes = indexFile ? new Uint8Array(await indexFile.arrayBuffer()) : undefined; aborted(signal)
  if (indexFile && indexBytes?.length !== indexFile.size) fail('directory-file-changed')
  const modes = new Map<string, 420 | 493>()
  if (indexBytes) {
    let index: unknown
    try { index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes)) } catch { return fail('invalid-file-index') }
    if (!index || typeof index !== 'object' || !('schemaVersion' in index) || index.schemaVersion !== 1 || !('files' in index) || !Array.isArray(index.files) || !index.files.length || index.files.length > defaultApplicationArchiveLimits.files) fail('invalid-file-index')
    for (const file of index.files) {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.mode !== 420 && file.mode !== 493 || modes.has(file.path)) fail('invalid-file-index')
      modes.set(applicationArchivePath(file.path), file.mode)
    }
  }
  const entries = []
  for (const { path, file } of directory.files) {
    aborted(signal)
    const bytes = path === 'files.json' ? indexBytes! : new Uint8Array(await file.arrayBuffer())
    aborted(signal)
    if (bytes.length !== file.size) fail('directory-file-changed')
    const mode = metadata.has(path) || !indexBytes ? 420 : modes.get(path)
    if (mode === undefined) fail('invalid-file-index')
    entries.push({ path, bytes, mode })
  }
  const bytes = encodeApplicationDirectory(entries, { signal })
  return new File([new Uint8Array(bytes).buffer], directory.name, { type: 'application/octet-stream' })
}

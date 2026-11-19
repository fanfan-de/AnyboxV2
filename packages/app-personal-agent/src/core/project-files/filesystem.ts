import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { fileError, fileLimits, excludedPath, validateFilePath, selectFileText, compareFilePaths } from './domain.js'
import type { FileRange, FilePreview, FileSearch } from './domain.js'

/** No symlink component is accepted, including when a caller bypasses search. */
async function checkedPath(root: string, path: string): Promise<string> {
  validateFilePath(path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw fileError('file-invalid')
  }
  const canonical = await realpath(current), rel = relative(root, canonical)
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw fileError('file-invalid')
  return current
}
export async function readProjectFile(root: string, path: string, range: FileRange | undefined, signal: AbortSignal): Promise<FilePreview> {
  signal.throwIfAborted()
  const target = await checkedPath(root, path)
  signal.throwIfAborted()
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw fileError('file-unsupported')
    if (before.size > BigInt(fileLimits.maxSourceBytes)) throw fileError('file-too-large')
    const chunks: Buffer[] = []; let length = 0
    while (true) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(64 * 1024, fileLimits.maxSourceBytes + 1 - length))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (!bytesRead) break
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead
      if (length > fileLimits.maxSourceBytes) throw fileError('file-too-large')
    }
    const after = await handle.stat({ bigint: true })
    await checkedPath(root, path)
    const current = await lstat(target, { bigint: true })
    if ([after, current].some(info => !info.isFile() || info.dev !== before.dev || info.ino !== before.ino ||
      info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs) || BigInt(length) !== before.size) throw fileError('file-changed')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length)) }
    catch { throw fileError('file-unsupported') }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fileError('file-unsupported')
    const selected = selectFileText(text, range), byteLength = Buffer.byteLength(selected.text)
    const canReference = byteLength <= fileLimits.maxBytes
    // Preview may be bounded, but its explicit failure state prevents submitting that prefix.
    let preview = selected.text
    if (!canReference) {
      const bytes = Buffer.from(preview)
      let end = fileLimits.maxBytes
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
      preview = bytes.subarray(0, end).toString('utf8')
    }
    return { path, text: preview, byteLength, totalLines: selected.totalLines, actualRange: selected.actualRange,
      sourceByteLength: length, canReference, ...(!canReference ? { reason: 'file-too-large' as const } : {}) }
  } finally {
    try { await handle.close() } catch { throw fileError('file-cleanup-failed') }
  }
}
export async function searchProjectFiles(root: string, query: string, signal: AbortSignal): Promise<FileSearch> {
  const pending = [''], paths: string[] = [], started = performance.now()
  let entries = 0, incomplete = false
  const normalized = query.toLowerCase()
  while (pending.length) {
    signal.throwIfAborted()
    if (entries >= fileLimits.maxSearchEntries || performance.now() - started >= fileLimits.searchTimeMs) { incomplete = true; break }
    const path = pending.shift()!
    let directory
    try {
      if (path) await checkedPath(root, path)
      directory = await opendir(join(root, path))
    } catch (error) {
      if (!path) throw error
      incomplete = true; continue
    }
    try {
      while (true) {
        signal.throwIfAborted()
        if (entries >= fileLimits.maxSearchEntries || performance.now() - started >= fileLimits.searchTimeMs) { incomplete = true; break }
        const entry = await directory.read()
        if (!entry) break
        entries++
        const candidate = path ? `${path}/${entry.name}` : entry.name
        if (entry.isSymbolicLink() || excludedPath(candidate)) continue
        try { validateFilePath(candidate) } catch { continue }
        if (entry.isDirectory()) pending.push(candidate)
        else if (entry.isFile() && candidate.toLowerCase().includes(normalized)) paths.push(candidate)
      }
    } finally {
      try { await directory.close() } catch { throw fileError('file-cleanup-failed') }
    }
  }
  paths.sort((a, b) => compareFilePaths(normalized, a, b))
  return { paths: paths.slice(0, fileLimits.maxResults), incomplete: incomplete || paths.length > fileLimits.maxResults }
}

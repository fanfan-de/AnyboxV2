import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { excludedPath, fileError, validateFilePath, validateFileTreePath } from './domain.js'
import type { FileTreeEntry } from './domain.js'

/** Private filesystem boundary. Each cursor owns one directory handle. */
export interface FileTreeAccessCursor {
  verify(signal: AbortSignal): Promise<void>
  read(signal: AbortSignal): Promise<FileTreeEntry | 'other' | null>
  close(): Promise<void>
}
export interface FileTreeAccessProvider {
  open(root: string, path: string, signal: AbortSignal): Promise<FileTreeAccessCursor>
}

async function checkedDirectory(root: string, path: string, signal: AbortSignal) {
  validateFileTreePath(path)
  signal.throwIfAborted()
  let target = root
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) throw fileError('file-invalid')
  for (const part of path ? path.split('/') : []) {
    signal.throwIfAborted()
    target = join(target, part)
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isDirectory()) throw fileError('file-invalid')
  }
  const canonical = await realpath(target), rel = relative(root, canonical)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fileError('file-invalid')
  signal.throwIfAborted()
  return { target, identity: await lstat(target) }
}

/** One bounded listing of a project directory, for units answering tree queries without holding a handle across requests. */
export async function listProjectDirectory(root: string, path: string, limit: number, signal: AbortSignal): Promise<{ readonly entries: readonly FileTreeEntry[]; readonly identity: string; readonly truncated: boolean }> {
  const { identity } = await checkedDirectory(root, path, signal)
  const cursor = await createFileTreeAccessProvider().open(root, path, signal)
  const entries: FileTreeEntry[] = []
  let truncated = false
  try {
    while (true) {
      if (entries.length >= limit) { truncated = true; break }
      const entry = await cursor.read(signal)
      if (entry === null) break
      if (entry !== 'other') entries.push(entry)
    }
  } finally { await cursor.close() }
  return { entries, identity: `${identity.dev}:${identity.ino}`, truncated }
}

export function createFileTreeAccessProvider(): FileTreeAccessProvider {
  return { async open(root, path, signal) {
    const { target, identity } = await checkedDirectory(root, path, signal)
    signal.throwIfAborted()
    const directory = await opendir(target)
    let closed = false
    const verify = async (readSignal: AbortSignal) => {
      const current = await checkedDirectory(root, path, readSignal)
      if (current.identity.dev !== identity.dev || current.identity.ino !== identity.ino) throw fileError('file-changed')
      readSignal.throwIfAborted()
    }
    const close = async () => {
      if (closed) return
      closed = true
      try { await directory.close() } catch { throw fileError('file-cleanup-failed') }
    }
    try { await verify(signal) } catch (error) { await close(); throw error }
    return {
      verify,
      async read(readSignal) {
        readSignal.throwIfAborted()
        const entry = await directory.read()
        readSignal.throwIfAborted()
        if (!entry) return null
        const candidate = path ? `${path}/${entry.name}` : entry.name
        if (entry.isSymbolicLink() || excludedPath(candidate)) return 'other'
        try { validateFilePath(candidate) } catch { return 'other' }
        if (!entry.isDirectory() && !entry.isFile()) return 'other'
        // Recheck the current entry, because the directory can change between enumeration and use.
        try {
          const current = await lstat(join(target, entry.name))
          readSignal.throwIfAborted()
          if (current.isSymbolicLink()) return 'other'
          return current.isDirectory() ? { name: entry.name, path: candidate, kind: 'directory' }
            : current.isFile() ? { name: entry.name, path: candidate, kind: 'file' } : 'other'
        } catch (error) {
          readSignal.throwIfAborted()
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'other'
          throw error
        }
      },
      close,
    }
  } }
}

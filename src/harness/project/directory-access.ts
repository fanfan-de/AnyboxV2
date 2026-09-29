import { opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { directoryBrowseFailure, isDirectoryBrowseFailure } from './directories.js'
import type { DirectoryEntry, DirectoryEntryFailure } from './directories.js'

/** Internal replaceable filesystem boundary; a cursor owns exactly one directory handle. */
export interface DirectoryAccessCursor {
  readonly path: string
  verify?(signal: AbortSignal): Promise<void>
  read(signal: AbortSignal): Promise<DirectoryEntry | 'other' | null>
  close(): Promise<void>
}

export interface DirectoryAccessProvider {
  open(path: string, signal: AbortSignal): Promise<DirectoryAccessCursor>
}

export function directoryAccessFailure(error: unknown): DirectoryEntryFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === 'EACCES' || code === 'EPERM' ? 'directory-permission-denied'
    : code === 'ENOENT' ? 'directory-missing'
    : code === 'ENOTDIR' ? 'directory-not-directory'
    : code === 'ELOOP' ? 'directory-link-loop' : 'directory-unavailable'
}

export function normalizeDirectoryFailure(error: unknown): Error {
  return isDirectoryBrowseFailure(error) ? error : directoryBrowseFailure(directoryAccessFailure(error))
}

export function createDirectoryAccessProvider(): DirectoryAccessProvider {
  return {
    async open(path, signal) {
      signal.throwIfAborted()
      const canonical = await realpath(path)
      signal.throwIfAborted()
      const identity = await stat(canonical)
      if (!identity.isDirectory()) throw directoryBrowseFailure('directory-not-directory')
      signal.throwIfAborted()
      const directory = await opendir(canonical)
      let closed = false
      return {
        path: canonical,
        async verify(readSignal) {
          readSignal.throwIfAborted()
          const current = await stat(canonical)
          readSignal.throwIfAborted()
          if (!current.isDirectory()) throw directoryBrowseFailure('directory-not-directory')
          if (current.dev !== identity.dev || current.ino !== identity.ino) throw directoryBrowseFailure('directory-unavailable')
        },
        async read(readSignal) {
          readSignal.throwIfAborted()
          const entry = await directory.read()
          if (!entry) return null
          readSignal.throwIfAborted()
          const candidate = { name: entry.name, path: join(canonical, entry.name) }
          if (entry.isDirectory()) return { ...candidate, kind: 'directory' }
          if (!entry.isSymbolicLink()) return 'other'
          try {
            const target = await stat(candidate.path)
            readSignal.throwIfAborted()
            return target.isDirectory() ? { ...candidate, kind: 'symlink' } : 'other'
          } catch (error) {
            readSignal.throwIfAborted()
            return { ...candidate, kind: 'symlink', reason: directoryAccessFailure(error) }
          }
        },
        async close() {
          if (closed) return
          closed = true
          try { await directory.close() }
          catch { throw directoryBrowseFailure('directory-browse-cleanup-failed') }
        },
      }
    },
  }
}

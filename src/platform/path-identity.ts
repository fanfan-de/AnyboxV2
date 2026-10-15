import { realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DirectoryContainsPath } from '../applications/harness/core/computer/worker-attachments-domain.js'

/** Filesystem-owned identity check; no global assumption about case sensitivity. */
export function createDirectoryIdentityCheck(): DirectoryContainsPath {
  // Each admission reads target ancestors once, and each ceiling root at most once.
  // Nothing survives this synchronous admission check or component generation.
  const targets = new Map<string, ReadonlySet<string> | undefined>()
  const roots = new Map<string, string | undefined>()
  const identity = (path: string): string | undefined => {
    try {
      const info = statSync(path, { bigint: true })
      return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined
    } catch { return undefined }
  }
  return (path, directory) => {
    if (!roots.has(directory)) roots.set(directory, identity(directory))
    const root = roots.get(directory)
    if (!root) return false
    if (!targets.has(path)) {
      try {
        let current = realpathSync.native(path)
        const ancestors = new Set<string>()
        while (true) {
          const id = identity(current)
          if (!id) throw new Error('path unavailable')
          ancestors.add(id)
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        targets.set(path, ancestors)
      } catch { targets.set(path, undefined) }
    }
    return targets.get(path)?.has(root) ?? false
  }
}

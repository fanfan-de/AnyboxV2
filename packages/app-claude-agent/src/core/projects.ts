import { basename, dirname, normalize } from 'node:path'
import type { RecentProjectView } from './view.js'

/** One recorded use of a project directory. Time is an ISO string produced by the owner of that record. */
export interface RecentProjectSource { readonly path: string; readonly lastUsedAt: string; readonly source: 'threads' | 'claude' }
/** Trailing separators are dropped so the same directory recorded two ways merges into one entry; a root path stays as it is. */
export function normalizeProjectPath(path: string): string {
  const normalized = normalize(path.trim())
  return dirname(normalized) === normalized ? normalized : normalized.replace(/[\\/]+$/, '')
}
/** Pure merge: newest use per directory, union of sources, newest first, bounded. Existence is checked by the caller on the device. */
export function mergeRecentProjects(sources: readonly RecentProjectSource[], limit: number): RecentProjectView[] {
  const merged = new Map<string, { lastUsedAt: string; sources: Set<RecentProjectSource['source']> }>()
  for (const entry of sources) {
    if (!entry.path.trim()) continue
    const path = normalizeProjectPath(entry.path), current = merged.get(path)
    if (!current) merged.set(path, { lastUsedAt: entry.lastUsedAt, sources: new Set([entry.source]) })
    else { current.sources.add(entry.source); if (entry.lastUsedAt > current.lastUsedAt) current.lastUsedAt = entry.lastUsedAt }
  }
  return [...merged].sort((a, b) => (a[1].lastUsedAt < b[1].lastUsedAt ? 1 : a[1].lastUsedAt > b[1].lastUsedAt ? -1 : a[0].localeCompare(b[0]))).slice(0, limit)
    .map(([path, value]) => Object.freeze({ path, name: basename(path) || path, lastUsedAt: value.lastUsedAt, source: value.sources.size === 2 ? 'both' as const : [...value.sources][0] }))
}

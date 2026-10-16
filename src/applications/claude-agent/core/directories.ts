import { readdir as readDirectory } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { claudeAgentError } from './domain.js'
import type { DirectoryListingView } from './view.js'

export interface DirectoryRequest { readonly path: string; readonly showHidden: boolean }
export const directoryEntryLimit = 500
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const stripTrailing = (path: string) => { const normalized = normalize(path); return dirname(normalized) === normalized ? normalized : normalized.replace(/[\\/]+$/, '') }

/** Query parameters to a request: `~` or `~/…` expands to the execution device's home, everything else must be absolute. */
export function parseDirectoryRequest(params: { readonly path: string | null; readonly showHidden: string | null }, home: string): DirectoryRequest {
  const raw = params.path
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || raw.length > 4096) throw claudeAgentError('project-path-invalid', 400, 'A directory path on the execution device is required.')
  const trimmed = raw.trim()
  const expanded = trimmed === '~' ? home : /^~[\\/]/.test(trimmed) ? join(home, trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) throw claudeAgentError('project-path-invalid', 400, 'Directory paths must be absolute paths on the execution device.')
  const showHidden = params.showHidden === null || params.showHidden === '0' ? false : params.showHidden === '1' ? true : undefined
  if (showHidden === undefined) throw claudeAgentError('invalid-input', 400)
  return Object.freeze({ path: stripTrailing(expanded), showHidden })
}
export interface ListDirectoryOptions {
  readonly signal?: AbortSignal
  readonly limit?: number
  /** Replaceable for tests; production reads the execution device's file system. */
  readonly readdir?: (path: string) => Promise<readonly Dirent[]>
}
const failure = (error: unknown, path: string) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') return claudeAgentError('project-path-missing', 404, `目录不存在或不是文件夹：${path}`)
  if (code === 'EACCES' || code === 'EPERM') return claudeAgentError('directory-unreadable', 403, `没有权限读取目录：${path}`)
  return claudeAgentError('directory-unreadable', 503, `无法读取目录：${path}`)
}
/** Subdirectories only, symbolic links not followed, dot directories hidden unless asked, sorted by name, bounded. */
export async function listDirectory(request: DirectoryRequest, options: ListDirectoryOptions = {}): Promise<DirectoryListingView> {
  const limit = options.limit ?? directoryEntryLimit, read = options.readdir ?? (path => readDirectory(path, { withFileTypes: true }))
  if (options.signal?.aborted) throw claudeAgentError('cancelled', 499)
  let entries: readonly Dirent[]
  try { entries = await read(request.path) } catch (error) { throw failure(error, request.path) }
  if (options.signal?.aborted) throw claudeAgentError('cancelled', 499)
  const names = entries.filter(entry => entry.isDirectory() && (request.showHidden || !entry.name.startsWith('.'))).map(entry => entry.name).sort(collator.compare)
  const parent = dirname(request.path)
  return Object.freeze({ schemaVersion: 1, path: request.path, parent: parent === request.path ? null : parent, truncated: names.length > limit,
    entries: names.slice(0, limit).map(name => Object.freeze({ name, path: request.path.endsWith(sep) ? request.path + name : request.path + sep + name })) })
}

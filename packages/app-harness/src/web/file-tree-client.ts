import type { Api } from './client-types.js'
import type { SessionRef } from './workspace-layout.js'
import { validateFilePath } from '../core/project-files/domain.js'
import type { FileTreeEntry, FileTreePage } from '../core/project-files/domain.js'
export type { FileTreeEntry, FileTreePage } from '../core/project-files/domain.js'
export interface FileTreeDirectory {
  readonly path: string; readonly entries: readonly FileTreeEntry[]; readonly loading: boolean
  readonly nextPage: number | null; readonly error?: unknown
}
export interface FileTreeClient {
  snapshot(): ReadonlyMap<string, FileTreeDirectory>
  open(path: string): Promise<void>
  more(path: string): Promise<void>
  close(path: string): Promise<void>
  dispose(): Promise<void>
}

const validCursor = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')
function decodePage(value: unknown, path: string, page: number): FileTreePage {
  if (!value || typeof value !== 'object') throw new Error('文件目录响应无效。')
  const record = value as FileTreePage
  if (!validCursor(record.cursorId) || record.path !== path || record.page !== page || !Array.isArray(record.entries) ||
      (record.nextPage !== null && (!Number.isSafeInteger(record.nextPage) || record.nextPage !== page + 1))) throw new Error('文件目录响应无效。')
  const names = new Set<string>()
  for (const item of record.entries) {
    if (!item || typeof item.name !== 'string' || !item.name || item.name.includes('/') || names.has(item.name) ||
        item.path !== (path ? `${path}/${item.name}` : item.name) || !['directory', 'file'].includes(item.kind)) throw new Error('文件目录响应无效。')
    validateFilePath(item.path); names.add(item.name)
  }
  return record
}

/** Each expanded directory owns its opaque server cursor until collapse, hide or actual exit. */
export function createFileTreeClient(api: Api, ref: SessionRef, changed: () => void): FileTreeClient {
  const base = `/sessions/${encodeURIComponent(ref.sessionId)}/project-files/tree`
  const entries = new Map<string, FileTreeDirectory>(), versions = new Map<string, number>()
  const cursors = new Map<string, string>()
  const reads = new Map<string, { abort: AbortController; job: Promise<void> }>()
  const jobs = new Set<Promise<unknown>>(), closeFailures: unknown[] = []
  let disposed = false, exit: Promise<void> | undefined
  const publish = () => { if (!disposed) changed() }
  const track = <T>(job: Promise<T>): Promise<T> => {
    jobs.add(job)
    void job.finally(() => jobs.delete(job)).catch(() => {})
    return job
  }
  const closeCursor = (cursorId: string): Promise<void> => track(api(`${base}/close`, { cursorId }).then(() => {}, error => { closeFailures.push(error) }))
  const release = (path: string): Promise<void> => {
    const id = cursors.get(path)
    cursors.delete(path)
    return id ? closeCursor(id) : Promise.resolve()
  }
  const current = (path: string, version: number, abort: AbortController) => !disposed && !abort.signal.aborted && versions.get(path) === version
  const load = (path: string, continuation: boolean): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (path) validateFilePath(path)
    const previous = entries.get(path)
    if (reads.has(path)) return reads.get(path)!.job
    if (continuation && (!previous || previous.nextPage === null || !cursors.has(path))) return Promise.resolve()
    const version = (versions.get(path) ?? 0) + 1, abort = new AbortController()
    versions.set(path, version)
    const cursorId = continuation ? cursors.get(path) : undefined, page = continuation ? previous!.nextPage! : 0
    entries.set(path, { path, entries: previous?.entries ?? [], nextPage: previous?.nextPage ?? null, loading: true })
    const job = track((async () => {
      if (!continuation) await release(path)
      if (!current(path, version, abort)) return
      let raw: unknown, discardedCursor: string | undefined
      try {
        raw = await api(continuation ? `${base}/page` : `${base}/open`, continuation ? { cursorId, page } : { path }, abort.signal)
        const received = raw && typeof raw === 'object' && 'cursorId' in raw && validCursor(raw.cursorId) ? raw.cursorId : undefined
        if (!current(path, version, abort)) { if (received && (!cursorId || received !== cursorId)) await closeCursor(received); return }
        const value = decodePage(raw, path, page)
        if (continuation && value.cursorId !== cursorId) { discardedCursor = value.cursorId; await closeCursor(value.cursorId); throw new Error('文件目录分页已改变，请刷新。') }
        cursors.set(path, value.cursorId)
        const combined = continuation ? [...previous!.entries, ...value.entries] : [...value.entries]
        if (new Set(combined.map(item => item.path)).size !== combined.length) throw new Error('文件目录分页响应重复，请刷新。')
        combined.sort((a, b) => a.kind !== b.kind ? a.kind === 'directory' ? -1 : 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        entries.set(path, { path, entries: combined, nextPage: value.nextPage, loading: false })
        if (value.nextPage === null) await release(path)
      } catch (error) {
        if (raw && typeof raw === 'object' && 'cursorId' in raw && validCursor(raw.cursorId) && raw.cursorId !== cursors.get(path) && raw.cursorId !== cursorId && raw.cursorId !== discardedCursor) await closeCursor(raw.cursorId)
        if (current(path, version, abort)) {
          entries.set(path, { path, entries: previous?.entries ?? [], nextPage: previous?.nextPage ?? null, loading: false, error })
          await release(path)
        }
      } finally {
        if (reads.get(path)?.abort === abort) reads.delete(path)
        if (current(path, version, abort)) publish()
      }
    })())
    reads.set(path, { abort, job }); publish()
    return job
  }
  const client: FileTreeClient = {
    snapshot: () => entries,
    open: path => load(path, false),
    more: path => load(path, true),
    async close(path) {
      const owns = (value: string) => value === path || !path || value.startsWith(`${path}/`)
      const pending: Promise<unknown>[] = []
      for (const key of new Set([...entries.keys(), ...reads.keys(), ...cursors.keys()])) if (owns(key)) {
        versions.set(key, (versions.get(key) ?? 0) + 1)
        const read = reads.get(key); read?.abort.abort(); if (read) pending.push(read.job)
        reads.delete(key)
        pending.push(release(key)); entries.delete(key)
      }
      publish()
      await Promise.all(pending)
    },
    dispose() {
      if (exit) return exit
      disposed = true
      exit = (async () => {
        await client.close('')
        while (jobs.size) await Promise.all([...jobs])
        if (closeFailures.length) throw new AggregateError(closeFailures, '文件目录清理失败。')
      })()
      return exit
    },
  }
  return client
}

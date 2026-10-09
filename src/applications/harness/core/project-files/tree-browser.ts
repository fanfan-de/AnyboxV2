import { randomUUID } from 'node:crypto'
import type { OwnedCall } from '../contracts.js'
import { fileError, fileTreeLimits, validId, validateFileTreePath } from './domain.js'
import type { FileTreeEntry, FileTreePage } from './domain.js'
import { createFileTreeAccessProvider } from './tree-access.js'
import type { FileTreeAccessCursor, FileTreeAccessProvider } from './tree-access.js'

export interface FileTreeBrowserOptions {
  readonly access?: FileTreeAccessProvider
  readonly now?: () => number
  readonly scanTime?: () => number
  readonly newId?: () => string
  readonly idleMs?: number
}
interface TreeCursor {
  readonly id: string; readonly scope: string; readonly project: string; readonly owner: string; readonly path: string
  expiresAt: number; closed: boolean; busy: boolean
  cursor?: FileTreeAccessCursor; cached?: FileTreePage; active?: OwnedCall<FileTreePage>; retirement?: Promise<void>
}
export interface FileTreeBrowser {
  open(scope: string, project: string, path: string, owner: string, signal?: AbortSignal): OwnedCall<FileTreePage>
  page(scope: string, owner: string, cursorId: string, page: number, signal?: AbortSignal): OwnedCall<FileTreePage>
  release(scope: string, owner: string, cursorId: string): Promise<void>
  onRetired(listener: (cursorId: string) => void): () => void
  close(): Promise<void>
}

/** Project Files owns cursors; scans use the same slot as preview/search/prepare. */
export function createFileTreeBrowser(rootFor: (project: string) => Promise<string>,
  slot: <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T>, options: FileTreeBrowserOptions = {}): FileTreeBrowser {
  const access = options.access ?? createFileTreeAccessProvider(), now = options.now ?? Date.now
  const scanTime = options.scanTime ?? (() => performance.now()), newId = options.newId ?? randomUUID
  const idleMs = options.idleMs ?? fileTreeLimits.idleMs
  const cursors = new Map<string, TreeCursor>(), resources = new Set<TreeCursor>(), calls = new Set<OwnedCall<unknown>>()
  const retirements = new Set<Promise<void>>(), cleanupFailures = new Set<unknown>(), listeners = new Set<(id: string) => void>()
  let accepting = true, shutdown: Promise<void> | undefined
  const normalized = (error: unknown): Error => {
    if (error instanceof Error && (error.name === 'ProjectFileError' || 'code' in error && error.code === 'project-unavailable')) return error
    return fileError(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'file-missing' : 'file-unavailable')
  }
  const cleanupFailed = (error: unknown) => {
    cleanupFailures.add(error); accepting = false
    for (const call of calls) call.cancel('tree cleanup failed')
  }
  const closeCursor = async (cursor: TreeCursor) => {
    const handle = cursor.cursor; cursor.cursor = undefined
    if (!handle) return
    try { await handle.close() } catch {
      const error = fileError('file-cleanup-failed'); cleanupFailed(error)
      throw error
    }
  }
  const detach = (cursor: TreeCursor) => { cursor.closed = true; if (cursors.get(cursor.id) === cursor) cursors.delete(cursor.id) }
  const retired = (cursor: TreeCursor) => {
    if (!resources.delete(cursor)) return
    for (const listener of listeners) { try { listener(cursor.id) } catch { /* Consumers cannot interrupt cleanup. */ } }
  }
  const retire = (cursor: TreeCursor): Promise<void> => {
    if (cursor.retirement) return cursor.retirement
    detach(cursor); cursor.active?.cancel('tree retired')
    const task = Promise.resolve().then(async () => {
      try { await cursor.active?.done } finally { await closeCursor(cursor) }
    }).finally(() => { retired(cursor); retirements.delete(task) })
    cursor.retirement = task; retirements.add(task); void task.catch(() => {})
    return task
  }
  const expire = () => { for (const cursor of cursors.values()) if (!cursor.busy && cursor.expiresAt <= now()) void retire(cursor) }
  const timer = setInterval(expire, Math.min(idleMs, 1_000)); timer.unref()
  const owned = <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T> | T): OwnedCall<T> => {
    if (!accepting) throw fileError('file-unavailable')
    const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const result = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined) }).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'file-cleanup-failed') { cleanupFailed(error); throw error }
      if (combined.aborted) throw fileError('file-cancelled')
      throw normalized(error)
    })
    const done = result.then(() => {}, error => { if (error instanceof Error && 'code' in error && error.code === 'file-cleanup-failed') throw error })
      .finally(() => calls.delete(call))
    const call: OwnedCall<T> = { result, done, cancel: reason => abort.abort(reason) }
    calls.add(call); void result.catch(() => {}); void done.catch(() => {})
    return call
  }
  const scan = (cursor: TreeCursor, page: number, signal?: AbortSignal): OwnedCall<FileTreePage> => {
    cursor.busy = true
    const call = owned(signal, async readSignal => {
      try {
        if (cursor.closed) throw fileError('file-tree-expired')
        if (cursor.cached?.page === page) { cursor.expiresAt = now() + idleMs; return cursor.cached }
        return await slot(readSignal, async () => {
          if (cursor.closed) throw fileError('file-tree-expired')
          if (!cursor.cursor) cursor.cursor = await access.open(await rootFor(cursor.project), cursor.path, readSignal)
          readSignal.throwIfAborted()
          await cursor.cursor.verify(readSignal)
          const entries: FileTreeEntry[] = [], started = scanTime()
          let scanned = 0, ended = false
          while (entries.length < fileTreeLimits.pageEntries && scanned < fileTreeLimits.scanEntries &&
            (scanned === 0 || scanTime() - started < fileTreeLimits.scanTimeMs)) {
            readSignal.throwIfAborted()
            const entry = await cursor.cursor.read(readSignal)
            readSignal.throwIfAborted()
            if (entry === null) { ended = true; break }
            scanned++
            if (entry !== 'other') entries.push(Object.freeze({ ...entry }))
          }
          await cursor.cursor.verify(readSignal)
          if (ended) { detach(cursor); await closeCursor(cursor); retired(cursor) }
          readSignal.throwIfAborted()
          const result: FileTreePage = Object.freeze({ cursorId: cursor.id, page, path: cursor.path,
            entries: Object.freeze(entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
              (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))), nextPage: ended ? null : page + 1 })
          cursor.cached = result; cursor.expiresAt = now() + idleMs
          return result
        })
      } catch (error) {
        detach(cursor)
        try { await closeCursor(cursor) } finally { if (!cursor.retirement) retired(cursor) }
        throw error
      }
    })
    cursor.active = call
    // Cancellation while queued or before work starts must also release the reservation.
    const result = call.result.catch(async error => {
      if (!cursor.closed) {
        detach(cursor)
        try { await closeCursor(cursor) } finally { if (!cursor.retirement) retired(cursor) }
      }
      throw error
    })
    const baseDone = Promise.allSettled([call.done, result]).then(outcomes => {
      for (const outcome of outcomes) if (outcome.status === 'rejected' && outcome.reason instanceof Error &&
        'code' in outcome.reason && outcome.reason.code === 'file-cleanup-failed') throw outcome.reason
    }).finally(() => { if (cursor.active === active) cursor.busy = false })
    // Active cancellation itself only aborts. The public cancel additionally retires even after result settled.
    const active: OwnedCall<FileTreePage> = { result, done: baseDone, cancel: reason => call.cancel(reason) }
    cursor.active = active
    // Retirement joins baseDone, never this public promise: cancelled callers still wait for the handle close.
    const done = baseDone.then(async () => { await cursor.retirement }, async error => { await cursor.retirement; throw error })
    const joined = { result, done, cancel: (reason: string) => { call.cancel(reason); void retire(cursor) } }
    void result.catch(() => {}); void done.catch(() => {})
    return joined
  }
  return {
    open(scope, project, path, owner, signal) {
      if (!accepting) throw fileError('file-unavailable')
      try {
        if (!validId(scope) || !validId(project) || !validId(owner)) throw fileError('file-invalid')
        validateFileTreePath(path); expire()
        if (resources.size >= fileTreeLimits.maxCursors) throw fileError('file-tree-busy')
        const id = newId()
        if (!validId(id) || [...resources].some(cursor => cursor.id === id)) throw fileError('file-tree-busy')
        const cursor: TreeCursor = { id, scope, project, path, owner, expiresAt: now() + idleMs, closed: false, busy: false }
        cursors.set(id, cursor); resources.add(cursor)
        return scan(cursor, 0, signal)
      } catch (error) { return owned(signal, () => { throw error }) }
    },
    page(scope, owner, id, page, signal) {
      expire()
      const cursor = cursors.get(id)
      const reject = (code: Parameters<typeof fileError>[0]) => owned(signal, () => { throw fileError(code) })
      if (!cursor || cursor.scope !== scope || cursor.owner !== owner) return reject('file-tree-expired')
      if (!Number.isSafeInteger(page) || page < 0) return reject('file-invalid')
      if (cursor.busy) return reject('file-tree-busy')
      if (page !== cursor.cached?.page && page !== cursor.cached?.nextPage) return reject('file-tree-conflict')
      return scan(cursor, page, signal)
    },
    release(scope, owner, id) {
      const cursor = [...resources].find(cursor => cursor.id === id && cursor.scope === scope && cursor.owner === owner)
      return cursor ? retire(cursor) : Promise.resolve()
    },
    onRetired(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close() {
      if (shutdown) return shutdown
      accepting = false; clearInterval(timer)
      for (const call of calls) call.cancel('project files closed')
      for (const cursor of resources) void retire(cursor)
      shutdown = Promise.allSettled([...calls].map(call => call.done).concat([...retirements])).then(() => {
        listeners.clear()
        if (cleanupFailures.size) throw new AggregateError([...cleanupFailures], 'project file tree cleanup failed')
      })
      return shutdown
    },
  }
}

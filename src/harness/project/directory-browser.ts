import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { OwnedCall } from '../contracts.js'
import { createDirectoryAccessProvider, normalizeDirectoryFailure } from './directory-access.js'
import type { DirectoryAccessCursor, DirectoryAccessProvider } from './directory-access.js'
import { directoryBrowseFailure, isDirectoryBrowseFailure } from './directories.js'
import type { DirectoryBrowseOpened, DirectoryBrowseOptions, DirectoryEntry, DirectoryPage } from './directories.js'

export interface DirectoryBrowserOptions {
  readonly homePath?: string
  readonly access?: DirectoryAccessProvider
  readonly now?: () => number
  readonly scanTime?: () => number
  readonly newId?: () => string
  /** Test seam; production cursors expire after sixty idle seconds. */
  readonly idleMs?: number
}

export interface DirectoryBrowser {
  readonly supported: boolean
  open(owner: string, input: DirectoryBrowseOptions, signal?: AbortSignal): OwnedCall<DirectoryBrowseOpened>
  page(owner: string, browseId: string, page: number, signal?: AbortSignal): OwnedCall<DirectoryPage>
  release(owner: string, browseId: string): Promise<void>
  onRetired(listener: (browseId: string) => void): () => void
  close(): Promise<void>
}

interface BrowseSession {
  readonly id: string
  readonly owner: string
  readonly path: string
  readonly query: string
  readonly showHidden: boolean
  expiresAt: number
  closed: boolean
  busy: boolean
  cursor?: DirectoryAccessCursor
  cached?: DirectoryPage
  active?: OwnedCall<DirectoryPage>
  retirement?: Promise<void>
}

function breadcrumbs(path: string): readonly Readonly<{ name: string; path: string }>[] {
  const root = parse(path).root
  const result = [{ name: root, path: root }]
  let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    result.push({ name: part, path: current })
  }
  return Object.freeze(result.map(item => Object.freeze(item)))
}

/** Projects owns reservations, live cursors, in-flight calls and their actual cleanup. */
export function createDirectoryBrowser(options: DirectoryBrowserOptions = {}): DirectoryBrowser {
  // A bad host default must not block unrelated Harness services or explicit path recovery.
  const homePath = options.homePath === undefined ? undefined
    : isAbsolute(options.homePath) && !options.homePath.includes('\0') ? resolve(options.homePath) : options.homePath
  const access = options.access ?? createDirectoryAccessProvider()
  const now = options.now ?? Date.now, scanTime = options.scanTime ?? (() => performance.now())
  const newId = options.newId ?? randomUUID, idleMs = options.idleMs ?? 60_000
  const sessions = new Map<string, BrowseSession>(), resources = new Set<BrowseSession>()
  const calls = new Set<OwnedCall<unknown>>(), retirements = new Set<Promise<void>>()
  const cleanupFailures = new Set<unknown>(), wake = new Set<() => void>()
  const retiredListeners = new Set<(browseId: string) => void>()
  let accepting = true, activeScans = 0, shutdown: Promise<void> | undefined

  const closeCursor = async (session: BrowseSession): Promise<void> => {
    const cursor = session.cursor
    session.cursor = undefined
    if (!cursor) return
    try { await cursor.close() }
    catch (error) {
      const failure = isDirectoryBrowseFailure(error) && error.code === 'directory-browse-cleanup-failed'
        ? error : directoryBrowseFailure('directory-browse-cleanup-failed')
      cleanupFailures.add(failure)
      // A failed close leaves ownership uncertain. Do not replace that handle with new work.
      accepting = false
      for (const call of calls) call.cancel('directory cleanup failed')
      throw failure
    }
  }
  const detach = (session: BrowseSession): void => {
    session.closed = true
    if (sessions.get(session.id) === session) sessions.delete(session.id)
  }
  const retired = (session: BrowseSession): void => {
    if (!resources.delete(session)) return
    for (const listener of retiredListeners) {
      try { listener(session.id) } catch { /* A consumer cannot interrupt filesystem cleanup. */ }
    }
  }
  const retire = (session: BrowseSession): Promise<void> => {
    if (session.retirement) return session.retirement
    detach(session)
    session.active?.cancel('directory browser closed')
    const task = Promise.resolve().then(async () => {
      try { await session.active?.done } finally { await closeCursor(session) }
    }).finally(() => { retired(session); retirements.delete(task) })
    session.retirement = task
    retirements.add(task)
    void task.catch(() => {})
    return task
  }
  const expire = (): void => {
    const time = now()
    for (const session of sessions.values()) {
      if (!session.busy && session.expiresAt <= time) void retire(session)
    }
  }
  const timer = setInterval(expire, Math.min(idleMs, 1_000))
  timer.unref()

  const owned = <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T> | T): OwnedCall<T> => {
    if (!accepting) throw directoryBrowseFailure('directory-unavailable')
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const result = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return work(combined)
    }).catch(error => {
      if (isDirectoryBrowseFailure(error) && error.code === 'directory-browse-cleanup-failed') throw error
      if (combined.aborted) throw directoryBrowseFailure('directory-browse-cancelled')
      throw normalizeDirectoryFailure(error)
    })
    const done = result.then(() => {}, error => {
      if (isDirectoryBrowseFailure(error) && error.code === 'directory-browse-cleanup-failed') throw error
    }).finally(() => calls.delete(call))
    const call: OwnedCall<T> = { result, done, cancel: reason => abort.abort(reason) }
    calls.add(call)
    void result.catch(() => {}); void done.catch(() => {})
    return call
  }
  const slot = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    while (activeScans >= 2) {
      signal.throwIfAborted()
      await new Promise<void>(resolveWait => {
        const ready = () => { wake.delete(ready); signal.removeEventListener('abort', ready); resolveWait() }
        wake.add(ready); signal.addEventListener('abort', ready, { once: true })
        if (signal.aborted) ready()
      })
    }
    signal.throwIfAborted()
    activeScans++
    try { return await work() }
    finally { activeScans--; for (const ready of [...wake]) ready() }
  }

  return {
    supported: homePath !== undefined,
    open(owner, input, signal) {
      return owned(signal, () => {
        if (homePath === undefined) throw directoryBrowseFailure('directory-browse-unsupported')
        if (typeof owner !== 'string' || !owner || !input || typeof input !== 'object' ||
          input.path !== undefined && (typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0')) ||
          input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256 || input.query.includes('\0')) ||
          input.showHidden !== undefined && typeof input.showHidden !== 'boolean') {
          throw directoryBrowseFailure('directory-browse-invalid')
        }
        if (input.path === undefined && (!isAbsolute(homePath) || homePath.includes('\0'))) {
          throw directoryBrowseFailure('directory-browse-invalid')
        }
        expire()
        // Includes closing cursors: a new reservation cannot outrun slow handle cleanup.
        if (resources.size >= 16) throw directoryBrowseFailure('directory-browse-busy')
        const id = newId()
        if (!id || resourcesHasId(id)) throw directoryBrowseFailure('directory-browse-busy')
        const session: BrowseSession = { id, owner, path: input.path ?? homePath, query: (input.query ?? '').toLowerCase(),
          showHidden: input.showHidden ?? false, expiresAt: now() + idleMs, closed: false, busy: false }
        sessions.set(id, session); resources.add(session)
        return Object.freeze({ browseId: id, homePath })
      })
    },
    page(owner, browseId, page, signal) {
      expire()
      const session = sessions.get(browseId)
      if (!session || session.owner !== owner) return owned(signal, () => { throw directoryBrowseFailure('directory-browse-expired') })
      if (!Number.isSafeInteger(page) || page < 0) return owned(signal, () => { throw directoryBrowseFailure('directory-browse-invalid') })
      if (session.busy) return owned(signal, () => { throw directoryBrowseFailure('directory-browse-busy') })
      const replay = session.cached?.page === page
      if (!replay && page !== (session.cached ? session.cached.nextPage : 0)) {
        return owned(signal, () => { throw directoryBrowseFailure('directory-browse-conflict') })
      }
      session.busy = true
      const call = owned(signal, async pageSignal => {
        try {
          if (session.closed) throw directoryBrowseFailure('directory-browse-expired')
          if (replay) {
            session.expiresAt = now() + idleMs
            return session.cached!
          }
          return await slot(pageSignal, async () => {
            if (session.closed) throw directoryBrowseFailure('directory-browse-expired')
            session.cursor ??= await access.open(session.path, pageSignal)
            pageSignal.throwIfAborted()
            const cursor = session.cursor, start = scanTime(), entries: DirectoryEntry[] = []
            await cursor.verify?.(pageSignal)
            let count = 0, ended = false
            while (entries.length < 100 && count < 1_000 && (count === 0 || scanTime() - start < 200)) {
              pageSignal.throwIfAborted()
              const entry = await cursor.read(pageSignal)
              pageSignal.throwIfAborted()
              if (entry === null) { ended = true; break }
              count++
              if (entry === 'other' || !session.showHidden && entry.name.startsWith('.') ||
                !entry.name.toLowerCase().includes(session.query)) continue
              entries.push(Object.freeze({ ...entry }))
            }
            if (ended) await closeCursor(session)
            pageSignal.throwIfAborted()
            const parent = dirname(cursor.path)
            const result: DirectoryPage = Object.freeze({ browseId, page, path: cursor.path, homePath: homePath!,
              parentPath: parent === cursor.path ? null : parent, breadcrumbs: breadcrumbs(cursor.path),
              entries: Object.freeze(entries.sort((a, b) => a.name.localeCompare(b.name))), nextPage: ended ? null : page + 1 })
            session.cached = result
            session.expiresAt = now() + idleMs
            return result
          })
        } catch (error) {
          detach(session)
          try { await closeCursor(session) } finally { if (!session.retirement) retired(session) }
          throw error
        } finally { session.busy = false }
      })
      session.active = call
      // Pre-start cancellation also retires the session, before the caller's done settles.
      const result = call.result.catch(async error => {
        if (!session.closed) {
          detach(session)
          try { await closeCursor(session) } finally { if (!session.retirement) retired(session) }
        }
        throw error
      })
      const done = Promise.allSettled([call.done, result]).then(outcomes => {
        for (const outcome of outcomes) if (outcome.status === 'rejected' && isDirectoryBrowseFailure(outcome.reason) &&
          outcome.reason.code === 'directory-browse-cleanup-failed') throw outcome.reason
      }).finally(() => { session.busy = false })
      const joined: OwnedCall<DirectoryPage> = { result, done, cancel: reason => call.cancel(reason) }
      session.active = joined
      void result.catch(() => {}); void done.catch(() => {})
      return joined
    },
    release(owner, browseId) {
      const session = [...resources].find(item => item.id === browseId && item.owner === owner)
      return session ? retire(session) : Promise.resolve()
    },
    onRetired(listener) { retiredListeners.add(listener); return () => { retiredListeners.delete(listener) } },
    close() {
      if (shutdown) return shutdown
      accepting = false; clearInterval(timer)
      for (const call of calls) call.cancel('project service closed')
      for (const session of resources) void retire(session)
      shutdown = Promise.allSettled([...calls].map(call => call.done).concat([...retirements])).then(() => {
        retiredListeners.clear()
        if (cleanupFailures.size) throw new AggregateError([...cleanupFailures], 'directory browser cleanup failed')
      })
      return shutdown
    },
  }

  function resourcesHasId(id: string): boolean { return [...resources].some(session => session.id === id) }
}

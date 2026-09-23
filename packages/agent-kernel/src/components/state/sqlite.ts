import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Owned, StateData, StateService } from '@anybox/agent-contracts/spi'
import { fault, KernelFault, wrap } from '../../shared/errors.js'
import { decodeState, emptyState, encodeState } from './codec.js'

export interface SQLiteStateOptions {
  readonly path: string
  /** Whole-snapshot backend for bounded local applications; default 64 MiB. */
  readonly maxSnapshotBytes?: number
}

/** SQLite is confined to this effect boundary; callers use project-owned snapshots and transactions. */
export async function createSQLiteState(options: SQLiteStateOptions): Promise<Owned<StateService>> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:') {
    throw fault('INVALID_ARGUMENT', 'a persistent database path is required')
  }
  const maxBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fault('INVALID_ARGUMENT', 'maxSnapshotBytes must be positive')
  // Lazy import keeps the original memory-only entry usable on older supported Node versions.
  const { DatabaseSync } = await import('node:sqlite')
  const path = resolve(options.path)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'a', 0o600)
  await file.close()
  const database = new DatabaseSync(path)
  const checkSize = (payload: string) => {
    if (Buffer.byteLength(payload) > maxBytes) throw fault('LIMIT_EXCEEDED', 'persistent snapshot exceeds size limit')
    return payload
  }
  const storageError = (cause: unknown) => {
    if (cause instanceof KernelFault) return cause
    const code = (cause as { errcode?: number })?.errcode
    return wrap(code === 5 || code === 6 ? 'CONFLICT' : 'STATE_FAILED',
      code === 5 || code === 6 ? 'agent database is already owned' : 'agent database operation failed', cause)
  }
  try {
    database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE')
    const version = database.prepare('PRAGMA user_version').get()?.user_version
    if (version === 0) {
      const existing = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (existing.length) throw fault('STATE_FAILED', 'database is not an empty Agent state database')
      database.exec('CREATE TABLE agent_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL) STRICT; PRAGMA user_version=1')
      database.prepare('INSERT INTO agent_state(id, payload) VALUES (1, ?)').run(checkSize(encodeState(emptyState())))
    } else if (version !== 1) throw fault('STATE_FAILED', 'unsupported database schema version')
    const payload = database.prepare('SELECT payload FROM agent_state WHERE id=1').get()?.payload
    if (typeof payload !== 'string') throw fault('STATE_FAILED', 'stored state is missing')
    decodeState(checkSize(payload))
    database.exec('COMMIT')
    // EXCLUSIVE mode retains the writer lock after commit, until close or process exit.
  } catch (cause) {
    try { database.exec('ROLLBACK') } catch { /* No transaction may have begun. */ }
    database.close()
    throw storageError(cause)
  }
  let closed = false
  let broken: unknown
  let tail: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const enqueue = <T>(work: () => T): Promise<T> => {
    if (closed) return Promise.reject(fault('CLOSED', 'state service is closed'))
    const task = tail.then(() => { if (broken) throw broken; return work() })
    tail = task.catch(() => {})
    return task
  }
  const read = () => {
    const payload = database.prepare('SELECT payload FROM agent_state WHERE id=1').get()?.payload
    if (typeof payload !== 'string') throw fault('STATE_FAILED', 'stored state is missing')
    return decodeState(checkSize(payload))
  }
  const service: StateService = {
    durability: 'persistent',
    readSnapshot: () => enqueue(() => { try { return read() } catch (cause) { throw storageError(cause) } }),
    transaction: <T>(_label: string, change: (draft: StateData) => T) => enqueue(() => {
      let begun = false
      let callbackFailed = false
      let callbackError: unknown
      try {
        database.exec('BEGIN EXCLUSIVE'); begun = true
        const draft = read()
        let result: T
        try { result = change(draft) } catch (cause) { callbackFailed = true; callbackError = cause; throw cause }
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => {})
          throw fault('INVALID_ARGUMENT', 'state transaction callbacks must be synchronous')
        }
        const returned = structuredClone(result)
        const payload = checkSize(encodeState(draft))
        decodeState(payload)
        database.prepare('UPDATE agent_state SET payload=? WHERE id=1').run(payload)
        database.exec('COMMIT')
        return returned
      } catch (cause) {
        if (begun) {
          try { database.exec('ROLLBACK') }
          catch (rollbackError) { broken = wrap('STATE_FAILED', 'transaction rollback could not be confirmed', rollbackError) }
        }
        if (callbackFailed) throw callbackError
        throw storageError(cause)
      }
    }),
  }
  return { service, close() {
    if (closing) return closing
    closed = true
    closing = tail.then(() => { database.close() })
    return closing
  } }
}

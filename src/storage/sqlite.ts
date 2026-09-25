import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Component } from '@nya/core'
import { localStorageError, localStorageServiceKey } from './port.js'
import type {
  LocalStoragePort, StorageMigration, StorageReader, StorageRow,
  StorageTransaction, StorageValue,
} from './port.js'

function failure(error: unknown, code: 'open-failed' | 'operation-failed' | 'migration-failed') {
  if (error instanceof Error && error.name === 'LocalStorageError') return error
  return localStorageError(code, `local database ${code}`)
}

function databasePath(file: string): string {
  if (typeof file !== 'string' || !file.trim() || file === ':memory:') {
    throw new TypeError('a local SQLite file path is required')
  }
  const absolute = resolve(file)
  try {
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
    return existsSync(absolute)
      ? realpathSync(absolute)
      : join(realpathSync(dirname(absolute)), basename(absolute))
  } catch (error) {
    throw failure(error, 'open-failed')
  }
}

function sortedMigrations(input: readonly StorageMigration[]): readonly StorageMigration[] {
  if (!Array.isArray(input)) throw new TypeError('migrations must be an array')
  const migrations = [...input].sort((a, b) => a.version - b.version)
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index]?.version !== index + 1 || typeof migrations[index]?.up !== 'function') {
      throw localStorageError('schema-version', 'migrations must have consecutive versions starting at 1')
    }
  }
  return migrations
}

function makeReader(db: DatabaseSync, signal?: AbortSignal): { reader: StorageReader; invalidate(): void } {
  let active = true
  const assertActive = () => {
    if (!active) throw localStorageError('closed', 'storage operation has ended')
    signal?.throwIfAborted()
  }
  const reader: StorageReader = {
    get<Row extends StorageRow>(sql: string, values: readonly StorageValue[] = []): Row | undefined {
      assertActive()
      try { return db.prepare(sql).get(...values) as Row | undefined } catch (error) {
        throw failure(error, 'operation-failed')
      }
    },
    all<Row extends StorageRow>(sql: string, values: readonly StorageValue[] = []): readonly Row[] {
      assertActive()
      try { return db.prepare(sql).all(...values) as Row[] } catch (error) {
        throw failure(error, 'operation-failed')
      }
    },
  }
  return { reader, invalidate() { active = false } }
}

function makeTransaction(db: DatabaseSync, signal?: AbortSignal): { tx: StorageTransaction; invalidate(): void } {
  const scope = makeReader(db, signal)
  let active = true
  const tx: StorageTransaction = {
    ...scope.reader,
    execute(sql, values = []) {
      if (!active) throw localStorageError('closed', 'storage operation has ended')
      signal?.throwIfAborted()
      try {
        const result = db.prepare(sql).run(...values)
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      } catch (error) {
        throw failure(error, 'operation-failed')
      }
    },
  }
  return { tx, invalidate() { active = false; scope.invalidate() } }
}

/** Provider-owned layout: the only use of user_version is the per-domain migration ledger. */
const layoutVersion = 1

function initializeLayout(db: DatabaseSync): void {
  let current: unknown
  let hasTables: boolean
  try {
    current = db.prepare('PRAGMA user_version').get()?.user_version
    hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== undefined
  } catch (error) { throw failure(error, 'open-failed') }
  if (current === layoutVersion) return
  if (current !== 0 || hasTables) throw localStorageError('schema-version', 'unsupported local database layout')
  let begun = false
  try {
    db.exec('BEGIN IMMEDIATE')
    begun = true
    db.exec('CREATE TABLE schema_migrations (domain TEXT PRIMARY KEY, version INTEGER NOT NULL)')
    db.exec(`PRAGMA user_version = ${layoutVersion}`)
    db.exec('COMMIT')
  } catch (error) {
    if (begun) {
      try { db.exec('ROLLBACK') } catch {
        throw localStorageError('rollback-failed', 'database layout rollback failed')
      }
    }
    throw failure(error, 'open-failed')
  }
}

function migrate(db: DatabaseSync, domain: string, migrations: readonly StorageMigration[]): void {
  let current: unknown
  try {
    current = db.prepare('SELECT version FROM schema_migrations WHERE domain = ?').get(domain)?.version ?? 0
  } catch (error) { throw failure(error, 'migration-failed') }
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    throw localStorageError('schema-version', `invalid ${domain} schema version`)
  }
  if (current > migrations.length) {
    throw localStorageError('schema-version', `${domain} schema is newer than this application`)
  }
  for (const migration of migrations.slice(current)) {
    const scope = makeTransaction(db)
    let begun = false
    try {
      db.exec('BEGIN IMMEDIATE')
      begun = true
      const result: unknown = migration.up(scope.tx)
      if (result && typeof result === 'object' && 'then' in result) {
        throw localStorageError('migration-failed', 'migrations must be synchronous')
      }
      db.prepare(`INSERT INTO schema_migrations (domain, version) VALUES (?, ?)
        ON CONFLICT(domain) DO UPDATE SET version = excluded.version`).run(domain, migration.version)
      db.exec('COMMIT')
    } catch {
      if (begun) {
        try { db.exec('ROLLBACK') } catch {
          throw localStorageError('rollback-failed', 'database migration rollback failed')
        }
      }
      throw localStorageError('migration-failed', `${domain} migration ${migration.version} failed`)
    } finally { scope.invalidate() }
  }
}

/** Owns one file-backed SQLite connection and its admission/cleanup lifecycle. */
export function createLocalSqliteComponent(file: string): Component.Object<void> {
  if (typeof file !== 'string' || !file.trim() || file === ':memory:') {
    throw new TypeError('a local SQLite file path is required')
  }
  return {
    name: 'local-sqlite',
    apply(ctx) {
      const path = databasePath(file)
      const lockPath = `${path}.lock`
      ctx.effect(() => {
        try { mkdirSync(lockPath, { mode: 0o700 }) } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
            throw localStorageError('occupied', `local database is already owned: ${path}`)
          }
          throw failure(error, 'open-failed')
        }
        return () => {
          try { rmSync(lockPath, { recursive: true, force: true }) } catch {
            throw localStorageError('close-failed', 'cannot release local database ownership')
          }
        }
      }, 'exclusive local database')

      let db!: DatabaseSync
      ctx.effect(() => {
        try { db = new DatabaseSync(path) } catch (error) { throw failure(error, 'open-failed') }
        return () => { try { db.close() } catch { throw localStorageError('close-failed', 'cannot close local database') } }
      }, 'SQLite connection')
      initializeLayout(db)

      let accepting = true
      let tail: Promise<void> = Promise.resolve()
      const schedule = <Result>(work: () => Result | Promise<Result>, signal?: AbortSignal): Promise<Result> => {
        if (!accepting) return Promise.reject(localStorageError('closed', 'local database is closing'))
        if (signal?.aborted) return Promise.reject(signal.reason)
        const result = tail.then(() => { signal?.throwIfAborted(); return work() })
        tail = result.then(() => {}, () => {})
        return result
      }
      ctx.effect(() => async () => {
        accepting = false
        await tail
      }, 'join local database operations')

      const service: LocalStoragePort = {
        read(work, signal) {
          return schedule(async () => {
            try { db.exec('PRAGMA query_only = ON') } catch (error) { throw failure(error, 'operation-failed') }
            const scope = makeReader(db, signal)
            try {
              const result = await work(scope.reader)
              signal?.throwIfAborted()
              return result
            } finally {
              scope.invalidate()
              try { db.exec('PRAGMA query_only = OFF') } catch (error) { throw failure(error, 'operation-failed') }
            }
          }, signal)
        },
        transaction(work, signal) {
          return schedule(async () => {
            const scope = makeTransaction(db, signal)
            try { db.exec('BEGIN IMMEDIATE') } catch (error) {
              scope.invalidate()
              throw failure(error, 'operation-failed')
            }
            try {
              const result = await work(scope.tx)
              signal?.throwIfAborted()
              try { db.exec('COMMIT') } catch (error) { throw failure(error, 'operation-failed') }
              return result
            } catch (error) {
              try { db.exec('ROLLBACK') } catch {
                throw localStorageError('rollback-failed', 'database transaction rollback failed')
              }
              throw error
            } finally { scope.invalidate() }
          }, signal)
        },
        migrate(domain, input) {
          let migrations: readonly StorageMigration[]
          try {
            if (typeof domain !== 'string' || !domain.trim()) throw new TypeError('a migration domain is required')
            migrations = sortedMigrations(input)
          } catch (error) { return Promise.reject(error) }
          return schedule(() => migrate(db, domain, migrations))
        },
      }
      ctx.provide(localStorageServiceKey, service)
    },
  }
}

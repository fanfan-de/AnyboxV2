import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { localStorageError } from './port.js'

const table = 'storage_layout_fence'
const columns = '(slot INTEGER PRIMARY KEY CHECK (slot=1), identity TEXT NOT NULL, revision INTEGER NOT NULL, token TEXT NOT NULL)'
const mismatch = () => localStorageError('schema-version', 'protected database and authority checkpoint require offline reconciliation')

function authorityPath(lockDirectory: string) {
  return join(lockDirectory, 'authority.sqlite')
}

export function hasFence(lockDirectory: string): boolean {
  const marker = lstatSync(lockDirectory, { throwIfNoEntry: false })
  if (!marker) return false
  if (!marker.isDirectory() || !lstatSync(authorityPath(lockDirectory), { throwIfNoEntry: false })?.isFile()) {
    throw localStorageError('occupied', 'database lock requires offline inspection')
  }
  return true
}

function attach(db: DatabaseSync, directory: string) {
  db.prepare('ATTACH DATABASE ? AS authority').run(authorityPath(directory))
  // SQLite uses the super-journal for atomic commits across these two on-disk files.
  for (const schema of ['main', 'authority']) {
    if (db.prepare('PRAGMA ' + schema + '.journal_mode=DELETE').get()?.journal_mode !== 'delete') throw mismatch()
    db.exec('PRAGMA ' + schema + '.synchronous=FULL')
  }
}

export function verifyFence(db: DatabaseSync, directory: string, layout: 2 | 3) {
  try {
    attach(db, directory)
    // The original layout-2 checkpoint has the default SQLite user_version of zero.
    if (db.prepare('PRAGMA authority.user_version').get()?.user_version !== (layout === 3 ? 3 : 0)) throw mismatch()
    if (layout === 3) db.prepare('SELECT application_id, minimum_capability FROM storage_layout_writers LIMIT 0').all()
    if (!db.prepare('SELECT 1 FROM main.storage_layout_fence m JOIN authority.storage_layout_fence a ON a.slot=m.slot AND a.identity=m.identity AND a.revision=m.revision AND a.token=m.token WHERE m.slot=1 AND m.revision>=0').get()) throw mismatch()
  } catch { throw mismatch() }
}

function initializeWriterRequirements(db: DatabaseSync, applicationId?: string) {
  db.exec('CREATE TABLE storage_layout_writers (application_id TEXT PRIMARY KEY, minimum_capability TEXT NOT NULL)')
  if (applicationId) recordWriter(db, applicationId)
}

export function recordWriter(db: DatabaseSync, applicationId: string) {
  db.prepare('INSERT INTO storage_layout_writers VALUES (?, ?)').run(applicationId, '1.2.0')
}

export function createFence(db: DatabaseSync, directory: string, layout: 2 | 3, applicationId?: string) {
  // Pre-cutover binaries refuse to open the database whenever this path exists.
  // Keep incomplete checkpoints for offline inspection after a crash.
  mkdirSync(directory, { mode: 0o700 })
  attach(db, directory)
  db.exec('BEGIN IMMEDIATE')
  try {
    const identity = randomUUID()
    const token = randomUUID()
    for (const schema of ['main', 'authority']) {
      db.exec('CREATE TABLE ' + schema + '.' + table + ' ' + columns)
      db.prepare('INSERT INTO ' + schema + '.' + table + ' VALUES (1, ?, 0, ?)').run(identity, token)
    }
    if (layout === 3) {
      initializeWriterRequirements(db, applicationId)
      db.exec('PRAGMA authority.user_version=3')
    }
    db.exec('PRAGMA main.user_version=' + layout + '; COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function upgradeFence(db: DatabaseSync, applicationId?: string) {
  db.exec('BEGIN IMMEDIATE')
  try {
    initializeWriterRequirements(db, applicationId)
    advanceFence(db)
    db.exec('PRAGMA main.user_version=3; PRAGMA authority.user_version=3; COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function advanceFence(db: DatabaseSync) {
  const token = randomUUID()
  for (const schema of ['main', 'authority']) {
    if (db.prepare('UPDATE ' + schema + '.' + table + ' SET revision=revision+1, token=? WHERE slot=1').run(token).changes !== 1) throw mismatch()
  }
}

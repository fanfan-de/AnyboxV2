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

export function verifyFence(db: DatabaseSync, directory: string) {
  try {
    attach(db, directory)
    if (!db.prepare('SELECT 1 FROM main.storage_layout_fence m JOIN authority.storage_layout_fence a ON a.slot=m.slot AND a.identity=m.identity AND a.revision=m.revision AND a.token=m.token WHERE m.slot=1 AND m.revision>=0').get()) throw mismatch()
  } catch { throw mismatch() }
}

export function createFence(db: DatabaseSync, directory: string) {
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
    db.exec('PRAGMA main.user_version=2; COMMIT')
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

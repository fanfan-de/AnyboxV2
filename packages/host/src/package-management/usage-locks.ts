import { createHash, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type PackageUsageLockErrorCode = 'invalid' | 'occupied' | 'unauthorized' | 'unavailable' | 'release-failed'

export interface PackageUsageLockError extends Error {
  readonly code: PackageUsageLockErrorCode
}

export interface PackageUsageLock {
  /** Settles only after this connection and its OS-backed lock have actually exited. */
  release(): Promise<void>
}

export interface PackageUsageExitLock extends PackageUsageLock {
  /** Durably fences this token before the registry records that its usage has exited. */
  revoke(): void
}

function failure(code: PackageUsageLockErrorCode): PackageUsageLockError {
  return Object.assign(new Error(`package usage lock ${code}`), { name: 'PackageUsageLockError', code })
}

function anchorPath(directory: string, usageId: string): string {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0') ||
      typeof usageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(usageId)) throw failure('invalid')
  return join(directory, 'usage-locks', `${usageId}.sqlite`)
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error &&
    typeof error.errcode === 'number' && (error.errcode & 0xff) === 5
}

function lockFailure(error: unknown): PackageUsageLockError {
  if (error instanceof Error && error.name === 'PackageUsageLockError') return error as PackageUsageLockError
  return failure(isBusy(error) ? 'occupied' : 'unavailable')
}

function close(db: DatabaseSync | undefined, transaction: boolean): void {
  if (!db) return
  let failed = false
  if (transaction) {
    try { db.exec('ROLLBACK') } catch { failed = true }
  }
  try { db.close() } catch { failed = true }
  if (failed) throw failure('release-failed')
}

function discard(db: DatabaseSync | undefined, transaction: boolean): void {
  // Failure to release ownership must remain visible even when initialization failed.
  close(db, transaction)
}

function handle(db: DatabaseSync): PackageUsageLock {
  let released: Promise<void> | undefined
  return Object.freeze({
    release() {
      if (!released) {
        try { close(db, true); released = Promise.resolve() } catch (error) { released = Promise.reject(error) }
      }
      return released
    },
  })
}

function exitHandle(db: DatabaseSync, path: string, anchor: AnchorIdentity): PackageUsageExitLock {
  let transaction = true
  let revoked = false
  let released: Promise<void> | undefined
  return Object.freeze({
    revoke() {
      if (released) throw failure('unavailable')
      assertAnchor(path, anchor)
      if (revoked) return
      try {
        db.prepare('UPDATE package_usage_identity SET revoked = 1 WHERE id = 1').run()
        db.exec('COMMIT')
        transaction = false
        revoked = true
        assertAnchor(path, anchor)
      } catch (error) { throw lockFailure(error) }
    },
    release() {
      if (!released) {
        try { close(db, transaction); released = Promise.resolve() } catch (error) { released = Promise.reject(error) }
      }
      return released
    },
  })
}

interface AnchorIdentity { readonly device: string; readonly inode: string }
function anchorIdentity(path: string): AnchorIdentity {
  try {
    const parent = lstatSync(dirname(path)), file = lstatSync(path, { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n) throw failure('unavailable')
    return { device: String(file.dev), inode: String(file.ino) }
  } catch { throw failure('unavailable') }
}
function assertAnchor(path: string, expected: AnchorIdentity): void {
  const actual = anchorIdentity(path)
  if (actual.device !== expected.device || actual.inode !== expected.inode) throw failure('unavailable')
}
function assertLayout(db: DatabaseSync, path: string, anchor: AnchorIdentity): void {
  // v1 did not bind its original physical file. Adopting its current pathname
  // would invent exit evidence after an external restore/replacement.
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 2 ||
      db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw failure('unavailable')
  const stored = db.prepare('SELECT anchor_device, anchor_inode FROM package_usage_identity WHERE id = 1').get()
  if (stored?.anchor_device !== anchor.device || stored?.anchor_inode !== anchor.inode) throw failure('unavailable')
  assertAnchor(path, anchor)
}

/** Called by the registry owner before handing a token to any process. Anchors are never deleted. */
export function prepareUsageLock(directory: string, usageId: string, secretDigest: string): void {
  const path = anchorPath(directory, usageId)
  if (typeof secretDigest !== 'string' || !/^[a-fA-F0-9]{64}$/.test(secretDigest)) throw failure('invalid')
  const digest = secretDigest.toLowerCase()
  let db: DatabaseSync | undefined
  let transaction = false
  try {
    mkdirSync(join(directory, 'usage-locks'), { recursive: true, mode: 0o700 })
    const parent = lstatSync(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure('unavailable')
    let created = false
    try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const anchor = anchorIdentity(path)
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=0')
    const initialVersion = db.prepare('PRAGMA user_version').get()?.user_version
    if (created && initialVersion === 0) {
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' ||
          db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) throw failure('unavailable')
      // Only a verified empty rollback-journal anchor may be initialized. Existing layouts
      // are validated before any journal-mode assignment, so an unknown/WAL file is untouched.
      db.exec('PRAGMA journal_mode=DELETE')
    } else { assertLayout(db, path, anchor) }
    db.exec('BEGIN EXCLUSIVE')
    transaction = true
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) throw failure('unavailable')
      assertAnchor(path, anchor)
      db.exec('CREATE TABLE package_usage_identity (id INTEGER PRIMARY KEY CHECK (id = 1), secret_digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)), anchor_device TEXT NOT NULL, anchor_inode TEXT NOT NULL); PRAGMA user_version=2')
      db.prepare('INSERT INTO package_usage_identity (id, secret_digest, anchor_device, anchor_inode) VALUES (1, ?, ?, ?)').run(digest, anchor.device, anchor.inode)
    } else {
      assertLayout(db, path, anchor)
      if (db.prepare('SELECT secret_digest FROM package_usage_identity WHERE id = 1').get()?.secret_digest !== digest) {
        throw failure('unauthorized')
      }
    }
    db.exec('COMMIT')
    transaction = false
    assertLayout(db, path, anchor)
  } catch (error) {
    const failed = db
    db = undefined
    discard(failed, transaction)
    throw lockFailure(error)
  } finally { if (db) close(db, transaction) }
}

/** Holds a SHARED rollback-journal lock for the real lifetime of a token's process usage. */
export function acquirePackageUsageLock(
  directory: string,
  input: { readonly usageId: string; readonly secret: string },
): PackageUsageLock {
  if (typeof input !== 'object' || input === null ||
      typeof input.secret !== 'string' || !input.secret.length || input.secret.length > 256) throw failure('invalid')
  const path = anchorPath(directory, input.usageId)
  const presented = createHash('sha256').update(input.secret).digest()
  let db: DatabaseSync | undefined
  let transaction = false
  try {
    const anchor = anchorIdentity(path)
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout=0; BEGIN')
    transaction = true
    assertLayout(db, path, anchor)
    const identity = db.prepare('SELECT secret_digest, revoked FROM package_usage_identity WHERE id = 1').get()
    const digest = identity?.secret_digest
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) ||
        !timingSafeEqual(presented, Buffer.from(digest, 'hex')) || identity?.revoked !== 0) throw failure('unauthorized')
    assertAnchor(path, anchor)
    return handle(db)
  } catch (error) {
    discard(db, transaction)
    throw lockFailure(error)
  }
}

/** An acquired EXCLUSIVE lock proves that all SHARED process holders have exited. */
export function tryAcquirePackageUsageExitLock(directory: string, usageId: string): PackageUsageExitLock | undefined {
  const path = anchorPath(directory, usageId)
  let db: DatabaseSync | undefined
  let transaction = false
  try {
    // A missing anchor is uncertainty, never proof of resource exit or permission to recreate it.
    const anchor = anchorIdentity(path)
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    transaction = true
    assertLayout(db, path, anchor)
    const identity = db.prepare('SELECT secret_digest, revoked FROM package_usage_identity WHERE id = 1').get()
    if (typeof identity?.secret_digest !== 'string' || !/^[a-f0-9]{64}$/.test(identity.secret_digest) ||
        (identity.revoked !== 0 && identity.revoked !== 1)) {
      throw failure('unavailable')
    }
    assertAnchor(path, anchor)
    return exitHandle(db, path, anchor)
  } catch (error) {
    discard(db, transaction)
    if (isBusy(error)) return undefined
    throw lockFailure(error)
  }
}

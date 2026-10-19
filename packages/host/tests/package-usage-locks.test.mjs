import { symbolicAliasSync } from './helpers/filesystem-alias.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  acquirePackageUsageLock, prepareUsageLock, tryAcquirePackageUsageExitLock,
} from '../dist/package-management/usage-locks.js'

const moduleUrl = new URL('../dist/package-management/usage-locks.js', import.meta.url).href
const secret = 'temporary-package-usage-test-secret'
const digest = createHash('sha256').update(secret).digest('hex')
const childrenByDirectory = new Map()

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-package-usage-'))
  const children = []
  childrenByDirectory.set(directory, children)
  t.after(async () => {
    for (const { process, exited } of children) {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
      await exited
    }
    childrenByDirectory.delete(directory)
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

async function child(t, directory, usageId, mode = 'shared') {
  const script = `
    let lock
    process.on('message', async message => {
      if (message.type === 'release') {
        await lock?.release()
        process.disconnect()
        return
      }
      try {
        const api = await import(message.moduleUrl)
        lock = message.mode === 'shared'
          ? api.acquirePackageUsageLock(message.directory, { usageId: message.usageId, secret: message.secret })
          : api.tryAcquirePackageUsageExitLock(message.directory, message.usageId)
        process.send({ type: 'ready', acquired: Boolean(lock) })
      } catch (error) { process.send({ type: 'failure', code: error.code, message: error.message }) }
    })
  `
  const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  processHandle.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = once(processHandle, 'exit')
  childrenByDirectory.get(directory).push({ process: processHandle, exited })
  const ready = Promise.race([
    once(processHandle, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`usage child exited before readiness: ${stderr}`) }),
  ])
  processHandle.send({ moduleUrl, directory, usageId, secret, mode })
  const message = await ready
  assert.equal(message.type, 'ready', JSON.stringify(message))
  return { process: processHandle, exited, acquired: message.acquired }
}

test('usage anchors authenticate tokens and cannot be repurposed by preparing a different digest', async t => {
  const directory = workspace(t)
  prepareUsageLock(directory, 'usage-1', digest)
  prepareUsageLock(directory, 'usage-1', digest.toUpperCase())
  const file = join(directory, 'usage-locks', 'usage-1.sqlite')
  const contents = readFileSync(file)
  assert.equal(contents.includes(Buffer.from(secret)), false)
  assert.throws(() => prepareUsageLock(directory, 'usage-1', 'a'.repeat(64)), { code: 'unauthorized' })
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'usage-1', secret: 'wrong-secret' }), { code: 'unauthorized' })
  const usage = acquirePackageUsageLock(directory, { usageId: 'usage-1', secret })
  assert.equal(tryAcquirePackageUsageExitLock(directory, 'usage-1'), undefined)
  const released = usage.release()
  assert.equal(usage.release(), released)
  await released
  const exit = tryAcquirePackageUsageExitLock(directory, 'usage-1')
  assert.ok(exit)
  await exit.release()
})

test('a real child SHARED holder blocks parent and second-process exit proof until actual release', { timeout: 10_000 }, async t => {
  const directory = workspace(t)
  prepareUsageLock(directory, 'child-usage', digest)
  const holder = await child(t, directory, 'child-usage')
  assert.equal(holder.acquired, true)
  assert.equal(tryAcquirePackageUsageExitLock(directory, 'child-usage'), undefined)
  const contender = await child(t, directory, 'child-usage', 'exclusive')
  assert.equal(contender.acquired, false)
  contender.process.send({ type: 'release' })
  await contender.exited
  holder.process.send({ type: 'release' })
  await holder.exited
  const proof = tryAcquirePackageUsageExitLock(directory, 'child-usage')
  assert.ok(proof)
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'child-usage', secret }), { code: 'occupied' })
  await proof.release()
})

test('SIGKILL releases a process usage lock without PID checks or deleting its anchor', { timeout: 10_000 }, async t => {
  const directory = workspace(t)
  prepareUsageLock(directory, 'killed-usage', digest)
  const holder = await child(t, directory, 'killed-usage')
  assert.equal(tryAcquirePackageUsageExitLock(directory, 'killed-usage'), undefined)
  holder.process.kill('SIGKILL')
  const [code, signal] = await holder.exited
  assert.equal(code, null)
  assert.equal(signal, 'SIGKILL')
  const proof = tryAcquirePackageUsageExitLock(directory, 'killed-usage')
  assert.ok(proof)
  await proof.release()
  assert.equal(existsSync(join(directory, 'usage-locks', 'killed-usage.sqlite')), true)
})

test('a copied replacement anchor cannot prove exit or admit another holder while its original physical file is locked', { timeout: 10_000 }, async t => {
  const directory = workspace(t), usageId = 'replaced-usage'
  prepareUsageLock(directory, usageId, digest)
  const holder = await child(t, directory, usageId)
  const path = join(directory, 'usage-locks', `${usageId}.sqlite`), original = path + '.original'
  if (process.platform === 'win32') {
    assert.throws(() => renameSync(path, original), { code: 'EBUSY' }, 'the native SQLite handle prevents replacing a live anchor')
    assert.equal(tryAcquirePackageUsageExitLock(directory, usageId), undefined)
    holder.process.send({ type: 'release' }); await holder.exited
  }
  renameSync(path, original); copyFileSync(original, path)
  assert.throws(() => tryAcquirePackageUsageExitLock(directory, usageId), { code: 'unavailable' })
  assert.throws(() => acquirePackageUsageLock(directory, { usageId, secret }), { code: 'unavailable' })
  assert.throws(() => prepareUsageLock(directory, usageId, digest), { code: 'unavailable' })
  const originalConnection = new DatabaseSync(original)
  try { if (process.platform === 'win32') originalConnection.exec('BEGIN EXCLUSIVE; ROLLBACK'); else assert.throws(() => originalConnection.exec('BEGIN EXCLUSIVE'), /locked/) } finally { originalConnection.close() }
  rmSync(path); renameSync(original, path)
  if (process.platform !== 'win32') {
    assert.equal(tryAcquirePackageUsageExitLock(directory, usageId), undefined)
    holder.process.send({ type: 'release' }); await holder.exited
  }
  const proof = tryAcquirePackageUsageExitLock(directory, usageId)
  assert.ok(proof); proof.revoke(); await proof.release()
})

test('symbolic and hard-link anchor aliases are rejected without repurposing the original file', async t => {
  const directory = workspace(t), source = join(directory, 'usage-locks/source.sqlite'), alias = join(directory, 'usage-locks/alias.sqlite')
  prepareUsageLock(directory, 'source', digest)
  for (const createAlias of [symbolicAliasSync, linkSync]) {
    createAlias(source, alias)
    assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'alias'), { code: 'unavailable' })
    assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'alias', secret }), { code: 'unavailable' })
    assert.throws(() => prepareUsageLock(directory, 'alias', digest), { code: 'unavailable' })
    rmSync(alias)
  }
  const proof = tryAcquirePackageUsageExitLock(directory, 'source'); assert.ok(proof); await proof.release()
})

test('legacy anchors without a physical identity remain uncertain and are never silently upgraded', async t => {
  const directory = workspace(t)
  prepareUsageLock(directory, 'current', digest)
  const path = join(directory, 'usage-locks/legacy.sqlite'), legacy = new DatabaseSync(path)
  legacy.exec('CREATE TABLE package_usage_identity (id INTEGER PRIMARY KEY, secret_digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=1')
  legacy.prepare('INSERT INTO package_usage_identity VALUES(1,?,0)').run(digest); legacy.close()
  const original = readFileSync(path)
  assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'legacy'), { code: 'unavailable' })
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'legacy', secret }), { code: 'unavailable' })
  assert.throws(() => prepareUsageLock(directory, 'legacy', digest), { code: 'unavailable' })
  assert.deepEqual(readFileSync(path), original)
})

test('an acquired exit proof rechecks physical identity before writing a revocation', async t => {
  const directory = workspace(t), path = join(directory, 'usage-locks/replaced-before-revoke.sqlite')
  prepareUsageLock(directory, 'replaced-before-revoke', digest)
  const proof = tryAcquirePackageUsageExitLock(directory, 'replaced-before-revoke')
  if (process.platform === 'win32') {
    assert.throws(() => renameSync(path, path + '.original'), { code: 'EBUSY' }, 'an acquired native exit lock also blocks file substitution')
    proof.revoke(); await proof.release()
    renameSync(path, path + '.original'); copyFileSync(path + '.original', path)
    assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'replaced-before-revoke'), { code: 'unavailable' })
    const original = new DatabaseSync(path + '.original', { readOnly: true })
    try { assert.equal(original.prepare('SELECT revoked FROM package_usage_identity').get().revoked, 1) } finally { original.close() }
    return
  }
  renameSync(path, path + '.original'); copyFileSync(path + '.original', path)
  assert.throws(() => proof.revoke(), { name: 'PackageUsageLockError', code: 'unavailable' })
  await proof.release()
  for (const file of [path, path + '.original']) {
    const db = new DatabaseSync(file, { readOnly: true })
    try { assert.equal(db.prepare('SELECT revoked FROM package_usage_identity').get().revoked, 0) } finally { db.close() }
  }
})

test('exit proof revokes a token durably before registry confirmation and stale holders cannot reacquire', async t => {
  const directory = workspace(t)
  prepareUsageLock(directory, 'revoked-usage', digest)
  const proof = tryAcquirePackageUsageExitLock(directory, 'revoked-usage')
  assert.ok(proof)
  proof.revoke()
  proof.revoke()
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'revoked-usage', secret }), { code: 'unauthorized' })
  const release = proof.release()
  assert.equal(proof.release(), release)
  await release
  prepareUsageLock(directory, 'revoked-usage', digest)
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'revoked-usage', secret }), { code: 'unauthorized' })
  const recoveryProof = tryAcquirePackageUsageExitLock(directory, 'revoked-usage')
  assert.ok(recoveryProof)
  recoveryProof.revoke()
  await recoveryProof.release()
})

test('missing or malformed anchors remain uncertain and errors expose no native details', t => {
  const directory = workspace(t)
  const path = join(directory, 'usage-locks', 'missing.sqlite')
  assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'missing'), error =>
    error.name === 'PackageUsageLockError' && error.code === 'unavailable' && !error.message.includes(directory))
  assert.equal(existsSync(path), false)
  assert.throws(() => acquirePackageUsageLock(directory, { usageId: 'missing', secret }), error =>
    error.name === 'PackageUsageLockError' && error.code === 'unavailable' && !error.message.includes(directory))
  assert.equal(existsSync(path), false)
  prepareUsageLock(directory, 'broken', digest)
  writeFileSync(join(directory, 'usage-locks', 'broken.sqlite'), 'not SQLite')
  assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'broken'), { code: 'unavailable' })
  prepareUsageLock(directory, 'wal', digest)
  const wal = new DatabaseSync(join(directory, 'usage-locks', 'wal.sqlite'))
  wal.exec('PRAGMA journal_mode=WAL')
  wal.close()
  assert.throws(() => tryAcquirePackageUsageExitLock(directory, 'wal'), { code: 'unavailable' })
  assert.throws(() => prepareUsageLock(directory, 'wal', digest), { code: 'unavailable' })
  const unchanged = new DatabaseSync(join(directory, 'usage-locks', 'wal.sqlite'), { readOnly: true })
  try { assert.equal(unchanged.prepare('PRAGMA journal_mode').get().journal_mode, 'wal') } finally { unchanged.close() }
})

test('usage identifiers and digests are validated before creating any paths', t => {
  const directory = workspace(t)
  for (const usageId of ['', '..', '../escape', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(129)]) {
    assert.throws(() => prepareUsageLock(directory, usageId, digest), { code: 'invalid' })
    assert.throws(() => acquirePackageUsageLock(directory, { usageId, secret }), { code: 'invalid' })
    assert.throws(() => tryAcquirePackageUsageExitLock(directory, usageId), { code: 'invalid' })
  }
  assert.throws(() => prepareUsageLock(directory, 'valid', 'not-sha256'), { code: 'invalid' })
  for (const input of [null, undefined, false, { usageId: 'valid', secret: '' }, { usageId: 'valid', secret: 'x'.repeat(257) }]) {
    assert.throws(() => acquirePackageUsageLock(directory, input), { code: 'invalid' })
  }
  assert.equal(existsSync(join(directory, 'usage-locks')), false)
})

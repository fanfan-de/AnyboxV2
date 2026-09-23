import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSQLiteState } from '../dist/index.js'
import { isCode, deferred } from './helpers.mjs'

async function storage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-sqlite-'))
  const path = join(directory, 'agent.sqlite')
  const owners = []
  t.after(async () => { for (const owner of owners) await owner.close(); await rm(directory, { recursive: true, force: true }) })
  return { path, async open(options = {}) {
    const owner = await createSQLiteState({ path, ...options }); owners.push(owner); return owner
  } }
}

test('SQLite transactions preserve isolation, rollback and data after close/reopen', async t => {
  const f = await storage(t), first = await f.open()
  assert.equal(first.service.durability, 'persistent')
  let retained
  const session = await first.service.transaction('session', draft => {
    retained = draft
    const session = { id: 's', agentId: 'a', version: 1, createdAt: '2026-09-22T00:00:00Z' }
    draft.sessions.set('s', session); return session
  })
  session.version = 99; retained.sessions.clear()
  await assert.rejects(first.service.transaction('rollback', draft => {
    draft.sessions.clear(); draft.events.set('invalid', [])
    throw new Error('business rejection')
  }), /business rejection/)
  const snapshot = await first.service.readSnapshot()
  assert.equal(snapshot.sessions.get('s').version, 1)
  assert.equal(snapshot.events.size, 0)
  snapshot.sessions.clear()
  const closing = first.close()
  assert.strictEqual(first.close(), closing)
  await closing
  await assert.rejects(first.service.readSnapshot(), isCode('CLOSED'))
  const second = await f.open()
  assert.equal((await second.service.readSnapshot()).sessions.get('s').version, 1)
})

test('SQLite rejects a second owner and releases its lock on close', async t => {
  const f = await storage(t), first = await f.open()
  await assert.rejects(f.open(), isCode('CONFLICT'))
  await first.close()
  const second = await f.open()
  assert.equal((await second.service.readSnapshot()).runs.size, 0)
})

test('asynchronous or non-serializable transactions cannot commit', async t => {
  const f = await storage(t), owner = await f.open(), gate = deferred()
  await assert.rejects(owner.service.transaction('async', async draft => {
    await gate.promise; draft.sessions.clear()
  }), isCode('INVALID_ARGUMENT'))
  gate.resolve()
  await assert.rejects(owner.service.transaction('nan', draft => {
    draft.sessions.set('s', { id: 's', version: NaN })
  }), isCode('INVALID_ARGUMENT'))
  await owner.service.transaction('empty', () => undefined)
  assert.equal((await owner.service.readSnapshot()).sessions.size, 0)
})

test('unknown formats and damaged snapshots fail without resetting the database', async t => {
  const f = await storage(t), owner = await f.open()
  await owner.close()
  const database = new DatabaseSync(f.path)
  database.exec('PRAGMA user_version=99')
  database.close()
  await assert.rejects(f.open(), isCode('STATE_FAILED'))
  const check = new DatabaseSync(f.path)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99)
  check.exec("PRAGMA user_version=1; UPDATE agent_state SET payload='{}'")
  check.close()
  await assert.rejects(f.open(), isCode('STATE_FAILED'))
  const verify = new DatabaseSync(f.path)
  assert.equal(verify.prepare('SELECT payload FROM agent_state').get().payload, '{}')
  verify.close()
})

test('snapshot size limits roll back a transaction and preserve earlier data', async t => {
  const f = await storage(t), owner = await f.open({ maxSnapshotBytes: 1024 })
  await assert.rejects(owner.service.transaction('oversize', draft => {
    draft.sessions.set('s', { id: 's', agentId: 'a', version: 1, createdAt: 'x'.repeat(2000) })
  }), isCode('LIMIT_EXCEEDED'))
  assert.equal((await owner.service.readSnapshot()).sessions.size, 0)
  await owner.close()
  assert.equal((await (await f.open()).service.readSnapshot()).sessions.size, 0)
})

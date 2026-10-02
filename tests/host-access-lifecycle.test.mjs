import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent } from '../dist/host/access.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-access-lifecycle-')), root = new Context()
  t.after(async () => { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const fiber = root.installComponent(createHostAccessComponent('device')); await fiber
  return { root, fiber, access: root.get('host.access') }
}

test('access revocation commits before joining every observer and shutdown waits their cleanup', async t => {
  const f = await fixture(t), issued = await f.access.issue('owner'), entered = deferred(), exit = deferred()
  const observed = []
  f.access.onRevoked(() => { observed.push('throwing'); throw new Error('private observer failure') })
  f.access.onRevoked(async id => {
    observed.push(id); entered.resolve()
    assert.throws(() => f.access.authenticate(`Bearer ${issued.token}`), { code: 'authentication-failed' })
    await exit.promise
  })
  f.access.onRevoked(() => observed.push('last'))
  let revoked = false, closed = false
  const revoking = f.access.revoke(issued.record.id).then(() => revoked = true)
  await entered.promise
  assert.deepEqual(observed, ['throwing', issued.record.id, 'last'])
  assert.notEqual((await f.access.list())[0].revokedAt, null)
  const closing = f.fiber.dispose().then(() => closed = true)
  await tick(); assert.equal(revoked, false); assert.equal(closed, false)
  exit.resolve(); await revoking; await closing
  assert.equal(revoked, true); assert.equal(closed, true)
})

test('identity reset fixes its new identity and rejects all old tokens before waiting all observer exits', async t => {
  const f = await fixture(t), first = await f.access.issue('first'), second = await f.access.issue('second')
  const old = f.access.instance.instanceId, entered = deferred(), exit = deferred(), observed = []
  f.access.onRevoked(async id => {
    observed.push(id)
    assert.notEqual(f.access.instance.instanceId, old)
    for (const token of [first, second]) assert.throws(() => f.access.authenticate(`Bearer ${token.token}`), { code: 'authentication-failed' })
    if (observed.length === 2) entered.resolve()
    await exit.promise
  })
  let reset = false; const resetting = f.access.resetIdentity().then(value => { reset = true; return value })
  await entered.promise; await tick(); assert.equal(reset, false)
  assert.deepEqual(new Set(observed), new Set([first.record.id, second.record.id]))
  exit.resolve(); assert.equal((await resetting).instanceId, f.access.instance.instanceId)
})

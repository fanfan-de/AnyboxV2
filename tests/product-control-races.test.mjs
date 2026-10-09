import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProductActivity, createProductActivityComponent } from '../dist/host/applications/activity.js'
import { createProductsComponent } from '../dist/host/applications/component.js'
import { fakeRuntime, definition } from './helpers/application-runtime.mjs'
import { deferred } from './helpers/controlled-models.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-product-races-')), root = new Context()
  const runtime = fakeRuntime(), calls = runtime.calls
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProductActivityComponent())
  await root.installComponent(createProductsComponent({ directory: [definition], runtime: () => runtime }))
  const products = root.get('app.products'), activity = root.get('app.activity'), db = root.get('local-storage')
  await products.restore()
  t.after(async () => {
    activity.stop(); await products.stop()
    try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  return { products, activity, db, calls }
}

test('a failed target commit releases every freeze and leaves the running selection unchanged', async t => {
  const { products, activity, db, calls } = await fixture(t)
  const id = 'agent'
  await products.open(id)
  let freezes = 0
  activity.registerGuard('agent', () => { freezes++; return () => { freezes-- } })
  const original = db.transaction.bind(db), failure = new Error('deliberate target commit failure')
  db.transaction = () => Promise.reject(failure)
  const priorCalls = calls.length
  try { await assert.rejects(products.disable(id), { code: 'product-storage-failed' }) }
  finally { db.transaction = original }
  assert.equal(freezes, 0)
  assert.equal(products.get(id).desiredEnabled, true)
  assert.equal(products.get(id).state, 'running')
  assert.equal(calls.length, priorCalls)
  assert.equal((await db.read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', [id]))).desired_enabled, 1)
  const resumed = activity.enter(id); resumed.release()
  assert.equal((await products.disable(id)).state, 'disabled')
})

test('stop waits for an accepted application open to settle while rejecting queued and new changes', async t => {
  const { products, activity, db, calls } = await fixture(t)
  const id = 'agent'
  const original = db.transaction.bind(db), entered = deferred(), release = deferred()
  let blocked = true
  db.transaction = (work, signal) => original(async tx => {
    if (blocked) { blocked = false; entered.resolve(); await release.promise }
    return work(tx)
  }, signal)
  const applying = products.open(id)
  await entered.promise
  const queued = products.open(id)
  void queued.catch(() => {})
  let stopped = false
  const stopping = products.stop().then(() => { stopped = true })
  activity.stop()
  await assert.rejects(products.open(id), { code: 'service-unavailable' })
  await Promise.resolve(); assert.equal(stopped, false)
  release.resolve()
  try {
    assert.equal((await applying).state, 'running')
    await assert.rejects(queued, { code: 'service-unavailable' })
    await stopping
  } finally { db.transaction = original; release.resolve() }
  assert.equal(stopped, true)
  assert.equal(calls.at(-1), 'open')
  assert.equal(products.list().length, 1)
  assert.equal((await db.read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', [id]))).desired_enabled, 1)
  assert.throws(() => activity.enter(id), { code: 'product-unavailable' })
})

test('failed guard rollback fences the application before changing its durable target', async t => {
  const { products, activity, db, calls } = await fixture(t)
  await products.open('agent')
  activity.registerGuard('agent', () => () => { throw new Error('guard rollback failed') })
  activity.registerGuard('agent', () => undefined)
  const count = calls.length
  await assert.rejects(products.disable('agent'), { code: 'product-cleanup-failed' })
  assert.equal(products.get('agent').desiredEnabled, true)
  assert.equal(products.get('agent').state, 'failed')
  assert.deepEqual(products.get('agent').error, { phase: 'cleanup', code: 'product-cleanup-failed' })
  assert.equal((await db.read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', ['agent']))).desired_enabled, 1)
  assert.equal(calls.length, count)
  await assert.rejects(products.retry('agent'), { code: 'product-restart-required' })
})

test('failed guard release after stopping retains the saved target and requires restart', async t => {
  const { products, activity, db, calls } = await fixture(t)
  await products.open('agent')
  activity.registerGuard('agent', () => () => { throw new Error('guard release failed') })
  await assert.rejects(products.disable('agent'), { code: 'product-cleanup-failed' })
  assert.equal(calls.at(-1), 'stop')
  assert.equal(products.get('agent').desiredEnabled, false)
  assert.equal(products.get('agent').state, 'failed')
  assert.deepEqual(products.get('agent').error, { phase: 'cleanup', code: 'product-cleanup-failed' })
  assert.equal((await db.read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', ['agent']))).desired_enabled, 0)
  await assert.rejects(products.open('agent'), { code: 'product-restart-required' })
})

test('one failing observer cancellation still cancels other observers and waits for real exits', async () => {
  const activity = createProductActivity(), cancelled = []
  const first = activity.enter('a', { blocking: false, cancel() { cancelled.push('first'); throw new Error('observer cancellation failed') } })
  const second = activity.enter('a', { blocking: false, cancel() { cancelled.push('second') } })
  const freeze = activity.freeze(['a'])
  let finished = false
  const draining = freeze.drain().finally(() => { finished = true })
  void draining.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(cancelled, ['first', 'second'])
  assert.equal(finished, false)
  first.release(); await Promise.resolve(); assert.equal(finished, false)
  second.release()
  await assert.rejects(draining, error => error.phase === 'cleanup')
  freeze.release()
  const next = activity.enter('a'); next.release()
})

test('observer drain failure settles the saved stop target and preserves its cleanup error', async t => {
  const { products, activity, calls } = await fixture(t)
  const id = 'agent'
  await products.open(id)
  const cancelled = deferred(), count = calls.length
  const observer = activity.enter(id, { blocking: false, cancel() { cancelled.resolve(); throw new Error('observer cancellation failed') } })
  const stopping = products.disable(id)
  await cancelled.promise
  assert.equal(products.get(id).state, 'applying')
  observer.release()
  const stopped = await stopping
  assert.equal(stopped.state, 'failed')
  assert.equal(stopped.desiredEnabled, false)
  assert.deepEqual(stopped.error, { phase: 'cleanup', code: 'product-cleanup-failed' })
  assert.equal(calls.length, count)
  await assert.rejects(products.retry(id), { code: 'product-restart-required' })
})

test('activity stop closes admission even if one observer cancellation throws', async () => {
  const activity = createProductActivity(), cancelled = []
  const first = activity.enter('a', { blocking: false, cancel() { cancelled.push('first'); throw new Error('cancel failed') } })
  const second = activity.enter('b', { blocking: false, cancel() { cancelled.push('second') } })
  assert.doesNotThrow(() => activity.stop())
  assert.deepEqual(cancelled, ['first', 'second'])
  assert.throws(() => activity.enter('c'), { code: 'product-unavailable' })
  let finished = false
  const waiting = activity.wait().finally(() => { finished = true }); void waiting.catch(() => {})
  await Promise.resolve(); assert.equal(finished, false)
  first.release(); second.release()
  await assert.rejects(waiting, error => error.phase === 'cleanup')
})

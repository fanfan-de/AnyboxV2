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
async function open(path, runtime = fakeRuntime(), legacy = false) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(path))
  if (legacy) await root.get('local-storage').migrate('run-state', [{ version: 1, up() {} }])
  await root.installComponent(createProductActivityComponent())
  await root.installComponent(createProductsComponent({ directory: [definition], runtime: () => runtime }))
  const products = root.get('app.products'), activity = root.get('app.activity')
  await products.restore()
  return { root, products, activity, runtime, async close() { activity.stop(); await products.stop(); await root.fiber.dispose() } }
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-products-')), owners = []
  try { await fn(join(dir, 'business.sqlite'), async (...args) => { const value = await open(...args); owners.push(value); return value }) }
  finally { for (const owner of owners.reverse()) await owner.close(); await rm(dir, { recursive: true, force: true }) }
}

test('the registered Harness application opens once and has no composition API', () => fixture(async (path, start) => {
  const { products, runtime } = await start(path)
  assert.deepEqual(products.list(), [{ definition: { id: 'agent', name: 'Anybox Harness', icon: 'agent' }, desiredEnabled: false, state: 'disabled' }])
  assert.equal(runtime.inspect(), 'disabled')
  for (const method of ['modules', 'create', 'save', 'preview', 'apply', 'remove']) assert.equal(products[method], undefined)
  assert.equal((await products.open('agent')).state, 'running')
  assert.equal(runtime.calls.at(-1), 'open')
  const count = runtime.calls.length
  await products.open('agent'); assert.equal(runtime.calls.length, count)
  await assert.rejects(products.open('models'), { code: 'product-not-found' })
  assert.equal((await products.disable('agent')).state, 'disabled')
  assert.equal(runtime.inspect(), 'disabled')
}))

test('busy application operations reject stopping before changing the durable target', () => fixture(async (path, start) => {
  const { products, activity, root } = await start(path)
  await products.open('agent')
  const lease = activity.enter('agent')
  await assert.rejects(products.disable('agent'), { code: 'product-busy' })
  assert.equal(products.get('agent').desiredEnabled, true)
  assert.equal((await root.get('local-storage').read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', ['agent']))).desired_enabled, 1)
  lease.release(); await products.disable('agent')
  assert.throws(() => products.authorize('agent'), { code: 'product-unavailable' })
}))

test('preparing guards protect stopping and freeze admission atomically', () => fixture(async (path, start) => {
  const { products, activity } = await start(path)
  await products.open('agent')
  let busy = true, paused = false
  activity.registerGuard('agent', () => { if (busy) return undefined; paused = true; return () => { paused = false } })
  await assert.rejects(products.disable('agent'), { code: 'product-busy' })
  busy = false
  const frozen = activity.freeze(['agent'])
  assert.equal(paused, true)
  assert.throws(() => activity.enter('agent'), { code: 'product-unavailable' })
  frozen.release(); assert.equal(paused, false)
  await products.disable('agent')
}))

test('application stop cancels observers and waits for their real exit', async () => {
  const activity = createProductActivity()
  let cancelled = false, exited = false
  const observer = activity.enter('agent', { blocking: false, cancel() { cancelled = true } })
  const freeze = activity.freeze(['agent'])
  const draining = freeze.drain().then(() => { exited = true })
  await Promise.resolve(); assert.equal(cancelled, true); assert.equal(exited, false)
  observer.release(); await draining; freeze.release()
})

test('saved Harness targets restore after restart and legacy execution databases open Harness', () => fixture(async (path, start) => {
  let f = await start(path, fakeRuntime(), true)
  assert.equal(f.products.get('agent').state, 'running')
  await f.products.disable('agent'); await f.close()
  f = await start(path); assert.equal(f.products.get('agent').state, 'disabled')
  await f.products.open('agent'); await f.close()
  f = await start(path); assert.equal(f.products.get('agent').state, 'running')
}))

test('legacy combination v1 migrates only the builtin target and preserves business and historical JSON', () => fixture(async (path, start) => {
  const root = new Context(); await root.installComponent(createLocalSqliteComponent(path))
  const db = root.get('local-storage'), raw = '{"pages":[{"kind":"prompt-management"}],"legacy":"untouched"}'
  await db.migrate('app-products', [{ version: 1, up(tx) {
    tx.execute('CREATE TABLE app_products (id TEXT PRIMARY KEY, definition_json TEXT, target_json TEXT, desired_enabled INTEGER, applied_json TEXT, error_json TEXT)')
    tx.execute('INSERT INTO app_products VALUES(?,?,?,?,?,NULL)', ['agent', raw, raw, 0, raw])
    tx.execute('INSERT INTO app_products VALUES(?,?,?,?,?,NULL)', ['custom', raw, raw, 1, raw])
    tx.execute('CREATE TABLE business_evidence (value TEXT)'); tx.execute('INSERT INTO business_evidence VALUES(?)', ['retained'])
  } }])
  await root.fiber.dispose()
  const f = await start(path)
  assert.equal(f.products.list().length, 1); assert.equal(f.products.get('agent').state, 'disabled')
  assert.equal(f.products.get('custom'), undefined); assert.equal(f.runtime.inspect(), 'disabled')
  await f.products.open('agent')
  await f.root.get('local-storage').read(reader => {
    assert.equal(reader.get('SELECT definition_json FROM app_products WHERE id=?', ['custom']).definition_json, raw)
    assert.equal(reader.get('SELECT value FROM business_evidence').value, 'retained')
  })
}))

test('startup can explicitly retry and cleanup failure requires a fresh host', () => fixture(async (path, start) => {
  const runtime = fakeRuntime(), f = await start(path, runtime)
  runtime.failure = new Error('private provider error')
  const failed = await f.products.open('agent')
  assert.deepEqual(failed.error, { phase: 'startup', code: 'product-startup-failed' })
  assert.ok(!JSON.stringify(failed).includes('private provider'))
  runtime.failure = undefined
  assert.equal((await f.products.retry('agent')).state, 'running')
  runtime.failure = Object.assign(new Error('cleanup failure'), { phase: 'cleanup' })
  assert.equal((await f.products.disable('agent')).error.phase, 'cleanup')
  await assert.rejects(f.products.open('agent'), { code: 'product-restart-required' })
  await assert.rejects(f.products.retry('agent'), { code: 'product-restart-required' })
}))

test('dependency recovery changes the installed application from blocked to running', () => fixture(async (path, start) => {
  const runtime = fakeRuntime(), f = await start(path, runtime)
  runtime.open = async () => { runtime.state = 'blocked' }
  assert.equal((await f.products.open('agent')).state, 'blocked')
  runtime.state = 'active'
  assert.equal(f.products.get('agent').state, 'running')
}))

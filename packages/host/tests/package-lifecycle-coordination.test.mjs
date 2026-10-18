import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createProductsComponent } from '../dist/applications/component.js'
import { createProductActivityComponent } from '../dist/applications/activity.js'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { createPackageActivationComponent } from '../dist/package-management/activation.js'
import { acquirePackageUsageLock } from '../dist/package-management/usage-locks.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const identity = { appId: 'target', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-role-coordination-')), root = new Context(), calls = [], locks = []
  const runtimes = Object.fromEntries(['target', 'other'].map(id => {
    let active = false
    return [id, { async open() { calls.push(`${id}:open`); await options.open?.(id); active = true }, async stop() { calls.push(`${id}:stop`); active = false }, async retry() { calls.push(`${id}:retry`); active = true }, inspect: () => active ? 'active' : 'disabled', closeAdmission() {}, async awaitIdle() {} }]
  }))
  await root.installComponent(createLocalSqliteComponent(join(directory, 'control.sqlite')))
  await root.installComponent(createLocalSqliteComponent(join(directory, 'registry.sqlite'), { serviceKey: 'host.package-registry-storage' }))
  await root.installComponent(createPackageRegistryComponent({ directory }))
  await root.installComponent(createProductActivityComponent())
  await root.installComponent(createProductsComponent({ directory: ['target', 'other'].map(id => ({ id, name: id, icon: id })), runtime: id => runtimes[id] }))
  const products = root.get('app.products'), activity = root.get('app.activity'), registry = root.get('host.package-registry')
  await products.restore()
  let operation = await registry.begin({ requestId: 'install', kind: 'install', identity, expectedAppRevision: 0 })
  operation = await registry.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'preparing' })
  operation = await registry.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'prepared' })
  operation = await registry.advance({ operationId: operation.id, expectedRevision: operation.revision, phase: 'committing' })
  await registry.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: 0, source: { kind: 'file', reference: 'fixture', publisher: 'fixture' } })
  await root.installComponent(createPackageActivationComponent({
    manager: { roles: ['client'], ownedUsageIds: async () => [], async freeze() { calls.push('manager:freeze') }, async release() { calls.push('manager:release') }, async closeTargets(ids) { calls.push('manager:closed-targets'); await options.closeTargets?.(ids) }, async handoff(launch) { for (const credential of launch.credentials) locks.push(acquirePackageUsageLock(directory, credential)); calls.push('manager:handoff') } },
    pages: { async freeze(id) { calls.push('pages:freeze'); await options.freeze?.(id) }, async dispose(id) { calls.push('pages:dispose'); await options.dispose?.(id) }, release() { calls.push('pages:release') }, async close() {} },
    plan: async (_view, intent) => [{ role: 'client', entries: intent.kind === 'remove' ? [] : [{ package: identity, entry: 'client', desiredEnabled: false }], capabilities: [] }],
    preparedTimeoutMs: options.preparedTimeoutMs,
  }))
  const activation = root.get('host.package-activation')
  t.after(async () => { try { await root.fiber.dispose() } finally { for (const lock of locks) await lock.release(); await rm(directory, { recursive: true, force: true }) } })
  return { products, activity, registry, activation, calls, intent: async () => ({ requestId: 'activate', expectedRegistryRevision: (await registry.inspect()).revision }) }
}

test('another application guard blocks activation without cancelling work or changing its saved runtime target', async t => {
  const f = await fixture(t)
  await f.products.open('other')
  let cancellations = 0
  const work = f.activity.enter('other', { blocking: true, cancel: () => { cancellations++ } })
  try { await assert.rejects(f.activation.prepare(await f.intent()), { code: 'product-busy' }) }
  finally { work.release() }
  assert.equal(cancellations, 0)
  assert.equal(f.products.get('other').desiredEnabled, true)
  assert.equal(f.products.get('other').state, 'running')
  assert.deepEqual(f.calls, ['other:open'])
  assert.deepEqual(await f.registry.listActivations(), [])
  assert.equal((await f.registry.inspect()).applications[0].selected, null)
  assert.equal((await f.products.disable('other')).state, 'disabled')
})

test('activation first drains accepted controls, then holds every role and page guard until explicit cancellation', async t => {
  const entered = deferred(), open = deferred(), page = deferred(), frozen = deferred()
  const f = await fixture(t, { open: async () => { entered.resolve(); await open.promise }, freeze: async () => { frozen.resolve(); await page.promise } })
  const opening = f.products.open('other'); await entered.promise
  const preparing = f.activation.prepare(await f.intent())
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.products.open('target'), { code: 'product-busy' })
  assert.equal(f.calls.includes('manager:freeze'), false)
  open.resolve(); await opening; await frozen.promise
  const visiblePrepared = (await f.registry.listActivations())[0]
  assert.equal(visiblePrepared.phase, 'prepared')
  assert.equal(f.activation.isPrepared(visiblePrepared.id), false)
  await assert.rejects(f.products.disable('other'), { code: 'product-busy' })
  page.resolve(); const prepared = await preparing
  assert.equal(prepared.phase, 'prepared')
  assert.equal(f.activation.isPrepared(prepared.id), true)
  await assert.rejects(f.activation.prepare({ requestId: 'activate', expectedRegistryRevision: prepared.registryRevision, appIds: ['other'] }), { code: 'request-conflict' })
  assert.equal(f.products.get('other').desiredEnabled, true)
  assert.throws(() => f.activity.enter('other'), { code: 'product-unavailable' })
  assert.equal((await f.activation.cancel(prepared.id)).phase, 'cancelled')
  assert.equal(f.activation.isPrepared(prepared.id), false)
  assert.equal((await f.products.disable('other')).state, 'disabled')
  assert.ok(f.calls.indexOf('manager:freeze') < f.calls.indexOf('pages:freeze'))
  assert.equal(f.calls.includes('manager:handoff'), false)
})

test('selection cannot change before actual page disposal and the private parent handoff never reports role readiness', async t => {
  const disposing = deferred(), disposed = deferred(), f = await fixture(t, { dispose: async () => { disposing.resolve(); await disposed.promise } })
  const prepared = await f.activation.prepare(await f.intent()), commit = f.activation.commit(prepared.id)
  await disposing.promise
  assert.equal((await f.registry.inspect()).applications[0].selected, null)
  assert.equal(f.calls.includes('manager:handoff'), false)
  await assert.rejects(f.products.retry('other'), { code: 'product-busy' })
  disposed.resolve(); const handed = await commit
  assert.equal(handed.phase, 'handoff')
  assert.equal(f.activation.isPrepared(handed.id), false)
  const facts = await f.registry.inspect()
  assert.deepEqual(facts.applications[0].selected, identity)
  assert.deepEqual(facts.applications[0].pending, identity)
  assert.deepEqual(facts.actual, [])
  assert.equal(f.calls.at(-1), 'manager:handoff')
  assert.ok(f.calls.every(call => !call.endsWith(':open') && !call.endsWith(':stop') && !call.endsWith(':retry')))
})

test('a page refusal cancels only the prepared activation and releases product admission with the package still pending', async t => {
  const f = await fixture(t, { freeze: async () => { throw Object.assign(new Error('page refuses close'), { code: 'activation-page-busy' }) } })
  await assert.rejects(f.activation.prepare(await f.intent()), { code: 'activation-page-busy' })
  assert.equal((await f.registry.listActivations())[0].phase, 'cancelled')
  assert.equal((await f.registry.inspect()).applications[0].selected, null)
  assert.deepEqual((await f.registry.inspect()).applications[0].pending, identity)
  assert.equal((await f.products.open('target')).state, 'running')
  assert.ok(f.calls.includes('pages:release'))
  assert.equal(f.calls.includes('manager:handoff'), false)
})

test('uninstall page refusal leaves targets intact, while commit saves closed targets only after disposal and before role handoff', async t => {
  const disposing = deferred(), disposed = deferred(), f = await fixture(t, { dispose: async () => { disposing.resolve(); await disposed.promise } })
  await f.products.open('target'); await f.products.open('other')
  const input = { ...(await f.intent()), kind: 'remove', appIds: ['target'] }
  const prepared = await f.activation.prepare(input)
  assert.equal(f.products.get('target').desiredEnabled, true)
  const committing = f.activation.commit(prepared.id); await disposing.promise
  assert.equal(f.products.get('target').desiredEnabled, true)
  assert.equal(f.calls.includes('manager:closed-targets'), false)
  disposed.resolve(); const handed = await committing
  assert.equal(handed.phase, 'handoff')
  assert.equal(f.products.get('target').desiredEnabled, false)
  assert.equal(f.products.get('other').desiredEnabled, true)
  assert.equal((await f.registry.inspect()).applications[0].selected, null)
  assert.equal((await f.registry.inspect()).applications[0].pending, null)
  assert.ok(f.calls.indexOf('pages:dispose') < f.calls.indexOf('manager:closed-targets'))
  assert.ok(f.calls.indexOf('manager:closed-targets') < f.calls.indexOf('manager:handoff'))
  assert.equal(f.calls.some(call => call.endsWith(':stop') || call.endsWith(':retry')), false)
})

test('uninstall protection blocks busy work and cancellation preserves the open target and installed code', async t => {
  const f = await fixture(t)
  await f.products.open('target')
  const lease = f.activity.enter('other')
  await assert.rejects(f.activation.prepare({ ...(await f.intent()), kind: 'remove', appIds: ['target'] }), { code: 'product-busy' })
  lease.release()
  const prepared = await f.activation.prepare({ ...(await f.intent()), kind: 'remove', appIds: ['target'] })
  await assert.rejects(f.activation.prepare({ ...(await f.intent()), kind: 'activate', appIds: ['target'] }), { code: 'request-conflict' })
  await f.activation.cancel(prepared.id)
  assert.equal(f.products.get('target').desiredEnabled, true)
  assert.equal((await f.registry.inspect()).applications[0].installed[0].state, 'installed')
  assert.equal(f.calls.includes('manager:closed-targets'), false)
})

test('a pre-handoff closed-target failure preserves a recoverable intent and explicit resume reacquires every guard', async t => {
  let failed = false
  const f = await fixture(t, { closeTargets: async () => { if (!failed) { failed = true; throw Object.assign(Error('target write rejected'), { code: 'product-storage-failed' }) } } })
  await f.products.open('target')
  const prepared = await f.activation.prepare({ ...(await f.intent()), kind: 'remove', appIds: ['target'] })
  await assert.rejects(f.activation.commit(prepared.id), { code: 'product-storage-failed' })
  assert.equal((await f.activation.get(prepared.id)).phase, 'recovery-required')
  assert.equal(f.products.get('target').desiredEnabled, true)
  assert.equal(f.activation.isPrepared(prepared.id), false)
  assert.equal(f.calls.includes('manager:handoff'), false)
  await f.activation.resume(prepared.id)
  assert.equal(f.activation.isPrepared(prepared.id), true)
  assert.equal((await f.activation.commit(prepared.id)).phase, 'handoff')
  assert.equal(f.products.get('target').desiredEnabled, false)
  assert.equal(f.calls.filter(call => call === 'pages:freeze').length, 2)
})

test('an abandoned resume expires only its temporary guards, preserves durable recovery, and can be explicitly resumed again', async t => {
  const f = await fixture(t, { preparedTimeoutMs: 50, dispose: async () => { throw Object.assign(Error('page disposal failed'), { code: 'activation-page-dispose-failed' }) } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const prepared = await f.activation.prepare(await f.intent())
  await assert.rejects(f.activation.commit(prepared.id), { code: 'activation-page-dispose-failed' })
  const recovery = await f.activation.get(prepared.id)
  assert.equal(recovery.phase, 'recovery-required')
  await f.activation.resume(prepared.id)
  assert.equal(f.activation.isPrepared(prepared.id), true)
  await assert.rejects(f.products.open('target'), { code: 'product-busy' })
  t.mock.timers.tick(50); await f.activation.awaitIdle()
  assert.equal(f.activation.isPrepared(prepared.id), false)
  assert.deepEqual(await f.activation.get(prepared.id), recovery)
  assert.equal((await f.products.open('target')).state, 'running')
  assert.equal(f.calls.includes('manager:handoff'), false)

  await f.activation.resume(prepared.id)
  t.mock.timers.tick(20)
  assert.deepEqual(await f.activation.cancel(prepared.id), recovery)
  await f.activation.resume(prepared.id)
  t.mock.timers.tick(30); await f.activation.awaitIdle()
  assert.equal(f.activation.isPrepared(prepared.id), true, 'a cancelled resume timer cannot release a later resume')
  t.mock.timers.tick(20); await f.activation.awaitIdle()
  assert.equal(f.activation.isPrepared(prepared.id), false)
  assert.deepEqual(await f.activation.get(prepared.id), recovery)
  assert.equal((await f.products.disable('target')).state, 'disabled')
})

test('committing a resumed activation clears its preparation timeout while real page disposal and handoff retain protection', async t => {
  const disposing = deferred(), disposed = deferred()
  let failed = false
  const f = await fixture(t, { preparedTimeoutMs: 50, dispose: async () => {
    if (!failed) { failed = true; throw Object.assign(Error('first disposal failed'), { code: 'activation-page-dispose-failed' }) }
    disposing.resolve(); await disposed.promise
  } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const prepared = await f.activation.prepare(await f.intent())
  await assert.rejects(f.activation.commit(prepared.id), { code: 'activation-page-dispose-failed' })
  await f.activation.resume(prepared.id)
  const releases = f.calls.filter(call => call === 'pages:release').length
  const committing = f.activation.commit(prepared.id); await disposing.promise
  t.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.products.open('target'), { code: 'product-busy' })
  assert.equal(f.calls.filter(call => call === 'pages:release').length, releases)
  disposed.resolve(); assert.equal((await committing).phase, 'handoff')
  t.mock.timers.tick(100); await f.activation.awaitIdle()
  assert.equal((await f.activation.get(prepared.id)).phase, 'handoff')
  assert.equal(f.calls.filter(call => call === 'pages:release').length, releases)
})

test('an expired callback already queued behind cancel and a same-id resume cannot release the new protection', async t => {
  const f = await fixture(t, { preparedTimeoutMs: 50, dispose: async () => { throw Object.assign(Error('disposal failed'), { code: 'activation-page-dispose-failed' }) } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const callbacks = [], schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ...args) => { callbacks.push(callback); return schedule(callback, ...args) })
  const prepared = await f.activation.prepare(await f.intent())
  await assert.rejects(f.activation.commit(prepared.id), { code: 'activation-page-dispose-failed' })
  const recovery = await f.activation.get(prepared.id)
  await f.activation.resume(prepared.id)
  const expired = callbacks.at(-1), releases = f.calls.filter(call => call === 'pages:release').length
  // All three calls enter the serial queue before cancellation can clear the
  // old timer. At callback invocation its original protection is still held.
  const cancelling = f.activation.cancel(prepared.id), resuming = f.activation.resume(prepared.id)
  expired()
  await cancelling; await resuming; await f.activation.awaitIdle()
  assert.equal(f.activation.isPrepared(prepared.id), true)
  assert.equal(f.calls.filter(call => call === 'pages:release').length, releases + 1)
  assert.deepEqual(await f.activation.get(prepared.id), recovery)
  await assert.rejects(f.products.open('target'), { code: 'product-busy' })
  t.mock.timers.tick(50); await f.activation.awaitIdle()
  assert.equal(f.activation.isPrepared(prepared.id), false, 'the new protection retains its own expiry')
})

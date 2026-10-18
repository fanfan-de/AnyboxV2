import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@nya/core'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { createApplicationCapabilityManager } from '../dist/applications/providers.js'
import { createApplicationCatalog, createApplicationRuntimes } from '../dist/applications/registration.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const provider = (id, version = '1.0.0', options = {}) => ({ id, version, services: [id], create: () => ({
  name: id, apply(ctx) { options.open?.(); ctx.provide(id, {}); if (options.close) ctx.effect(() => options.close, 'release fixture resource') },
}), ...options.descriptor })
const app = (id, requirements, setup = () => {}) => ({ definition: { id, name: id, icon: 'a' }, capabilityRequirements: requirements,
  createRuntime(root, context) { return createApplicationRuntime(root, installation => setup(installation, context)) },
})
const registry = (root, applications, providers = []) => createApplicationRuntimes(root, createApplicationCatalog(applications), providers)

test('capability declarations validate real version ranges without opening a provider', () => {
  assert.throws(() => createApplicationCatalog([app('example', { required: { sql: 'latest' } })]), /capability requirement/)
  const source = { sql: '^1.0.0 || ^2.0.0' }
  const catalog = createApplicationCatalog([app('example', { required: source })])
  source.sql = '*'
  assert.equal(catalog.applications[0].capabilityRequirements.required.sql, '^1.0.0 || ^2.0.0')
  assert.throws(() => createApplicationCapabilityManager(new Context(), [provider('sql', 'invalid')]), /invalid application capability provider/)
})

test('runtime lookup and capability inspection never initialize unconsumed providers or application business', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  let opened = 0, created = 0
  const application = app('example', { optional: { directory: '^1.0.0' } })
  const runtimes = registry(root, [{ ...application, createRuntime(...args) { created++; return application.createRuntime(...args) } }], [provider('directory', '1.0.0', { open: () => opened++ })])
  assert.equal(runtimes.get('example').inspect(), 'disabled')
  assert.equal(runtimes.capabilities('example')[0].status, 'ready')
  assert.equal(created, 0); assert.equal(opened, 0)
})

test('required missing, incompatible and unsupported capabilities block only their consumer before any factory', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  let created = 0, optionalOpened = 0
  const applications = [
    app('missing', { required: { absent: '^1' }, optional: { optional: '^1' } }),
    app('incompatible', { required: { sql: '^2' } }),
    app('unsupported', { required: { native: '^1' } }),
    app('independent', undefined),
  ].map(application => ({ ...application, createRuntime(...args) { created++; return application.createRuntime(...args) } }))
  const runtimes = registry(root, applications, [provider('sql'), provider('native', '1.0.0', { descriptor: { supported: false } }), provider('optional', '1.0.0', { open: () => optionalOpened++ })])
  for (const id of ['missing', 'incompatible', 'unsupported']) { await runtimes.get(id).open(); assert.equal(runtimes.get(id).inspect(), 'blocked'); assert.equal(runtimes.capabilities(id)[0].status, id) }
  assert.equal(created, 0); assert.equal(optionalOpened, 0)
  await runtimes.get('independent').open(); assert.equal(runtimes.get('independent').inspect(), 'active'); assert.equal(created, 1)
})

test('optional unavailable capabilities degrade with explicit safe diagnostics and an immutable execution context', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  let context
  const runtimes = registry(root, [app('example', { optional: { missing: '*', native: '^1', sql: '^2' } }, (_installation, value) => { context = value })], [provider('native', '1.0.0', { descriptor: { supported: false } }), provider('sql')])
  await runtimes.get('example').open()
  assert.deepEqual(context.capabilities, {})
  assert.equal(Object.isFrozen(context.capabilities), true)
  assert.equal(Object.isFrozen(context), true)
  assert.deepEqual(runtimes.capabilities('example').map(item => item.status), ['missing', 'unsupported', 'incompatible'])
  assert.equal(runtimes.get('example').inspect(), 'active')
})

test('highest compatible version is shared and stays pinned until its last consumer actually exits', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const opened = [], closed = []
  const providers = ['1.0.0', '1.5.0', '2.0.0'].map(version => provider('sql', version, { open: () => opened.push(version), close: () => closed.push(version) }))
  const runtimes = registry(root, [app('first', { required: { sql: '^1' } }), app('second', { required: { sql: '*' } }), app('third', { required: { sql: '^2' } })], providers)
  await Promise.all([runtimes.get('first').open(), runtimes.get('second').open()])
  assert.deepEqual(opened, ['1.5.0'])
  assert.equal(runtimes.capabilities('second')[0].version, '1.5.0')
  await runtimes.get('third').open(); assert.equal(runtimes.capabilities('third')[0].status, 'conflict')
  await runtimes.get('first').stop(); assert.deepEqual(closed, [])
  await runtimes.get('second').stop(); assert.deepEqual(closed, ['1.5.0'])
  await runtimes.get('third').retry(); assert.deepEqual(opened, ['1.5.0', '2.0.0'])
})

test('last release waits for real provider cleanup and serializes a replacement acquisition', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const exiting = deferred(), exit = deferred(); let starts = 0
  const manager = createApplicationCapabilityManager(root, [provider('directory', '1.0.0', {
    open: () => starts++, close: () => { exiting.resolve(); return exit.promise },
  })])
  const first = await manager.acquire({ required: { directory: '*' } })
  const releasing = first.release(); await exiting.promise
  let acquired = false
  const replacement = manager.acquire({ required: { directory: '*' } }).then(value => { acquired = true; return value })
  await Promise.resolve(); assert.equal(acquired, false); assert.equal(starts, 1)
  exit.resolve(); await releasing
  const second = await replacement; assert.equal(starts, 2); await second.release()
})

test('slow provider cleanup does not delay unrelated application opens or providers', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const exiting = deferred(), exit = deferred()
  const runtimes = registry(root, [app('slow', { required: { slow: '*' } }), app('empty'), app('other', { required: { other: '*' } })], [
    provider('slow', '1.0.0', { close: () => { exiting.resolve(); return exit.promise } }), provider('other'),
  ])
  await runtimes.get('slow').open()
  const closing = runtimes.get('slow').stop(); await exiting.promise
  await Promise.all([runtimes.get('empty').open(), runtimes.get('other').open()])
  assert.equal(runtimes.get('empty').inspect(), 'active'); assert.equal(runtimes.get('other').inspect(), 'active')
  exit.resolve(); await closing
})

test('conflicting service owners are rejected before initializing application business', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  let created = 0
  const first = provider('first', '1.0.0', { descriptor: { services: ['shared'], create: () => ({ apply(ctx) { ctx.provide('shared', {}) } }) } })
  const second = provider('second', '1.0.0', { descriptor: { services: ['shared'], create() { throw new Error('must not initialize') } } })
  const runtimes = registry(root, [app('example', { required: { first: '*', second: '*' } }, () => created++)], [first, second])
  await runtimes.get('example').open()
  assert.equal(created, 0); assert.equal(root.get('shared'), undefined)
  assert.deepEqual(runtimes.capabilities('example').map(item => item.status), ['ready', 'conflict'])
})

test('host resident providers are reused and retained when every application closes', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  await root.installComponent({ apply(ctx) { ctx.provide('sql', { resident: true }) } })
  const runtimes = registry(root, [app('example', { required: { sql: '^1' } })], [provider('sql', '1.0.0', { descriptor: { resident: true, create() { throw new Error('resident provider must not be created') } } })])
  await runtimes.get('example').open(); await runtimes.get('example').stop()
  assert.deepEqual(root.get('sql'), { resident: true })
})

test('provider startup failures block required consumers and degrade optional ones after actual rollback', async t => {
  const root = new Context(); t.after(() => assert.rejects(root.fiber.dispose()))
  let contexts = [], rolledBack = 0
  const bad = provider('bad', '1.0.0', { descriptor: { create: () => ({ apply(ctx) {
    ctx.effect(() => () => { rolledBack++ }, 'rollback startup'); throw new Error('private startup detail')
  } }) } })
  const runtimes = registry(root, [app('required', { required: { bad: '*' } }, () => assert.fail('required capability gate must precede business')), app('optional', { optional: { bad: '*' } }, (_installation, context) => contexts.push(context))], [bad])
  await runtimes.get('required').open(); assert.equal(runtimes.get('required').inspect(), 'blocked'); assert.equal(rolledBack, 1)
  await runtimes.get('optional').open(); assert.equal(runtimes.get('optional').inspect(), 'active'); assert.deepEqual(contexts[0].capabilities, {})
  assert.equal(rolledBack, 1)
  assert.equal(runtimes.capabilities('optional')[0].status, 'failed')
  assert.equal(JSON.stringify(runtimes.capabilities('optional')).includes('private'), false)
})

test('provider dependency ordering belongs to Nya and does not depend on capability declaration order', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const first = provider('first', '1.0.0', { descriptor: { create: () => ({ inject: ['second'], apply(ctx, _config, deps) { ctx.provide('first', deps.second) } }) } })
  const manager = createApplicationCapabilityManager(root, [first, provider('second')])
  const lease = await manager.acquire({ required: { first: '*', second: '*' } })
  assert.deepEqual(lease.statuses.map(item => item.status), ['ready', 'ready'])
  await lease.release()
})

test('application cleanup completes before provider release and retry gets a fresh factory generation', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const events = []; let generations = 0
  const application = app('example', { required: { sql: '*' } }, (installation, context) => {
    generations++; assert.deepEqual(context.capabilities, { sql: '1.0.0' })
    installation.effect(() => () => { events.push('business closed') }, 'business resource')
  })
  const runtimes = registry(root, [application], [provider('sql', '1.0.0', { close: () => events.push('provider closed') })])
  await runtimes.get('example').open(); await runtimes.get('example').retry()
  assert.deepEqual(events, ['business closed', 'provider closed']); assert.equal(generations, 2)
})

test('failed application cleanup retains capability ownership and forbids another application generation', async t => {
  const root = new Context(); let providerClosed = 0, created = 0
  t.after(() => assert.rejects(root.fiber.dispose()))
  const application = app('example', { required: { sql: '*' } }, installation => {
    created++; installation.effect(() => () => { throw new Error('private cleanup detail') }, 'failed cleanup')
  })
  const runtimes = registry(root, [application], [provider('sql', '1.0.0', { close: () => providerClosed++ })])
  const runtime = runtimes.get('example'); await runtime.open()
  await assert.rejects(runtime.stop(), error => error.phase === 'cleanup')
  assert.equal(providerClosed, 0); assert.equal(runtime.inspect(), 'failed')
  await assert.rejects(runtime.retry(), error => error.phase === 'cleanup')
  assert.equal(created, 1)
})

test('failed provider cleanup fences its version and service ownership until host restart', async () => {
  const root = new Context(); let created = 0
  const manager = createApplicationCapabilityManager(root, [provider('sql', '1.0.0', { open: () => created++, close: () => { throw new Error('private resource detail') } }), provider('sql', '2.0.0')])
  const first = await manager.acquire({ required: { sql: '^1' } })
  await assert.rejects(first.release(), error => error.phase === 'cleanup')
  assert.equal(manager.inspect({ required: { sql: '^1' } })[0].status, 'failed')
  assert.equal(manager.inspect({ required: { sql: '^2' } })[0].status, 'conflict')
  const fenced = await manager.acquire({ required: { sql: '^1' } })
  assert.deepEqual(fenced.capabilities, {}); assert.equal(created, 1)
  await assert.rejects(root.fiber.dispose())
})

test('a committed provider failing during restart retains its ownership after a seemingly clean permanent dispose', async () => {
  const root = new Context(); let fiber, starts = 0
  const manager = createApplicationCapabilityManager(root, [provider('native', '1.0.0', { descriptor: { create: () => ({ apply(ctx) {
    fiber = ctx.fiber; starts++; ctx.provide('native', {})
    ctx.effect(() => () => { throw new Error('committed provider cleanup failed') }, 'failed restart cleanup')
  } }) } }), provider('native', '2.0.0')])
  const lease = await manager.acquire({ required: { native: '^1' } })
  await assert.rejects(fiber.restart(), /committed provider cleanup failed/)
  await assert.rejects(lease.release(), error => error.phase === 'cleanup')
  assert.equal(manager.inspect({ required: { native: '^1' } })[0].status, 'failed')
  assert.equal(manager.inspect({ required: { native: '^2' } })[0].status, 'conflict')
  assert.deepEqual((await manager.acquire({ required: { native: '^1' } })).capabilities, {})
  assert.equal(starts, 1)
  await assert.rejects(root.fiber.dispose())
})

test('whole root shutdown reports a committed provider failure even before its lease is released', async t => {
  for (const closeAdmission of [false, true]) await t.test(`close admission first: ${closeAdmission}`, async () => {
    const root = new Context(); let fiber
    const manager = createApplicationCapabilityManager(root, [provider('native', '1.0.0', { descriptor: { create: () => ({ apply(ctx) {
      fiber = ctx.fiber; ctx.provide('native', {})
      ctx.effect(() => () => { throw new Error('unconfirmed committed exit') }, 'failed committed cleanup')
    } }) } })])
    await manager.acquire({ required: { native: '^1' } })
    await assert.rejects(fiber.restart(), /unconfirmed committed exit/)
    if (closeAdmission) manager.closeAdmission()
    await assert.rejects(root.fiber.dispose())
  })
})

test('provider cleanup failure after an unloading shutdown snapshot survives permanent fiber disposal', async () => {
  const root = new Context(), unloading = deferred(), exit = deferred(); let fiber
  const manager = createApplicationCapabilityManager(root, [provider('native', '1.0.0', { descriptor: { create: () => ({ apply(ctx) {
    fiber = ctx.fiber; ctx.provide('native', {})
    ctx.effect(() => async () => { unloading.resolve(); await exit.promise; throw new Error('late provider cleanup failure') }, 'late failed cleanup')
  } }) } })])
  const lease = await manager.acquire({ required: { native: '*' } })
  const restarting = fiber.restart(), rejected = assert.rejects(restarting, /late provider cleanup failure/)
  await unloading.promise; manager.closeAdmission()
  exit.resolve(); await rejected
  // The framework can finish permanent disposal after the failure event has been published.
  // Its resulting DISPOSED snapshot no longer conveys that the earlier exit was unconfirmed.
  await fiber.dispose()
  await assert.rejects(lease.release(), error => error.phase === 'cleanup')
  await assert.rejects(root.fiber.dispose())
})

test('a custom runtime failed stop is retained and reported by whole host shutdown', async () => {
  const root = new Context(); let creates = 0
  const runtimes = registry(root, [{ definition: { id: 'custom', name: 'custom', icon: 'a' }, createRuntime() {
    creates++
    return { async open() {}, async stop() { throw new Error('custom resource exit failed') }, async retry() {},
      inspect: () => 'active', closeAdmission() {}, async awaitIdle() {} }
  } }])
  const runtime = runtimes.get('custom'); await runtime.open()
  await assert.rejects(runtime.stop(), error => error.phase === 'cleanup')
  await assert.rejects(runtime.retry(), error => error.phase === 'cleanup')
  assert.equal(creates, 1)
  runtimes.closeAdmission(); await runtimes.awaitIdle()
  await assert.rejects(root.fiber.dispose())
})

test('failed initialization rollback never grants replacement ownership even when Nya later disposes the fiber', async () => {
  const root = new Context(); let starts = 0
  const manager = createApplicationCapabilityManager(root, [provider('native', '1.0.0', { descriptor: { create: () => ({ apply(ctx) {
    starts++; ctx.effect(() => () => { throw new Error('rollback failed') }, 'uncertain initialization resource')
    throw new Error('initialization failed')
  } }) } }), provider('native', '2.0.0')])
  const lease = await manager.acquire({ required: { native: '^1' } })
  assert.equal(lease.statuses[0].status, 'failed'); assert.deepEqual(lease.capabilities, {})
  const again = await manager.acquire({ required: { native: '^1' } })
  assert.equal(again.statuses[0].status, 'failed'); assert.equal(starts, 1)
  assert.equal(manager.inspect({ required: { native: '^2' } })[0].status, 'conflict')
  await assert.rejects(root.fiber.dispose())
})

test('host admission closure during provider initialization prevents every late application factory', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const entered = deferred(), ready = deferred(); let created = 0, closed = 0
  const slow = provider('slow', '1.0.0', { descriptor: { create: () => ({ async apply(ctx) {
    entered.resolve(); await ready.promise; ctx.provide('slow', {}); ctx.effect(() => () => { closed++ }, 'slow provider cleanup')
  } }) } })
  const runtimes = registry(root, [app('example', { required: { slow: '*' } }, () => created++)], [slow])
  const opening = runtimes.get('example').open(); const rejected = assert.rejects(opening, /closing/)
  await entered.promise; runtimes.closeAdmission(); ready.resolve()
  await rejected; await runtimes.awaitIdle()
  assert.equal(created, 0); assert.equal(closed, 1)
  assert.throws(() => runtimes.get('example'), /closing/)
})

test('closing admission aborts provider initialization and joins actual exit before root disposal', async t => {
  const root = new Context(); t.after(() => root.fiber.dispose())
  const entered = deferred(), aborted = deferred(), actualExit = deferred()
  let created = 0, cleaned = 0
  const slow = provider('slow', '1.0.0', { descriptor: { create: ({ signal }) => ({ async apply(ctx) {
    ctx.effect(() => () => { cleaned++ }, 'initialization resource')
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    entered.resolve(); await aborted.promise; await actualExit.promise
  } }) } })
  const runtimes = registry(root, [app('example', { required: { slow: '*' } }, () => created++)], [slow])
  const opening = runtimes.get('example').open(); const rejected = assert.rejects(opening, /closing/)
  await entered.promise; runtimes.closeAdmission(); await aborted.promise
  let idle = false
  const idleTask = runtimes.awaitIdle().then(() => { idle = true })
  await Promise.resolve(); assert.equal(idle, false); assert.equal(cleaned, 0); assert.equal(created, 0)
  actualExit.resolve(); await rejected; await idleTask
  assert.equal(cleaned, 1); assert.equal(created, 0)
})

test('admission closure leaves committed providers running until root disposal cancels their lifecycle', async () => {
  const root = new Context(); let signal, cleaned = 0
  const committed = provider('committed', '1.0.0', { descriptor: { create: context => ({ apply(ctx) {
    signal = context.signal; ctx.provide('committed', {})
    ctx.effect(() => () => { assert.equal(signal.aborted, true); cleaned++ }, 'committed provider resource')
  } }) } })
  const runtimes = registry(root, [app('example', { required: { committed: '*' } })], [committed])
  await runtimes.get('example').open(); runtimes.closeAdmission(); await runtimes.awaitIdle()
  assert.equal(signal.aborted, false); assert.equal(cleaned, 0)
  await root.fiber.dispose(); assert.equal(cleaned, 1)
})

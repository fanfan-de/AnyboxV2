import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createApplicationRuntime } from '../dist/nya.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const messages = error => [error.message, ...Array.from(error.errors ?? []).flatMap(messages)]
function rootFor(t) {
  const root = new Context()
  t.after(() => root.fiber.dispose().catch(() => {}))
  return root
}

test('closing admission cancels initialization and joins its accepted cleanup before becoming idle', async t => {
  const root = rootFor(t), entered = deferred(), cancelled = deferred(), exit = deferred()
  let disposed = false, admissionClosures = 0
  const runtime = createApplicationRuntime(root, async installation => {
    installation.effect(() => async () => { await exit.promise; disposed = true }, 'join initialization resource')
    installation.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
    entered.resolve()
    await cancelled.promise
    assert.equal(installation.isClosing(), true)
  }, () => { admissionClosures++ })
  const opening = runtime.open()
  const rejected = assert.rejects(opening, { code: 'product-unavailable' })
  await entered.promise
  runtime.closeAdmission(); runtime.closeAdmission()
  assert.equal(admissionClosures, 1)
  await cancelled.promise
  let idle = false
  const waiting = runtime.awaitIdle().then(() => { idle = true })
  await tick(); assert.equal(idle, false); assert.equal(disposed, false)
  await assert.rejects(runtime.open(), { code: 'product-unavailable' })
  exit.resolve(); await rejected; await waiting
  assert.equal(disposed, true)
})

test('a shutdown race still records a just-created Fiber before rejecting further initialization', async t => {
  const root = rootFor(t)
  let transferred
  const unsubscribe = root.registry.subscribe(event => {
    if (event.type === 'installed' && event.fiber.name === 'transferred-resource') runtime.closeAdmission()
  })
  t.after(unsubscribe)
  const runtime = createApplicationRuntime(root, installation => {
    transferred = root.installComponent({ name: 'transferred-resource', apply(ctx) {
      ctx.provide('transferred-resource', {})
    } })
    installation.track(transferred)
  })
  await assert.rejects(runtime.open(), { code: 'product-unavailable' })
  assert.equal(transferred.state, 'DISPOSED'); assert.equal(root.get('transferred-resource'), undefined)
})

test('queued open and close wait for actual cleanup and leave another application on the same root running', async t => {
  const root = rootFor(t), ready = deferred(), openExit = deferred(), cleaning = deferred(), cleanupExit = deferred()
  let generations = 0
  const other = createApplicationRuntime(root, installation => installation.install({ name: 'other', apply(ctx) { ctx.provide('other', {}) } }))
  await other.open(); const retained = root.get('other')
  const runtime = createApplicationRuntime(root, async installation => {
    generations++
    installation.install({ name: 'owned', apply(ctx) {
      ctx.provide('owned', { root: ctx.root })
      ctx.effect(() => async () => { cleaning.resolve(); await cleanupExit.promise }, 'join owned resource')
    } })
    ready.resolve(); await openExit.promise
  })
  const opening = runtime.open(); await ready.promise
  const stopping = runtime.stop(); let stopped = false; void stopping.then(() => { stopped = true })
  openExit.resolve(); await opening; await cleaning.promise; await tick()
  assert.equal(stopped, false); assert.equal(root.get('other'), retained)
  cleanupExit.resolve(); await stopping
  assert.equal(runtime.inspect(), 'disabled'); assert.equal(root.get('owned'), undefined)
  await runtime.open()
  assert.equal(generations, 2); assert.equal(root.get('owned').root, root); assert.equal(root.get('other'), retained)
  await runtime.stop(); await other.stop()
})

test('released installation callbacks cannot add components or effects to a later application generation', async t => {
  const root = rootFor(t), scopes = []
  const runtime = createApplicationRuntime(root, installation => {
    scopes.push(installation)
    installation.install({ name: 'generation', apply(ctx) { ctx.provide('generation', {}) } })
  })
  await runtime.open(); await runtime.stop(); await runtime.open()
  const current = root.get('generation'); let acquired = false
  assert.equal(scopes[0].isClosing(), true); assert.equal(scopes[1].isClosing(), false)
  assert.throws(() => scopes[0].install({ name: 'stale', apply(ctx) { ctx.provide('stale', {}) } }), { code: 'product-unavailable' })
  assert.throws(() => scopes[0].effect(() => { acquired = true; return () => {} }, 'stale effect'), { code: 'product-unavailable' })
  assert.equal(root.get('stale'), undefined); assert.equal(acquired, false); assert.equal(root.get('generation'), current)
  await runtime.stop()
})

test('readiness reports blocked dependencies and Nya activates the same root component when they arrive', async t => {
  const root = rootFor(t)
  const runtime = createApplicationRuntime(root, installation => installation.install({ name: 'consumer', inject: ['optional-provider'], apply(ctx, _, deps) {
    ctx.provide('consumer', { root: ctx.root, provider: deps['optional-provider'] })
  } }))
  await runtime.open(); assert.equal(runtime.inspect(), 'blocked'); assert.equal(root.get('consumer'), undefined)
  const provider = root.installComponent({ name: 'provider', apply(ctx) { ctx.provide('optional-provider', {}) } }); await provider
  await tick(); assert.equal(runtime.inspect(), 'active'); assert.equal(root.get('consumer').root, root)
  assert.equal(root.get('consumer').provider, root.get('optional-provider'))
  await runtime.stop(); assert.ok(root.get('optional-provider'))
})

test('cleanup failure remains failed, prevents reopening and is also reported by root shutdown', async t => {
  const root = rootFor(t); let generations = 0, otherCleaned = false
  const other = createApplicationRuntime(root, installation => installation.install({ name: 'other-resource', apply(ctx) {
    ctx.effect(() => () => { otherCleaned = true }, 'close other resource')
  } }))
  const runtime = createApplicationRuntime(root, installation => {
    generations++
    installation.effect(() => () => { throw new Error('resource exit unconfirmed') }, 'failed resource cleanup')
  })
  await runtime.open(); await other.open()
  await assert.rejects(runtime.stop(), error => error.phase === 'cleanup' && messages(error).includes('resource exit unconfirmed'))
  assert.equal(runtime.inspect(), 'failed'); assert.equal(otherCleaned, false)
  await assert.rejects(runtime.open(), { phase: 'cleanup' }); await assert.rejects(runtime.retry(), { phase: 'cleanup' })
  assert.equal(generations, 1)
  await assert.rejects(root.fiber.dispose(), error => messages(error).includes('resource exit unconfirmed'))
  assert.equal(otherCleaned, true)
})

test('a failed component initialization retains unconfirmed rollback through retry and root shutdown', async t => {
  const root = rootFor(t); let generations = 0, rollbacks = 0
  const runtime = createApplicationRuntime(root, installation => {
    generations++
    installation.install({ name: 'failed-initialization', apply(ctx) {
      ctx.effect(() => () => { rollbacks++; throw new Error('rollback exit unconfirmed') }, 'rollback initialized resource')
      throw new Error('initialization failed')
    } })
  })
  await assert.rejects(runtime.open(), error => error.phase === 'cleanup' && messages(error).includes('rollback exit unconfirmed'))
  assert.equal(rollbacks, 1); assert.equal(runtime.inspect(), 'failed')
  await assert.rejects(runtime.retry(), { phase: 'cleanup' }); assert.equal(generations, 1)
  await assert.rejects(root.fiber.dispose(), error => messages(error).includes('rollback exit unconfirmed'))
})

test('a setup failure with confirmed component cleanup remains explicitly retryable', async t => {
  const root = rootFor(t); let broken = true, cleaned = 0
  const runtime = createApplicationRuntime(root, async installation => {
    const fiber = installation.install({ name: 'initialized-resource', apply(ctx) {
      ctx.effect(() => () => { cleaned++ }, 'release initialized resource')
      ctx.provide('initialized-resource', {})
    } })
    await fiber
    if (broken) throw new Error('setup failed after initialization')
  })
  await assert.rejects(runtime.open(), { message: 'setup failed after initialization' })
  assert.equal(cleaned, 1); assert.equal(root.get('initialized-resource'), undefined)
  broken = false; await runtime.retry(); assert.equal(runtime.inspect(), 'active'); assert.ok(root.get('initialized-resource'))
  await runtime.stop(); assert.equal(cleaned, 2)
})

test('confirmed shutdown releases generation reports instead of retaining every old runtime on the root', async t => {
  const root = rootFor(t), baseline = root.fiber.inspect().effects
  for (let generation = 0; generation < 4; generation++) {
    const runtime = createApplicationRuntime(root, installation => installation.install({ name: 'temporary-resource', apply(ctx) {
      ctx.provide('temporary-resource', {})
    } }))
    await runtime.open(); assert.ok(root.get('temporary-resource'))
    await runtime.stop(); assert.equal(root.get('temporary-resource'), undefined)
    assert.deepEqual(root.fiber.inspect().effects, baseline)
  }
})

test('a component failing after admission closes remains unconfirmed through whole root shutdown', async t => {
  const root = rootFor(t); let fiber
  const runtime = createApplicationRuntime(root, installation => {
    fiber = installation.install({ name: 'late-failed-cleanup', apply(ctx) {
      ctx.provide('late-failed-cleanup', {})
      ctx.effect(() => () => { throw new Error('exit failed after admission closed') }, 'late failing resource')
    } })
  })
  await runtime.open(); runtime.closeAdmission()
  await assert.rejects(fiber.restart(), /exit failed after admission closed/)
  await runtime.awaitIdle()
  await assert.rejects(root.fiber.dispose(), error => messages(error).includes('exit failed after admission closed'))
})

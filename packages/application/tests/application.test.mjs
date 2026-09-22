import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FiberState } from '@nya/core'
import { ConfigConflictError, Include } from '@nya/include'
import { interval, timeout } from '@nya/timer'
import { ApplicationClosedError, ApplicationNotReadyError } from '../dist/index.js'
import { deferred, fixture, waitFor } from './helpers.mjs'

function installedFibers(context) {
  const fibers = []
  const unsubscribe = context.registry.subscribe(event => fibers.push(event.fiber), { replay: true })
  unsubscribe()
  return fibers
}

test('application loads one component tree and owns component resources', { timeout: 5_000 }, async t => {
  const output = []
  const target = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => output.push(args)]))
  const f = await fixture(t, { logger: { target } })
  const app = f.create()
  const signalsBefore = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name))
  const startup = app.start()
  assert.strictEqual(app.start(), startup)
  await waitFor(startup, t.signal)
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), signalsBefore)
  assert.equal(app.context.get('testConsumer').value, 'one')
  assert.ok(app.context.get('loader'))
  assert.ok(app.context.get('include'))
  assert.equal(app.context.get('timer'), undefined)
  assert.equal(app.context.get('hmr'), undefined)
  assert.ok(output.some(args => args.some(value => typeof value === 'string' && value.includes('application started'))))
  const ticked = deferred()
  const worker = app.context.installComponent({
    apply(ctx) {
      timeout(ctx, ticked.resolve, 0)
      interval(ctx, () => {}, 60_000)
    },
  })
  await worker
  await waitFor(ticked.promise, t.signal)
  const closing = app.close()
  assert.strictEqual(app.close(), closing)
  await assert.rejects(app.previewConfig(f.config), ApplicationClosedError)
  await closing
  assert.equal(worker.state, FiberState.DISPOSED)
  assert.deepEqual(installedFibers(app.context), [])
  assert.deepEqual(app.context.fiber.inspect().effects, [])
  assert.equal(app.context.get('timer'), undefined)
  assert.strictEqual(app.close(), closing)
})

test('preview and save update component dependencies and recover pending consumers', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const app = f.create()
  await app.start()
  const previousConsumer = app.context.get('testConsumer')
  const previousValue = app.context.get('testValue')
  const next = structuredClone(f.config)
  next.entries[0].config.value = 'two'
  const preview = await app.previewConfig(next)
  assert.ok(preview.some(operation => operation.type === 'update'))
  assert.deepEqual(await f.readConfig(), f.config)
  assert.strictEqual(app.context.get('testConsumer'), previousConsumer)
  const saved = await app.saveConfig(next)
  assert.equal(saved.saved, true)
  assert.equal(saved.status, 'applied')
  assert.deepEqual(await f.readConfig(), next)
  assert.notStrictEqual(app.context.get('testValue'), previousValue)
  assert.notStrictEqual(app.context.get('testConsumer'), previousConsumer)
  assert.equal(app.context.get('testConsumer').value, 'two')

  next.entries[0].disabled = true
  await app.saveConfig(next)
  const consumerId = app.context.get('include').entryId('consumer')
  assert.equal(app.context.get('loader').get(consumerId).state, 'pending')
  assert.equal(app.context.get('testConsumer'), undefined)
  next.entries[0].disabled = false
  await app.saveConfig(next)
  assert.equal(app.context.get('testConsumer').value, 'two')
})

test('configuration errors and external edits preserve the accepted runtime', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const app = f.create()
  await app.start()
  const consumer = app.context.get('testConsumer')
  await assert.rejects(app.saveConfig({ version: 1, entries: [] }))
  await writeFile(f.configPath, '{ broken json')
  await assert.rejects(app.refreshConfig())
  await assert.rejects(app.saveConfig(f.config), ConfigConflictError)
  assert.strictEqual(app.context.get('testConsumer'), consumer)
  assert.equal(app.context.get('testConsumer').value, 'one')
  await f.writeConfig(f.config)
  assert.equal((await app.refreshConfig()).status, 'applied')
  assert.strictEqual(app.context.get('testConsumer'), consumer)
})

test('configuration controls acquire the current Include service after restart', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const app = f.create()
  await app.start()
  const previous = app.context.get('include')
  const runtime = app.context.registry.get(Include)
  assert.equal(runtime?.fibers.length, 1)

  await runtime.fibers[0].restart()
  assert.notStrictEqual(app.context.get('include'), previous)
  assert.equal(app.context.get('testConsumer'), undefined)

  const report = await app.refreshConfig()
  assert.equal(report.status, 'applied')
  assert.equal(app.context.get('testConsumer').value, 'one')
})

test('components in a child Include file can be controlled without rewriting the root source', { timeout: 5_000 }, async t => {
  const f = await fixture(t, {}, {
    version: 2, entries: [{ id: 'jobs', type: 'include', path: './jobs.json' }],
  })
  const childPath = join(f.directory, 'jobs.json')
  const child = { version: 2, entries: [
    { id: 'value', name: './value.mjs', config: { value: 'child' } },
    { id: 'consumer', name: './consumer.mjs' },
  ] }
  await writeFile(childPath, JSON.stringify(child))
  const app = f.create()
  await app.start()
  assert.equal(app.context.get('testConsumer').value, 'child')
  child.entries[0].config.value = 'edited'
  assert.equal((await app.saveConfig(child, childPath)).saved, true)
  assert.deepEqual(await f.readConfig(), f.config)
  assert.equal(app.context.get('testConsumer').value, 'edited')
})

test('an empty configuration starts without requiring a business component', { timeout: 5_000 }, async t => {
  const f = await fixture(t, {}, { version: 2, entries: [] })
  const app = f.create()
  await assert.rejects(app.previewConfig(f.config), ApplicationNotReadyError)
  await app.start()
  assert.equal(app.context.get('include').report().status, 'applied')
  assert.deepEqual(await app.previewConfig(f.config), [])
  await app.close()
})

test('pending components do not block startup and activate when dependencies arrive', { timeout: 5_000 }, async t => {
  const f = await fixture(t, {}, { version: 2, entries: [{ id: 'consumer', name: './consumer.mjs' }] })
  const app = f.create()
  await app.start()
  const consumerId = app.context.get('include').entryId('consumer')
  assert.equal(app.context.get('loader').get(consumerId).state, 'pending')
  assert.equal(app.context.get('testConsumer'), undefined)
  const next = structuredClone(f.config)
  next.entries.push({ id: 'value', name: './value.mjs', config: { value: 'available' } })
  await app.saveConfig(next)
  assert.equal(app.context.get('loader').get(consumerId).state, 'active')
  assert.equal(app.context.get('testConsumer').value, 'available')
})

test('a partial startup failure closes the application and cleans its components', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'failure.mjs'), `export default () => { throw new Error('startup component failed') }`)
  f.config.entries.push({ id: 'failure', name: './failure.mjs' })
  await f.writeConfig(f.config)
  const app = f.create()
  await assert.rejects(app.start(), /startup component failed/)
  assert.equal((await app.failure).message, 'startup component failed')
  assert.deepEqual(installedFibers(app.context), [])
  await assert.rejects(app.previewConfig(f.config), ApplicationClosedError)
})

test('disabling a component waits for its cleanup; close rejects queued controls', { timeout: 5_000 }, async t => {
  const cleanupStarted = deferred()
  const release = deferred()
  const f = await fixture(t, {}, { version: 2, entries: [{ id: 'resource', name: './resource.mjs' }] })
  await writeFile(join(f.directory, 'resource.mjs'), `export default {
    inject: ['testLifecycle'],
    apply(ctx, _config, deps) {
      const lifecycle = deps.testLifecycle
      ctx.effect(() => async () => {
        lifecycle.cleanupStarted.resolve()
        await lifecycle.release.promise
      })
    },
  }`)
  const app = f.create()
  app.context.provide('testLifecycle', { cleanupStarted, release })
  await app.start()
  const next = structuredClone(f.config)
  next.entries[0].disabled = true
  let saved = false
  const saving = app.saveConfig(next)
  void saving.then(() => { saved = true }, () => {})
  const queued = app.previewConfig(f.config)
  const settledControls = Promise.allSettled([saving, queued])
  let closing
  try {
    await waitFor(cleanupStarted.promise, t.signal)
    assert.equal(saved, false, 'save must wait for component cleanup to finish')
    closing = app.close()
    let closed = false
    void closing.then(() => { closed = true })
    await assert.rejects(app.refreshConfig(), ApplicationClosedError)
    assert.equal(closed, false)
    release.resolve()
    const results = await waitFor(settledControls, t.signal)
    assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof ApplicationClosedError))
    await waitFor(closing, t.signal)
    assert.equal(closed, true)
  } finally {
    release.resolve()
    await Promise.allSettled([settledControls, closing ?? app.close()])
  }
})

test('closing before start prevents initialization', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const app = f.create()
  const startup = app.start()
  const rejected = assert.rejects(startup, ApplicationClosedError)
  const closing = app.close()
  await closing
  await rejected
  await assert.rejects(app.start(), ApplicationClosedError)
  assert.deepEqual(installedFibers(app.context), [])
})

test('close during component initialization waits for that lifecycle and installs no later resources', { timeout: 5_000 }, async t => {
  const started = deferred()
  const release = deferred()
  let cleaned = false
  const f = await fixture(t, {}, { version: 2, entries: [
    { id: 'blocker', name: './blocker.mjs' },
  ] })
  await writeFile(join(f.directory, 'blocker.mjs'), `export default {
    inject: ['testLifecycle'],
    async apply(ctx, _config, deps) {
      const lifecycle = deps.testLifecycle
      ctx.effect(() => () => lifecycle.clean())
      lifecycle.started.resolve()
      await lifecycle.release.promise
    },
  }`)
  const app = f.create()
  app.context.provide('testLifecycle', { started, release, clean: () => { cleaned = true } })
  const startup = app.start()
  const rejected = assert.rejects(startup, ApplicationClosedError)
  let closing
  try {
    await waitFor(started.promise, t.signal)
    closing = app.close()
    assert.equal(cleaned, false)
    release.resolve()
    await waitFor(Promise.all([rejected, closing]), t.signal)
    assert.equal(cleaned, true)
    assert.deepEqual(installedFibers(app.context), [])
  } finally {
    release.resolve()
    await Promise.allSettled([startup, closing ?? app.close()])
  }
})

test('cleanup reports retain the original failure and the same close promise', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const errorPath = join(f.directory, 'cleanup.mjs')
  await writeFile(errorPath, `export const failure = new Error('cleanup failed'); export default () => () => { throw failure }`)
  f.config.entries.push({ id: 'cleanup', name: './cleanup.mjs' })
  await f.writeConfig(f.config)
  const { failure } = await import(pathToFileURL(errorPath).href)
  const app = f.create()
  await app.start()
  const closing = app.close()
  // Include 与 Loader 清理可能同时报告同一失败；保留 Core 的聚合结构。
  const containsFailure = error => error === failure || error instanceof AggregateError && error.errors.some(containsFailure)
  await assert.rejects(closing, containsFailure)
  assert.strictEqual(app.close(), closing)
  assert.ok(containsFailure(await app.failure))
})

test('a saved startup failure is reported as partial and can be explicitly recovered', { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'recoverable.mjs'), `let fail = true; export default () => { if (fail) { fail = false; throw new Error('first attempt') } }`)
  const app = f.create()
  await app.start()
  const next = structuredClone(f.config)
  next.entries.push({ id: 'recoverable', name: './recoverable.mjs' })
  const saved = await app.saveConfig(next)
  assert.equal(saved.saved, true)
  assert.equal(saved.status, 'partial')
  assert.deepEqual(await f.readConfig(), next)
  assert.equal((await app.failure).message, 'first attempt')
  const recovered = await app.recover(app.context.get('include').entryId('recoverable'))
  assert.equal(recovered.status, 'applied')
  assert.equal(app.context.get('testConsumer').value, 'one')
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createComputersComponent } from '../dist/applications/harness/core/computer/component.js'
import { createLocalComputerProvider } from './helpers/fixed-computer-provider.mjs'
import { computerServiceKey, computerInstanceProviderServiceKey } from '../dist/applications/harness/core/computer/port.js'

const inputs = { now: () => new Date().toISOString(), newId: randomUUID }
const spec = { providerId: 'local', platform: process.platform, architecture: process.arch }
const tick = () => new Promise(yes => setImmediate(yes))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function joined(call) { try { return await call.result } finally { await call.done } }
function controlledProvider() {
  const calls = []
  return { calls, providerId: 'local', activate(input) {
    const result = deferred(), done = deferred(), cancelled = []
    calls.push({ input, result, done, cancelled })
    return { result: result.promise, done: done.promise, cancel(reason) { cancelled.push(reason) } }
  } }
}
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-computers-'))
  const roots = new Set()
  t.after(async () => {
    try { for (const root of roots) await root.fiber.dispose() }
    finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  return { async open(provider = createLocalComputerProvider()) {
    const root = new Context()
    roots.add(root)
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent({ name: 'test-computer-provider', apply(ctx) { ctx.provide(computerInstanceProviderServiceKey, provider) } })
    await root.installComponent(createComputersComponent(inputs))
    return { root, db: root.get('local-storage'), computers: root.get(computerServiceKey), async close() {
      try { await root.fiber.dispose() } finally { roots.delete(root) }
    } }
  } }
}
async function reserve(f, computerId = 'computer') {
  return f.db.transaction(tx => f.computers.reserveIn(tx, { computerId, spec }))
}

test('logical resources are durable, transaction-owned and do not activate the execution host', async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  assert.deepEqual(await f.computers.list(), [])
  assert.equal(provider.calls.length, 0)
  const first = await reserve(f)
  assert.equal(first.activationRevision, 0)
  assert.deepEqual(await reserve(f), first)
  assert.equal(provider.calls.length, 0)
  await assert.rejects(f.db.transaction(tx => {
    f.computers.reserveIn(tx, { computerId: 'rolled-back', spec })
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await f.computers.get('rolled-back'), undefined)
  await assert.rejects(f.db.transaction(tx => f.computers.reserveIn(tx,
    { computerId: 'computer', spec: { ...spec, platform: 'different' } })), { code: 'computer-conflict' })
  assert.equal(await f.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM harness_computer_instances').count), 0)
  await f.close()
  const reopened = await owner.open()
  assert.deepEqual(await reopened.computers.get('computer'), first)
})

test('concurrent activation shares provider work and a cancelled observer leaves other demand intact', async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const a = f.computers.activate('computer'), b = f.computers.activate('computer')
  await tick()
  assert.equal(provider.calls.length, 1)
  a.cancel('observer left')
  await assert.rejects(joined(a), { code: 'computer-cancelled' })
  assert.deepEqual(provider.calls[0].cancelled, [])
  provider.calls[0].result.resolve({ providerRef: 'host', platform: process.platform, architecture: process.arch })
  let returned = false
  void b.result.then(() => { returned = true })
  await tick()
  assert.equal(returned, false, 'a provider result does not imply provider resource exit')
  assert.equal(await f.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM harness_computer_instances').count), 0)
  provider.calls[0].done.resolve()
  const instance = await joined(b)
  assert.equal(instance.instanceGeneration, 1)
  assert.deepEqual(await joined(f.computers.activate('computer')), instance)
  assert.equal(provider.calls.length, 1)
})

test('instance pins participate atomically and reject foreign owners or stale generation', async t => {
  const owner = await fixture(t), f = await owner.open()
  await reserve(f)
  const instance = await joined(f.computers.activate('computer'))
  const pinInput = { ...instance, pinId: 'pin', ownerId: 'run' }
  await assert.rejects(f.db.transaction(tx => {
    f.computers.pinIn(tx, pinInput)
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await f.computers.getPin('pin'), undefined)
  const pin = await f.db.transaction(tx => f.computers.pinIn(tx, pinInput))
  assert.deepEqual(await f.db.transaction(tx => f.computers.pinIn(tx, pinInput)), pin)
  await assert.rejects(f.db.transaction(tx => f.computers.releasePinIn(tx, 'pin', 'foreign')), { code: 'computer-conflict' })
  await assert.rejects(f.db.transaction(tx => f.computers.pinIn(tx, { ...pinInput, pinId: 'stale', instanceGeneration: 2 })),
    { code: 'computer-generation-mismatch' })
  await f.db.transaction(tx => f.computers.releasePinIn(tx, 'pin', 'run'))
  const released = await f.computers.getPin('pin')
  assert.equal(typeof released.releasedAt, 'string')
  await f.db.transaction(tx => f.computers.releasePinIn(tx, 'pin', 'run'))
  assert.deepEqual(await f.computers.getPin('pin'), released)
  await assert.rejects(f.db.transaction(tx => f.computers.pinIn(tx, pinInput)), { code: 'computer-conflict' })
})

test('component replacement preserves a confirmed host identity and only advances generation without active pins', async t => {
  const owner = await fixture(t), first = await owner.open(createLocalComputerProvider({ providerRef: 'host-a' }))
  await reserve(first)
  const a = await joined(first.computers.activate('computer'))
  await first.db.transaction(tx => first.computers.pinIn(tx, { ...a, pinId: 'run-pin', ownerId: 'run' }))
  await first.close()
  const resumed = await owner.open(createLocalComputerProvider({ providerRef: 'host-a' }))
  const same = await joined(resumed.computers.activate('computer'))
  assert.equal(same.computerInstanceId, a.computerInstanceId)
  assert.equal(same.instanceGeneration, a.instanceGeneration)
  await resumed.close()
  const replacement = await owner.open(createLocalComputerProvider({ providerRef: 'host-b' }))
  await assert.rejects(joined(replacement.computers.activate('computer')), { code: 'computer-pinned' })
  await replacement.db.transaction(tx => replacement.computers.releasePinIn(tx, 'run-pin', 'run'))
  const b = await joined(replacement.computers.activate('computer'))
  assert.equal(b.instanceGeneration, 2)
  assert.notEqual(b.computerInstanceId, a.computerInstanceId)
  await assert.rejects(replacement.computers.requireInstance(a), { code: 'computer-generation-mismatch' })
  assert.deepEqual(await replacement.computers.requireInstance(b), b)
})

test('component close stops admission, cancels activation and waits for provider actual exit', async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const call = f.computers.activate('computer')
  await tick()
  let closed = false
  const closing = f.close().then(() => { closed = true })
  await tick()
  assert.equal(provider.calls[0].cancelled.length, 1)
  assert.equal(closed, false)
  assert.throws(() => f.computers.activate('computer'), { code: 'computer-unavailable' })
  provider.calls[0].result.resolve({ providerRef: 'host', platform: process.platform, architecture: process.arch })
  await tick()
  assert.equal(closed, false)
  provider.calls[0].done.resolve()
  await assert.rejects(joined(call), { code: 'computer-cancelled' })
  await closing
  const reopened = await owner.open()
  assert.equal(await reopened.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM harness_computer_instances').count), 0)
})

test('activation failure joins provider cleanup and may be retried without a confirmed instance', async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const failed = f.computers.activate('computer')
  await tick()
  provider.calls[0].result.reject(new Error('private provider error'))
  let observed = false
  void failed.result.catch(() => { observed = true })
  await tick()
  assert.equal(observed, false)
  provider.calls[0].done.resolve()
  await assert.rejects(joined(failed), { code: 'computer-unavailable', message: 'computer-unavailable' })
  const retry = f.computers.activate('computer')
  await tick()
  assert.equal(provider.calls.length, 2)
  provider.calls[1].result.resolve({ providerRef: 'host', platform: process.platform, architecture: process.arch })
  provider.calls[1].done.resolve()
  assert.equal((await joined(retry)).instanceGeneration, 1)
})

test('provider cleanup failure cannot publish a ready instance or report component cleanup success', async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const activation = f.computers.activate('computer')
  await tick()
  provider.calls[0].result.resolve({ providerRef: 'host', platform: process.platform, architecture: process.arch })
  provider.calls[0].done.reject(new Error('private cleanup details'))
  await assert.rejects(joined(activation), { code: 'computer-cleanup-failed', message: 'computer-cleanup-failed' })
  await assert.rejects(activation.done, { code: 'computer-cleanup-failed' })
  assert.equal(await f.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM harness_computer_instances').count), 0)
  await assert.rejects(f.close())
})

test('provider failed exit releases result waiting and component close even if its result never settles', { timeout: 3000 }, async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const activation = f.computers.activate('computer')
  await tick()
  provider.calls[0].done.reject(new Error('private failed exit'))
  await assert.rejects(activation.result, { code: 'computer-cleanup-failed' })
  await assert.rejects(activation.done, { code: 'computer-cleanup-failed' })
  assert.equal(await f.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM harness_computer_instances').count), 0)
  await assert.rejects(f.close())
})

test('close observes provider failed exit without waiting for an unsettled result', { timeout: 3000 }, async t => {
  const owner = await fixture(t), provider = controlledProvider(), f = await owner.open(provider)
  await reserve(f)
  const activation = f.computers.activate('computer')
  await tick()
  const closing = f.close()
  await tick()
  assert.equal(provider.calls[0].cancelled.length, 1)
  provider.calls[0].done.reject(new Error('private failed cancellation cleanup'))
  await assert.rejects(activation.result, { code: 'computer-cleanup-failed' })
  await assert.rejects(activation.done, { code: 'computer-cleanup-failed' })
  await assert.rejects(closing)
})

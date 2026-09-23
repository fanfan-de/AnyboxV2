import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createControlledMock } from '@anybox/agent-kernel/testing'
import { Context } from '@nya/core'
import { createMemoryState, createMockModel, createMockModelComponent, createSQLiteState,
  createStateComponent, createToolComponent, createHarnessComponent } from '@anybox/agent-kernel'
import { createAgentComponent } from '../dist/index.js'
import { definition, fixture, request, deferred, tick, isCode } from './helpers.mjs'

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn)

test('startup initializes automatically; clean restart preserves identity, history and request deduplication', async t => {
  const f = await fixture(t), first = f.create()
  assert.equal(first.status().state, 'new')
  await assert.rejects(first.sessions.create(), isCode('NOT_READY'))
  const starting = first.start()
  assert.strictEqual(first.start(), starting)
  await starting
  assert.equal(first.status().ready, true)
  assert.equal(first.describe().stateDurability, 'persistent')
  const identity = first.status().agent
  const session = await first.sessions.create(), input = request(session)
  const accepted = await first.tasks.submit(input)
  assert.equal((await first.tasks.wait({ runId: accepted.runId })).status, 'completed')
  const events = await first.tasks.events({ runId: accepted.runId })
  const closing = first.close(); assert.strictEqual(first.close(), closing); await closing
  assert.equal(first.status().state, 'closed')
  await assert.rejects(first.tasks.submit(input), isCode('CLOSED'))
  let calls = 0
  const second = f.create({ model: () => createMockModel(() => { calls++; return { content: [{ type: 'text', text: 'next' }] } }) })
  await second.start()
  const restored = second.status().agent
  assert.equal(restored.id, identity.id); assert.equal(restored.createdAt, identity.createdAt)
  assert.notEqual(restored.generation, identity.generation)
  assert.equal(calls, 0)
  assert.equal((await second.sessions.list()).length, 1)
  assert.equal((await second.sessions.messages({ sessionId: session.id })).messages.length, 2)
  assert.deepEqual(await second.tasks.submit(input), accepted)
  assert.equal(calls, 0)
  assert.deepEqual(await second.tasks.events({ runId: accepted.runId }), events)
  await assert.rejects(second.tasks.submit({ ...input, input: [{ type: 'text', text: 'changed' }] }), isCode('CONFLICT'))
  const next = await second.tasks.submit(request(await second.sessions.get({ sessionId: session.id }), 'next'))
  await second.tasks.wait({ runId: next.runId })
  assert.equal(calls, 1)
  assert.equal((await second.tasks.list({ sessionId: session.id })).length, 2)
})

test('a competing application fails without taking over the live owner', async t => {
  const f = await fixture(t), owner = f.create(), contender = f.create()
  await owner.start()
  await assert.rejects(contender.start())
  assert.equal(contender.status().ready, false)
  const accepted = await owner.tasks.submit(request(await owner.sessions.create()))
  assert.equal((await owner.tasks.wait({ runId: accepted.runId })).status, 'completed')
  await owner.close()
  const next = f.create(); await next.start()
  assert.equal((await next.tasks.list()).length, 1)
})

test('changed definitions fail closed and do not overwrite persisted Agent identity', async t => {
  const f = await fixture(t), first = f.create()
  await first.start()
  const identity = first.status().agent
  await first.close()
  const changed = f.create({ definition: { ...definition, revision: 2 } })
  await assert.rejects(changed.start())
  const restored = f.create(); await restored.start()
  assert.equal(restored.status().agent.id, identity.id)
  assert.equal(restored.status().agent.definitionRevision, 1)
})

test('graceful close stops active work, waits for cleanup and leaves durable records', async t => {
  const f = await fixture(t), model = createControlledMock()
  const app = f.create({ model: () => model, limits: { maxConcurrent: 1 } })
  await app.start()
  const active = await app.tasks.submit(request(await app.sessions.create()))
  const call = await model.nextCall(), gate = call.holdCleanup()
  f.releases.push(gate.release)
  const queued = await app.tasks.submit(request(await app.sessions.create()))
  const result = app.tasks.wait({ runId: active.runId })
  const closing = app.close(); let done = false; void closing.then(() => { done = true })
  await call.cleanupStarted; await tick()
  assert.equal(done, false)
  await assert.rejects(app.sessions.create(), isCode('CLOSED'))
  gate.release(); await closing
  assert.equal((await result).status, 'cancelled')
  const next = f.create(); await next.start()
  assert.deepEqual((await next.tasks.list()).map(run => run.status), ['cancelled', 'cancelled'])
  assert.equal((await next.tasks.get({ runId: queued.runId })).status, 'cancelled')
  assert.deepEqual(next.describe().recovery.interruptedRunIds, [])
})

test('component replacement automatically initializes a fresh facade and root calls use it', async t => {
  const f = await fixture(t), context = new Context()
  const state = context.installComponent(createStateComponent(() => createSQLiteState({ path: f.path })))
  const model = context.installComponent(createMockModelComponent())
  const tools = context.installComponent(createToolComponent())
  const harness = context.installComponent(createHarnessComponent({ recovery: 'interrupt', requestScope: 'agent' }))
  const driver = context.installComponent(createAgentComponent(definition))
  t.after(() => context.fiber.dispose())
  for (const fiber of [state, model, tools, harness, driver]) await fiber
  const previous = context.get('agent.application'), identity = previous.describe().agent
  const session = await previous.sessions.create()
  await model.restart(); await harness; await driver
  await assert.rejects(previous.sessions.create(), isCode('CLOSED'))
  const next = context.get('agent.application')
  assert.notStrictEqual(next, previous)
  assert.notEqual(next.describe().agent.generation, identity.generation)
  assert.equal(next.describe().agent.id, identity.id)
  const accepted = await next.tasks.submit(request(session))
  assert.equal((await next.tasks.wait({ runId: accepted.runId })).status, 'completed')
  await context.fiber.dispose()
})

test('close during asynchronous provider acquisition waits and releases the acquired database', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.releases.push(release.resolve)
  const app = f.create({ state: async () => {
    entered.resolve(); await release.promise; return createSQLiteState({ path: f.path })
  } })
  const starting = app.start(), rejected = assert.rejects(starting)
  await entered.promise
  const closing = app.close(); let done = false; void closing.then(() => { done = true })
  await tick(); assert.equal(done, false)
  release.resolve()
  await closing; await rejected
  const next = f.create(); await next.start()
  assert.equal(next.status().ready, true)
})

test('persistent applications reject memory-only state and close-before-start acquires nothing', async t => {
  const f = await fixture(t), invalid = f.create({ state: createMemoryState })
  await assert.rejects(invalid.start())
  let acquisitions = 0
  const closed = f.create({ state: () => { acquisitions++; return createSQLiteState({ path: f.path }) } })
  await closed.close()
  await assert.rejects(closed.start(), isCode('CLOSED'))
  assert.equal(acquisitions, 0)
})

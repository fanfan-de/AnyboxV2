import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { Context, FiberState } from '@nya/core'
import {
  createMemoryState, createMemoryStateComponent, createMockModel,
  createMockModelComponent, createRunCoordinatorComponent, createRunCoordinator,
  createSessionPolicy, createTextStrategy,
} from '../dist/index.js'
import { createControlledMock } from '../dist/testing.js'
import { definition, deferred, fixture, isCode, remainsPending, text, tick } from './helpers.mjs'

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn)

test('start returns acceptance before completion; full result and snapshots are isolated', async t => {
  const f = await fixture(t)
  const request = f.request(f.session)
  const starting = f.kernel.runs.start(request)
  request.input[0].text = 'mutated'
  const accepted = await starting
  const call = await f.model.nextCall()
  assert.equal(call.request.input[0].text, 'hello')
  assert.equal((await f.kernel.runs.get({ runId: accepted.runId })).status, 'running')
  const result = f.kernel.runs.wait({ runId: accepted.runId })
  await remainsPending(result)
  call.succeed('answer')
  const completed = await result
  assert.equal(completed.status, 'completed')
  assert.equal(f.model.activeCalls, 0)
  completed.basis.definition.instructions = 'changed'
  const history = await f.kernel.sessions.messages({ sessionId: f.session.id })
  assert.deepEqual(history.messages.map(m => m.content[0].text), ['hello', 'answer'])
  history.messages[0].content[0].text = 'changed'
  assert.equal((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages[0].content[0].text, 'hello')
  assert.equal((await f.kernel.runs.get({ runId: accepted.runId })).basis.definition.instructions, definition.instructions)
})

test('successive runs see completed history only and other sessions stay isolated', async t => {
  const f = await fixture(t)
  const first = await f.kernel.runs.start(f.request(f.session))
  ;(await f.model.nextCall()).succeed('first answer')
  await f.kernel.runs.wait({ runId: first.runId })
  const session = await f.kernel.sessions.get({ sessionId: f.session.id })
  assert.equal(session.version, 3)
  const second = await f.kernel.runs.start(f.request(session, 'follow up', 'second'))
  const secondCall = await f.model.nextCall()
  assert.deepEqual(secondCall.request.history.map(m => m.content[0].text), ['hello', 'first answer'])
  secondCall.fail(new Error('private provider failure'))
  assert.equal((await f.kernel.runs.wait({ runId: second.runId })).error.code, 'MODEL_FAILED')
  const third = await f.kernel.runs.start(f.request(await f.kernel.sessions.get({ sessionId: session.id }), 'try again', 'third'))
  const thirdCall = await f.model.nextCall()
  assert.equal(thirdCall.request.history.length, 2)
  const other = await f.kernel.sessions.create()
  const independent = await f.kernel.runs.start(f.request(other))
  const otherCall = await f.model.nextCall()
  assert.deepEqual(otherCall.request.history, [])
  thirdCall.succeed('third'); otherCall.succeed('other')
  await Promise.all([third, independent].map(run => f.kernel.runs.wait({ runId: run.runId })))
  assert.equal((await f.kernel.sessions.messages({ sessionId: session.id })).messages.length, 5)
})

test('request deduplication precedes busy and version checks and remains after completion', async t => {
  const f = await fixture(t)
  const request = f.request(f.session)
  const [first, duplicate] = await Promise.all([f.kernel.runs.start(request), f.kernel.runs.start(request)])
  assert.deepEqual(duplicate, first)
  const call = await f.model.nextCall()
  await assert.rejects(f.kernel.runs.start({ ...request, input: text('different') }), isCode('CONFLICT'))
  await assert.rejects(f.kernel.runs.start({ ...request, requestKey: 'another' }), isCode('SESSION_BUSY'))
  call.succeed('done')
  await f.kernel.runs.wait({ runId: first.runId })
  assert.deepEqual(await f.kernel.runs.start(request), first)
  await assert.rejects(f.kernel.runs.start({ ...request, requestKey: 'stale-version' }), isCode('CONFLICT'))
  assert.equal(f.model.totalCalls, 1)
  const data = await f.memory.service.readSnapshot()
  assert.equal(data.runs.size, 1); assert.equal(data.requests.size, 1)
})

test('bounded FIFO scheduling cancels queued runs without invoking the model', async t => {
  const f = await fixture(t, { config: { maxConcurrent: 1, maxQueued: 2 } })
  const sessions = [f.session, await f.kernel.sessions.create(), await f.kernel.sessions.create(), await f.kernel.sessions.create()]
  const first = await f.kernel.runs.start(f.request(sessions[0]))
  const firstCall = await f.model.nextCall()
  const second = await f.kernel.runs.start(f.request(sessions[1]))
  const third = await f.kernel.runs.start(f.request(sessions[2]))
  await assert.rejects(f.kernel.runs.start(f.request(sessions[3])), isCode('LIMIT_EXCEEDED'))
  assert.equal((await f.kernel.runs.get({ runId: second.runId })).status, 'queued')
  await f.kernel.runs.cancel({ runId: second.runId })
  assert.equal((await f.kernel.runs.wait({ runId: second.runId })).status, 'cancelled')
  assert.equal(f.model.totalCalls, 1)
  firstCall.succeed('first')
  const thirdCall = await f.model.nextCall()
  assert.equal(thirdCall.request.runId, third.runId)
  thirdCall.succeed('third')
  await Promise.all([first, third].map(run => f.kernel.runs.wait({ runId: run.runId })))
  assert.equal(f.model.totalCalls, 2)
})

test('cancellation waits for cleanup, while aborting a wait only releases the observer', async t => {
  const f = await fixture(t)
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  f.beforeClose(gate.release)
  const observer = new AbortController()
  const observing = f.kernel.runs.wait({ runId: run.runId, signal: observer.signal })
  observer.abort()
  await assert.rejects(observing, isCode('CANCELLED'))
  assert.equal(call.signal.aborted, false)
  const result = f.kernel.runs.wait({ runId: run.runId })
  await f.kernel.runs.cancel({ runId: run.runId, reason: 'user stop' })
  await call.cleanupStarted
  await remainsPending(result)
  assert.equal((await f.kernel.runs.get({ runId: run.runId })).status, 'cancelling')
  await f.kernel.runs.cancel({ runId: run.runId, reason: 'later reason' })
  gate.release()
  const cancelled = await result
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, 'user stop')
  assert.equal(f.model.activeCalls, 0)
})

test('completion/cancel races commit one outcome and discard late output', async t => {
  const f = await fixture(t)
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  f.beforeClose(gate.release)
  call.succeed('not committed yet')
  await call.cleanupStarted
  await f.kernel.runs.cancel({ runId: run.runId })
  gate.release()
  assert.equal((await f.kernel.runs.wait({ runId: run.runId })).status, 'cancelled')
  assert.equal((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages.length, 1)
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.get({ sessionId: f.session.id }), 'second', 'second'))
  ;(await f.model.nextCall()).succeed('committed')
  await f.kernel.runs.wait({ runId: second.runId })
  assert.deepEqual(await f.kernel.runs.cancel({ runId: second.runId }), { runId: second.runId, outcome: 'already-terminal', status: 'completed' })
})

test('model failure releases concurrency and exposes only project error data', async t => {
  const f = await fixture(t, { config: { maxConcurrent: 1 } })
  const first = await f.kernel.runs.start(f.request(f.session))
  const failedCall = await f.model.nextCall()
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  failedCall.fail(new Error('secret SDK token'))
  const failed = await f.kernel.runs.wait({ runId: first.runId })
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'MODEL_FAILED')
  assert.equal(JSON.stringify(failed).includes('secret SDK token'), false)
  ;(await f.model.nextCall()).succeed('next')
  assert.equal((await f.kernel.runs.wait({ runId: second.runId })).status, 'completed')
})

test('byte, context, session and record limits are enforced without losing deduplication', async t => {
  const f = await fixture(t, { config: { maxInputBytes: 4, maxOutputBytes: 4, maxContextBytes: 24, maxSessions: 1, maxRuns: 2 } })
  await assert.rejects(f.kernel.sessions.create(), isCode('LIMIT_EXCEEDED'))
  await assert.rejects(f.kernel.runs.start(f.request(f.session, '你好')), isCode('LIMIT_EXCEEDED'))
  const req = f.request(f.session, 'abc')
  const run = await f.kernel.runs.start(req)
  ;(await f.model.nextCall()).succeed('12345')
  const failed = await f.kernel.runs.wait({ runId: run.runId })
  assert.equal(failed.error.code, 'LIMIT_EXCEEDED')
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.get({ sessionId: f.session.id }), 'abc', 'second'))
  ;(await f.model.nextCall()).succeed('1234')
  await f.kernel.runs.wait({ runId: second.runId })
  assert.deepEqual(await f.kernel.runs.start(req), run)
  await assert.rejects(f.kernel.runs.start(f.request(await f.kernel.sessions.get({ sessionId: f.session.id }), 'abc', 'third')), isCode('LIMIT_EXCEEDED'))
  const g = await fixture(t, { config: { maxContextBytes: 24 } })
  const one = await g.kernel.runs.start(g.request(g.session, 'abc'))
  ;(await g.model.nextCall()).succeed('long answer')
  await g.kernel.runs.wait({ runId: one.runId })
  const two = await g.kernel.runs.start(g.request(await g.kernel.sessions.get({ sessionId: g.session.id }), 'abc', 'second'))
  assert.equal((await g.kernel.runs.wait({ runId: two.runId })).error.code, 'LIMIT_EXCEEDED')
  assert.equal(g.model.totalCalls, 1)
})

test('deadline includes queued time and stops active calls before settling', async t => {
  const f = await fixture(t, { config: { maxConcurrent: 1, runTimeoutMs: 25 } })
  const first = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  f.beforeClose(gate.release)
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  const firstResult = f.kernel.runs.wait({ runId: first.runId })
  const secondResult = await f.kernel.runs.wait({ runId: second.runId })
  assert.equal(secondResult.status, 'failed'); assert.equal(secondResult.error.code, 'LIMIT_EXCEEDED')
  assert.equal(call.signal.aborted, true)
  assert.equal(f.model.totalCalls, 1)
  await remainsPending(firstResult)
  gate.release()
  assert.equal((await firstResult).error.code, 'LIMIT_EXCEEDED')
})

test('cleanup errors fail the run, preserve independent cleanup, and reject component disposal', async t => {
  const f = await fixture(t, { cleanupMayFail: true })
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  call.succeed('answer')
  await call.cleanupStarted
  gate.fail(new Error('cleanup failed'))
  const result = await f.kernel.runs.wait({ runId: run.runId })
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'CLEANUP_FAILED')
  assert.equal(f.model.activeCalls, 0)
  await assert.rejects(f.context.fiber.dispose())
  assert.equal(f.context.get('agent.state'), undefined)
  assert.equal(f.context.get('agent.model'), undefined)
  assert.deepEqual(f.context.fiber.inspect().effects, [])
})

test('settlement rechecks the deadline after waiting to enter the terminal transaction', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const memory = createMemoryState(), entered = deferred(), release = deferred()
  const delayed = { service: { durability: 'memory', readSnapshot: () => memory.service.readSnapshot(),
    async transaction(label, change) {
      if (label === 'run.finish') { entered.resolve(); await release.promise }
      return memory.service.transaction(label, change)
    },
  }, close: () => memory.close() }
  const f = await fixture(t, { memory: delayed })
  f.beforeClose(release.resolve)
  const accepted = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const run = await f.kernel.runs.get({ runId: accepted.runId })
  const waiting = f.kernel.runs.wait({ runId: accepted.runId })
  call.succeed('finished before the deadline')
  await entered.promise
  assert.equal(f.model.activeCalls, 0)
  t.mock.timers.setTime(Date.parse(run.deadlineAt))
  release.resolve()
  const result = await waiting
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'LIMIT_EXCEEDED')
  assert.equal(result.endedAt, run.deadlineAt)
  assert.equal((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages.length, 1)
  const events = (await f.kernel.runs.events({ runId: run.id })).events
  assert.equal(events.at(-1).type, 'run.finished')
  assert.equal(events.at(-1).createdAt, result.endedAt)
})

test('acceptance transaction failure rolls back all records and closes the receive gate', async t => {
  const memory = createMemoryState()
  const failing = { service: { durability: 'memory', readSnapshot: () => memory.service.readSnapshot(),
    transaction: (label, change) => memory.service.transaction(label, draft => {
      const result = change(draft)
      if (label === 'run.accept') throw new Error('commit failed')
      return result
    }) }, close: () => memory.close() }
  const f = await fixture(t, { memory: failing, cleanupMayFail: true })
  await assert.rejects(f.kernel.runs.start(f.request(f.session)), isCode('STATE_FAILED'))
  const data = await memory.service.readSnapshot()
  assert.equal(data.runs.size, 0); assert.equal(data.messages.size, 0); assert.equal(data.requests.size, 0)
  assert.equal(data.sessions.get(f.session.id).version, 1)
  assert.equal(f.kernel.describe().ready, false)
  await assert.rejects(f.kernel.runs.start(f.request(f.session)), isCode('STATE_FAILED'))
  assert.equal(f.model.totalCalls, 0)
})

test('failed terminal commit rejects wait and still drains all real work', async t => {
  const memory = createMemoryState()
  const failing = { service: { durability: 'memory', readSnapshot: () => memory.service.readSnapshot(),
    transaction: (label, change) => memory.service.transaction(label, draft => {
      const result = change(draft)
      if (label === 'run.finish') throw new Error('disk-like failure')
      return result
    }) }, close: () => memory.close() }
  const f = await fixture(t, { memory: failing, cleanupMayFail: true })
  const first = await f.kernel.runs.start(f.request(f.session))
  const firstCall = await f.model.nextCall()
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  const secondCall = await f.model.nextCall()
  const firstWait = f.kernel.runs.wait({ runId: first.runId })
  const secondWait = f.kernel.runs.wait({ runId: second.runId })
  const checks = [assert.rejects(firstWait, isCode('SETTLEMENT_FAILED')), assert.rejects(secondWait, isCode('SETTLEMENT_FAILED'))]
  firstCall.succeed('cannot commit')
  await Promise.all(checks)
  assert.equal(secondCall.signal.aborted, true)
  assert.equal(f.model.activeCalls, 0)
  const run = await f.kernel.runs.get({ runId: first.runId })
  assert.notEqual(run.status, 'completed')
  assert.equal((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages.length, 1)
  assert.equal((await f.kernel.sessions.get({ sessionId: f.session.id })).version, 2)
  assert.equal((await f.kernel.runs.events({ runId: first.runId })).events.some(event => event.type === 'run.finished'), false)
  await assert.rejects(f.kernel.runs.wait({ runId: first.runId }), isCode('SETTLEMENT_FAILED'))
  await assert.rejects(f.context.fiber.dispose())
})

test('component starts only when dependencies are ready and initialization is explicit', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const run = ctx.installComponent(createRunCoordinatorComponent())
  await run
  assert.equal(run.state, FiberState.PENDING)
  assert.equal(ctx.get('agent.kernel'), undefined)
  const state = ctx.installComponent(createMemoryStateComponent())
  const model = ctx.installComponent(createMockModelComponent())
  await Promise.all([state, model]); await run
  const api = ctx.get('agent.kernel')
  assert.equal(api.describe().ready, false)
  await assert.rejects(api.sessions.create(), isCode('NOT_READY'))
  await api.initialize({ definition })
  await assert.rejects(api.initialize({ definition }), isCode('CONFLICT'))
  assert.equal(api.describe().stateDurability, 'memory')
})

test('provider removal waits for calls and replacement never reuses old facade or replays a run', async t => {
  const f = await fixture(t)
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  f.beforeClose(gate.release)
  const result = f.kernel.runs.wait({ runId: run.runId })
  await tick()
  const removal = f.modelFiber.dispose()
  await call.cleanupStarted
  await remainsPending(removal)
  await assert.rejects(f.kernel.runs.start(f.request(f.session, 'new', 'new')), isCode('CLOSED'))
  gate.release()
  await removal
  assert.equal((await result).status, 'cancelled')
  assert.equal(f.context.get('agent.kernel'), undefined)
  const replacement = createControlledMock()
  const newProvider = f.context.installComponent(createMockModelComponent(() => replacement))
  await newProvider; await f.runFiber
  const next = f.context.get('agent.kernel')
  assert.notStrictEqual(next, f.kernel)
  const newAgent = await next.initialize({ definition })
  assert.notEqual(newAgent.generation, f.agent.generation)
  assert.equal(replacement.totalCalls, 0)
  await assert.rejects(f.kernel.sessions.create(), isCode('CLOSED'))
  await assert.rejects(next.runs.start(f.request(await next.sessions.get({ sessionId: f.session.id }))), isCode('CONFLICT'))
})

test('state provider stays alive until consumers settle their runs', async t => {
  const f = await fixture(t)
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const gate = call.holdCleanup()
  f.beforeClose(gate.release)
  const result = f.kernel.runs.wait({ runId: run.runId })
  await tick()
  const removal = f.stateFiber.dispose()
  await call.cleanupStarted
  await remainsPending(removal)
  assert.equal((await f.memory.service.readSnapshot()).runs.size, 1)
  gate.release()
  assert.equal((await result).status, 'cancelled')
  await removal
  await assert.rejects(f.memory.service.readSnapshot(), isCode('CLOSED'))
})

test('close racing an in-flight acceptance still owns and settles the committed run', async t => {
  const base = createMemoryState()
  const entered = deferred(), gate = deferred()
  const memory = { service: { durability: 'memory', readSnapshot: () => base.service.readSnapshot(),
    async transaction(label, change) {
      if (label === 'run.accept') { entered.resolve(); await gate.promise }
      return base.service.transaction(label, change)
    } }, close: () => base.close() }
  const f = await fixture(t, { memory })
  const start = f.kernel.runs.start(f.request(f.session))
  await entered.promise
  const close = f.runFiber.dispose()
  gate.resolve()
  const accepted = await start
  await close
  const run = (await base.service.readSnapshot()).runs.get(accepted.runId)
  assert.equal(run.status, 'cancelled')
  assert.equal(f.model.totalCalls, 0)
})

test('project factories can replace session policy, execution strategy and model implementation', async t => {
  let histories = 0, executions = 0, cleaned = 0
  const alternate = createMockModel((_request, { onCleanup }) => {
    onCleanup(() => { cleaned++ })
    return { content: text('replacement') }
  })
  const f = await fixture(t, { model: alternate, factories: {
    sessionPolicy() {
      const original = createSessionPolicy()
      return { validateStart: (...args) => original.validateStart(...args), history: (...args) => { histories++; return original.history(...args) } }
    },
    strategy() {
      const original = createTextStrategy()
      return { execute: (...args) => { executions++; return original.execute(...args) } }
    },
  } })
  const run = await f.kernel.runs.start(f.request(f.session))
  assert.equal((await f.kernel.runs.wait({ runId: run.runId })).status, 'completed')
  assert.equal(histories, 1); assert.equal(executions, 1); assert.equal(cleaned, 1)
})

test('coordinator close is idempotent and does not resolve before real cleanup', async () => {
  const memory = createMemoryState(), model = createControlledMock()
  const coordinator = createRunCoordinator({ state: memory.service, model: model.service })
  const agent = await coordinator.service.initialize({ definition })
  const session = await coordinator.service.sessions.create()
  await coordinator.service.runs.start({ agentId: agent.id, agentGeneration: agent.generation,
    sessionId: session.id, expectedSessionVersion: session.version, requestKey: 'one', input: text('hi') })
  const call = await model.nextCall()
  const gate = call.holdCleanup()
  const closing = coordinator.close()
  assert.strictEqual(coordinator.close(), closing)
  await call.cleanupStarted
  await remainsPending(closing)
  gate.release()
  await closing
  await model.close(); await memory.close()
  assert.equal(model.activeCalls, 0)
})

test('custom strategy receives cancellation and must finish its own work before terminal state', async t => {
  const entered = deferred(), stopped = deferred(), release = deferred()
  const f = await fixture(t, { factories: { strategy: () => ({
    async execute(_request, _call, signal) {
      entered.resolve()
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      stopped.resolve()
      await release.promise
      return { content: text('late strategy output') }
    },
  }) } })
  const run = await f.kernel.runs.start(f.request(f.session))
  await entered.promise
  const result = f.kernel.runs.wait({ runId: run.runId })
  await f.kernel.runs.cancel({ runId: run.runId })
  await stopped.promise
  await remainsPending(result)
  release.resolve()
  assert.equal((await result).status, 'cancelled')
  assert.equal(f.model.totalCalls, 0)
})

test('a model that finishes after cancellation cannot publish output or escape cleanup', async t => {
  const entered = deferred(), release = deferred()
  let cleaned = false, signal
  const model = createMockModel((_request, execution) => {
    signal = execution.signal
    execution.onCleanup(() => { cleaned = true })
    entered.resolve()
    return release.promise
  })
  const f = await fixture(t, { model })
  const run = await f.kernel.runs.start(f.request(f.session))
  await entered.promise
  const result = f.kernel.runs.wait({ runId: run.runId })
  await f.kernel.runs.cancel({ runId: run.runId })
  assert.equal(signal.aborted, true)
  await remainsPending(result)
  assert.equal(cleaned, false)
  release.resolve({ content: text('too late') })
  assert.equal((await result).status, 'cancelled')
  assert.equal(cleaned, true)
  assert.equal((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages.length, 1)
})

test('read failure interrupts other work, reports a fault, and does not strand waiters', async t => {
  const base = createMemoryState()
  let broken = false
  const memory = { service: { durability: 'memory',
    readSnapshot: () => broken ? Promise.reject(new Error('snapshot unavailable')) : base.service.readSnapshot(),
    transaction: (...args) => base.service.transaction(...args),
  }, close: () => base.close() }
  const f = await fixture(t, { memory, cleanupMayFail: true })
  const run = await f.kernel.runs.start(f.request(f.session))
  const call = await f.model.nextCall()
  const result = f.kernel.runs.wait({ runId: run.runId })
  await tick()
  broken = true
  await assert.rejects(f.kernel.runs.get({ runId: run.runId }), isCode('STATE_FAILED'))
  assert.equal((await result).error.code, 'STATE_FAILED')
  assert.equal(call.signal.aborted, true)
  assert.equal(f.model.activeCalls, 0)
})

test('mutating a cancel request cannot redirect it to another run', async t => {
  const f = await fixture(t)
  const first = await f.kernel.runs.start(f.request(f.session))
  const firstCall = await f.model.nextCall()
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  const secondCall = await f.model.nextCall()
  const request = { runId: first.runId, reason: 'original' }
  const cancel = f.kernel.runs.cancel(request)
  request.runId = second.runId; request.reason = 'changed'
  await cancel
  assert.equal((await f.kernel.runs.wait({ runId: first.runId })).reason, 'original')
  assert.equal(firstCall.signal.aborted, true)
  assert.equal(secondCall.signal.aborted, false)
  secondCall.succeed('still running')
  assert.equal((await f.kernel.runs.wait({ runId: second.runId })).status, 'completed')
})

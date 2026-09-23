import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createAgentLoop, createContextBuilder, createLocalTools, createMemoryState, createMockModel, createSessionPolicy } from '../dist/index.js'
import { deferred, definition, fixture, isCode, remainsPending, text, tick } from './helpers.mjs'

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn)
const toolDefinition = { id: 'double', revision: 1, description: 'Double an integer.',
  inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }
const agentDefinition = { ...definition, tools: [{ id: 'double', revision: 1 }] }
const invocation = (id = 'call-1', input = { value: 3 }, toolId = 'double') => ({ type: 'tool-call', toolCallId: id, toolId, input })
const local = execute => createLocalTools([{ definition: toolDefinition, execute }])
const start = f => f.kernel.runs.start(f.request(f.session))
const wait = (f, run) => f.kernel.runs.wait({ runId: run.runId })

test('harness completes model → tool → model with pinned context and atomic ordered events', async t => {
  let calls = 0, cleaned = 0
  const tools = local((input, execution) => {
    calls++; execution.onCleanup(() => { cleaned++ }); return input.value * 2
  })
  const f = await fixture(t, { tools, definition: agentDefinition })
  assert.equal(f.kernel.describe().capabilities.tools, true)
  const run = await start(f)
  const first = await f.model.nextCall()
  assert.deepEqual(first.request.tools, [toolDefinition])
  first.respond({ content: [invocation()] })
  const second = await f.model.nextCall()
  assert.equal(cleaned, 1)
  assert.deepEqual(second.request.continuation.map(message => message.role), ['assistant', 'tool'])
  assert.equal(second.request.continuation[1].content[0].outcome.output, 6)
  assert.equal(second.request.input[0].text, 'hello')
  second.succeed('The answer is 6.')
  const result = await wait(f, run)
  assert.equal(result.status, 'completed'); assert.equal(calls, 1)
  const inspection = await f.kernel.runs.inspect({ runId: run.runId })
  assert.deepEqual(inspection.steps.map(step => step.status), ['completed', 'completed'])
  assert.equal(new Set(inspection.attempts.map(attempt => attempt.id)).size, 2)
  assert.equal(inspection.toolCalls[0].status, 'succeeded')
  assert.equal((await f.kernel.sessions.get({ sessionId: f.session.id })).version, 3)
  const history = await f.kernel.sessions.messages({ sessionId: f.session.id })
  assert.deepEqual(history.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant'])
  const firstPage = await f.kernel.runs.events({ runId: run.runId, limit: 3 })
  const secondPage = await f.kernel.runs.events({ runId: run.runId, afterSeq: firstPage.events.at(-1).seq })
  const events = [...firstPage.events, ...secondPage.events]
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
  assert.equal(firstPage.hasMore, true); assert.equal(secondPage.hasMore, false)
  assert.equal(events.at(-1).type, 'run.finished')
  assert.equal(events.at(-1).seq, inspection.run.lastEventSeq)
  for (const event of events) {
    if (event.stepId) assert.ok(inspection.steps.some(step => step.id === event.stepId))
    if (event.attemptId) assert.ok(inspection.attempts.some(attempt => attempt.id === event.attemptId))
    if (event.toolCallId) assert.ok(inspection.toolCalls.some(call => call.id === event.toolCallId))
  }
  inspection.toolCalls[0].request.input.value = 999
  events[0].status = 'corrupted'
  assert.equal((await f.kernel.runs.inspect({ runId: run.runId })).toolCalls[0].request.input.value, 3)
  assert.equal((await f.kernel.runs.events({ runId: run.runId })).events[0].status, 'queued')
  await assert.rejects(f.kernel.runs.events({ runId: run.runId, afterSeq: -1 }), isCode('INVALID_ARGUMENT'))
  await assert.rejects(f.kernel.runs.events({ runId: run.runId, afterSeq: result.lastEventSeq + 1 }), isCode('INVALID_ARGUMENT'))
})

for (const [name, parts, expected] of [
  ['unknown tool', [invocation('a'), invocation('b', {}, 'unknown')], 'TOOL_DENIED'],
  ['invalid arguments', [invocation('a'), invocation('b', { value: 'bad' })], 'INVALID_ARGUMENT'],
  ['extra arguments', [invocation('a', { value: 3, extra: true })], 'INVALID_ARGUMENT'],
  ['duplicate protocol IDs', [invocation('a'), invocation('a')], 'MODEL_FAILED'],
]) test(`${name} executes zero tools, including earlier valid calls in the batch`, async t => {
  let calls = 0
  const f = await fixture(t, { tools: local(() => { calls++; return 1 }), definition: agentDefinition })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: parts })
  assert.equal((await wait(f, run)).error.code, expected)
  assert.equal(calls, 0)
  assert.equal(f.model.totalCalls, 1)
})

for (const [decision, expected] of [['deny', 'TOOL_DENIED'], ['ask', 'INTERACTION_UNAVAILABLE']]) {
  test(`${decision} policy blocks execution`, async t => {
    let calls = 0
    const f = await fixture(t, { tools: local(() => { calls++; return 1 }), definition: agentDefinition,
      factories: { toolPolicy: () => ({ decide: () => decision }) } })
    const run = await start(f)
    ;(await f.model.nextCall()).respond({ content: [invocation()] })
    assert.equal((await wait(f, run)).error.code, expected)
    assert.equal(calls, 0)
  })
}

test('tools wait for model cleanup and cancellation before dispatch executes nothing', async t => {
  let calls = 0
  const f = await fixture(t, { tools: local(() => { calls++; return 1 }), definition: agentDefinition })
  const run = await start(f), model = await f.model.nextCall()
  const gate = model.holdCleanup(); f.beforeClose(gate.release)
  model.respond({ content: [invocation()] })
  await model.cleanupStarted
  assert.equal(calls, 0)
  await f.kernel.runs.cancel({ runId: run.runId })
  gate.release()
  assert.equal((await wait(f, run)).status, 'cancelled')
  assert.equal(calls, 0)
  assert.equal((await f.kernel.runs.inspect({ runId: run.runId })).toolCalls.length, 0)
})

test('tool batches are serial; cancellation retains actual effects and drains cleanup', async t => {
  const entered = deferred(), release = deferred(), cleaning = deferred(), cleaned = deferred()
  let calls = 0, toolSignal
  const f = await fixture(t, { definition: agentDefinition, tools: local(async (_input, execution) => {
    calls++; toolSignal = execution.signal
    execution.onCleanup(async () => { cleaning.resolve(); await cleaned.promise })
    entered.resolve(); await release.promise
    return 'side effect completed'
  }) })
  f.beforeClose(() => { release.resolve(); cleaned.resolve() })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation('one'), invocation('two')] })
  await entered.promise
  assert.equal(calls, 1)
  const result = wait(f, run)
  await f.kernel.runs.cancel({ runId: run.runId })
  assert.equal(toolSignal.aborted, true)
  await remainsPending(result)
  release.resolve(); await cleaning.promise
  await remainsPending(result)
  cleaned.resolve()
  assert.equal((await result).status, 'cancelled')
  assert.equal(calls, 1); assert.equal(f.model.totalCalls, 1)
  const inspection = await f.kernel.runs.inspect({ runId: run.runId })
  assert.deepEqual(inspection.toolCalls.map(call => call.status), ['succeeded', 'cancelled'])
  assert.equal(inspection.toolCalls[0].outcome.output, 'side effect completed')
  const next = await f.kernel.runs.start(f.request(await f.kernel.sessions.get({ sessionId: f.session.id }), 'continue', 'next'))
  const nextCall = await f.model.nextCall()
  assert.equal(nextCall.request.history.filter(message => message.role === 'tool').length, 2)
  nextCall.succeed('I can see the prior effects.')
  await wait(f, next)
})

test('tool provider removal drains consumers before provider resources are released', async t => {
  const entered = deferred(), cleanup = deferred(), release = deferred()
  let providerClosed = false
  const base = local(async (_input, execution) => {
    execution.onCleanup(async () => { cleanup.resolve(); await release.promise })
    entered.resolve()
    await new Promise(resolve => execution.signal.aborted ? resolve() : execution.signal.addEventListener('abort', resolve, { once: true }))
    return 'stopped'
  })
  const f = await fixture(t, { definition: agentDefinition,
    tools: { service: base.service, async close() { await base.close(); providerClosed = true } } })
  f.beforeClose(release.resolve)
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  await entered.promise
  const result = wait(f, run); await tick()
  const removal = f.toolFiber.dispose()
  await cleanup.promise
  await remainsPending(removal)
  assert.equal(providerClosed, false)
  await assert.rejects(f.kernel.sessions.create(), isCode('CLOSED'))
  release.resolve()
  await removal
  assert.equal((await result).status, 'cancelled')
  assert.equal(providerClosed, true)
  assert.equal(f.context.get('agent.kernel'), undefined)
})

test('a failed tool result commit never replays effects and records uncertainty when settlement works', async t => {
  const base = createMemoryState()
  let calls = 0, cleaned = 0
  const memory = { service: { durability: 'memory', readSnapshot: () => base.service.readSnapshot(),
    transaction: (label, change) => base.service.transaction(label, draft => {
      const result = change(draft)
      if (label === 'tool.finish') throw new Error('storage failure')
      return result
    }) }, close: () => base.close() }
  const f = await fixture(t, { memory, cleanupMayFail: true, definition: agentDefinition, tools: local((_input, execution) => {
    calls++; execution.onCleanup(() => { cleaned++ }); return 'already written'
  }) })
  const request = f.request(f.session)
  const run = await f.kernel.runs.start(request)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  assert.equal((await wait(f, run)).error.code, 'STATE_FAILED')
  const inspection = await f.kernel.runs.inspect({ runId: run.runId })
  assert.equal(inspection.toolCalls[0].status, 'uncertain')
  assert.equal(inspection.toolCalls[0].outcome.error.code, 'SETTLEMENT_FAILED')
  assert.equal(calls, 1); assert.equal(cleaned, 1); assert.equal(f.model.totalCalls, 1)
  const events = (await f.kernel.runs.events({ runId: run.runId })).events
  assert.deepEqual(events.filter(event => event.type === 'tool.finished').map(event => event.status), ['uncertain'])
  await assert.rejects(f.kernel.runs.start(request), isCode('STATE_FAILED'))
})

test('failed model commit rolls back its events and never dispatches tools', async t => {
  const base = createMemoryState()
  let calls = 0
  const f = await fixture(t, { definition: agentDefinition, tools: local(() => { calls++; return 1 }), cleanupMayFail: true,
    memory: { service: { durability: 'memory', readSnapshot: () => base.service.readSnapshot(),
      transaction: (label, change) => base.service.transaction(label, draft => {
        const result = change(draft)
        if (label === 'model.finish') throw new Error('rollback model outcome')
        return result
      }) }, close: () => base.close() } })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  assert.equal((await wait(f, run)).error.code, 'STATE_FAILED')
  assert.equal(calls, 0)
  assert.equal((await f.kernel.runs.inspect({ runId: run.runId })).toolCalls.length, 0)
  const events = (await f.kernel.runs.events({ runId: run.runId })).events
  assert.equal(events.some(event => event.type === 'model.finished' && event.status === 'succeeded'), false)
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
})

test('step, tool count, cumulative model output and tool output limits stop subsequent work', async t => {
  for (const [config, parts, toolOutput, expectedCalls] of [
    [{ maxSteps: 1 }, [invocation()], 6, 1],
    [{ maxToolCalls: 1 }, [invocation('a'), invocation('b')], 6, 0],
    [{ maxOutputBytes: 4 }, text('12345'), 6, 0],
    [{ maxToolResultBytes: 4 }, [invocation()], '12345', 1],
  ]) {
    let calls = 0
    const f = await fixture(t, { config, definition: agentDefinition, tools: local(() => { calls++; return toolOutput }) })
    const run = await start(f)
    ;(await f.model.nextCall()).respond({ content: parts })
    assert.equal((await wait(f, run)).error.code, 'LIMIT_EXCEEDED')
    assert.equal(calls, expectedCalls); assert.equal(f.model.totalCalls, 1)
  }
  const firstOutput = { content: [invocation()] }
  const budget = Buffer.byteLength(JSON.stringify(firstOutput.content[0])) + 3
  const f = await fixture(t, { config: { maxOutputBytes: budget }, definition: agentDefinition, tools: local(() => 6) })
  const run = await start(f)
  ;(await f.model.nextCall()).respond(firstOutput)
  const second = await f.model.nextCall()
  assert.equal(second.request.maxOutputBytes, 3)
  second.succeed('1234')
  assert.equal((await wait(f, run)).error.code, 'LIMIT_EXCEEDED')
})

test('unhandled tool exceptions are uncertain and private errors are not exposed', async t => {
  const f = await fixture(t, { definition: agentDefinition, tools: local(() => { throw new Error('secret connection string') }) })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  assert.equal((await wait(f, run)).error.code, 'TOOL_FAILED')
  const inspection = await f.kernel.runs.inspect({ runId: run.runId })
  assert.equal(inspection.toolCalls[0].status, 'uncertain')
  assert.equal(JSON.stringify(inspection).includes('secret connection string'), false)
})

test('tool cleanup failure stops the loop, attempts all cleanups and rejects disposal', async t => {
  let cleaned = 0
  const f = await fixture(t, { cleanupMayFail: true, definition: agentDefinition, tools: local((_input, execution) => {
    execution.onCleanup(() => { cleaned++ })
    execution.onCleanup(() => { throw new Error('private cleanup failure') })
    return 6
  }) })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  assert.equal((await wait(f, run)).error.code, 'CLEANUP_FAILED')
  assert.equal(cleaned, 1); assert.equal(f.model.totalCalls, 1)
  await assert.rejects(f.context.fiber.dispose())
  assert.equal(f.context.get('agent.tools'), undefined)
})

test('a replacement strategy cannot repeat tool effects or hide action failures', async t => {
  let calls = 0
  const f = await fixture(t, { definition: agentDefinition, tools: local(() => { calls++; return 6 }), factories: {
    executionStrategy: () => ({ async execute(context) {
      const step = await context.modelStep()
      await context.executeTools({ stepId: step.stepId })
      await assert.rejects(context.executeTools({ stepId: step.stepId }), isCode('CONFLICT'))
      await assert.rejects(context.modelStep(), isCode('CONFLICT'))
      return { finalStepId: step.stepId }
    } }),
  } })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  assert.equal((await wait(f, run)).error.code, 'CONFLICT')
  assert.equal(calls, 1); assert.equal(f.model.totalCalls, 1)
})

test('strategy instances are per-run, context builders are replaceable and retained ports are closed', async t => {
  let strategies = 0, contexts = 0
  const retained = []
  const f = await fixture(t, { model: createMockModel(() => ({ content: text('ok') })), factories: {
    executionStrategy() {
      strategies++
      const loop = createAgentLoop()
      return { execute(context) { retained.push(context); return loop.execute(context) } }
    },
    contextBuilder() {
      const original = createContextBuilder()
      return { build(input) { contexts++; return original.build(input) } }
    },
  } })
  const first = await start(f)
  await wait(f, first)
  const second = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  await wait(f, second)
  assert.equal(strategies, 2); assert.equal(contexts, 2)
  await assert.rejects(retained[0].modelStep(), isCode('CLOSED'))
})

test('a strategy that returns with an active operation cannot detach it from Run cleanup', async t => {
  const started = deferred(), returning = deferred()
  const f = await fixture(t, { factories: { executionStrategy: () => ({ async execute(context) {
    void context.modelStep()
    started.resolve()
    await returning.promise
    return { finalStepId: 'invented' }
  } }) } })
  const run = await start(f)
  await started.promise
  const call = await f.model.nextCall()
  const gate = call.holdCleanup(); f.beforeClose(gate.release)
  const result = wait(f, run)
  returning.resolve()
  await call.cleanupStarted
  await remainsPending(result)
  gate.release()
  assert.equal((await result).error.code, 'CONFLICT')
  assert.equal(f.model.activeCalls, 0)
})

test('tool schema vocabulary rejects unsupported validation rules at registration', () => {
  assert.throws(() => createLocalTools([{ definition: { ...toolDefinition, inputSchema: { type: 'string', pattern: 'x' } }, execute: () => 1 }]), isCode('INVALID_ARGUMENT'))
})

test('policy is rechecked before each tool after an earlier side effect', async t => {
  let allowed = true, calls = 0
  const f = await fixture(t, { definition: agentDefinition,
    tools: local(() => { calls++; allowed = false; return 6 }),
    factories: { toolPolicy: () => ({ decide: () => allowed ? 'allow' : 'deny' }) } })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation('one'), invocation('two')] })
  assert.equal((await wait(f, run)).error.code, 'TOOL_DENIED')
  assert.equal(calls, 1)
  assert.deepEqual((await f.kernel.runs.inspect({ runId: run.runId })).toolCalls.map(call => call.status), ['succeeded', 'cancelled'])
})

test('replacement tool service can report a known failure for the next model step', async t => {
  let cleaned = 0
  const tools = { service: {
    definitions: () => [toolDefinition],
    call: () => ({ result: Promise.resolve({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'private error' } }),
      done: Promise.resolve().then(() => { cleaned++ }), cancel() {} }),
  }, close: async () => {} }
  const f = await fixture(t, { tools, definition: agentDefinition })
  const run = await start(f)
  ;(await f.model.nextCall()).respond({ content: [invocation()] })
  const next = await f.model.nextCall()
  const outcome = next.request.continuation.at(-1).content[0].outcome
  assert.equal(outcome.status, 'failed')
  assert.equal(JSON.stringify(outcome).includes('private error'), false)
  assert.equal(cleaned, 1)
  next.succeed('The tool failed; no further action is needed.')
  assert.equal((await wait(f, run)).status, 'completed')
})

test('even non-Error action failures remain sticky when a strategy catches them', async t => {
  let builds = 0
  const f = await fixture(t, { factories: {
    contextBuilder: () => ({ build() { builds++; throw undefined } }),
    executionStrategy: () => ({ async execute(context) {
      await assert.rejects(context.modelStep(), isCode('INTERNAL'))
      await assert.rejects(context.modelStep(), isCode('INTERNAL'))
      throw new Error('strategy stopped')
    } }),
  } })
  const run = await start(f)
  assert.equal((await wait(f, run)).error.code, 'INTERNAL')
  assert.equal(builds, 1); assert.equal(f.model.totalCalls, 0)
})

for (const [failedLabel, expectedModelCalls, expectedToolCalls, rolledBackEvent] of [
  ['model.start', 0, 0, 'model.started'],
  ['tool.start', 1, 0, 'tool.started'],
  ['step.finish', 1, 1, 'step.finished'],
]) test(`${failedLabel} rollback cannot dispatch later effects or publish the planned transition`, async t => {
  const base = createMemoryState()
  let toolCalls = 0
  const f = await fixture(t, { definition: agentDefinition, cleanupMayFail: true,
    tools: local(() => { toolCalls++; return 6 }),
    memory: { service: { durability: 'memory', readSnapshot: () => base.service.readSnapshot(),
      transaction: (label, change) => base.service.transaction(label, draft => {
        const value = change(draft)
        if (label === failedLabel) throw new Error('reject the planned commit')
        return value
      }),
    }, close: () => base.close() },
  })
  const run = await start(f)
  if (expectedModelCalls) (await f.model.nextCall()).respond({ content: [invocation()] })
  const result = await wait(f, run)
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'STATE_FAILED')
  assert.equal(f.model.totalCalls, expectedModelCalls)
  assert.equal(toolCalls, expectedToolCalls)
  const inspection = await f.kernel.runs.inspect({ runId: run.runId })
  assert.equal(inspection.toolCalls.some(call => call.status === 'running' || call.status === 'pending'), false)
  if (expectedToolCalls) assert.equal(inspection.toolCalls[0].status, 'succeeded')
  const events = (await f.kernel.runs.events({ runId: run.runId })).events
  assert.equal(events.some(event => event.type === rolledBackEvent && event.status !== 'failed'), false)
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
  assert.equal(events.filter(event => event.type === 'run.finished').length, 1)
})

test('strategy snapshot mutations cannot alter stored state or the Runtime basis', async t => {
  const policy = createSessionPolicy(), builder = createContextBuilder()
  const f = await fixture(t, { factories: {
    sessionPolicy: () => ({
      validateStart(state, request) {
        const session = policy.validateStart(state, request)
        state.sessions.clear()
        return session
      },
      history(state, run) {
        const history = policy.history(state, run)
        state.runs.clear()
        run.basis.limits.maxSteps = 0
        return history
      },
    }),
    contextBuilder: () => ({ build(input) {
      const context = builder.build(input)
      input.state.messages.clear()
      input.run.basis.limits.maxOutputBytes = 0
      return context
    } }),
  } })
  const run = await start(f)
  const call = await f.model.nextCall()
  assert.equal(call.request.input[0].text, 'hello')
  assert.equal(call.request.maxOutputBytes, f.kernel.describe().limits.maxOutputBytes)
  call.succeed('answer')
  const completed = await wait(f, run)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.basis.limits.maxSteps, f.kernel.describe().limits.maxSteps)
  assert.equal((await f.kernel.sessions.get({ sessionId: f.session.id })).version, 3)
  assert.deepEqual((await f.kernel.sessions.messages({ sessionId: f.session.id })).messages.map(message => message.role), ['user', 'assistant'])
})

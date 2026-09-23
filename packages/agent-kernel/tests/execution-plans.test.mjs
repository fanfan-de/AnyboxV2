import assert from 'node:assert/strict'
import test from 'node:test'
import { nextModelStep, planModelStarted, planModelFinished, planModelFailed } from '../dist/domain/model.js'
import { planToolStarted, planToolFinished, planToolStepFinished, normalizeToolOutcome,
  unconfirmedToolOutcome, toolBatch } from '../dist/domain/tools.js'
import { planRunSettlement } from '../dist/domain/settlement.js'
import { contentBytes } from '../dist/domain/content.js'
import { emptyState } from '../dist/components/state/codec.js'
import { defaultLimits } from '../dist/shared/utils.js'
import { definition, isCode, text } from './helpers.mjs'

const at = '2026-09-23T00:00:00.000Z'
const tool = { id: 'echo', revision: 1, description: 'Echo text', inputSchema: { type: 'string' } }
const callPart = id => ({ type: 'tool-call', toolCallId: id, toolId: 'echo', input: 'hello' })
const start = (suffix = '') => ({ runId: 'run', stepId: `step${suffix}`, attemptId: `attempt${suffix}`, at })
const finish = (parts, suffix = '', ids = []) => ({ runId: 'run', stepId: `step${suffix}`, output: { content: parts },
  toolsAvailable: true, toolCallIds: ids, assistantMessageId: `assistant${suffix}`, at })
const dispatch = id => ({ runId: 'run', stepId: 'step', callId: id, at })
const result = (id, outcome = { status: 'succeeded', output: 'done' }) => ({ ...dispatch(id), outcome, messageId: `result-${id}` })

function snapshot(limits = {}) {
  const state = emptyState()
  state.sessions.set('session', { id: 'session', agentId: 'agent', version: 2, createdAt: at })
  state.messages.set('input', { id: 'input', sessionId: 'session', runId: 'run', role: 'user', content: text('question'), createdAt: at })
  state.runs.set('run', { id: 'run', agentId: 'agent', sessionId: 'session', status: 'running',
    basis: { definition: structuredClone(definition), limits: { ...defaultLimits, ...limits }, tools: [tool], agentGeneration: 'generation' },
    inputMessageId: 'input', resultMessageIds: [], createdAt: at, deadlineAt: '2026-09-23T00:01:00.000Z', lastEventSeq: 1 })
  state.events.set('run', [{ runId: 'run', seq: 1, type: 'run.running', status: 'running', createdAt: at }])
  state.sessions.set('unrelated', { id: 'unrelated', agentId: 'agent', version: 7, createdAt: at })
  return state
}

// Every transition in the scenarios must be deterministic and leave both inputs unchanged.
function apply(plan, state, input) {
  const original = structuredClone(state), originalInput = structuredClone(input)
  const planned = plan(state, input)
  assert.deepEqual(plan(state, input), planned)
  assert.deepEqual(state, original)
  assert.deepEqual(input, originalInput)
  return planned
}
function rejects(plan, state, input, code = 'CONFLICT') {
  const original = structuredClone(state), originalInput = structuredClone(input)
  assert.throws(() => plan(state, input), isCode(code))
  assert.deepEqual(state, original)
  assert.deepEqual(input, originalInput)
}
function batch(ids = ['one', 'two'], limits = {}) {
  const started = apply(planModelStarted, snapshot(limits), start()).state
  return apply(planModelFinished, started, finish(ids.map(callPart), '', ids)).state
}
function completeTools(state, ids) {
  for (const id of ids) {
    state = apply(planToolStarted, state, dispatch(id)).state
    state = apply(planToolFinished, state, result(id)).state
  }
  return apply(planToolStepFinished, state, { runId: 'run', stepId: 'step', at }).state
}

test('pure plans compose model → tools → model → settlement without clock or service access', () => {
  const source = snapshot(), original = structuredClone(source)
  let state = apply(planModelStarted, source, start()).state
  state = apply(planModelFinished, state, finish([callPart('one')], '', ['one'])).state
  state = completeTools(state, ['one'])
  const next = apply(planModelStarted, state, start('-2'))
  assert.equal(next.value.maxOutputBytes, defaultLimits.maxOutputBytes - contentBytes([callPart('one')]))
  assert.equal(next.state.steps.get('step-2').index, 2)
  const finished = apply(planModelFinished, next.state, finish(text('answer'), '-2'))
  assert.equal(finished.value.outcome, 'final')
  assert.equal([...finished.state.messages.values()].filter(message => message.role === 'assistant').length, 1)
  const settled = planRunSettlement(finished.state, { runId: 'run', endedAt: at,
    final: { output: finished.value.output, attemptId: 'attempt-2', messageId: 'answer' }, toolResultMessageIds: new Map() })
  assert.equal(settled.result.status, 'completed')
  const events = settled.state.events.get('run')
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
  assert.ok(events.every(event => event.createdAt === at))
  assert.equal(settled.result.lastEventSeq, events.length)
  assert.equal(settled.state.sessions.get('unrelated').version, 7)
  settled.state.runs.get('run').basis.definition.instructions = 'changed'
  assert.deepEqual(source, original)
})

test('execution plans reject overlapping models, skipped or repeated tools, and premature step completion', () => {
  const started = apply(planModelStarted, snapshot(), start()).state
  rejects(planModelStarted, started, start('-2'))
  let state = batch()
  rejects(planModelStarted, state, start('-2'))
  rejects(planToolStarted, state, dispatch('two'))
  rejects(planToolFinished, state, result('one'))
  rejects(planToolStepFinished, state, { runId: 'run', stepId: 'step', at })
  state = apply(planToolStarted, state, dispatch('one')).state
  rejects(planToolStarted, state, dispatch('one'))
  state = apply(planToolFinished, state, result('one')).state
  rejects(planToolFinished, state, result('one'))
  const before = structuredClone(state)
  assert.throws(() => toolBatch(state, 'run', 'step'), isCode('CONFLICT'))
  assert.deepEqual(state, before)
})

test('pure plans use persisted counts for cumulative output, step and tool budgets', () => {
  const bytes = contentBytes([callPart('one')])
  for (const limits of [{ maxSteps: 1 }, { maxOutputBytes: bytes }]) {
    const state = completeTools(batch(['one'], limits), ['one'])
    rejects(planModelStarted, state, start('-2'), 'LIMIT_EXCEEDED')
  }
  let state = completeTools(batch(['one'], { maxToolCalls: 1 }), ['one'])
  state = apply(planModelStarted, state, start('-2')).state
  rejects(planModelFinished, state, finish([callPart('two')], '-2', ['two']), 'LIMIT_EXCEEDED')
  state = completeTools(batch(['one'], { maxOutputBytes: bytes + 3 }), ['one'])
  state = apply(planModelStarted, state, start('-2')).state
  rejects(planModelFinished, state, finish(text('four'), '-2'), 'LIMIT_EXCEEDED')
})

test('protocol call IDs are unique across a Run and within a batch, while internal identities cannot collide', () => {
  let state = completeTools(batch(['one']), ['one'])
  state = apply(planModelStarted, state, start('-2')).state
  rejects(planModelFinished, state, finish([callPart('one')], '-2', ['new']), 'MODEL_FAILED')
  rejects(planModelFinished, state, finish([callPart('two'), callPart('two')], '-2', ['new', 'newer']), 'MODEL_FAILED')
  rejects(planModelFinished, state, finish([callPart('two')], '-2', ['one']))
  rejects(planModelFinished, state, finish([callPart('two'), callPart('three')], '-2', ['same', 'same']))
  rejects(planModelFinished, state, { ...finish([callPart('two')], '-2', ['new']), assistantMessageId: 'input' })
})

test('model failures cannot overwrite a committed success or publish a late final answer', () => {
  const state = apply(planModelStarted, snapshot(), start()).state
  const failedInput = { runId: 'run', stepId: 'step', error: { code: 'MODEL_FAILED', message: 'failed' }, cancelled: false, at }
  const failed = apply(planModelFailed, state, failedInput)
  assert.equal(failed.state.attempts.get('attempt').status, 'failed')
  assert.deepEqual(apply(planModelFailed, failed.state, failedInput), failed)
  rejects(planModelFinished, failed.state, finish(text('late')))
  const success = apply(planModelFinished, state, finish(text('answer')))
  assert.deepEqual(apply(planModelFailed, success.state, failedInput).state, success.state)
  rejects(planModelStarted, success.state, start('-2'))
  failed.state.attempts.get('attempt').error.message = 'changed'
  assert.equal(failedInput.error.message, 'failed')
})

test('cancellation accepts an already dispatched tool result but blocks further model and tool starts', () => {
  let state = batch()
  state = apply(planToolStarted, state, dispatch('one')).state
  state.runs.set('run', { ...state.runs.get('run'), status: 'cancelling' })
  const command = result('one', { status: 'succeeded', output: { effect: 'saved' } })
  const saved = apply(planToolFinished, state, command)
  assert.equal(saved.value.status, 'succeeded')
  assert.equal(saved.state.messages.get('result-one').content[0].outcome.output.effect, 'saved')
  rejects(planToolStarted, saved.state, dispatch('two'))
  rejects(planModelStarted, saved.state, start('-2'))
  saved.value.outcome.output.effect = 'changed'
  assert.equal(command.outcome.output.effect, 'saved')
})

test('uncertain or cancelled tools cannot advance the step, while known failures can', () => {
  for (const outcome of [{ status: 'uncertain', error: { code: 'TOOL_FAILED', message: 'unknown' } }, { status: 'cancelled' }]) {
    let state = apply(planToolStarted, batch(), dispatch('one')).state
    state = apply(planToolFinished, state, result('one', outcome)).state
    rejects(planToolStarted, state, dispatch('two'))
    rejects(planToolStepFinished, state, { runId: 'run', stepId: 'step', at })
  }
  let state = apply(planToolStarted, batch(['one']), dispatch('one')).state
  state = apply(planToolFinished, state, result('one', { status: 'failed', error: { code: 'TOOL_FAILED', message: 'known' } })).state
  state = apply(planToolStepFinished, state, { runId: 'run', stepId: 'step', at }).state
  assert.equal(nextModelStep(state, 'run').index, 2)
})

test('execution identities cannot be used across runs or after terminal settlement', () => {
  let state = batch(['one'])
  const other = { ...state.runs.get('run'), id: 'other' }
  state.runs.set('other', other)
  rejects(planToolStarted, state, { ...dispatch('one'), runId: 'other' })
  rejects(planModelFinished, state, { ...finish(text('answer')), runId: 'other' })
  state = apply(planToolStarted, state, dispatch('one')).state
  state.runs.set('run', { ...state.runs.get('run'), status: 'cancelled', endedAt: at })
  rejects(planToolFinished, state, result('one'))
})

test('tool outcomes are isolated, bounded and sanitized without claiming undispatched effects', () => {
  const raw = { status: 'succeeded', output: { text: 'hello' } }
  const normalized = normalizeToolOutcome(raw, 100)
  normalized.output.text = 'changed'
  assert.equal(raw.output.text, 'hello')
  assert.throws(() => normalizeToolOutcome(raw, 1), isCode('LIMIT_EXCEEDED'))
  assert.throws(() => normalizeToolOutcome({ status: 'succeeded', output: NaN }, 100), isCode('INVALID_ARGUMENT'))
  assert.throws(() => normalizeToolOutcome({ status: 'invented' }, 100), isCode('TOOL_FAILED'))
  const privateError = { code: 'INTERNAL', message: 'secret', details: { key: 'secret' } }
  assert.deepEqual(normalizeToolOutcome({ status: 'failed', error: privateError }, 100), {
    status: 'failed', error: { code: 'TOOL_FAILED', message: 'tool execution did not succeed' },
  })
  assert.deepEqual(unconfirmedToolOutcome(false, privateError), { status: 'cancelled' })
  assert.deepEqual(unconfirmedToolOutcome(true, privateError), {
    status: 'uncertain', error: { code: 'INTERNAL', message: 'tool result could not be confirmed' },
  })
})

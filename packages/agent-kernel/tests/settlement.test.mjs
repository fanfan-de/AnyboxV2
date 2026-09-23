import assert from 'node:assert/strict'
import test from 'node:test'
import { planRunSettlement } from '../dist/domain/settlement.js'
import { planRecovery } from '../dist/domain/recovery.js'
import { emptyState } from '../dist/components/state/codec.js'
import { defaultLimits } from '../dist/shared/utils.js'
import { definition, isCode, text } from './helpers.mjs'

const createdAt = '2026-09-23T00:00:00.000Z'
const endedAt = '2026-09-23T00:00:01.000Z'
const deadlineAt = '2026-09-23T00:00:02.000Z'
const error = code => ({ code, message: code })
const input = (overrides = {}) => ({ runId: 'run', endedAt,
  final: { output: { content: text('answer') }, attemptId: 'attempt', messageId: 'answer' },
  toolResultMessageIds: new Map(), ...overrides })

function snapshot() {
  const state = emptyState()
  state.sessions.set('session', { id: 'session', agentId: 'agent', version: 2, createdAt })
  state.runs.set('run', { id: 'run', agentId: 'agent', sessionId: 'session', status: 'running',
    basis: { definition, limits: defaultLimits, tools: [], agentGeneration: 'generation' },
    inputMessageId: 'input', resultMessageIds: [], createdAt, deadlineAt, lastEventSeq: 1 })
  state.messages.set('input', { id: 'input', sessionId: 'session', runId: 'run', role: 'user', content: text('question'), createdAt })
  state.events.set('run', [{ runId: 'run', seq: 1, type: 'run.accepted', status: 'queued', createdAt }])
  state.steps.set('step', { id: 'step', runId: 'run', index: 1, attemptId: 'attempt', status: 'completed', toolCallIds: [] })
  state.attempts.set('attempt', { id: 'attempt', runId: 'run', stepId: 'step', status: 'succeeded', content: text('answer') })
  return state
}

function withTools() {
  const state = snapshot()
  const ids = ['pending', 'running', 'succeeded']
  state.steps.set('step', { ...state.steps.get('step'), status: 'tools', toolCallIds: ids })
  for (const status of ids) {
    state.toolCalls.set(status, { id: status, runId: 'run', stepId: 'step', toolRevision: 1, status,
      request: { type: 'tool-call', toolCallId: `protocol-${status}`, toolId: 'tool', input: {} },
      ...(status === 'succeeded' ? { outcome: { status, output: { saved: true } } } : {}) })
  }
  state.messages.set('saved-result', { id: 'saved-result', sessionId: 'session', runId: 'run', role: 'tool', createdAt,
    content: [{ type: 'tool-result', toolCallId: 'protocol-succeeded', outcome: state.toolCalls.get('succeeded').outcome }] })
  return state
}

const toolIds = () => new Map([['pending', 'pending-result'], ['running', 'running-result']])

for (const [name, overrides, status, code] of [
  ['successful execution', {}, 'completed'],
  ['execution failure', { executionError: error('MODEL_FAILED') }, 'failed', 'MODEL_FAILED'],
  ['deadline at equality', { endedAt: deadlineAt }, 'failed', 'LIMIT_EXCEEDED'],
  ['deadline wins over execution failure', { endedAt: deadlineAt, executionError: error('MODEL_FAILED') }, 'failed', 'LIMIT_EXCEEDED'],
  ['stop failure wins over deadline', { endedAt: deadlineAt, stop: { kind: 'failure', error: error('STATE_FAILED') } }, 'failed', 'STATE_FAILED'],
  ['accepted cancellation wins over deadline and execution failure', {
    endedAt: deadlineAt, stop: { kind: 'cancel', reason: 'user' }, executionError: error('MODEL_FAILED'),
  }, 'cancelled'],
  ['cleanup failure wins over cancellation', {
    stop: { kind: 'cancel' }, cleanupError: error('CLEANUP_FAILED'),
  }, 'failed', 'CLEANUP_FAILED'],
  ['cleanup failure wins over stop failure', {
    stop: { kind: 'failure', error: error('STATE_FAILED') }, cleanupError: error('CLEANUP_FAILED'),
  }, 'failed', 'CLEANUP_FAILED'],
]) test(`settlement precedence: ${name}`, () => {
  const { state, result } = planRunSettlement(snapshot(), input(overrides))
  assert.equal(result.status, status)
  assert.equal(result.error?.code, code)
  assert.equal(result.reason, overrides.stop?.kind === 'cancel' && status === 'cancelled' ? overrides.stop.reason : undefined)
  assert.equal(state.messages.has('answer'), status === 'completed')
  assert.deepEqual(result.resultMessageIds, status === 'completed' ? ['answer'] : [])
  assert.equal(state.sessions.get('session').version, 3)
})

test('settlement is deterministic, isolates all inputs, and settles a terminal Run only once', () => {
  const source = snapshot(), command = input()
  const original = structuredClone(source), originalCommand = structuredClone(command)
  const planned = planRunSettlement(source, command)
  assert.deepEqual(planRunSettlement(source, command), planned)
  assert.deepEqual(planRunSettlement(planned.state, input({ endedAt: deadlineAt, stop: { kind: 'cancel' } })).state, planned.state)
  assert.equal(planned.state.messages.get('answer').createdAt, endedAt)
  assert.equal(planned.state.events.get('run').at(-1).createdAt, endedAt)
  planned.state.messages.get('answer').content[0].text = 'changed'
  planned.state.runs.get('run').basis.definition.instructions = 'changed'
  planned.state.sessions.clear()
  assert.deepEqual(source, original)
  assert.deepEqual(command, originalCommand)
})

test('settlement closes unhandled tools once, preserves confirmed effects, and sequences its records atomically', () => {
  const source = withTools(), original = structuredClone(source)
  const command = input({ stop: { kind: 'cancel' }, toolResultMessageIds: toolIds() })
  const planned = planRunSettlement(source, command)
  const { state, result } = planned
  assert.deepEqual(source, original)
  assert.deepEqual([...state.toolCalls.values()].map(call => call.status), ['cancelled', 'uncertain', 'succeeded'])
  assert.equal(state.toolCalls.get('running').outcome.error.code, 'SETTLEMENT_FAILED')
  assert.deepEqual(state.toolCalls.get('succeeded'), source.toolCalls.get('succeeded'))
  assert.deepEqual(state.messages.get('saved-result'), source.messages.get('saved-result'))
  assert.equal(state.steps.get('step').status, 'cancelled')
  assert.equal(state.attempts.get('attempt').status, 'succeeded')
  assert.equal(state.messages.get('pending-result').content[0].toolCallId, 'protocol-pending')
  assert.equal(state.messages.get('running-result').content[0].outcome.status, 'uncertain')
  const events = state.events.get('run')
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5])
  assert.deepEqual(events.slice(1).map(event => [event.type, event.status]), [
    ['tool.finished', 'cancelled'], ['tool.finished', 'uncertain'], ['step.finished', 'cancelled'], ['run.finished', 'cancelled'],
  ])
  assert.ok(events.slice(1).every(event => event.createdAt === endedAt))
  assert.equal(result.lastEventSeq, 5)
  assert.deepEqual(planRunSettlement(state, command), planned)
})

test('normal settlement and recovery share record rules while retaining their distinct failure diagnostics', () => {
  const source = withTools(), original = structuredClone(source)
  source.steps.set('model-step', { id: 'model-step', runId: 'run', index: 2, attemptId: 'inflight', status: 'model', toolCallIds: [] })
  source.attempts.set('inflight', { id: 'inflight', runId: 'run', stepId: 'model-step', status: 'running' })
  const normal = planRunSettlement(source, input({ executionError: error('MODEL_FAILED'), toolResultMessageIds: toolIds() }))
  const recovered = planRecovery(source, endedAt)
  assert.equal(normal.state.attempts.get('inflight').status, 'failed')
  assert.equal(normal.state.attempts.get('inflight').error, undefined)
  assert.equal(recovered.state.attempts.get('inflight').error.code, 'INTERRUPTED')
  assert.equal(recovered.state.toolCalls.get('running').outcome.error.code, 'INTERRUPTED')
  assert.equal(recovered.state.toolCalls.get('pending').status, 'cancelled')
  assert.deepEqual(recovered.state.messages.get('saved-result'), original.messages.get('saved-result'))
  assert.equal(recovered.state.messages.get('recovered:running').content[0].outcome.status, 'uncertain')
  assert.equal(recovered.state.runs.get('run').status, 'interrupted')
  assert.equal(recovered.state.sessions.get('session').version, 3)
  assert.deepEqual(planRecovery(recovered.state, deadlineAt).state, recovered.state)
  assert.deepEqual(planRunSettlement(recovered.state, input()).state, recovered.state)
  assert.deepEqual(normal.state.events.get('run').map(event => event.type), recovered.state.events.get('run').map(event => event.type))
  assert.equal(source.attempts.get('inflight').status, 'running')
})

for (const [name, overrides] of [
  ['missing tool result ID', { toolResultMessageIds: new Map() }],
  ['colliding tool result IDs', { toolResultMessageIds: new Map([['pending', 'same'], ['running', 'same']]) }],
  ['existing tool message ID', { toolResultMessageIds: new Map([['pending', 'input']]) }],
]) test(`invalid settlement leaves the snapshot unchanged: ${name}`, () => {
  const source = withTools(), original = structuredClone(source)
  assert.throws(() => planRunSettlement(source, input({ stop: { kind: 'cancel' }, ...overrides })), isCode('INTERNAL'))
  assert.deepEqual(source, original)
})

test('completion requires a model result and a fresh message identity', () => {
  const source = snapshot(), original = structuredClone(source)
  assert.throws(() => planRunSettlement(source, input({ final: undefined })), isCode('INTERNAL'))
  assert.throws(() => planRunSettlement(source, input({ final: { ...input().final, messageId: 'input' } })), isCode('INTERNAL'))
  assert.deepEqual(source, original)
})

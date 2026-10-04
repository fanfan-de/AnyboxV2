import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTraceDuration, runTrace, traceElapsed } from '../dist/applications/harness/web/run-trace.js'
import { toolTrace } from '../dist/applications/harness/web/tool-trace.js'

const at = seconds => new Date(Date.UTC(2026, 9, 2, 1, 0, seconds)).toISOString()
const run = (status = 'completed', extra = {}) => ({ id: 'run', sessionId: 'session', input: 'Find the project', status,
  history: { kind: 'tree', parentNodeId: null }, revision: 1, createdAt: at(0), updatedAt: at(10),
  modelSnapshot: { remoteModelId: 'deepseek-chat', protocolId: 'chat-completions' }, ...extra })
const modelStart = (id, time) => ({ kind: 'operation-started', operationId: id, operationKind: 'model', at: at(time) })
const observed = (id, time) => ({ kind: 'operation-observed', operationId: id, at: at(time) })
const bash = (time, id = 'bash') => ({ kind: 'tool-started', id, requestId: id, name: 'bash', command: 'pwd', at: at(time) })
const bashResult = (time, id = 'bash', extra = {}) => ({ kind: 'tool-observed', requestId: id, name: 'bash',
  exitCode: 0, signal: null, stdout: '/project', stderr: '', truncated: false, at: at(time), ...extra })

test('native traces preserve event order and distinguish model calls, tools and other operations', () => {
  const events = [modelStart('exchange-1', 0), observed('exchange-1', 2), bash(2), bashResult(3),
    { kind: 'operation-started', operationId: 'bookkeeping', operationKind: 'operation', at: at(3) }, observed('bookkeeping', 4),
    modelStart('exchange-2', 4), observed('exchange-2', 9), { kind: 'terminal', at: at(10) }]
  const before = structuredClone(events), trace = runTrace(run(), events)
  assert.deepEqual(trace.steps.map(step => [step.kind, step.id, step.eventIndex]), [
    ['model', 'exchange-1', 0], ['tool', 'bash', 2], ['operation', 'bookkeeping', 4], ['model', 'exchange-2', 6],
  ])
  assert.deepEqual(trace.counts, { modelCalls: 2, toolCalls: 1 })
  assert.equal(trace.steps[0].state, 'completed'); assert.equal(trace.steps[0].finishedAt, at(2))
  assert.equal(trace.steps[1].call.finishedAt, at(3)); assert.equal(trace.steps[2].state, 'completed')
  assert.equal(trace.modelName, 'deepseek-chat'); assert.equal(trace.protocolId, 'chat-completions')
  assert.equal(trace.createdAt, at(0)); assert.equal(trace.finishedAt, at(10)); assert.equal(trace.elapsedMs, 10_000)
  assert.equal(trace.legacy, false); assert.deepEqual(events, before)
})

test('legacy model records do not infer exit from tools or the Run terminal state', () => {
  const events = [{ kind: 'model-started', at: at(0) },
    { kind: 'model-tool-calls', calls: [{ id: 'started', name: 'bash', command: 'pwd' }, { id: 'queued', name: 'bash', command: 'ls' }], at: at(1) },
    bash(2, 'started'), bashResult(3, 'started'), { kind: 'model-started', at: at(4) }, { kind: 'terminal', at: at(9) }]
  const trace = runTrace(run('failed', { history: { kind: 'legacy-unknown' }, modelSnapshot: null }), events)
  assert.equal(trace.legacy, true); assert.equal(trace.modelName, undefined); assert.equal(trace.protocolId, undefined)
  assert.deepEqual(trace.counts, { modelCalls: 2, toolCalls: 1 })
  for (const step of trace.steps.filter(step => step.kind === 'model')) {
    assert.equal(step.state, 'recorded'); assert.equal(step.legacy, true); assert.equal(step.finishedAt, undefined)
  }
  const queued = trace.steps.find(step => step.kind === 'tool' && step.id === 'queued').call
  assert.equal(queued.state, 'skipped'); assert.equal(queued.startedAt, undefined); assert.equal(queued.finishedAt, undefined)
})

test('cancellation preserves observed model and tool outcomes and closes only unresolved work', () => {
  for (const status of ['cancelled', 'interrupted']) {
    const result = { status: 'cancelled', changes: [{ kind: 'added', path: '/project/saved.txt' }], pending: [] }
    const trace = runTrace(run(status), [modelStart('completed', 0), observed('completed', 1),
      modelStart('failed', 1), { kind: 'operation-failed', operationId: 'failed', category: 'provider-failure', at: at(2) },
      { kind: 'tool-started', name: 'apply_patch', id: 'patch', requestId: 'patch', patch: 'patch', patchTruncated: false, at: at(3) },
      { kind: 'tool-observed', name: 'apply_patch', requestId: 'patch', result, at: at(4) },
      modelStart('unresolved', 5), bash(6), { kind: status === 'interrupted' ? 'interrupted' : 'terminal', at: at(10) }])
    assert.equal(trace.steps[0].state, 'completed'); assert.equal(trace.steps[0].finishedAt, at(1))
    assert.equal(trace.steps[1].state, 'failed'); assert.equal(trace.steps[1].category, 'provider-failure')
    assert.equal(trace.steps[2].call.result, result); assert.equal(trace.steps[2].call.finishedAt, at(4))
    assert.equal(trace.steps[3].state, status); assert.equal(trace.steps[3].finishedAt, undefined)
    assert.equal(trace.steps[4].call.state, status); assert.equal(trace.steps[4].call.finishedAt, undefined)
  }
})

test('tool observations retain separate timestamps when a provider reuses request IDs', () => {
  const calls = toolTrace(run(), [bash(1, 'reused'), bashResult(2, 'reused'), bash(3, 'reused'), bashResult(6, 'reused', { exitCode: 1 }),
    { kind: 'tool-failed', name: 'bash', requestId: 'reused', category: 'tool-cleanup-failure', at: at(7) }])
  assert.deepEqual(calls.map(call => [call.eventIndex, call.startedAt, call.finishedAt]), [[0, at(1), at(2)], [2, at(3), at(7)]])
  assert.equal(calls[0].state, 'completed'); assert.equal(calls[1].state, 'failed'); assert.equal(calls[1].exitCode, 1)
  const untimed = toolTrace({ status: 'completed' }, [{ ...bash(0), at: undefined }, { ...bashResult(0), at: undefined }])[0]
  assert.equal(untimed.startedAt, undefined); assert.equal(untimed.finishedAt, undefined)
})

test('Run timing uses terminal facts and omits unavailable or invalid durations', () => {
  assert.equal(runTrace(run('running'), [modelStart('working', 1)]).elapsedMs, undefined)
  assert.equal(runTrace(run('cancelling'), [modelStart('working', 1)]).finishedAt, undefined)
  assert.equal(runTrace(run('completed', { updatedAt: undefined }), [{ kind: 'terminal', at: at(8) }]).elapsedMs, 8000)
  assert.equal(runTrace(run('interrupted', { updatedAt: undefined }), [{ kind: 'interrupted', at: at(7) }]).elapsedMs, undefined)
  assert.equal(runTrace(run('completed', { updatedAt: at(-1) }), []).elapsedMs, undefined)
  assert.equal(runTrace(run('completed', { createdAt: 'unknown', updatedAt: 'unknown' }), []).elapsedMs, undefined)
  const missingObservation = runTrace(run(), [modelStart('unknown-exit', 1)]).steps[0]
  assert.equal(missingObservation.state, 'recorded'); assert.equal(missingObservation.finishedAt, undefined)
})

test('unobserved steps and recovered interruption never claim an actual exit time', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const trace = runTrace(run(status, { updatedAt: '2026-10-03T01:00:00.000Z' }), [
      modelStart('unobserved', 0), bash(2), { kind: status === 'interrupted' ? 'interrupted' : 'terminal', at: at(10) },
    ])
    assert.equal(trace.steps[0].state, status); assert.equal(trace.steps[0].finishedAt, undefined)
    assert.equal(trace.steps[1].call.state, status); assert.equal(trace.steps[1].call.finishedAt, undefined)
    if (status === 'interrupted') { assert.equal(trace.finishedAt, undefined); assert.equal(trace.elapsedMs, undefined) }
  }
})

test('duration helpers reject invalid and backwards time without displaying NaN', () => {
  for (const [start, end] of [[undefined, at(0)], [at(0), undefined], ['', at(1)], ['invalid', at(1)], [at(1), 'invalid'], [at(2), at(1)]])
    assert.equal(traceElapsed(start, end), undefined)
  assert.equal(traceElapsed(at(0), at(0)), 0); assert.equal(traceElapsed(at(0), at(2)), 2000)
  assert.deepEqual([0, 12, 1000, 1250, 61_000, 3_600_000, NaN, Infinity, -1].map(formatTraceDuration),
    ['0 ms', '12 ms', '1 s', '1.3 s', '1 min 1 s', '1 h 0 min', '—', '—', '—'])
})

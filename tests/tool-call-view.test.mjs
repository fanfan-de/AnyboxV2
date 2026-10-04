import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeToolRequest } from '../dist/applications/harness/web/tool-call-view.js'

const request = (name = 'bash', arguments_ = '{"command":"requested-command"}') => ({ id: 'request', name, arguments: arguments_ })
const bash = (state, extra = {}) => ({ id: 'call', name: 'bash', state, command: 'real-command', ...extra })
const patch = (state, extra = {}) => ({ id: 'call', name: 'apply_patch', state, patch: 'not a source of file-count facts', patchTruncated: false, ...extra })

test('tool summaries use durable execution facts and valid real timing', () => {
  const result = summarizeToolRequest(request(), bash('completed', { exitCode: 0, startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:02.300Z' }))
  assert.equal(result.title, 'Bash'); assert.equal(result.preview, 'real-command')
  assert.equal(result.statusLabel, '已完成'); assert.equal(result.success, true)
  assert.equal(result.attention, false); assert.equal(result.busy, false); assert.equal(result.elapsedMs, 2300)
  for (const extra of [{}, { startedAt: 'invalid', finishedAt: '2026-10-04T00:00:02Z' },
    { startedAt: '2026-10-04T00:00:02Z', finishedAt: '2026-10-04T00:00:01Z' }]) {
    assert.equal(summarizeToolRequest(request(), bash('completed', extra)).elapsedMs, undefined)
  }
  assert.equal(summarizeToolRequest(request(), bash('running', { startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:02Z' })).elapsedMs, undefined)
})

test('tool summaries distinguish in-flight, failed and unresolved execution states', () => {
  const cases = [
    ['queued', {}, /等待/, false, true], ['running', {}, /执行中/, false, true],
    ['failed', { exitCode: 1 }, /非零退出/, true, false], ['failed', { signal: 'SIGTERM' }, /信号终止/, true, false],
    ['failed', { category: 'start-failed' }, /执行失败/, true, false],
    ['skipped', {}, /未执行/, true, false], ['cancelled', {}, /已取消/, true, false], ['interrupted', {}, /中断/, true, false],
  ]
  for (const [state, extra, label, attention, busy] of cases) {
    const result = summarizeToolRequest(request(), bash(state, extra))
    assert.match(result.statusLabel, label, state); assert.equal(result.attention, attention, state); assert.equal(result.busy, busy, state)
    assert.equal(result.success, false, state)
  }
  assert.match(summarizeToolRequest(request(), bash('failed', { exitCode: 1, stderr: 'Invented root cause' })).shortReason, /退出码：1/)
  assert.doesNotMatch(summarizeToolRequest(request(), bash('failed', { exitCode: 1, stderr: 'Invented root cause' })).shortReason, /Invented/)
  assert.match(summarizeToolRequest(request(), bash('failed', { signal: 'SIGTERM' })).shortReason, /SIGTERM/)
  assert.match(summarizeToolRequest(request(), bash('failed', { category: 'start-failed', exitCode: 2 })).shortReason, /start-failed/)
  for (const [readiness, label, attention, awaiting] of [['loading', '执行事实待同步', false, true], ['ready', '执行结果未记录', true, false], ['failed', '执行记录读取失败', true, false]]) {
    const result = summarizeToolRequest(request(), undefined, readiness)
    assert.equal(result.statusLabel, label); assert.equal(result.attention, attention); assert.equal(result.awaitingFacts, awaiting)
    assert.equal(result.success, false)
  }
})

test('request-only summaries expose known complete fields without guessing partial arguments', () => {
  assert.equal(summarizeToolRequest(request()).preview, 'requested-command')
  assert.match(summarizeToolRequest(request('bash', '{"command":')).preview, /参数生成中/)
  assert.match(summarizeToolRequest(request('bash', '{"other":"ignore"}')).preview, /参数|请求/)
  const unknown = summarizeToolRequest(request('<unknown-tool>', '{"command":"do not guess","secret":"hidden"}'))
  assert.equal(unknown.title, '<unknown-tool>'); assert.doesNotMatch(unknown.preview, /do not guess|hidden/)
  assert.equal(summarizeToolRequest(request('apply_patch', '{"patch":"*** Add File: guessed.txt"}')).preview, '补丁请求')
})

test('loaded events without a tool fact remain pending during an active Run and become missing only after it exits', () => {
  for (const runStatus of ['running', 'cancelling']) {
    const pending = summarizeToolRequest(request(), undefined, 'ready', runStatus)
    assert.equal(pending.statusLabel, '执行事实待同步'); assert.equal(pending.awaitingFacts, true)
    assert.equal(pending.attention, false); assert.equal(pending.tone, 'neutral'); assert.equal(pending.shortReason, undefined)
    const failedRead = summarizeToolRequest(request(), undefined, 'failed', runStatus)
    assert.equal(failedRead.statusLabel, '执行记录读取失败'); assert.equal(failedRead.attention, true); assert.equal(failedRead.tone, 'warning')
  }
  for (const runStatus of ['completed', 'failed', 'cancelled', 'interrupted']) {
    const missing = summarizeToolRequest(request(), undefined, 'ready', runStatus)
    assert.equal(missing.statusLabel, '执行结果未记录'); assert.equal(missing.awaitingFacts, false)
    assert.equal(missing.attention, true); assert.equal(missing.tone, 'warning')
  }
})

test('patch summaries count actual changes and pending operations and prioritize diagnostics', () => {
  const result = { status: 'partial', changes: [{ kind: 'updated', path: '/p/a' }], pending: [{ kind: 'delete', path: '/p/b' }, { kind: 'update', path: '/p/c' }],
    diagnostic: { code: 'commit-failed', message: 'Permission denied', path: '/p/c' } }
  const summary = summarizeToolRequest(request('apply_patch'), patch('partial', { result, category: 'cleanup-failed' }))
  assert.equal(summary.title, 'Apply Patch'); assert.equal(summary.statusLabel, '部分完成')
  assert.match(summary.preview, /已变更 1 个文件/); assert.match(summary.preview, /2 项未完成/)
  assert.match(summary.shortReason, /commit-failed.*Permission denied/); assert.equal(summary.attention, true)
  const success = summarizeToolRequest(request('apply_patch'), patch('applied', { result: { status: 'applied', changes: [{ kind: 'added', path: '/p/a' }, { kind: 'deleted', path: '/p/b' }], pending: [] } }))
  assert.equal(success.statusLabel, '已应用'); assert.match(success.preview, /2 个文件/); assert.equal(success.success, true)
  for (const status of ['rejected', 'cancelled']) assert.equal(summarizeToolRequest(request('apply_patch'), patch(status, { result: { status, changes: [], pending: [] } })).attention, true)
})

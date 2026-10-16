import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRoute, formatRoute, selectDevice, deviceLabel, messageFor, displayItems, formatUsage, groupThreads, threadIndicator, relativeTime } from '../dist/applications/claude-agent/web/state.js'
import { createApplicationCatalog } from '../dist/host/applications/registration.js'
import { shellAssets } from '../dist/host/assets.js'
import { claudeAgentClientApplication } from '../dist/applications/claude-agent/client/registration.js'
import { harnessClientApplication } from '../dist/applications/harness/registration.js'

test('routes pin the device and thread, reject malformed segments and round-trip encoding', () => {
  assert.deepEqual(parseRoute(''), {}); assert.deepEqual(parseRoute('host/abc'), { hostId: 'abc' })
  assert.deepEqual(parseRoute('host/11111111-1111-4111-8111-111111111111/thread/t-1'), { hostId: '11111111-1111-4111-8111-111111111111', threadId: 't-1' })
  assert.deepEqual(parseRoute('host/a%2Fb/thread/t'), {}); assert.deepEqual(parseRoute('workspace'), {}); assert.deepEqual(parseRoute('host/%E0%A4%A'), {})
  assert.equal(formatRoute({ hostId: 'h', threadId: 't:1' }), 'host/h/thread/t%3A1'); assert.equal(formatRoute({}), '')
  assert.deepEqual(parseRoute(formatRoute({ hostId: 'h', threadId: 't:1' })), { hostId: 'h', threadId: 't:1' })
})
test('device selection prefers the route, then the remembered device, then the first one, and labels the local device', () => {
  const devices = [{ id: 'a', name: 'Laptop', instanceId: 'ia' }, { id: 'b', name: 'Server', instanceId: 'ib' }]
  assert.equal(selectDevice(devices, { hostId: 'ib' }, 'a').id, 'b'); assert.equal(selectDevice(devices, {}, 'b').id, 'b'); assert.equal(selectDevice(devices, { hostId: 'missing' }, null).id, 'a')
  assert.equal(selectDevice(devices, {}, null, 'ib').id, 'b', 'this machine wins over the first registered device'); assert.equal(selectDevice(devices, {}, 'a', 'ib').id, 'a', 'a remembered choice wins over this machine')
  assert.equal(selectDevice([], {}, 'a'), undefined)
  assert.match(messageFor(Object.assign(new Error('product-not-found'), { status: 404, code: 'product-not-found' })), /升级/)
  assert.equal(deviceLabel(devices[0], 'ia'), '本地 · Laptop'); assert.equal(deviceLabel(devices[1], 'ia'), 'Server')
})
test('error copy prefers the product\'s own message and never mentions Claude Code', () => {
  const error = Object.assign(new Error('未找到 `claude` 命令。'), { status: 503, code: 'claude-binary-missing' })
  assert.equal(messageFor(error), '未找到 `claude` 命令。')
  assert.match(messageFor(Object.assign(new Error('run-active'), { status: 409, code: 'run-active' })), /正在执行/)
  assert.match(messageFor(Object.assign(new Error('weird'), { status: 500, code: 'weird' })), /weird/)
  assert.match(messageFor(new TypeError('fetch failed')), /无法连接执行设备/)
  for (const key of ['claude-binary-missing', 'claude-binary-shim', 'product-unavailable']) assert.doesNotMatch(messageFor(Object.assign(new Error(key), { status: 503, code: key })), /Claude Code/)
})
test('the transcript shows history, then the running prompt and live projection, and summarizes usage', () => {
  const history = [{ id: 'h1', role: 'user', blocks: [{ kind: 'text', text: 'hi', truncated: false }] }]
  const live = { schemaVersion: 1, runId: 'r', threadId: 't', seq: 3, init: null, approvals: [], notices: [], modelStatus: null, result: null, error: null,
    items: [{ id: 'm', role: 'assistant', blocks: [{ block: { kind: 'text', text: 'Hel', truncated: false }, state: 'streaming' }] }] }
  assert.deepEqual(displayItems(history, undefined, 'ignored').map(item => item.id), ['h1'])
  const items = displayItems(history, live, 'next prompt')
  assert.deepEqual(items.map(item => [item.id, item.role, item.streaming]), [['h1', 'user', false], ['live:r:prompt', 'user', false], ['live:m', 'assistant', true]])
  assert.equal(items[1].blocks[0].text, 'next prompt')
  assert.equal(formatUsage({ subtype: 'success', isError: false, durationMs: 1500, durationApiMs: 1000, numTurns: 2, totalCostUsd: 0.0042, stopReason: null, usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 } }), '2 轮 · 1.5 秒 · 110 输入 / 5 输出 tokens · 约 $0.0042')
})
test('the client registration publishes an exact asset map beside Anybox Harness without overlapping paths', () => {
  const catalog = createApplicationCatalog([harnessClientApplication(), claudeAgentClientApplication()], shellAssets)
  assert.deepEqual(catalog.applications.map(app => app.definition.id), ['agent', 'claude-agent'])
  const claude = catalog.applications[1]
  assert.equal(claude.definition.web.entry, '/applications/claude-agent/web/app.js'); assert.deepEqual(claude.definition.web.styles, ['/apps/claude-agent/style.css'])
  assert.ok(catalog.assets.has('/applications/claude-agent/core/events.js')); assert.equal(catalog.assets.has('/applications/claude-agent/core/sdk/adapter.js'), false)
  assert.equal(claude.definition.description.includes('Claude Code'), false); assert.match(claude.definition.description, /Powered by Claude/)
})
test('threads group by project directory with the newest group and thread first, and indicators rank approvals over running', () => {
  const thread = (id, projectPath, updatedAt, lastRun = null, pendingApprovals = 0) => ({ id, projectPath, title: id, updatedAt, lastRun, pendingApprovals })
  const groups = groupThreads([
    thread('a1', '/w/alpha', '2026-10-16T00:00:01.000Z'), thread('b1', '/w/beta', '2026-10-16T00:00:05.000Z', { id: 'r', status: 'running' }, 1),
    thread('a2', '/w/alpha', '2026-10-16T00:00:03.000Z', { id: 'r', status: 'failed' }), thread('c1', '/', '2026-10-16T00:00:02.000Z'),
  ])
  assert.deepEqual(groups.map(group => [group.path, group.name, group.updatedAt, group.threads.map(item => item.id)]), [
    ['/w/beta', 'beta', '2026-10-16T00:00:05.000Z', ['b1']], ['/w/alpha', 'alpha', '2026-10-16T00:00:03.000Z', ['a2', 'a1']], ['/', '/', '2026-10-16T00:00:02.000Z', ['c1']]])
  assert.equal(threadIndicator(groups[0].threads[0]), 'approval'); assert.equal(threadIndicator(thread('x', '/', '', { id: 'r', status: 'running' })), 'running')
  assert.equal(threadIndicator(thread('x', '/', '', { id: 'r', status: 'cancelling' }, 0)), 'running'); assert.equal(threadIndicator(groups[1].threads[0]), 'failed')
  assert.equal(threadIndicator(thread('x', '/', '', { id: 'r', status: 'interrupted' })), 'failed'); assert.equal(threadIndicator(thread('x', '/', '', { id: 'r', status: 'completed' })), null)
  assert.equal(threadIndicator(thread('x', '/', '', { id: 'r', status: 'completed' }, 3)), null, 'stale counts never show on finished runs'); assert.equal(threadIndicator(thread('x', '/', '')), null)
  assert.deepEqual(groupThreads([]), [])
})
test('relative times are coarse, explicit about now and fall back to a date', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z')
  assert.equal(relativeTime('2026-10-16T11:59:40.000Z', now), '刚刚'); assert.equal(relativeTime('2026-10-16T11:45:00.000Z', now), '15 分钟前')
  assert.equal(relativeTime('2026-10-16T09:00:00.000Z', now), '3 小时前'); assert.equal(relativeTime('2026-10-15T11:00:00.000Z', now), '昨天')
  assert.equal(relativeTime('2026-10-10T12:00:00.000Z', now), '6 天前'); assert.match(relativeTime('2026-08-01T12:00:00.000Z', now), /^2026-08-0[12]$/)
  assert.equal(relativeTime('garbage', now), ''); assert.equal(relativeTime('2026-10-16T13:00:00.000Z', now), '刚刚', 'clock skew never produces negative times')
})

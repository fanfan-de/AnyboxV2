import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApplicationHttpServer } from '../packages/host/dist/http-server.js'
import { createApplicationCatalog } from '../packages/host/dist/applications/registration.js'
import { createExecutionHost } from '../packages/host/dist/execution.js'
import { claudeAgentDefinition, claudeAgentServerHttp } from '../packages/app-claude-agent/dist/definition.js'
import { createClaudeAgentHttpComponent } from '../packages/app-claude-agent/dist/http/component.js'
import { claudeAgentServerApplication } from '../packages/app-claude-agent/dist/registration.js'
import { claudeAgentSdkServiceKey } from '../packages/app-claude-agent/dist/core/sdk/port.js'
import { createRunsFixture, fakeSdk, sampleResult, tick, waitFor } from './helpers/claude-agent.mjs'

async function httpFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-http-'))
  const f = await createRunsFixture(join(directory, 'claude-agent.sqlite'), options)
  await f.root.installComponent(createClaudeAgentHttpComponent(f.root))
  const catalog = createApplicationCatalog([{ definition: claudeAgentDefinition, http: claudeAgentServerHttp, createRuntime() { throw new Error('fixture already installed') } }])
  const server = await startApplicationHttpServer({ catalog, service: key => f.root.get(key), port: 0 })
  t.after(async () => { await server.close(); await f.close(); await rm(directory, { recursive: true, force: true }) })
  const api = async (method, path, body) => {
    const response = await fetch(`${server.url}/api/v1/apps/claude-agent${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: server.url }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { ...f, server, api }
}
async function events(url, threadIds) {
  const response = await fetch(`${url}/api/v1/apps/claude-agent/events?${new URLSearchParams(threadIds.map(id => ['threadId', id]))}`)
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  const read = async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        if (event) return { event, data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]) }
        continue
      }
      const next = await reader.read()
      if (next.done) throw new Error('stream ended')
      buffer += decoder.decode(next.value, { stream: true })
    }
  }
  return { read, close: () => reader.cancel().catch(() => {}) }
}
const permission = (toolUseId, extra = {}) => ({ toolUseId, toolName: 'Bash', input: { command: 'ls' }, title: 'Run ls', description: null, reason: null, defaultToNo: false, allowSessionAvailable: true, questions: null, signal: new AbortController().signal, ...extra })

test('workspace routes preserve thread identity, validate queries and bodies, and expose native history and safe configuration', async t => {
  const sdk = fakeSdk(), inspections = []
  sdk.port.inspectSession = async (request, input) => { inspections.push({ request, input }); return input.action === 'context' ? { schemaVersion: 1, model: 'test', totalTokens: 4, maxTokens: 100, percentage: 4, estimated: true, categories: [] } : input.action === 'file' ? { path: '/a/readme.md', contents: 'read me', truncated: false } : { schemaVersion: 1, source: 'project', permissionMode: 'default', skills: [], agents: [], mcp: [] } }
  sdk.port.listSubagents = async () => ['child']
  sdk.port.readSubagentMessages = async (_id, _dir, _agent, offset) => ({ messages: [{ id: String(offset), role: 'assistant', blocks: [] }], hasMore: false })
  const f = await httpFixture(t, { sdk }), thread = (await f.api('POST', '/threads', { projectPath: '/a' })).data, base = `/threads/${thread.id}`
  await f.store.updateThread(thread.id, { nativeSessionId: '11111111-1111-4111-8111-111111111111' }, new Date().toISOString())
  assert.equal((await f.api('POST', `${base}/options`, { maxBudgetUsd: 2, maxTurns: 6, revision: 0 })).status, 200)
  assert.equal((await f.api('POST', `${base}/options`, { apiKey: 'secret' })).status, 400)
  assert.equal((await f.api('GET', `${base}/context?unknown=1`)).status, 400)
  assert.equal((await f.api('GET', `${base}/context`)).data.totalTokens, 4)
  assert.equal(inspections[0].request.cwd, '/a')
  assert.deepEqual((await f.api('GET', `${base}/agents`)).data, ['child'])
  assert.equal((await f.api('GET', `${base}/agents/child/messages?offset=100`)).data.messages[0].id, '100')
  assert.equal((await f.api('GET', `${base}/agents/child/messages?offset=-1`)).status, 400)
  assert.equal((await f.api('GET', `${base}/agents/foreign/messages`)).status, 404)
  assert.equal((await f.api('GET', `${base}/file?path=readme.md`)).data.contents, 'read me')
  assert.equal((await f.api('GET', `${base}/file?path=a&path=b`)).status, 400)
  assert.equal((await f.api('POST', `${base}/rewind`, { checkpointId: 'foreign', dryRun: false, idempotencyKey: 'x' })).status, 404)
  assert.deepEqual((await f.api('GET', `${base}/interactions`)).data, [])
  assert.equal((await f.api('POST', `${base}/interactions/foreign`, { action: 'accept' })).status, 409)
  const connected = await f.api('POST', `${base}/mcp/connect`, {})
  assert.equal(connected.status, 202)
  await f.runs.waitConnectionJob(connected.data.id)
  assert.equal((await f.api('GET', `${base}/mcp/jobs/${connected.data.id}`)).data.status, 'completed')
  assert.equal((await f.api('GET', `${base}/mcp/jobs`)).data.length, 1)
})

test('HTTP exposes the environment, threads, runs, live views, approvals and SSE with whitelisted DTOs', async t => {
  const f = await httpFixture(t, { directoryExists: async path => path === '/projects/demo' })
  assert.deepEqual((await f.api('GET', '/environment')).data, { schemaVersion: 1, platform: 'darwin', executable: { path: '/fake/bin/claude', source: 'path' } })
  assert.equal((await f.api('POST', '/threads', { projectPath: 'relative' })).data.error.code, 'project-path-invalid')
  assert.equal((await f.api('POST', '/threads', { projectPath: '/projects/other' })).status, 404)
  assert.equal((await f.api('POST', '/threads', { projectPath: '/projects/demo', extra: 1 })).status, 400)
  const created = await f.api('POST', '/threads', { projectPath: '/projects/demo', title: 'Demo' })
  assert.equal(created.status, 201); assert.deepEqual(Object.keys(created.data).sort(), ['archived', 'createdAt', 'forkedFrom', 'id', 'lastRun', 'nativeSessionId', 'options', 'optionsRevision', 'pendingApprovals', 'permissionMode', 'projectPath', 'schemaVersion', 'tag', 'title', 'titleSource', 'updatedAt'])
  assert.equal(created.data.titleSource, 'user')
  const thread = created.data
  assert.deepEqual((await f.api('GET', '/threads')).data.map(item => item.id), [thread.id])
  assert.equal((await f.api('GET', '/threads/missing')).status, 404); assert.equal((await f.api('GET', '/threads/missing/runs')).status, 404)
  assert.equal((await f.api('GET', `/threads/${thread.id}?x=1`)).status, 400)
  assert.deepEqual((await f.api('GET', `/threads/${thread.id}/messages`)).data, { nativeSessionId: null, messages: [] })
  const stream = await events(f.server.url, [thread.id, 'other'])
  assert.deepEqual(await stream.read(), { event: 'ready', data: {} })
  const started = await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'hello', idempotencyKey: 'k1', effort: 'medium' })
  assert.equal(started.status, 202); assert.equal(started.data.status, 'running'); assert.equal(started.data.effort, 'medium')
  assert.equal((await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'hello', idempotencyKey: 'k1' })).data.id, started.data.id)
  assert.deepEqual((await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'again', idempotencyKey: 'k2' })).data.error, { code: 'run-active', message: 'This thread already has a running task.' })
  assert.deepEqual(await stream.read(), { event: 'run-changed', data: { threadId: thread.id, runId: started.data.id, status: 'running', seq: 0 } })
  const active = f.sdk.runs[0]
  active.hooks.onEvent({ type: 'init', init: { nativeSessionId: 'sess', model: 'm', cwd: '/projects/demo', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 1 } })
  active.hooks.onEvent({ type: 'message-start', messageId: 'm1' })
  const frame = await stream.read()
  assert.equal(frame.event, 'run-event'); assert.deepEqual(frame.data, { threadId: thread.id, runId: started.data.id, seq: 1, event: { type: 'init', init: { nativeSessionId: 'sess', model: 'm', cwd: '/projects/demo', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 1 } } })
  assert.equal((await stream.read()).data.seq, 2)
  const view = await f.api('GET', `/runs/${started.data.id}/view`)
  assert.equal(view.status, 200); assert.equal(view.data.seq, 2); assert.equal(view.data.init.nativeSessionId, 'sess'); assert.equal(view.data.items[0].id, 'm1')
  const decision = active.hooks.canUseTool(permission('t1'))
  await waitFor(() => f.runs.listPendingApprovals(thread.id).length === 1)
  const pending = (await f.api('GET', `/threads/${thread.id}/approvals`)).data
  assert.equal(pending.length, 1); assert.equal(pending[0].toolName, 'Bash'); assert.equal(pending[0].decision, null)
  assert.equal((await f.api('GET', `/threads/${thread.id}`)).data.pendingApprovals, 1, 'the thread view counts approvals waiting in memory')
  assert.equal((await stream.read()).data.event.type, 'approval-requested')
  assert.equal((await f.api('POST', `/approvals/${pending[0].id}`, { decision: 'maybe' })).status, 400)
  const resolved = await f.api('POST', `/approvals/${pending[0].id}`, { decision: 'allow' })
  assert.equal(resolved.status, 200); assert.equal(resolved.data.decision, 'allow')
  assert.deepEqual(await decision, { behavior: 'allow', session: false })
  assert.equal((await f.api('POST', `/approvals/${pending[0].id}`, { decision: 'deny' })).status, 409)
  assert.equal((await stream.read()).data.event.type, 'approval-resolved')
  const waited = await f.api('GET', `/runs/${started.data.id}/wait?timeoutMs=20`)
  assert.deepEqual({ done: waited.data.done, timedOut: waited.data.timedOut, status: waited.data.run.status }, { done: false, timedOut: true, status: 'running' })
  assert.equal((await f.api('GET', `/runs/${started.data.id}/wait?timeoutMs=99999`)).status, 400)
  const cancelled = await f.api('POST', `/runs/${started.data.id}/cancel`, {})
  assert.equal(cancelled.data.status, 'cancelling')
  assert.deepEqual(await stream.read(), { event: 'run-changed', data: { threadId: thread.id, runId: started.data.id, status: 'cancelling', seq: 4 } })
  await waitFor(() => active.interrupts === 1)
  active.finish({ kind: 'result', result: sampleResult({ isError: true, text: 'interrupted' }) }); active.exit()
  const finished = await f.api('GET', `/runs/${started.data.id}/wait`)
  assert.deepEqual({ done: finished.data.done, timedOut: finished.data.timedOut, status: finished.data.run.status }, { done: true, timedOut: false, status: 'cancelled' })
  assert.deepEqual(await stream.read(), { event: 'run-changed', data: { threadId: thread.id, runId: started.data.id, status: 'cancelled', seq: 4 } })
  assert.equal((await f.api('GET', `/runs/${started.data.id}`)).data.status, 'cancelled')
  assert.equal((await f.api('GET', '/runs/missing')).status, 404); assert.equal((await f.api('GET', '/runs/missing/view')).data.error.code, 'run-not-found')
  assert.equal((await f.api('POST', '/runs/missing/cancel', {})).status, 404)
  assert.deepEqual((await f.api('GET', `/threads/${thread.id}/runs`)).data.map(run => run.status), ['cancelled'])
  assert.equal((await f.api('GET', `/threads/${thread.id}`)).data.nativeSessionId, 'sess')
  assert.deepEqual((await f.api('GET', '/models/recent')).data, { schemaVersion: 1, models: ['m'] }, 'the reported model of the run is suggested')
  assert.equal((await f.api('GET', '/models/recent?x=1')).status, 400)
  assert.equal((await fetch(`${f.server.url}/api/v1/apps/claude-agent/events`)).status, 400)
  assert.equal((await fetch(`${f.server.url}/api/v1/apps/claude-agent/events?threadId=a&threadId=a`)).status, 400)
  await stream.close()
})
test('a missing executable is reported with its message and run acceptance survives a lost browser', async t => {
  const missing = fakeSdk({ environment: { schemaVersion: 1, platform: 'linux', executable: { path: null, source: null, error: { code: 'claude-binary-missing', message: '未找到 `claude` 命令。' } } } })
  const f = await httpFixture(t, { sdk: missing })
  const thread = (await f.api('POST', '/threads', { projectPath: '/p' })).data
  const rejected = await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'x', idempotencyKey: 'k' })
  assert.equal(rejected.status, 503); assert.deepEqual(rejected.data.error, { code: 'claude-binary-missing', message: '未找到 `claude` 命令。' })
  assert.equal((await f.api('GET', '/environment')).data.executable.error.code, 'claude-binary-missing')
})
test('the registered execution application guards stops while a run is active, advertises its capability and joins on close', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-host-'))
  const sdk = fakeSdk({ onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'terminated' } }); setTimeout(() => run.exit(), 10) } })
  const sdkComponent = { name: 'fake-claude-agent-sdk', apply(ctx) { ctx.provide(claudeAgentSdkServiceKey, sdk.port) } }
  const applications = [claudeAgentServerApplication({}, { sdkComponent, runs: { directoryExists: async () => true, cancel: { interruptTimeoutMs: 5, resultTimeoutMs: 10, exitTimeoutMs: 10 } } })]
  let host = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications })
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }) })
  await host.ready
  const token = (await host.root.get('host.access').issue('test')).token
  const request = async (path, body) => {
    const response = await fetch(host.url + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Anybox-Instance-Id': host.instance.instanceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  assert.ok((await request('/instance')).data.capabilities.includes('claude-agent.v1'))
  assert.equal((await request('/apps/claude-agent/environment')).status, 503, 'the application is closed until opened')
  assert.equal((await request('/products/claude-agent/open', {})).data.state, 'running')
  assert.ok(host.root.get('claude-agent.runs')); assert.equal(host.root.get('models'), undefined); assert.equal(host.root.get('harness.runs'), undefined)
  const thread = (await request('/apps/claude-agent/threads', { projectPath: '/p' })).data
  const run = (await request(`/apps/claude-agent/threads/${thread.id}/runs`, { prompt: 'work', idempotencyKey: 'k' })).data
  assert.equal(run.status, 'running')
  assert.equal((await request('/products/claude-agent/stop', {})).data.error.code, 'product-busy')
  assert.equal(host.products.get('claude-agent').state, 'running')
  sdk.runs[0].finish({ kind: 'result', result: sampleResult() }); sdk.runs[0].exit()
  assert.equal((await request(`/apps/claude-agent/runs/${run.id}/wait`)).data.run.status, 'completed')
  assert.equal((await request('/products/claude-agent/stop', {})).data.state, 'disabled')
  assert.equal(host.root.get('claude-agent.runs'), undefined); assert.equal(host.root.get('claude-agent.store'), undefined)
  assert.equal((await request('/products/claude-agent/open', {})).data.state, 'running')
  assert.equal((await request(`/apps/claude-agent/threads/${thread.id}`)).data.lastRun.status, 'completed', 'the index survives application restarts')
  const second = (await request(`/apps/claude-agent/threads/${thread.id}/runs`, { prompt: 'long', idempotencyKey: 'k2' })).data
  assert.equal(second.status, 'running')
  let closed = false
  const closing = host.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  await closing
  assert.ok(sdk.runs[1].closed, 'closing the host terminates the active run')
  host = undefined
  host = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications })
  await host.ready
  await waitFor(() => host.products.get('claude-agent').state === 'running')
  assert.equal((await host.root.get('claude-agent.runs').getRun(second.id)).status, 'cancelled')
})
test('recent projects and directory browsing are served with bounded query parameters', async t => {
  const home = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'work')); await mkdir(join(home, 'work', 'app')); await mkdir(join(home, '.config'))
  const sdk = fakeSdk({ sessionProjects: async () => [{ path: join(home, 'work'), lastUsedAt: '2026-10-15T00:00:00.000Z' }] })
  const f = await httpFixture(t, { sdk, directoryExists: async path => path === join(home, 'work') || path === join(home, 'work', 'app'), homeDirectory: home })
  await f.api('POST', '/threads', { projectPath: join(home, 'work', 'app') })
  const recent = await f.api('GET', '/projects/recent')
  assert.equal(recent.status, 200); assert.equal(recent.data.schemaVersion, 1); assert.equal(recent.data.partial, false)
  assert.deepEqual(recent.data.projects.map(project => [project.name, project.source]), [['app', 'threads'], ['work', 'claude']])
  assert.equal((await f.api('GET', '/projects/recent?x=1')).status, 400)
  const listing = await f.api('GET', '/directories?path=~')
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.data, { schemaVersion: 1, path: home, parent: join(home, '..'), entries: [{ name: 'work', path: join(home, 'work') }], truncated: false })
  assert.deepEqual((await f.api('GET', `/directories?path=${encodeURIComponent('~/')}&showHidden=1`)).data.entries.map(entry => entry.name), ['.config', 'work'])
  assert.deepEqual((await f.api('GET', `/directories?path=${encodeURIComponent(join(home, 'work'))}`)).data.entries, [{ name: 'app', path: join(home, 'work', 'app') }])
  assert.equal((await f.api('GET', '/directories')).data.error.code, 'project-path-invalid')
  assert.equal((await f.api('GET', '/directories?path=relative')).status, 400)
  assert.equal((await f.api('GET', `/directories?path=${encodeURIComponent(join(home, 'missing'))}`)).data.error.code, 'project-path-missing')
  assert.equal((await f.api('GET', '/directories?path=~&other=1')).status, 400)
  assert.equal((await f.api('GET', '/directories?path=~&showHidden=maybe')).status, 400)
})
test('available model HTTP discovery passes the current project and cancellation signal without creating a Run', async t => {
  const seen = [], available = { schemaVersion: 1, models: [{ value: 'sonnet[1m]', displayName: 'Current Sonnet', description: 'Advertised by this device' }] }
  const sdk = fakeSdk({ models: async (cwd, signal) => { seen.push({ cwd, signal }); return available } })
  const f = await httpFixture(t, { sdk })
  assert.deepEqual(await f.api('GET', '/models?cwd=%2Fprojects%2Fdemo'), { status: 200, data: available })
  assert.equal(seen[0].cwd, '/projects/demo'); assert.ok(seen[0].signal instanceof AbortSignal)
  assert.deepEqual((await f.api('GET', '/models')).data, available)
  assert.equal(seen[1].cwd, undefined, 'no selected project lets the adapter use this device home')
  for (const path of ['/models?cwd=relative', '/models?cwd=', '/models?cwd=%00', '/models?cwd=%2Fa&cwd=%2Fb', '/models?other=1']) assert.equal((await f.api('GET', path)).status, 400)
  assert.equal(seen.length, 2); assert.equal(sdk.runs.length, 0); assert.deepEqual(await f.runs.listThreads(), [])
})

test('capability and control routes reject extra inputs and ended or foreign tasks without replaying controls', async t => {
  const sdk = fakeSdk({ onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } }); run.exit() } })
  const seen = [], catalog = { schemaVersion: 1, source: 'project', permissionMode: 'default', skills: [], agents: [], mcp: [] }
  sdk.port.listCapabilities = async (cwd, signal) => { seen.push({ cwd, signal }); return catalog }
  const original = sdk.port.openRun
  sdk.port.openRun = (...args) => { const handle = original(...args); handle.capabilities = async () => ({ ...catalog, source: 'run' }); handle.control = async input => { seen.push(input) }; return handle }
  const f = await httpFixture(t, { sdk, cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } })
  assert.equal((await f.api('GET', '/capabilities?extra=1')).status, 400)
  assert.equal((await f.api('GET', '/capabilities?cwd=/a&cwd=/b')).status, 400)
  assert.equal((await f.api('GET', '/capabilities?cwd=relative')).status, 400)
  assert.deepEqual((await f.api('GET', '/capabilities?cwd=/project')).data, catalog)
  const thread = (await f.api('POST', '/threads', { projectPath: '/project' })).data
  assert.equal((await f.api('GET', `/threads/${thread.id}/capabilities`)).data.source, 'project')
  const run = (await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'plan', idempotencyKey: 'controls', permissionMode: 'plan' })).data
  assert.equal(sdk.runs[0].request.permissionMode, 'plan')
  assert.equal((await f.api('GET', `/threads/${thread.id}/capabilities`)).data.source, 'run')
  assert.equal((await f.api('POST', `/runs/${run.id}/control`, { action: 'permission-mode', mode: 'bypassPermissions' })).status, 400)
  assert.equal((await f.api('POST', `/runs/${run.id}/control`, { action: 'reload-skills', token: 'unexpected' })).status, 400)
  assert.equal((await f.api('POST', `/runs/${run.id}/control`, { action: 'stop-task', taskId: 'not-owned' })).data.error.code, 'task-not-active')
  assert.deepEqual((await f.api('POST', `/runs/${run.id}/control`, { action: 'reload-skills' })).data, { ok: true })
  assert.deepEqual(seen.filter(value => value.action), [{ action: 'reload-skills' }])
  sdk.runs[0].finish({ kind: 'result', result: sampleResult() }); sdk.runs[0].exit(); await f.runs.waitRun(run.id)
  assert.equal((await f.api('POST', `/runs/${run.id}/control`, { action: 'reload-skills' })).data.error.code, 'run-ended')
  assert.equal(seen.filter(value => value.action).length, 1)
})

test('session authorization endpoints persist only SDK-proposed rules and revoke them for subsequent messages', async t => {
  const f = await httpFixture(t, { sdkOptions: { onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } }); run.exit() } }, cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } })
  const thread = (await f.api('POST', '/threads', { projectPath: '/project' })).data
  const run = (await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'test', idempotencyKey: 'remember' })).data
  f.sdk.runs[0].hooks.onEvent({ type: 'init', init: { nativeSessionId: 'native-session', model: 'model', cwd: '/project', permissionMode: 'default', claudeCodeVersion: 'test', toolCount: 1 } })
  const waiting = f.sdk.runs[0].hooks.canUseTool(permission('remember', { reusablePermissions: { allow: [{ tool: 'Bash', pattern: 'ls:*' }], directories: [] } }))
  const pending = f.runs.listPendingApprovals(thread.id)[0]
  assert.equal((await f.api('POST', `/approvals/${pending.id}`, { decision: 'allow-session', rules: ['Bash'] })).status, 400)
  assert.equal((await f.api('POST', `/approvals/${pending.id}`, { decision: 'allow-session' })).status, 200)
  assert.deepEqual(await waiting, { behavior: 'allow', session: true })
  const base = `/threads/${thread.id}/permissions`
  assert.equal((await f.api('GET', base)).data.grants[0].rules[0], 'Bash(ls:*)')
  assert.equal((await f.api('POST', `${base}/${pending.id}/revoke`, {})).data.error.code, 'permissions-active')
  f.sdk.runs[0].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[0].exit(); await f.runs.waitRun(run.id)
  assert.equal((await f.api('POST', `${base}/${pending.id}/revoke`, { unexpected: true })).status, 400)
  assert.equal((await f.api('GET', `${base}?all=true`)).status, 400)
  assert.equal((await f.api('POST', `${base}/${pending.id}/revoke`, {})).data.grants.length, 0)
  const next = (await f.api('POST', `/threads/${thread.id}/runs`, { prompt: 'again', idempotencyKey: 'after-revoke' })).data
  assert.deepEqual(f.sdk.runs[1].request.sessionPermissions.allow, [])
  f.sdk.runs[1].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[1].exit(); await f.runs.waitRun(next.id)
})

test('chunked attachments and running follow-ups cross the public HTTP boundary without exposing bytes or persisting dynamic MCP configuration', async t => {
  const f=await httpFixture(t), bytes=Buffer.from('attachment content\n'.repeat(24000)), thread=(await f.api('POST','/threads',{projectPath:'/p'})).data
  const header={name:'notes.txt',mime:'text/plain',size:bytes.length,idempotencyKey:'http-upload'}
  let upload=(await f.api('POST','/attachments',header)).data
  while(!upload.ready){const response=await f.api('POST',`/attachments/${upload.id}/chunks`,{offset:upload.received,data:bytes.subarray(upload.received,upload.received+192*1024).toString('base64')});assert.equal(response.status,200,JSON.stringify(response));upload=response.data}
  const start=await f.api('POST',`/threads/${thread.id}/runs`,{prompt:'first',attachmentIds:[upload.id],idempotencyKey:'http-start'});assert.equal(start.status,202);assert.equal('data' in start.data.attachments[0],false)
  const native=f.sdk.runs[0],enqueued=[];native.handle.enqueue=(message,assets)=>{enqueued.push({message,assets});native.hooks.onEvent({type:'input',message})};native.handle.cancelInput=id=>{native.hooks.onEvent({type:'input',message:{...enqueued.find(x=>x.message.id===id).message,status:'cancelled'}});return true}
  const body={prompt:'next',attachmentIds:[upload.id],idempotencyKey:'http-follow-up'},a=await f.api('POST',`/runs/${start.data.id}/messages`,body),b=await f.api('POST',`/runs/${start.data.id}/messages`,body);assert.equal(a.status,202);assert.equal(a.data.id,b.data.id);assert.equal(enqueued.length,1);assert.deepEqual(Buffer.from(enqueued[0].assets[0].data,'base64'),bytes)
  const listed=await f.api('GET',`/runs/${start.data.id}/messages`);assert.equal(listed.data[0].status,'queued');assert.equal('data' in listed.data[0].attachments[0],false)
  assert.equal((await f.api('POST',`/runs/${start.data.id}/messages/${a.data.id}/cancel`,{})).status,200)
  const controls=[];native.handle.control=async input=>controls.push(input);native.handle.capabilities=async()=>({schemaVersion:1,source:'run',permissionMode:'default',skills:[],agents:[],mcp:[{name:'qa',status:'connected',source:'project',tools:[]}]})
  assert.equal((await f.api('POST',`/runs/${start.data.id}/control`,{action:'mcp-set',servers:{qa:{type:'http',url:'https://example.com/mcp'}}})).status,200)
  assert.equal((await f.api('POST',`/runs/${start.data.id}/control`,{action:'mcp-permission',name:'qa',mode:'default'})).status,200)
  assert.equal((await f.api('POST',`/runs/${start.data.id}/control`,{action:'mcp-permission',name:'foreign',mode:'default'})).status,404)
  assert.equal((await f.api('POST',`/runs/${start.data.id}/control`,{action:'mcp-set',servers:{qa:{type:'http',url:'https://example.com/mcp',headers:{Authorization:'forbidden'}}}})).status,400)
  assert.equal(f.runs.getRunView(start.data.id).mcpServers.qa.url,'https://example.com/mcp');assert.deepEqual((await f.runs.getThread(thread.id)).options.mcpServers,{})
  native.finish({kind:'result',result:sampleResult()});native.exit();await f.runs.waitRun(start.data.id)
})

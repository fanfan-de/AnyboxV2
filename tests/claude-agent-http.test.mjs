import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApplicationHttpServer } from '../dist/host/http-server.js'
import { createApplicationCatalog } from '../dist/host/applications/registration.js'
import { createExecutionHost } from '../dist/host/execution.js'
import { claudeAgentDefinition, claudeAgentServerHttp } from '../dist/applications/claude-agent/definition.js'
import { createClaudeAgentHttpComponent } from '../dist/applications/claude-agent/http/component.js'
import { claudeAgentServerApplication } from '../dist/applications/claude-agent/registration.js'
import { claudeAgentSdkServiceKey } from '../dist/applications/claude-agent/core/sdk/port.js'
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

test('HTTP exposes the environment, threads, runs, live views, approvals and SSE with whitelisted DTOs', async t => {
  const f = await httpFixture(t, { directoryExists: async path => path === '/projects/demo' })
  assert.deepEqual((await f.api('GET', '/environment')).data, { schemaVersion: 1, platform: 'darwin', executable: { path: '/fake/bin/claude', source: 'path' } })
  assert.equal((await f.api('POST', '/threads', { projectPath: 'relative' })).data.error.code, 'project-path-invalid')
  assert.equal((await f.api('POST', '/threads', { projectPath: '/projects/other' })).status, 404)
  assert.equal((await f.api('POST', '/threads', { projectPath: '/projects/demo', extra: 1 })).status, 400)
  const created = await f.api('POST', '/threads', { projectPath: '/projects/demo', title: 'Demo' })
  assert.equal(created.status, 201); assert.deepEqual(Object.keys(created.data).sort(), ['createdAt', 'id', 'lastRun', 'nativeSessionId', 'projectPath', 'schemaVersion', 'title', 'updatedAt'])
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

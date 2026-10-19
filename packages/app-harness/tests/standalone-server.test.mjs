import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createHarnessServerAccessComponent, harnessServerAccessServiceKey } from '@anybox/app-harness/server-access'
import { createHarnessServerListenerComponent, harnessServerListenerServiceKey } from '@anybox/app-harness/http/server'
import { createHarnessServerRuntime } from '@anybox/app-harness/server-runtime'
import { createStandaloneHarnessServer } from '@anybox/app-harness/server'
import { parseHarnessServerConfig } from '@anybox/app-harness/server-config'

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(t, fetchModel) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-standalone-harness-'))
  const secrets = new Map()
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite') })
  const options = { models: { catalogAutoRefresh: false, readLegacyCredential: async () => 'test-secret', fetch: fetchModel,
    openEntry(namespace, id) { const key = `${namespace}:${id}`; return {
      getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
    } },
  } }
  const server = await createStandaloneHarnessServer(config, options)
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const issued = await server.access.issue('Test device')
  const headers = { Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': server.instance.instanceId, 'Content-Type': 'application/json' }
  const request = (path, body) => fetch(server.url + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  return { server, config, options, request, headers, issued, directory }
}
const successfulModel = async () => new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Standalone answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

async function newSession(f) {
  // Empty tools exercise a text execution without activating an idle worker.
  await f.server.api.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
  const project = await (await f.request('/api/v1/apps/agent/projects', { path: f.directory })).json()
  const response = await f.request('/api/v1/apps/agent/sessions', { projectId: project.id, agentId: 'assistant' })
  assert.equal(response.status, 200)
  return response.json()
}

test('standalone Harness authenticates business requests, streams changes and preserves identity and data after reopening', async t => {
  const f = await fixture(t, successfulModel)
  assert.equal(f.server.root.get('app.activity'), undefined)
  assert.equal(f.server.root.get('host.access'), undefined)
  assert.equal(f.server.root.get('app.products'), undefined)
  assert.equal((await fetch(f.server.url + '/api/v1/instance')).status, 401)
  const identity = await (await f.request('/api/v1/instance')).json()
  assert.equal(identity.instanceId, f.server.instance.instanceId)
  assert.equal((await fetch(f.server.url + '/api/v1/projects', { headers: { Authorization: f.headers.Authorization } })).status, 409)
  assert.equal((await f.request('/api/v1/products')).status, 404)
  assert.equal((await f.request('/api/v1/units/unit/poll')).status, 404)
  const unit = await fetch(f.server.url + '/api/v1/apps/agent/units/unit/poll', { headers: f.headers })
  assert.equal(unit.status, 401, 'an owner token never authenticates a Computer unit')
  const session = await newSession(f)
  const stream = await f.request(`/api/v1/apps/agent/changes?sessionId=${session.id}`)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = stream.body.getReader()
  const first = await reader.read(); assert.equal(first.done, false)
  const response = await f.request(`/api/v1/apps/agent/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Hello', idempotencyKey: 'standalone-first' })
  assert.equal(response.status, 200)
  const run = await response.json(), settled = await f.server.api.waitRun(run.id)
  assert.equal(settled.status, 'completed'); assert.equal(settled.output, 'Standalone answer')
  const change = await reader.read(); assert.equal(change.done, false)
  const revoked = f.server.access.revoke(f.issued.record.id)
  await assert.rejects(async () => { while (!(await reader.read()).done) {} })
  await revoked
  assert.equal((await f.request('/api/v1/projects')).status, 401)
  const replacement = await f.server.access.issue('Replacement')
  const id = f.server.instance.instanceId
  await f.server.close()
  const reopened = await createStandaloneHarnessServer(f.config, f.options)
  try {
    assert.equal(reopened.instance.instanceId, id)
    assert.equal(reopened.access.authenticate(`Bearer ${replacement.token}`), replacement.record.id)
    assert.equal((await reopened.api.getSession(session.id)).id, session.id)
    assert.equal((await reopened.api.getRun(run.id)).status, 'completed')
  } finally { await reopened.close() }
  assert.equal(existsSync(`${f.config.harnessDatabasePath}.computer-worker`), false)
})

test('standalone Harness shutdown cancels an accepted Run and waits for actual model exit while draining retained HTTP requests', async t => {
  const entered = deferred(), cancelled = deferred(), release = deferred()
  const f = await fixture(t, async (_url, init) => {
    entered.resolve()
    if (!init.signal.aborted) await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    cancelled.resolve(); await release.promise
    throw new DOMException('Cancelled', 'AbortError')
  })
  const session = await newSession(f)
  const response = await f.request(`/api/v1/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Wait', idempotencyKey: 'standalone-closing' })
  assert.equal(response.status, 200)
  const run = await response.json(); await entered.promise
  let finished = false
  const closing = f.server.close().then(() => { finished = true })
  await cancelled.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false, 'closing must join actual execution exit')
  release.resolve(); await closing
  const reopened = await createStandaloneHarnessServer(f.config, f.options)
  try { assert.equal((await reopened.api.getRun(run.id)).status, 'cancelled') } finally { await reopened.close() }
  await assert.rejects(fetch(f.server.url + '/api/v1/instance'))
})

test('standalone Harness keeps the existing exclusive database owner', async t => {
  const f = await fixture(t, successfulModel)
  await assert.rejects(createStandaloneHarnessServer(f.config, f.options))
  assert.equal((await f.request('/api/v1/agents')).status, 200)
})


test('the standalone CLI resolves its platform launcher and validates help and arguments without creating data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-harness-bin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = fileURLToPath(new URL('../dist/entrypoints/server-main.js', import.meta.url))
  // npm's Windows shims invoke the JS entry directly; file symlinks require an unrelated OS privilege.
  const bin = process.platform === 'win32' ? entry : join(directory, 'anybox-harness-server')
  if (process.platform !== 'win32') await symlink(entry, bin)
  const run = promisify(execFile)
  const env = { ...process.env, ANYBOX_HARNESS_PORT: 'invalid', ANYBOX_HARNESS_DATABASE: join(directory, 'data', 'harness.sqlite') }
  for (const help of ['--help', '-h']) {
    const result = await run(process.execPath, [bin, help], { cwd: directory, env })
    assert.match(result.stdout, /serve.*init.*recover-access.*new-identity/)
  }
  for (const args of [['unknown'], ['serve', 'extra'], ['init', 'name', 'extra']]) {
    await assert.rejects(run(process.execPath, [bin, ...args], { cwd: directory, env }))
  }
  assert.equal(existsSync(join(directory, 'data')), false)
})


test('reinstalling the same Harness access component rebinds HTTP authentication and revocation on the same port', async t => {
  const f = await fixture(t, successfulModel)
  const session = await newSession(f)
  await f.server.close()
  const root = new Context(), accessComponent = createHarnessServerAccessComponent()
  const runtime = createHarnessServerRuntime(root, f.config, f.options, {
    http: { inject: [harnessServerAccessServiceKey], resolve: deps => {
      const access = deps[harnessServerAccessServiceKey]
      return { instanceId: () => access.instance.instanceId, onRevoked: listener => access.onRevoked(listener) }
    } },
  })
  const closeRoot = async () => {
    runtime.closeAdmission()
    const draining = root.get(harnessServerListenerServiceKey)?.close()
    await runtime.awaitIdle(); await Promise.all([root.fiber.dispose(), draining])
  }
  try {
    await root.installComponent(createLocalSqliteComponent(f.config.harnessDatabasePath))
    const accessFiber = root.installComponent(accessComponent); await accessFiber
    const listenerFiber = root.installComponent(createHarnessServerListenerComponent(root)); await listenerFiber
    await runtime.open()
    const oldAccess = root.get(harnessServerAccessServiceKey), oldHandler = root.get('harness.http')
    const url = root.get(harnessServerListenerServiceKey).url
    const before = await fetch(url + `/api/v1/changes?sessionId=${session.id}`, { headers: f.headers })
    const beforeReader = before.body.getReader(); await beforeReader.read()
    const oldStreamExit = (async () => { while (!(await beforeReader.read()).done) {} })().then(() => {}, () => {})
    await accessFiber.dispose(); await oldStreamExit
    assert.equal(root.get('harness.http'), undefined)
    assert.equal(root.get(harnessServerListenerServiceKey), undefined)
    await root.installComponent(accessComponent)
    await listenerFiber.awaitStable()
    assert.equal(root.get(harnessServerListenerServiceKey).url, url)
    assert.notEqual(root.get(harnessServerAccessServiceKey), oldAccess)
    assert.notEqual(root.get('harness.http'), oldHandler)
    const response = await fetch(url + '/api/v1/agents', { headers: f.headers })
    assert.equal(response.status, 200, 'the existing token still authenticates after access reload')
    const stream = await fetch(url + `/api/v1/changes?sessionId=${session.id}`, { headers: f.headers })
    const reader = stream.body.getReader(); await reader.read()
    const revoked = root.get(harnessServerAccessServiceKey).revoke(f.issued.record.id)
    await assert.rejects(async () => { while (!(await reader.read()).done) {} })
    await revoked
    assert.equal((await fetch(url + '/api/v1/agents', { headers: f.headers })).status, 401)
  } finally { await closeRoot() }
})

test('a standalone listener bind failure releases database ownership for a later successful start', async t => {
  const f = await fixture(t, successfulModel)
  await f.server.close()
  const blocker = createServer()
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => blocker.close(() => resolve())))
  const config = { ...f.config, port: blocker.address().port }
  await assert.rejects(createStandaloneHarnessServer(config, f.options))
  await new Promise(resolve => blocker.close(resolve))
  const restored = await createStandaloneHarnessServer(config, f.options)
  try {
    assert.equal(restored.instance.instanceId, f.headers['X-Anybox-Instance-Id'])
    assert.equal((await fetch(restored.url + '/api/v1/agents', { headers: f.headers })).status, 200)
  } finally { await restored.close() }
})

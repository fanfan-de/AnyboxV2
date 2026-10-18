import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createClaudeAgentRuntime } from '@anybox/app-claude-agent/server-runtime'
import { createClaudeAgentServer } from '@anybox/app-claude-agent/server'
import { parseClaudeAgentServerConfig } from '@anybox/app-claude-agent/server-config'
import { createClaudeAgentAccessComponent, hostAccessServiceKey } from '@anybox/app-claude-agent/server-access'
import { claudeAgentListenerServiceKey, createClaudeAgentListenerComponent } from '@anybox/app-claude-agent/server-http'
import { claudeAgentSdkServiceKey } from '@anybox/app-claude-agent/core/sdk/port'
import { claudeAgentRunsServiceKey } from '@anybox/app-claude-agent/core/runs/component'

const tick = () => new Promise(resolve => setImmediate(resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { kind: 'failed', error: { code: 'interrupted', message: 'test cancellation' } }
function sdk() {
  const calls = []
  const port = {
    environment: () => ({ schemaVersion: 1, platform: process.platform, executable: { path: '/fake/claude', source: 'path' } }),
    openRun(input, hooks) {
      let finish, exit
      const outcome = new Promise(resolve => { finish = resolve }), done = new Promise(resolve => { exit = resolve })
      const call = { input, hooks, finish, exit, interrupts: 0, terminated: 0 }
      calls.push(call)
      return { result: outcome, done, async interrupt() { call.interrupts++; finish(result) }, close() { call.terminated++ } }
    },
    async readSessionMessages() { return [] }, async listSessionProjects() { return [] }, async readSessionInfo() { return undefined },
  }
  return { calls, component: { name: 'standalone-test-sdk', apply(ctx) { ctx.provide(claudeAgentSdkServiceKey, port) } } }
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'claude-agent-standalone-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
const config = path => parseClaudeAgentServerConfig({ ANYBOX_HARNESS_DATABASE: path })
async function request(server, token, method, path, body, instance = server.instance.instanceId) {
  return fetch(server.url + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Anybox-Instance-Id': instance, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

test('standalone configuration keeps the existing business path and only adds application listener settings', () => {
  assert.deepEqual(parseClaudeAgentServerConfig({}), { port: 0, host: '127.0.0.1', name: 'Claude Agent', databasePath: './data/harness.sqlite' })
  assert.deepEqual(parseClaudeAgentServerConfig({ ANYBOX_HARNESS_DATABASE: '/existing/harness.sqlite', ANYBOX_HARNESS_PORT: '1234', ANYBOX_HARNESS_BIND: '::1', ANYBOX_CLAUDE_AGENT_BINARY: '/bin/claude' }),
    { port: 1234, host: '::1', name: 'Claude Agent', databasePath: '/existing/harness.sqlite', executableOverride: '/bin/claude' })
  assert.equal(parseClaudeAgentServerConfig({ ANYBOX_CLAUDE_AGENT_PORT: '4000', ANYBOX_HARNESS_PORT: '1234' }).port, 4000)
  assert.throws(() => parseClaudeAgentServerConfig({ ANYBOX_CLAUDE_AGENT_PORT: '-1' }), /TCP port/)
})

test('business runtime opens without application activity or owner authentication services', async t => {
  const path = join(await directory(t), 'harness.sqlite'), root = new Context(), fake = sdk()
  t.after(() => root.fiber.dispose())
  await root.installComponent(createLocalSqliteComponent(path))
  const runtime = createClaudeAgentRuntime(root, {}, { sdkComponent: fake.component })
  await runtime.open()
  assert.equal(runtime.inspect(), 'active')
  assert.equal(root.get('app.activity'), undefined)
  assert.equal(root.get('host.access'), undefined)
  assert.deepEqual(await root.get(claudeAgentRunsServiceKey).listThreads(), [])
})

test('standalone listener reads legacy identity and tokens, streams events and waits for actual SDK exit on close', async t => {
  const path = join(await directory(t), 'harness.sqlite'), instanceId = randomUUID(), tokenId = randomUUID(), secret = randomBytes(32).toString('base64url'), token = `${tokenId}.${secret}`
  // Exact v1 host-access layout from existing installations. The application must upgrade it in place.
  const old = new DatabaseSync(path)
  old.exec('PRAGMA user_version=1; CREATE TABLE schema_migrations (domain TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (\'host-access\',1); CREATE TABLE host_identity (id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL); CREATE TABLE host_access_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)')
  old.prepare('INSERT INTO host_identity VALUES(1,?)').run(instanceId)
  old.prepare('INSERT INTO host_access_tokens VALUES(?,?,?,?,NULL)').run(tokenId, 'Existing owner', createHash('sha256').update(secret).digest('hex'), new Date().toISOString())
  old.close()
  const fake = sdk(), server = await createClaudeAgentServer(config(path), { sdkComponent: fake.component, runs: { cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } } })
  let released = false
  t.after(async () => { for (const call of fake.calls) { call.finish(result); call.exit() } await server.close() })
  assert.equal(server.instance.instanceId, instanceId)
  const anonymous = await fetch(server.url + '/api/v1/apps/claude-agent/threads')
  assert.equal(anonymous.status, 401)
  const info = await request(server, token, 'GET', '/api/v1/instance', undefined, 'wrong')
  assert.equal(info.status, 200); assert.deepEqual((await info.json()).capabilities, ['tokens', 'claude-agent.v1', 'sse'])
  assert.equal((await request(server, token, 'GET', '/api/v1/apps/claude-agent/threads', undefined, 'wrong')).status, 409)
  assert.equal((await request(server, token, 'GET', '/api/v1/products')).status, 404)
  const created = await request(server, token, 'POST', '/api/v1/apps/claude-agent/threads', { projectPath: process.cwd(), title: 'Standalone' })
  assert.equal(created.status, 201)
  const thread = await created.json()
  const stream = await request(server, token, 'GET', `/api/v1/apps/claude-agent/events?threadId=${thread.id}`)
  assert.match(stream.headers.get('content-type'), /text\/event-stream/)
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  const accepted = await request(server, token, 'POST', `/api/v1/apps/claude-agent/threads/${thread.id}/runs`, { prompt: 'hello', idempotencyKey: 'standalone' })
  assert.equal(accepted.status, 202)
  const run = await accepted.json()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: run-changed/)
  const stopped = server.close().then(() => { released = true })
  for (let attempt = 0; !fake.calls[0].interrupts && attempt < 100; attempt++) await tick()
  assert.equal(fake.calls[0].interrupts, 1)
  await delay(10)
  assert.equal(released, false, 'close must retain its lock and operation until SDK done reports actual exit')
  await assert.rejects(createClaudeAgentServer(config(path), { sdkComponent: sdk().component }), error => error?.code === 'occupied')
  fake.calls[0].exit()
  await stopped
  await reader.cancel().catch(() => {})
  const reopened = await createClaudeAgentServer(config(path), { sdkComponent: sdk().component })
  try {
    const records = await request(reopened, token, 'GET', '/api/v1/apps/claude-agent/threads')
    assert.equal(records.status, 200); assert.equal((await records.json())[0].id, thread.id)
    const record = await request(reopened, token, 'GET', `/api/v1/apps/claude-agent/runs/${run.id}`)
    assert.equal((await record.json()).status, 'cancelled')
  } finally { await reopened.close() }
})

test('token revocation closes authenticated streams and prevents subsequent requests', async t => {
  const server = await createClaudeAgentServer(config(join(await directory(t), 'harness.sqlite')), { sdkComponent: sdk().component })
  t.after(() => server.close())
  const access = server.root.get(hostAccessServiceKey), owner = await access.issue('Owner'), viewer = await access.issue('Viewer')
  const stream = await request(server, viewer.token, 'GET', '/api/v1/apps/claude-agent/events?threadId=test')
  const reader = stream.body.getReader(); await reader.read()
  const ended = reader.read().then(() => true, () => true)
  const revoked = await request(server, owner.token, 'POST', `/api/v1/access/tokens/${viewer.record.id}/revoke`, {})
  assert.equal(revoked.status, 200)
  assert.equal(await ended, true)
  assert.equal((await request(server, viewer.token, 'GET', '/api/v1/apps/claude-agent/threads')).status, 401)
})

test('shutdown joins a Run still persisting its index and cannot launch it after admission closes', async t => {
  const fake = sdk(), server = await createClaudeAgentServer(config(join(await directory(t), 'harness.sqlite')), { sdkComponent: fake.component })
  t.after(() => server.close())
  const runs = server.root.get(claudeAgentRunsServiceKey), store = server.root.get('claude-agent.store')
  const thread = await runs.createThread({ projectPath: process.cwd() })
  let release, stored
  const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { stored = resolve })
  const createRun = store.createRun
  store.createRun = async input => { const record = await createRun(input); stored(); await gate; return record }
  const starting = runs.startRun(thread.id, { prompt: 'pending', idempotencyKey: 'pending-close' })
  const rejected = assert.rejects(starting, error => error?.code === 'service-unavailable')
  await entered
  let closed = false
  const stopped = server.close().then(() => { closed = true })
  await delay(10)
  assert.equal(closed, false, 'the business component retains storage until accepted starts exit')
  assert.equal(fake.calls.length, 0)
  release()
  await Promise.all([rejected, stopped])
  assert.equal(fake.calls.length, 0, 'a completed write cannot launch a new SDK process after closeAdmission')
})


test('CLI help lists commands before reading invalid configuration or creating resources', async t => {
  const cwd = await directory(t), main = fileURLToPath(new URL('../dist/main.js', import.meta.url))
  for (const help of ['--help', '-h']) {
    const { stdout } = await promisify(execFile)(process.execPath, [main, help], { cwd, env: { ...process.env, ANYBOX_CLAUDE_AGENT_PORT: 'invalid', ANYBOX_CLAUDE_AGENT_BINARY: '' } })
    assert.match(stdout, /anybox-claude-agent.*serve.*init.*recover-access.*new-identity/)
  }
  assert.deepEqual(await readdir(cwd), [])
})


test('access component restart replaces listener authentication and revocation while retaining the same port and token', async t => {
  const root = new Context(), path = join(await directory(t), 'harness.sqlite')
  t.after(() => root.fiber.dispose())
  await root.installComponent(createLocalSqliteComponent(path))
  const accessFiber = root.installComponent(createClaudeAgentAccessComponent())
  await accessFiber
  const listenerFiber = root.installComponent(createClaudeAgentListenerComponent(root))
  await listenerFiber
  const runtime = createClaudeAgentRuntime(root, {}, { sdkComponent: sdk().component })
  await runtime.open()
  const before = root.get(hostAccessServiceKey), url = root.get(claudeAgentListenerServiceKey).url
  const owner = await before.issue('Owner'), viewer = await before.issue('Viewer')
  const view = { url, instance: before.instance }
  const stream = await request(view, viewer.token, 'GET', '/api/v1/apps/claude-agent/events?threadId=test')
  const reader = stream.body.getReader(); await reader.read()
  const ended = reader.read().then(() => true, () => true)
  await accessFiber.restart()
  await listenerFiber.awaitStable()
  assert.equal(await ended, true)
  const after = root.get(hostAccessServiceKey)
  assert.notEqual(after, before)
  assert.equal(root.get(claudeAgentListenerServiceKey).url, url)
  assert.equal(after.instance.instanceId, view.instance.instanceId)
  assert.equal((await request(view, owner.token, 'GET', '/api/v1/apps/claude-agent/threads')).status, 200)
  const next = await request(view, viewer.token, 'GET', '/api/v1/apps/claude-agent/events?threadId=test')
  const nextReader = next.body.getReader(); await nextReader.read()
  const revoked = nextReader.read().then(() => true, () => true)
  await after.revoke(viewer.record.id)
  assert.equal(await revoked, true)
  assert.equal((await request(view, viewer.token, 'GET', '/api/v1/apps/claude-agent/threads')).status, 401)
})

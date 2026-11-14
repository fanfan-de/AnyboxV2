import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@nya/core'
import { createLocalWebHost } from '../packages/distribution/dist/composition/local-web.js'
import { createHarnessServer } from '../packages/distribution/dist/composition/harness-server.js'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'

function fixture(directory, fetch) {
  const secrets = new Map()
  const openEntry = (namespace, id) => {
    const key = `${namespace}:${id}`
    return { getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => { secrets.delete(key) } }
  }
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'),
    ANYBOX_MODELS_CONFIG: join(directory, 'models.json'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'),
    ANYBOX_MODELS_CATALOG_DATABASE: join(directory, 'catalog.sqlite'), ANYBOX_LLM_API: 'chat-completions' })
  return { config, client: { path: join(directory, 'client.sqlite'), port: 0, openEntry },
    options: { models: { openEntry, readLegacyCredential: async () => undefined, catalogAutoRefresh: false, fetch } } }
}
async function request(url, path, body) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`)
  return value
}
async function reopen(path) {
  const root = new Context()
  try { await root.installComponent(createLocalSqliteComponent(path)) } finally { await root.fiber.dispose() }
}

test('local Web shares exactly one root while keeping storage, targets and application Models independent', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-local-root-')), f = fixture(directory)
  let host
  try {
    host = await createLocalWebHost({ client: f.client, execution: { config: f.config, options: f.options } })
    assert.equal(host.root, host.client.root)
    assert.equal(host.root, host.execution.root)
    const clientDb = host.root.get('local-storage'), executionDb = host.root.get('host.execution.storage')
    assert.notEqual(clientDb, executionDb)
    await host.client.products.open('agent')
    assert.equal(host.execution.products.get('agent').state, 'disabled')
    await host.execution.products.open('agent')
    assert.equal(host.execution.products.get('agent').state, 'running')
    const harnessModels = host.root.get('harness.models.settings')
    assert.ok(harnessModels)
    assert.equal(host.root.get('models.settings'), undefined)
    await host.client.products.open('personal-agent')
    const personalModels = host.root.get('models.settings')
    assert.ok(personalModels)
    assert.notEqual(personalModels, harnessModels)
    assert.equal(personalModels.connections().length, 0)
    assert.ok(harnessModels.connections().length)
    assert.equal((await request(host.url, '/api/client/v1/apps/personal-agent/models')).connections.length, 0)
    const token = await host.root.get('host.access').issue('test HTTP identity')
    const response = await fetch(host.execution.url + '/api/v1/models/connections', { headers: {
      Authorization: `Bearer ${token.token}`, 'X-Anybox-Instance-Id': host.execution.instance.instanceId,
    } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).length, harnessModels.connections().length)
    assert.equal((await clientDb.read(r => r.all('SELECT * FROM schema_migrations WHERE domain=?', ['run-state']))).length, 0)
    assert.equal((await executionDb.read(r => r.all('SELECT * FROM schema_migrations WHERE domain=?', ['run-state']))).length, 1)
    const lease = host.root.get('host.execution.activity').enter('agent')
    await assert.rejects(host.execution.products.disable('agent'), { code: 'product-busy' })
    await host.client.products.disable('agent')
    assert.equal(host.execution.products.get('agent').state, 'running')
    lease.release()
    await host.execution.products.disable('agent')
    assert.equal(host.root.get('harness.models.settings'), undefined)
    assert.equal(host.root.get('models.settings'), personalModels)
    const urls = [host.url, host.execution.url]
    await Promise.all([host.close(), host.close()])
    for (const url of urls) await assert.rejects(fetch(url))
    await reopen(f.client.path); await reopen(f.config.harnessDatabasePath)
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('single-root shutdown cancels an accepted model call and persists its terminal state before releasing storage', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-local-run-'))
  let entered, cancelled = false
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(directory, async (_url, input) => {
    entered()
    return new Promise((_resolve, reject) => {
      const abort = () => { cancelled = true; reject(new DOMException('cancelled', 'AbortError')) }
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
    })
  })
  let host, run
  try {
    host = await createLocalWebHost({ client: f.client, execution: { config: f.config, options: f.options } })
    await host.execution.products.open('agent')
    const settings = host.root.get('harness.models.settings'), connection = settings.connections()[0]
    await settings.setApiKey(connection.id, 'test-private-key', connection.revision)
    const api = host.execution.api
    await api.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
    const project = await api.openProject(directory)
    const session = await api.createSession(project.id, 'assistant', 'default')
    run = await api.startRun({ sessionId: session.id, parentNodeId: null, input: 'wait', idempotencyKey: 'local-shutdown' })
    await started
    await assert.rejects(host.execution.products.disable('agent'), { code: 'product-busy' })
    await host.close()
    assert.equal(cancelled, true)
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(f.config.harnessDatabasePath))
      const row = await root.get('local-storage').read(r => r.get('SELECT status FROM harness_runs WHERE id=?', [run.id]))
      assert.equal(row.status, 'cancelled')
    } finally { await root.fiber.dispose() }
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('independent harness server continues to own an independent root with the original service names', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-independent-harness-')), f = fixture(directory)
  let server
  try {
    server = await createHarnessServer(f.config, f.options)
    await server.products.open('agent')
    assert.ok(server.root.get('local-storage'))
    assert.ok(server.root.get('models.settings'))
    assert.equal(server.root.get('host.execution.storage'), undefined)
    assert.equal(server.root.get('harness.models.settings'), undefined)
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a local execution listener failure releases its storage and leaves the client usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-local-listener-')), f = fixture(directory)
  const occupied = createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  let host, failure
  try {
    host = await createLocalWebHost({ client: f.client,
      execution: { config: { ...f.config, port: occupied.address().port }, options: f.options },
      onExecutionError: error => { failure = error },
    })
    assert.ok(failure)
    assert.equal(host.execution, undefined)
    assert.equal((await fetch(host.url)).status, 200)
    assert.equal(host.root.get('host.execution.storage'), undefined)
    await reopen(f.config.harnessDatabasePath)
    await host.client.products.open('agent')
    assert.deepEqual(await request(host.url, '/api/client/v1/apps/agent/connections'), [])
  } finally {
    await host?.close()
    await new Promise(resolve => occupied.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('a client listener failure releases both sides of the shared-root startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-local-client-failure-')), f = fixture(directory)
  const occupied = createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(createLocalWebHost({ client: { ...f.client, port: occupied.address().port },
      execution: { config: f.config, options: f.options } }))
    await reopen(f.client.path)
    await reopen(f.config.harnessDatabasePath)
  } finally {
    await new Promise(resolve => occupied.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

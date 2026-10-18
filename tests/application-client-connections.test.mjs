import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createConnectionsComponent as harnessConnections } from '../packages/app-harness/dist/client/connections.js'
import { createConnectionsComponent as claudeConnections } from '../packages/app-claude-agent/dist/client/connections.js'
import { createClientHost } from '../packages/distribution/dist/entrypoints/client-main.js'
import { startDesktopExecution } from '../packages/distribution/dist/entrypoints/desktop-execution.js'

const instance = { instanceId: '10000000-0000-0000-0000-000000000001', name: 'Device', apiVersion: 1, capabilities: ['claude-agent.v1'] }
const token = '20000000-0000-0000-0000-000000000002.' + 'A'.repeat(43)
const replacementToken = '30000000-0000-0000-0000-000000000003.' + 'B'.repeat(43)
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const memoryKeys = values => (namespace, id) => ({
  async getPassword() { return values.get(`${namespace}:${id}`) },
  async setPassword(value) { values.set(`${namespace}:${id}`, value) },
  async deleteCredential() { values.delete(`${namespace}:${id}`) },
})
const request = async (host, path, body) => {
  const response = await fetch(host.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: host.url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

test('connections belong to each application, start on open, persist independently and exit on stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-app-connections-')), keys = new Map()
  let client
  try {
    client = await createClientHost({ path: join(directory, 'client.sqlite'), openEntry: memoryKeys(keys), fetch: async () => Response.json(instance) })
    assert.equal(client.root.get('client.connections'), undefined)
    assert.equal(client.root.get('claude-agent.connections'), undefined)
    await client.products.open('claude-agent')
    assert.equal(client.root.get('client.connections'), undefined, 'Claude Agent never loads Harness business')
    const claude = client.root.get('claude-agent.connections')
    const base = '/api/client/v1/apps/claude-agent'
    const saved = await request(client, base + '/connections', { name: 'Claude device', endpoint: 'https://device.example', token })
    assert.equal((await request(client, `${base}/connections/${saved.id}/check`, {})).instanceId, instance.instanceId)
    await client.products.open('agent')
    const harness = client.root.get('client.connections')
    assert.deepEqual(await harness.list(), [])
    const other = await harness.save({ name: 'Harness device', endpoint: 'https://device.example', token: replacementToken })
    assert.equal((await claude.list())[0].name, 'Claude device')
    assert.equal((await claude.acquire(saved.id)).token, token)
    assert.equal((await harness.acquire(other.id)).token, replacementToken)
    assert.ok([...keys.keys()].some(key => key.startsWith('anybox.client.agent:')))
    assert.ok([...keys.keys()].some(key => key.startsWith('anybox.client.claude-agent:')))
    await client.products.disable('agent')
    assert.equal(client.root.get('client.connections'), undefined)
    assert.equal((await claude.acquire(saved.id)).token, token)
    await assert.rejects(harness.list(), { code: 'service-unavailable' })
    await client.products.open('agent')
    assert.equal((await client.root.get('client.connections').list())[0].id, other.id)
    await request(client, `${base}/connections/${saved.id}/delete`, { expectedRevision: saved.revision })
    assert.deepEqual((await request(client, base + '/connections')).connections, [])
    assert.equal((await client.root.get('client.connections').acquire(other.id)).token, replacementToken)
    await client.products.disable('claude-agent')
    assert.equal(client.root.get('claude-agent.connections'), undefined)
    assert.ok(client.root.get('client.connections'))
  } finally { await client?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('legacy shared records import once per application and credentials copy privately without deleting the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-legacy-connections-')), file = join(directory, 'client.sqlite'), keys = new Map([['anybox.client:legacy-ref', token]])
  let root
  const open = async () => {
    root = new Context()
    await root.installComponent(createLocalSqliteComponent(file))
    return root.get('local-storage')
  }
  try {
    const db = await open()
    // Exact pre-split schema and stored JSON. No old writer is part of either application.
    await db.transaction(tx => {
      tx.execute('CREATE TABLE client_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
      tx.execute('CREATE TABLE client_credential_intents (id TEXT PRIMARY KEY)')
      tx.execute('CREATE TABLE client_local_connection (slot INTEGER PRIMARY KEY CHECK(slot=1), connection_id TEXT NOT NULL, instance_id TEXT NOT NULL)')
      tx.execute('INSERT INTO client_connections VALUES(?,?)', ['saved', JSON.stringify({ id: 'saved', name: 'Existing device', endpoint: 'https://device.example', instanceId: instance.instanceId, revision: 7, credentialRef: 'legacy-ref' })])
      tx.execute('INSERT INTO client_local_connection VALUES(1,?,?)', ['saved', instance.instanceId])
    })
    const options = { openEntry: memoryKeys(keys), fetch: async () => Response.json(instance) }
    await root.installComponent(harnessConnections(options)); await root.installComponent(claudeConnections(options))
    const harness = root.get('client.connections'), claude = root.get('claude-agent.connections')
    assert.equal(keys.size, 1, 'listing and startup do not open or copy credentials')
    assert.deepEqual(await harness.list(), await claude.list())
    assert.equal((await harness.list())[0].revision, 7)
    assert.equal(JSON.stringify(await harness.list()).includes('legacy-ref'), false)
    assert.equal((await harness.acquire('saved')).token, token)
    await harness.remove('saved', 7)
    assert.equal(keys.get('anybox.client:legacy-ref'), token, 'removing one application never deletes the legacy source')
    assert.equal((await claude.acquire('saved')).token, token, 'the other application can still import after that removal')
    await claude.save({ ...(await claude.list())[0], name: 'Claude only', expectedRevision: 7 })
    await root.fiber.dispose()
    await open()
    await root.installComponent(harnessConnections(options)); await root.installComponent(claudeConnections(options))
    assert.deepEqual(await root.get('client.connections').list(), [], 'a removed connection is not imported again')
    assert.equal((await root.get('claude-agent.connections').list())[0].name, 'Claude only')
    keys.delete('anybox.client:legacy-ref')
    assert.equal((await root.get('claude-agent.connections').acquire('saved')).token, token, 'completed imports no longer depend on the source')
    assert.equal((await readFile(file)).includes(Buffer.from(token)), false)
  } finally { await root?.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('stopping one connection component waits for its requests to exit without cancelling another application', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-connections-exit-')), root = new Context(), keys = new Map(), waiting = new Map()
  let block = false
  const options = { openEntry: memoryKeys(keys), fetch: async (url, init) => {
    if (!block) return Response.json(instance)
    const gate = deferred(), state = { signal: init.signal, release: gate.resolve }
    waiting.set(new URL(url).hostname, state)
    await gate.promise
    init.signal.throwIfAborted()
    return Response.json(instance)
  } }
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'client.sqlite')))
    const fiber = root.installComponent(harnessConnections(options))
    await fiber
    await root.installComponent(claudeConnections(options))
    const harness = root.get('client.connections'), claude = root.get('claude-agent.connections')
    const a = await harness.save({ name: 'A', endpoint: 'https://harness.test', token })
    const b = await claude.save({ name: 'B', endpoint: 'https://claude.test', token })
    block = true
    const checkA = assert.rejects(harness.check(a.id), { code: 'cancelled' }), checkB = claude.check(b.id)
    while (waiting.size !== 2) await tick()
    let stopped = false
    const closing = fiber.dispose().then(() => { stopped = true })
    await tick()
    assert.equal(waiting.get('harness.test').signal.aborted, true)
    assert.equal(waiting.get('claude.test').signal.aborted, false)
    assert.equal(stopped, false, 'cancellation is not actual request exit')
    waiting.get('harness.test').release(); await checkA; await closing
    waiting.get('claude.test').release(); assert.equal((await checkB).instanceId, instance.instanceId)
    assert.equal((await claude.acquire(b.id)).token, token)
  } finally { for (const item of waiting.values()) item.release(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

for (const [app, factory, service, table] of [
  ['Harness', harnessConnections, 'client.connections', 'harness_client_credential_intents'],
  ['Claude Agent', claudeConnections, 'claude-agent.connections', 'claude_agent_client_credential_intents'],
]) test(`${app}: a failed legacy credential copy and cleanup can retry without restarting`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-credential-import-')), root = new Context()
  const keys = new Map([['anybox.client:old-ref', token]])
  let blocked = true
  const openEntry = (namespace, id) => ({
    async getPassword() { return keys.get(`${namespace}:${id}`) },
    async setPassword(value) { if (blocked) throw new Error('locked'); keys.set(`${namespace}:${id}`, value) },
    async deleteCredential() { if (blocked) throw new Error('locked'); keys.delete(`${namespace}:${id}`) },
  })
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'client.sqlite')))
    const db = root.get('local-storage')
    await db.transaction(tx => {
      tx.execute('CREATE TABLE client_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
      tx.execute('INSERT INTO client_connections VALUES(?,?)', ['saved', JSON.stringify({ id: 'saved', name: 'Old', endpoint: 'https://device.example', instanceId: instance.instanceId, revision: 1, credentialRef: 'old-ref' })])
    })
    await root.installComponent(factory({ openEntry }))
    const connections = root.get(service)
    await assert.rejects(connections.acquire('saved'), { code: 'credential-unavailable' })
    assert.equal((await connections.list()).length, 1)
    assert.equal(keys.get('anybox.client:old-ref'), token)
    assert.equal(await db.read(reader => reader.all(`SELECT id FROM ${table}`)).then(rows => rows.length), 1)
    blocked = false
    assert.equal((await connections.acquire('saved')).token, token)
    assert.equal(await db.read(reader => reader.all(`SELECT id FROM ${table}`)).then(rows => rows.length), 0)
    assert.equal(keys.get('anybox.client:old-ref'), token)
  } finally { blocked = false; await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('desktop local pairing reconciles Harness and Claude Agent managed tokens independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-pairing-owners-')), handlers = new Map()
  let host
  try {
    host = await startDesktopExecution({ kind: 'execution', userData: directory, namespace: 'anybox.pairing-test' }, { handle(name, handler) { handlers.set(name, handler) } })
    const harness = await handlers.get('issue')({ appId: 'agent' }), claude = await handlers.get('issue')({ appId: 'claude-agent' })
    await handlers.get('reconcile')({ appId: 'agent', token: harness })
    await handlers.get('reconcile')({ appId: 'claude-agent', token: claude })
    const authenticate = async credential => (await fetch(host.ready.url + '/api/v1/instance', { headers: { Authorization: `Bearer ${credential}` } })).status
    assert.equal(await authenticate(harness), 200); assert.equal(await authenticate(claude), 200)
    await handlers.get('reconcile')({ appId: 'agent' })
    assert.equal(await authenticate(harness), 401); assert.equal(await authenticate(claude), 200)
    await assert.rejects(handlers.get('issue')({ appId: 'other' }), { code: 'invalid-input' })
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }) }
})

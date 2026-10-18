import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientHost as createDefaultClientHost } from '../packages/distribution/dist/entrypoints/client-main.js'
import { createClientHost } from '../packages/host/dist/client.js'
import { createExecutionHost } from '../packages/host/dist/execution.js'
import { createApplicationRuntime } from '../packages/application-api/dist/nya.js'
import { harnessClientApplication } from '../packages/app-harness/dist/client/registration.js'
import { claudeAgentClientApplication } from '../packages/app-claude-agent/dist/client/registration.js'
import { harnessServerApplication } from '../packages/app-harness/dist/registration.js'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'
import { createDirectoryPickerComponent, directoryPickerServiceKey } from '../packages/directory-picker/dist/index.js'
import { testApplication } from './helpers/test-application.mjs'

const instance = { instanceId: '10000000-0000-0000-0000-000000000001', name: 'Device', apiVersion: 1,
  capabilities: ['claude-agent.v1', 'projects.path', 'projects.local-directories'] }
const token = '20000000-0000-0000-0000-000000000002.' + 'A'.repeat(43)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const memoryKeys = () => {
  const keys = new Map()
  return (namespace, id) => ({
    async getPassword() { return keys.get(`${namespace}:${id}`) },
    async setPassword(value) { keys.set(`${namespace}:${id}`, value) },
    async deleteCredential() { keys.delete(`${namespace}:${id}`) },
  })
}
async function request(host, path, body, status = 200) {
  const response = await fetch(host.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: host.url, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`)
  return data
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-optional-capabilities-')), hosts = []
  t.after(async () => { for (const host of hosts.reverse()) await host.close(); await rm(directory, { recursive: true, force: true }) })
  return async (options = {}, start = createDefaultClientHost) => {
    const host = await start({ path: join(directory, `${hosts.length}.sqlite`), openEntry: memoryKeys(), ...options })
    hosts.push(host); return host
  }
}

test('empty and interface-only default compositions never initialize the native directory provider', async t => {
  const start = await fixture(t)
  const empty = await start({ applications: [], picker: { platform: 'darwin' } })
  assert.equal(empty.root.get(directoryPickerServiceKey), undefined)
  const { definition, assets } = testApplication('calculator')
  const host = await start({ applications: [{ definition, assets }], picker: { platform: 'darwin' } })
  assert.equal((await host.products.open('calculator')).state, 'running')
  assert.equal(host.root.get(directoryPickerServiceKey), undefined)
  assert.equal(host.root.get('client.connections'), undefined)
  assert.equal(host.root.get('claude-agent.connections'), undefined)
})

test('both applications share one selected picker and last-consumer stop waits for actual native dialog exit', async t => {
  const start = await fixture(t), entered = deferred(), exit = deferred()
  let signal
  const host = await start({ localInstanceId: instance.instanceId, picker: { platform: 'darwin', runDialog: async input => {
    signal = input; entered.resolve(); await exit.promise; return '/selected'
  } } })
  assert.equal(host.root.get(directoryPickerServiceKey), undefined)
  assert.equal((await host.products.open('agent')).state, 'running')
  const first = host.root.get(directoryPickerServiceKey)
  assert.equal((await host.products.open('claude-agent')).state, 'running')
  assert.equal(host.root.get(directoryPickerServiceKey), first)
  for (const id of ['agent', 'claude-agent']) assert.equal((await request(host, `/api/client/v1/apps/${id}/local`)).picker, true)
  const picking = assert.rejects(first.pick(), { code: 'cancelled' })
  await entered.promise
  await host.products.disable('agent')
  assert.equal(host.root.get(directoryPickerServiceKey), first)
  assert.equal(signal.aborted, false)
  let stopped = false
  const stopping = host.products.disable('claude-agent').then(result => { stopped = true; return result })
  await tick()
  assert.equal(signal.aborted, true)
  assert.equal(stopped, false, 'cancel does not prove the native resource exited')
  exit.resolve(); await picking
  assert.equal((await stopping).state, 'disabled')
  assert.equal(host.root.get(directoryPickerServiceKey), undefined)
  assert.equal(host.root.get('client.gateway'), undefined)
  assert.equal(host.root.get('claude-agent.gateway'), undefined)
  await host.products.open('agent')
  assert.notEqual(host.root.get(directoryPickerServiceKey), first)
  await assert.rejects(first.pick(), { code: 'unavailable' })
})

async function device(t) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Anybox-Instance-Id': instance.instanceId })
    res.end(JSON.stringify(req.url === '/api/v1/instance' ? instance : { route: req.url, ...body }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  return `http://127.0.0.1:${server.address().port}`
}

for (const mode of ['missing', 'unsupported', 'incompatible']) test(`${mode} optional picker leaves both application gateways and explicit project paths usable`, async t => {
  const start = await fixture(t), endpoint = await device(t), options = { localInstanceId: instance.instanceId, openEntry: memoryKeys() }
  let created = 0
  const descriptor = { id: 'system.directory-picker', version: mode === 'incompatible' ? '2.0.0' : '1.0.0',
    services: [directoryPickerServiceKey], supported: mode !== 'unsupported', create() {
      created++; return createDirectoryPickerComponent({ platform: 'darwin', runDialog: async () => '/must-not-use' })
    } }
  // A v2 consumer deliberately keeps its selected provider live. V1 applications must not use it through a root lookup.
  const modern = { definition: { id: 'modern', name: 'Modern', icon: 'folder' }, capabilityRequirements: { required: { 'system.directory-picker': '^2.0.0' } },
    createRuntime(root) { return createApplicationRuntime(root, () => {}) } }
  const host = await start({ applications: [harnessClientApplication(options), claudeAgentClientApplication(options), ...(mode === 'incompatible' ? [modern] : [])],
    providers: mode === 'missing' ? [] : [descriptor] }, createClientHost)
  if (mode === 'incompatible') {
    assert.equal((await host.products.open('modern')).state, 'running')
    assert.ok(host.root.get(directoryPickerServiceKey))
  }
  for (const id of ['agent', 'claude-agent']) {
    assert.equal((await host.products.open(id)).state, 'running')
    const base = `/api/client/v1/apps/${id}`
    assert.equal((await request(host, base + '/local')).picker, false)
    const saved = await request(host, base + '/connections', { name: 'Device', endpoint, token })
    assert.equal((await request(host, `${base}/connections/${saved.id}/check`, {})).instanceId, instance.instanceId)
    assert.equal((await request(host, `${base}/connections/${saved.id}/pick`, {}, 403)).error.code, 'picker-unavailable')
    const route = id === 'agent' ? '/projects' : '/apps/claude-agent/threads'
    const body = id === 'agent' ? { path: '/explicit/project' } : { projectPath: '/explicit/project', prompt: 'Hello' }
    const result = await request(host, `${base}/connections/${saved.id}/v1${route}`, body)
    assert.equal(result.route, `/api/v1${route}`)
    assert.equal(result.path ?? result.projectPath, '/explicit/project')
    await host.products.disable(id)
  }
  assert.equal(created, mode === 'incompatible' ? 1 : 0)
})

test('Harness server does not capture another application\'s incompatible picker from the shared root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-server-optional-picker-'))
  let host, picks = 0
  t.after(async () => { await host?.close(); await rm(directory, { recursive: true, force: true }) })
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'server.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ANYBOX_MODELS_CONFIG: join(directory, 'models.json') })
  const modern = { definition: { id: 'modern', name: 'Modern', icon: 'folder' }, capabilityRequirements: { required: { 'system.directory-picker': '^2.0.0' } },
    createRuntime(root) { return createApplicationRuntime(root, () => {}) } }
  host = await createExecutionHost({ databasePath: config.harnessDatabasePath, applications: [harnessServerApplication(config, {
    models: { openEntry: memoryKeys(), readLegacyCredential: async () => undefined, catalogAutoRefresh: false },
  }), modern], providers: [{ id: 'system.directory-picker', version: '2.0.0', services: [directoryPickerServiceKey],
    create: () => createDirectoryPickerComponent({ platform: 'darwin', runDialog: async () => { picks++; return directory } }) }] })
  await host.ready
  assert.equal((await host.products.open('modern')).state, 'running')
  assert.equal((await host.products.open('agent')).state, 'running')
  const { token } = await host.root.get('host.access').issue('Test')
  const call = async (path, body) => {
    const response = await fetch(host.url + '/api/v1/apps/agent' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Anybox-Instance-Id': host.instance.instanceId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  assert.deepEqual(await call('/projects/picker'), { status: 200, data: { supported: false } })
  assert.deepEqual(await call('/projects/pick', {}), { status: 503, data: { error: { code: 'picker-unavailable' } } })
  assert.equal((await call('/projects')).status, 200)
  assert.equal(picks, 0)
})

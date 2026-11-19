import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Context } from '@nya/core'
import { createChatCompletionsProtocolComponent, createModelsComponent, createModelsJsonStoreComponent, createModelsVaultComponent } from '@anybox/models'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createLocalWebHost } from '../../distribution/dist/composition/local-web.js'
import { parseHarnessServerConfig } from '../../app-harness/dist/server-config.js'
import { seedHarnessModel } from '../../../tests/helpers/configured-models.mjs'
import { personalAgentServerApplication } from '../dist/registration.js'
import { parsePersonalAgentServerConfig } from '../dist/server-config.js'

const clientApi = '/api/client/v1'
const ownApi = clientApi + '/apps/personal-agent'

function vault() {
  const secrets = new Map()
  return {
    secrets,
    openEntry(namespace, id) {
      const key = namespace + ':' + id
      return {
        getPassword: async () => secrets.get(key),
        setPassword: async value => { secrets.set(key, value) },
        deleteCredential: async () => { secrets.delete(key) },
      }
    },
  }
}

async function seedPreviousModels(config, openEntry) {
  const root = new Context()
  try {
    await root.installComponent(createModelsJsonStoreComponent({ path: config.modelsConfigPath }))
    await root.installComponent(createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry }))
    await root.installComponent(createModelsComponent())
    await root.installComponent(createChatCompletionsProtocolComponent())
    const model = await seedHarnessModel(root.get('models.settings'), { id: 'retained-model', apiKey: 'personal-test-secret' })
    return { id: model.id, connectionId: model.connectionId }
  } finally {
    await root.fiber.dispose()
  }
}

async function request(origin, path, body, headers = {}, status = 200) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const data = await response.json()
  assert.equal(response.status, status, path + ' ' + JSON.stringify(data))
  return data
}

async function managedConnection(origin, appId) {
  const base = clientApi + '/apps/' + appId
  assert.equal((await request(origin, clientApi + '/products/' + appId + '/open', {})).state, 'running')
  const deadline = Date.now() + 10000
  while (true) {
    const state = await request(origin, base + '/local')
    if (state.status?.state === 'ready') break
    assert.notEqual(state.status?.state, 'failed', JSON.stringify(state))
    assert.ok(Date.now() < deadline, 'Local pairing has not become ready: ' + JSON.stringify(state))
    await wait(20)
  }
  const connections = await request(origin, base + '/connections')
  assert.equal(connections.length, 1)
  return connections[0]
}

test('Personal Agent uses an isolated native execution and retains earlier Personal Agent Models and text records', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-native-'))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const clientPath = join(directory, 'client.sqlite')
  const legacyWork = JSON.stringify({ id: 'earlier-task', agentId: 'legacy-agent', kind: 'task', status: 'completed', title: 'Earlier work' })
  const previousRoot = new Context()
  try {
    await previousRoot.installComponent(createLocalSqliteComponent(clientPath))
    const storage = previousRoot.get('local-storage')
    await storage.migrate('personal-agent', [{ version: 1, up(tx) {
      tx.execute('CREATE TABLE personal_agent_works (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_work_id TEXT, record TEXT NOT NULL)')
      tx.execute('INSERT INTO personal_agent_works(id, agent_id, record) VALUES (?, ?, ?)', ['earlier-task', 'legacy-agent', legacyWork])
    } }])
  } finally {
    await previousRoot.fiber.dispose()
  }

  const harnessConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const { openEntry, secrets } = vault()
  const existingModel = await seedPreviousModels(personalConfig, openEntry)
  const calls = []
  const application = personalAgentServerApplication(personalConfig, { models: {
    openEntry, catalogAutoRefresh: false,
    async fetch(url, init) {
      const input = JSON.parse(init.body)
      calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), input })
      if (!input.stream) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'Personal Agent native answer' }, finish_reason: 'stop' }] })
      return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Personal Agent native answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } })
    },
  } })
  host = await createLocalWebHost({
    client: { path: clientPath, port: 0, openEntry },
    execution: { config: harnessConfig, options: { additionalApplications: [application], models: {
      openEntry, catalogAutoRefresh: false,
      fetch() { throw new Error('Personal Agent ran a model through Harness') },
    } } },
  })
  const origin = host.url
  assert.equal(host.execution.products.get('personal-agent').state, 'disabled')
  await assert.rejects(access(personalConfig.harnessDatabasePath), { code: 'ENOENT' })
  const personalConnection = await managedConnection(origin, 'personal-agent')
  const harnessConnection = await managedConnection(origin, 'agent')
  assert.equal(personalConnection.instanceId, host.execution.instance.instanceId)
  assert.equal(personalConnection.instanceId, harnessConnection.instanceId)
  assert.notEqual(personalConnection.id, harnessConnection.id)
  assert.ok([...secrets.keys()].some(key => key.startsWith('anybox.client.personal-agent:')))
  assert.ok([...secrets.keys()].some(key => key.startsWith('anybox.client.agent:')))
  assert.equal(host.execution.products.get('personal-agent').state, 'disabled')

  const proxyBase = ownApi + '/connections/' + encodeURIComponent(personalConnection.id) + '/v1'
  const binding = {
    'X-Anybox-Product-Id': 'personal-agent',
    'X-Anybox-Expected-Instance-Id': personalConnection.instanceId,
    'X-Anybox-Connection-Revision': String(personalConnection.revision),
  }
  const execution = (path, body, status) => request(origin, proxyBase + path, body, binding, status)
  assert.ok((await execution('/instance')).capabilities.includes('personal-agent.v1'))
  assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
  assert.equal((await execution('/products/agent/open', {}, 404)).error.code, 'not-found')
  assert.equal(host.execution.products.get('agent').state, 'disabled')
  assert.equal((await host.execution.products.open('agent')).state, 'running')

  const connections = await execution('/models/connections')
  assert.ok(connections.some(connection => connection.id === existingModel.connectionId && connection.credentialConfigured))
  assert.equal(host.root.get('harness.models.settings').connections().length, 0)
  await execution('/agents/assistant/tools', { toolIds: [], expectedRevision: 0 })
  const project = await execution('/projects', { path: directory })
  const harnessProjects = await request(origin, clientApi + '/apps/agent/connections/' + harnessConnection.id + '/v1/projects')
  assert.deepEqual(harnessProjects, [])
  const session = await execution('/sessions', { projectId: project.id, agentId: 'assistant', modelId: existingModel.id })
  const run = await execution('/sessions/' + session.id + '/runs', { input: 'Personal Agent request', parentNodeId: null, idempotencyKey: 'first-personal-run' })
  const settled = await execution('/runs/' + run.id + '/wait')
  assert.equal(settled.done, true)
  assert.equal(settled.run.status, 'completed')
  assert.equal(settled.run.output, 'Personal Agent native answer')
  const node = await execution('/sessions/' + session.id + '/nodes/' + settled.run.resultNodeId)
  assert.equal(node.output, 'Personal Agent native answer')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth, 'Bearer personal-test-secret')
  assert.equal(calls[0].url, 'https://model.invalid/v1/chat/completions')
  assert.ok(calls[0].input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Personal Agent request')))

  await host.close()
  host = undefined
  const retained = new DatabaseSync(clientPath, { readOnly: true })
  try {
    assert.equal(retained.prepare('SELECT record FROM personal_agent_works WHERE id = ?').get('earlier-task').record, legacyWork)
  } finally {
    retained.close()
  }
})

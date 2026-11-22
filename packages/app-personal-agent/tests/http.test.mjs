import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Context } from '@nya/core'
import sharp from 'sharp'
import { createAnthropicMessagesProtocolComponent, createChatCompletionsProtocolComponent, createGeminiInteractionsProtocolComponent,
  createModelsComponent, createModelsJsonStoreComponent, createModelsVaultComponent, createResponsesProtocolComponent, unknownCapabilities } from '@anybox/models'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createLocalWebHost } from '../../distribution/dist/composition/local-web.js'
import { parseHarnessServerConfig } from '../../app-harness/dist/server-config.js'
import { seedHarnessModel } from '../../../tests/helpers/configured-models.mjs'
import { connectLocalComputerWorker } from '../dist/core/computer/worker-client.js'
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

async function seedPersonalModels(config, openEntry, ...definitions) {
  const protocols = {
    'anthropic-messages': createAnthropicMessagesProtocolComponent,
    'chat-completions': createChatCompletionsProtocolComponent,
    'gemini-interactions': createGeminiInteractionsProtocolComponent,
    responses: createResponsesProtocolComponent,
  }
  const root = new Context()
  try {
    await root.installComponent(createModelsJsonStoreComponent({ path: config.modelsConfigPath }))
    await root.installComponent(createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry }))
    await root.installComponent(createModelsComponent())
    for (const id of new Set(definitions.map(definition => definition.protocolId ?? 'chat-completions'))) {
      await root.installComponent(protocols[id]())
    }
    const settings = root.get('models.settings')
    const models = []
    for (const definition of definitions) models.push(await seedHarnessModel(settings, definition))
    return models
  } finally {
    await root.fiber.dispose()
  }
}

function chatResponse(content, stream) {
  if (!stream) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })
  const delta = { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }
  const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } })
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

function personalExecution(origin, connection) {
  const base = ownApi + '/connections/' + encodeURIComponent(connection.id) + '/v1'
  const binding = {
    'X-Anybox-Product-Id': 'personal-agent',
    'X-Anybox-Expected-Instance-Id': connection.instanceId,
    'X-Anybox-Connection-Revision': String(connection.revision),
  }
  return (path, body, status) => request(origin, base + path, body, binding, status)
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
  const [existingModel] = await seedPersonalModels(personalConfig, openEntry, { id: 'retained-model', apiKey: 'personal-test-secret' })
  const calls = []
  const application = personalAgentServerApplication(personalConfig, { models: {
    openEntry, catalogAutoRefresh: false,
    async fetch(url, init) {
      const input = JSON.parse(init.body)
      calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), input })
      return chatResponse('Personal Agent native answer', input.stream)
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

  const execution = personalExecution(origin, personalConnection)
  assert.ok((await execution('/instance')).capabilities.includes('personal-agent.v1'))
  assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
  assert.equal((await execution('/products/agent/open', {}, 404)).error.code, 'not-found')
  assert.equal(host.execution.products.get('agent').state, 'disabled')
  assert.equal((await host.execution.products.open('agent')).state, 'running')
  const layout = store => store.read(reader => reader.get('PRAGMA user_version').user_version)
  assert.equal(await layout(host.root.get('host.execution.storage')), 3)
  assert.equal(await layout(host.root.get('personal-agent.local-storage')), 2)

  const accessPath = '/agents/assistant/environment-access'
  const harnessBase = clientApi + '/apps/agent/connections/' + encodeURIComponent(harnessConnection.id) + '/v1'
  const harnessBinding = { 'X-Anybox-Product-Id': 'agent', 'X-Anybox-Expected-Instance-Id': harnessConnection.instanceId,
    'X-Anybox-Connection-Revision': String(harnessConnection.revision) }
  const harnessAccess = () => request(origin, harnessBase + accessPath, undefined, harnessBinding)
  const personalBefore = await execution(accessPath), harnessBefore = await harnessAccess()
  assert.ok(personalBefore.authorization.grants.length > 0)
  assert.ok(harnessBefore.authorization.grants.length > 0)
  const revoke = { requestId: 'private-personal-revoke', expectedRevision: personalBefore.authorization.revision, tools: [] }
  const completed = await execution(accessPath + '/grants', revoke)
  assert.equal(completed.state, 'completed')
  assert.deepEqual(await execution(accessPath + '/grants', revoke), completed)
  assert.deepEqual(await execution(accessPath + '/changes/' + revoke.requestId), completed)
  const personalAfter = await execution(accessPath)
  assert.deepEqual(personalAfter.preference, personalBefore.preference)
  assert.deepEqual(personalAfter.authorization.grants, [])
  assert.deepEqual((await harnessAccess()).authorization, harnessBefore.authorization)
  await request(origin, harnessBase + accessPath + '/changes/' + revoke.requestId, undefined, harnessBinding, 404)

  const providers = await execution('/models/provider-settings')
  assert.ok(providers.some(provider => provider.id === existingModel.providerId && provider.credentialConfigured))
  assert.deepEqual(await execution(`/models/settings?providerId=${encodeURIComponent(existingModel.providerId)}`), [existingModel])
  assert.equal(host.root.get('harness.models.settings').configuredProviders().length, 0)
  const project = await execution('/projects', { path: directory })
  const harnessProjects = await request(origin, clientApi + '/apps/agent/connections/' + harnessConnection.id + '/v1/projects')
  assert.deepEqual(harnessProjects, [])
  const session = await execution('/sessions', { projectId: project.id, agentId: 'assistant', modelId: existingModel.runtimeModelId })
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
  assert.deepEqual(calls[0].input.tools ?? [], [])
  assert.ok(calls[0].input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Personal Agent request')))
  await execution('/agents/assistant/tools', { toolIds: [], expectedRevision: 0 })

  await host.close()
  host = undefined
  const retained = new DatabaseSync(clientPath, { readOnly: true })
  try {
    assert.equal(retained.prepare('SELECT record FROM personal_agent_works WHERE id = ?').get('earlier-task').record, legacyWork)
  } finally {
    retained.close()
  }
})

test('Personal Agent gateway persists Agent settings and shader avatars without adding them to execution', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-directory-'))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const clientPath = join(directory, 'client.sqlite')
  const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'execution-host.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const legacyFields = { name: 'Older Agent', description: 'A directory record from before avatars.', instructions: 'Read the project.', modelId: null }
  const legacyRoot = new Context()
  try {
    await legacyRoot.installComponent(createLocalSqliteComponent(personalConfig.harnessDatabasePath))
    await legacyRoot.get('local-storage').migrate('personal-agent-directory', [{ version: 1, up(tx) {
      tx.execute(`CREATE TABLE personal_agent_directory (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL,
        instruction_version_id TEXT, model_id TEXT, environment_ids_json TEXT, revision INTEGER NOT NULL,
        creation_request_id TEXT UNIQUE, creation_digest TEXT)`)
      tx.execute(`INSERT INTO personal_agent_directory (id, name, description, instructions, revision, creation_request_id, creation_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, ['older-agent', legacyFields.name, legacyFields.description, legacyFields.instructions, 2,
        'older-request', createHash('sha256').update(JSON.stringify(legacyFields)).digest('hex')])
    } }])
  } finally { await legacyRoot.fiber.dispose() }
  const { openEntry } = vault()
  const [firstModel, secondModel] = await seedPersonalModels(personalConfig, openEntry,
    { id: 'first-research-model', remoteModelId: 'mock-original' }, { id: 'second-research-model', remoteModelId: 'mock-updated' })
  const calls = []
  const application = personalAgentServerApplication(personalConfig, { models: {
    openEntry, catalogAutoRefresh: false,
    async fetch(_url, init) {
      const input = JSON.parse(init.body)
      calls.push(input)
      return chatResponse(`Response from ${input.model}`, input.stream)
    },
  } })

  async function openExecution() {
    host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
      execution: { config: executionConfig, options: { applications: [application] } } })
    const origin = host.url
    const connection = await managedConnection(origin, 'personal-agent')
    const execution = personalExecution(origin, connection)
    assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
    return execution
  }

  async function runMessage(execution, session, input, parentNodeId, idempotencyKey) {
    const run = await execution(`/sessions/${session.id}/runs`, { input, parentNodeId, idempotencyKey })
    const settled = await execution(`/runs/${run.id}/wait`)
    assert.equal(settled.done, true)
    assert.equal(settled.run.status, 'completed')
    return settled.run
  }

  let execution = await openExecution()
  const initialAgents = await execution('/agents')
  assert.ok(initialAgents.some(agent => agent.id === 'assistant'))
  assert.deepEqual(await execution('/agents/older-agent'), { id: 'older-agent', ...legacyFields, revision: 2 })
  assert.equal((await execution('/agents', { ...legacyFields, requestId: 'older-request', logoShader: null }, 201)).id, 'older-agent')

  const originalInstructions = '  Summarize findings and cite the source of each fact.\n'
  const updatedInstructions = 'Rank evidence by reliability and state any uncertainty.'
  const originalShader = '\nvec3 paint(vec2 uv, float t, float edge) {\n  return vec3(uv, 0.35);\n}\n'
  const updatedShader = 'vec3 paint(vec2 uv, float t, float edge) { return vec3(0.1, 0.5 + 0.2 * sin(t), 0.7); }'
  const create = { name: '  Research  ', description: '  Summarizes research  ', instructions: originalInstructions,
    modelId: null, logoShader: originalShader, requestId: 'create-research' }
  assert.equal((await execution('/agents', { ...create, name: '  ' }, 400)).error.code, 'invalid-input')
  assert.equal((await execution('/agents', { ...create, modelId: 'nonexistent-model' }, 400)).error.code, 'model-not-found')
  assert.equal((await execution('/agents', { ...create, logoShader: '花'.repeat(11_000) }, 400)).error.code, 'invalid-input')
  const created = await execution('/agents', create, 201)
  assert.ok(created.id && !initialAgents.some(agent => agent.id === created.id))
  assert.deepEqual(created, { id: created.id, name: 'Research', description: 'Summarizes research',
    instructions: originalInstructions, modelId: null, revision: created.revision, logoShader: originalShader })
  assert.deepEqual(await execution('/agents', { ...create, name: created.name, description: created.description,
    instructions: created.instructions }, 201), created)
  assert.equal((await execution('/agents', { ...create, name: 'Finance' }, 409)).error.code, 'agent-request-conflict')
  assert.equal((await execution('/agents', { ...create, logoShader: updatedShader }, 409)).error.code, 'agent-request-conflict')

  const agentPath = '/agents/' + encodeURIComponent(created.id)
  assert.deepEqual(await execution(agentPath), created)
  const firstEdit = { name: created.name, description: created.description, instructions: created.instructions,
    modelId: firstModel.id, expectedRevision: created.revision }
  const configured = await execution(agentPath, firstEdit)
  assert.equal(configured.modelId, firstModel.id)
  assert.equal(configured.logoShader, originalShader)
  assert.ok(configured.revision > created.revision)

  const project = await execution('/projects', { path: directory })
  const continuous = await execution(`${agentPath}/session`, { projectId: project.id })
  const oldSession = await execution('/sessions', { projectId: project.id, agentId: created.id })
  assert.equal(oldSession.modelId, firstModel.id)
  const firstRun = await runMessage(execution, oldSession, 'Find evidence for the initial report.', null, 'initial-message')
  assert.equal(firstRun.output, 'Response from mock-original')

  const rename = { name: 'Research Desk', description: 'Evaluates research evidence', instructions: updatedInstructions,
    modelId: secondModel.id, logoShader: updatedShader, expectedRevision: configured.revision }
  const updated = await execution(agentPath, rename)
  assert.equal(updated.id, created.id)
  assert.equal(updated.logoShader, updatedShader)
  assert.ok(updated.revision > configured.revision)
  assert.equal((await execution(agentPath, firstEdit, 409)).error.code, 'agent-revision-conflict')

  await host.close()
  host = undefined
  execution = await openExecution()
  assert.deepEqual(await execution(agentPath), updated)
  assert.equal((await execution('/agents', create, 201)).id, created.id)
  const agents = await execution('/agents')
  assert.equal(agents.length, initialAgents.length + 1)
  assert.deepEqual(agents.find(agent => agent.id === created.id), { id: created.id, name: rename.name, description: rename.description, logoShader: updatedShader })
  assert.equal((await execution(`${agentPath}/session`, { projectId: project.id })).id, continuous.id)

  const newSession = await execution('/sessions', { projectId: project.id, agentId: created.id })
  assert.equal(newSession.modelId, secondModel.id)
  const newRun = await runMessage(execution, newSession, 'Review the new report.', null, 'new-message')
  assert.equal(newRun.output, 'Response from mock-updated')
  const continued = await runMessage(execution, oldSession, 'Continue the initial report.', firstRun.resultNodeId, 'follow-up')
  assert.equal(continued.output, 'Response from mock-original')

  assert.deepEqual(calls.map(call => call.model), ['mock-original', 'mock-updated', 'mock-original'])
  const systemMessages = call => call.messages.filter(message => message.role === 'system').map(message => message.content)
  assert.ok(systemMessages(calls[0]).includes(originalInstructions))
  assert.ok(systemMessages(calls[1]).includes(updatedInstructions))
  assert.ok(systemMessages(calls[2]).includes(originalInstructions))
  assert.ok(!systemMessages(calls[2]).includes(updatedInstructions))
  assert.ok(calls[2].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Find evidence for the initial report.')))
  assert.ok(calls.every(call => !JSON.stringify(call).includes('vec3 paint')))

  const defaultsPath = agentPath + '/session-defaults'
  const defaults = await execution(defaultsPath)
  assert.equal(defaults.effectiveModelId, updated.modelId)
  assert.equal(defaults.revision, updated.revision)
  const cleared = await execution(defaultsPath, { modelId: null, expectedRevision: defaults.revision })
  assert.deepEqual(await execution(agentPath), { ...updated, modelId: null, revision: cleared.revision })
  const noLogo = await execution(agentPath, { ...rename, modelId: null, logoShader: null, expectedRevision: cleared.revision })
  assert.ok(!('logoShader' in noLogo))
  assert.ok(!('logoShader' in (await execution('/agents')).find(agent => agent.id === created.id)))
  assert.equal((await execution(`${agentPath}/session`, { projectId: project.id })).id, continuous.id)
})

test('Personal Agent preserves continuous history across models and lets the provider reject a large request', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-continuous-'))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const clientPath = join(directory, 'client.sqlite')
  const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'execution.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const { openEntry } = vault()
  const [model, updatedModel] = await seedPersonalModels(personalConfig, openEntry,
    { id: 'continuous-model', remoteModelId: 'model-before', limits: { context: 16_000, output: 1_000 } },
    { id: 'continuous-updated-model', remoteModelId: 'model-after', limits: { context: 16_000, output: 1_000 } })
  const calls = [], rejectedCalls = []
  const application = personalAgentServerApplication(personalConfig, { models: {
    openEntry, catalogAutoRefresh: false,
    async fetch(_url, init) {
      const input = JSON.parse(init.body)
      const last = input.messages.at(-1)?.content
      if (typeof last === 'string' && (last.startsWith('yyyyy') || last.length >= 50_000)) {
        rejectedCalls.push(input)
        return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 })
      }
      calls.push(input)
      return chatResponse('Recorded.', input.stream)
    },
  } })
  async function openExecution() {
    host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
      execution: { config: executionConfig, options: { applications: [application] } } })
    const connection = await managedConnection(host.url, 'personal-agent')
    const execution = personalExecution(host.url, connection)
    assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
    return execution
  }

  let execution = await openExecution()
  const assistantRoute = '/agents/assistant/session'
  const [personal, repeated] = await Promise.all([execution(assistantRoute, {}), execution(assistantRoute, {})])
  assert.equal(personal.continuous, true)
  assert.equal(personal.id, repeated.id)
  assert.equal(personal.projectId, repeated.projectId)
  assert.deepEqual(await execution('/projects'), [])
  assert.equal((await execution('/agents/unknown/session', {}, 404)).error.code, 'agent-not-found')
  const alphaDir = join(directory, 'alpha'), betaDir = join(directory, 'beta')
  await Promise.all([mkdir(alphaDir), mkdir(betaDir)])
  await writeFile(join(betaDir, 'beta-notes.txt'), 'Only the Beta project has this file.')
  const [alpha, beta] = await Promise.all([
    execution('/projects', { path: alphaDir }), execution('/projects', { path: betaDir }),
  ])
  const agent = await execution('/agents', { name: 'Reports', description: '', instructions: 'Follow current instructions.',
    modelId: model.runtimeModelId, requestId: 'create-continuous-agent' }, 201)
  const sessionRoute = `/agents/${agent.id}/session`
  const [first, second] = await Promise.all([
    execution(sessionRoute, { projectId: alpha.id }), execution(sessionRoute, { projectId: beta.id }),
  ])
  assert.equal(first.id, second.id)
  assert.equal(first.continuous, true)
  assert.equal(first.projectId, alpha.id)
  assert.equal(second.projectId, beta.id)
  assert.equal(first.headNodeId, null)

  const session = `/sessions/${first.id}`
  const files = await execution(`${session}/project-files/tree/open?projectId=${beta.id}`, { path: '' })
  assert.ok(files.entries.some(item => item.name === 'beta-notes.txt'))
  const [reference] = await execution(`${session}/project-files/prepare`, { projectId: beta.id, preparationKey: 'beta-reference',
    selections: [{ kind: 'project-file', path: 'beta-notes.txt' }] })
  assert.equal(reference.projectId, beta.id)
  const wrongProject = await execution(`${session}/runs`, { input: 'Use the file.', parentNodeId: null, projectId: alpha.id,
    idempotencyKey: 'wrong-project-file', files: [{ snapshotId: reference.snapshotId }] }, 409)
  assert.equal(wrongProject.error.code, 'invalid-history')

  let parentNodeId = null
  let next = 0
  async function send(projectId, input, modelId) {
    const body = { input, projectId, parentNodeId, modelId, idempotencyKey: `continuous-${++next}` }
    const run = await execution(`${session}/runs`, body)
    const { done, run: settled } = await execution(`/runs/${run.id}/wait`)
    assert.equal(done, true)
    assert.equal(settled.status, 'completed')
    assert.equal(settled.projectId, projectId)
    assert.equal(settled.history.parentNodeId, parentNodeId)
    parentNodeId = settled.resultNodeId
    return { body, run: settled, messages: calls.at(-1).messages }
  }

  const original = '周报格式定为先风险再进度。旧代号 VIOLETOWL。'
  const opening = await send(alpha.id, original)
  const crossProject = await execution(`${session}/runs`, { input: '记下这批采购单。', parentNodeId, projectId: beta.id,
    idempotencyKey: 'different-project' }, 409)
  assert.equal(crossProject.error.code, 'history-incompatible')
  assert.equal(calls.length, 1)

  const bigInput = '物流进度记录。' + 'x'.repeat(27_000)
  const logistics = await send(alpha.id, bigInput)
  assert.deepEqual(logistics.messages, [...opening.messages, { role: 'assistant', content: 'Recorded.' }, { role: 'user', content: bigInput }])
  const overBudget = await execution(`${session}/runs`, { input: 'y'.repeat(27_000), parentNodeId, projectId: alpha.id,
    idempotencyKey: 'native-history-over-budget' })
  const rejected = await execution(`/runs/${overBudget.id}/wait`)
  assert.equal(rejected.run.status, 'failed')
  assert.equal(rejected.run.errorCategory, 'provider-failure')
  assert.ok(overBudget.estimatedInputTokens > 16_000)
  const rejectedResume = await host.root.get('personal-agent.session-runs').loadRunResume(overBudget.id)
  assert.ok(rejectedResume.history, 'an over-limit estimate still uses the native parent')
  assert.equal(rejectedResume.applicationPrefix, undefined)
  assert.deepEqual(rejectedCalls[0].messages, [...logistics.messages, { role: 'assistant', content: 'Recorded.' },
    { role: 'user', content: 'y'.repeat(27_000) }])
  assert.equal(calls.length, 2)
  assert.equal((await execution(sessionRoute, { projectId: alpha.id })).headNodeId, logistics.run.resultNodeId)

  const oldReference = `请按刚才定的周报格式写一版。[历史:${opening.run.resultNodeId}]`
  const followUp = await send(alpha.id, oldReference)
  assert.deepEqual(followUp.messages, [...logistics.messages, { role: 'assistant', content: 'Recorded.' }, { role: 'user', content: oldReference }])
  const prior = await execution(`${session}/runs`, followUp.body)
  assert.equal(prior.id, followUp.run.id)
  const duplicate = await execution(`${session}/runs`, { ...followUp.body, projectId: beta.id }, 409)
  assert.equal(duplicate.error.code, 'conflict')
  assert.equal(calls.length, next)
  const stale = await execution(`${session}/runs`, { ...opening.body, idempotencyKey: 'stale-position' }, 409)
  assert.equal(stale.error.code, 'history-position-changed')
  const oversize = await execution(`${session}/runs`, { input: 'x'.repeat(50_000), parentNodeId, projectId: alpha.id,
    idempotencyKey: 'input-over-budget' })
  assert.equal((await execution(`/runs/${oversize.id}/wait`)).run.errorCategory, 'provider-failure')
  assert.equal(rejectedCalls.length, 2)
  assert.equal(calls.length, next)
  assert.equal((await execution(`${session}/nodes/${opening.run.resultNodeId}`)).input, original)

  const furtherInputs = Array.from({ length: 32 }, (_, index) => `Check item ${index + 1}.`)
  for (const input of furtherInputs) await send(alpha.id, input)
  const furtherMessages = furtherInputs.flatMap(content => [{ role: 'assistant', content: 'Recorded.' }, { role: 'user', content }])
  assert.deepEqual(calls.at(-1).messages, [...followUp.messages, ...furtherMessages])

  await host.close()
  host = undefined
  const database = new DatabaseSync(personalConfig.harnessDatabasePath, { readOnly: true })
  try {
    assert.equal(database.prepare('SELECT count(*) AS count FROM harness_continuous_roots').get().count, 0)
    assert.equal(database.prepare('SELECT count(*) AS count FROM harness_continuous_run_contexts').get().count, 0)
  } finally { database.close() }
  execution = await openExecution()
  const reopened = await execution(sessionRoute, { projectId: beta.id })
  assert.equal(reopened.id, first.id)
  assert.equal(reopened.headNodeId, parentNodeId)
  const managed = await execution(sessionRoute, {})
  assert.equal(managed.id, first.id)
  assert.equal(managed.headNodeId, parentNodeId)
  assert.notEqual(managed.projectId, beta.id)
  assert.notEqual(managed.projectId, personal.projectId)
  assert.deepEqual(await execution(assistantRoute, {}), personal)
  assert.equal((await execution(sessionRoute, { projectId: personal.projectId }, 409)).error.code, 'project-unavailable')
  assert.equal((await execution(`${session}/project-files/tree/open?projectId=${personal.projectId}`, { path: '' }, 409)).error.code, 'project-unavailable')
  const managedKey = createHash('sha256').update(JSON.stringify(agent.id)).digest('hex')
  await writeFile(join(`${personalConfig.harnessDatabasePath}.workspaces`, managedKey, 'notes.txt'), 'Only the Agent workspace has this file.')
  const managedFiles = await execution(`${session}/project-files/tree/open?projectId=${managed.projectId}`, { path: '' })
  assert.ok(managedFiles.entries.some(item => item.name === 'notes.txt'))
  const [managedRef] = await execution(`${session}/project-files/prepare`, { projectId: managed.projectId, preparationKey: 'managed-reference',
    selections: [{ kind: 'project-file', path: 'notes.txt' }] })
  assert.equal(managedRef.projectId, managed.projectId)
  const managedRun = await execution(`${session}/runs`, { input: '检查 Agent 文件。', projectId: managed.projectId, parentNodeId,
    files: [{ snapshotId: managedRef.snapshotId }], idempotencyKey: 'different-workspace' }, 409)
  assert.equal(managedRun.error.code, 'history-incompatible')
  assert.equal((await execution(sessionRoute, {})).headNodeId, parentNodeId)
  const provider = (await execution('/models/provider-settings')).find(item => item.id === model.providerId)
  assert.ok(provider)
  const rotated = await execution(`/models/provider-settings/${encodeURIComponent(provider.id)}/key`,
    { apiKey: 'rotated-fixture-key', expectedRevision: provider.revision })
  assert.equal(rotated.credentialConfigured, true)
  assert.ok(rotated.revision > provider.revision)
  const previousMessages = calls.at(-1).messages
  const keyFollowUp = 'Continue with the new Key.'
  const afterRotation = await send(alpha.id, keyFollowUp)
  assert.deepEqual(afterRotation.messages, [...previousMessages, { role: 'assistant', content: 'Recorded.' }, { role: 'user', content: keyFollowUp }])
  const afterRotationSession = await execution(sessionRoute, { projectId: alpha.id })
  assert.equal(afterRotationSession.id, first.id)
  assert.equal(afterRotationSession.headNodeId, afterRotation.run.resultNodeId)
  assert.equal(calls.length, next)

  const originalMessages = calls.at(-1).messages
  const modelSwitch = 'Continue on another model.'
  const defaultsPath = `/agents/${agent.id}/session-defaults`
  const defaults = await execution(defaultsPath)
  await execution(defaultsPath, { modelId: updatedModel.runtimeModelId, expectedRevision: defaults.revision })
  const savedSessionModel = await execution(`${session}/model`, { modelId: model.runtimeModelId })
  assert.equal(savedSessionModel.modelId, updatedModel.runtimeModelId)
  assert.equal((await execution(session)).modelId, updatedModel.runtimeModelId)
  const differentModel = await send(alpha.id, modelSwitch, model.runtimeModelId)
  assert.equal(calls.at(-1).model, 'model-after')
  assert.deepEqual(differentModel.messages, [...originalMessages, { role: 'assistant', content: 'Recorded.' }, { role: 'user', content: modelSwitch }])
  assert.equal((await execution(sessionRoute, { projectId: alpha.id })).headNodeId, differentModel.run.resultNodeId)

  const parameters = { protocolId: 'chat-completions', formatVersion: 1, value: { max_tokens: 600 } }
  await execution(`/models/settings/${encodeURIComponent(updatedModel.id)}`, { patch: { parameters }, expectedRevision: updatedModel.revision })
  const withNewParameters = 'Continue with the new output limit.'
  const updated = await send(alpha.id, withNewParameters)
  assert.equal(calls.at(-1).max_tokens, 600)
  assert.deepEqual(updated.messages, [...differentModel.messages, { role: 'assistant', content: 'Recorded.' }, { role: 'user', content: withNewParameters }])
})

test('Personal Agent keeps native Chat Completions across restarts and renders a detached legacy chain', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-native-continuous-'))
  const workerDirectory = join(directory, 'computer-worker')
  const worker = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
  let host
  t.after(async () => {
    try { await host?.close() } finally {
      try { await worker.shutdown() } finally {
        await worker.closeObserver()
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  const clientPath = join(directory, 'client.sqlite')
  const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'execution.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const { openEntry } = vault()
  const originalKey = 'original-fixture-key'
  const rotatedKey = 'rotated-fixture-key'
  const [model] = await seedPersonalModels(personalConfig, openEntry, {
    id: 'native-continuous-deepseek', remoteModelId: 'deepseek-reasoner', apiKey: originalKey,
    capabilities: { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' },
      reasoning: { support: 'supported', modes: ['enabled'] } },
    limits: { context: 32_000, output: 512 }, parameters: { thinking: { type: 'enabled' }, max_tokens: 512 },
  })
  const toolCall = { id: 'native-deepseek-read', type: 'function',
    function: { name: 'claude_code_Read', arguments: JSON.stringify({ file_path: 'fixture.txt' }) } }
  const toolRequest = { role: 'assistant', content: null, reasoning_content: 'Private reasoning before reading.', tool_calls: [toolCall] }
  const firstAnswer = { role: 'assistant', content: 'Read and recorded the fixture.', reasoning_content: 'Private reasoning after reading.' }
  const secondAnswer = { role: 'assistant', content: 'Continued the conversation.', reasoning_content: 'Private reasoning after reopening.' }
  const thirdAnswer = { role: 'assistant', content: 'Continued again.' }
  const fourthAnswer = { role: 'assistant', content: 'Continued after a detached legacy Run.', reasoning_content: 'Private reasoning before Key rotation.' }
  const fifthAnswer = { role: 'assistant', content: 'Continued with the new Key.' }
  const responses = [toolRequest, firstAnswer, secondAnswer, thirdAnswer, fourthAnswer, fifthAnswer]
  const calls = []
  const authorizations = []
  const application = personalAgentServerApplication(personalConfig, {
    localWorkerDirectory: workerDirectory,
    agents: [{ id: 'assistant', instructions: 'Use the available file tool when needed.', modelId: model.runtimeModelId, environmentIds: ['computer'] }],
    models: {
      openEntry, catalogAutoRefresh: false,
      async fetch(_url, init) {
        const message = responses[calls.length]
        calls.push(JSON.parse(init.body))
        assert.ok(message, 'unexpected provider exchange')
        authorizations.push(new Headers(init.headers).get('authorization'))
        return Response.json({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
      },
    },
  })
  async function openExecution() {
    host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
      execution: { config: executionConfig, options: { applications: [application] } } })
    const execution = personalExecution(host.url, await managedConnection(host.url, 'personal-agent'))
    assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
    return execution
  }

  const projectPath = join(directory, 'project')
  const fixturePath = join(projectPath, 'fixture.txt')
  const fileContents = 'Private tool result from the fixture file.'
  await mkdir(projectPath)
  await writeFile(fixturePath, fileContents)
  let execution = await openExecution()
  const project = await execution('/projects', { path: projectPath })
  await execution('/agents/assistant/tools', { toolIds: ['claude-code.Read'], expectedRevision: 0 })
  const sessionRoute = '/agents/assistant/session'
  const session = await execution(sessionRoute, { projectId: project.id })
  assert.equal(session.continuous, true)
  let parentNodeId = null
  async function send(input, idempotencyKey) {
    const run = await execution(`/sessions/${session.id}/runs`, { input, projectId: project.id, parentNodeId, idempotencyKey })
    const { done, run: settled } = await execution(`/runs/${run.id}/wait`)
    assert.equal(done, true)
    assert.equal(settled.status, 'completed', JSON.stringify(settled))
    assert.ok(settled.resultNodeId)
    parentNodeId = settled.resultNodeId
    return settled
  }

  const firstPrompt = 'Read the fixture file.'
  const firstRun = await send(firstPrompt, 'native-first')
  assert.equal(firstRun.output, firstAnswer.content)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].model, 'deepseek-reasoner')
  assert.deepEqual(calls[0].thinking, { type: 'enabled' })
  assert.deepEqual(calls[0].messages.at(-1), { role: 'user', content: firstPrompt })
  const toolResult = calls[1].messages.at(-1)
  assert.equal(toolResult.role, 'tool')
  assert.equal(toolResult.tool_call_id, toolCall.id)
  assert.equal(JSON.parse(toolResult.content).text, `1: ${fileContents}`)
  assert.deepEqual(calls[1].messages, [...calls[0].messages, toolRequest, toolResult])

  await host.close()
  host = undefined
  await writeFile(fixturePath, 'Changed after the original tool result was recorded.')
  execution = await openExecution()
  const reopened = await execution(sessionRoute, { projectId: project.id })
  assert.equal(reopened.id, session.id)
  assert.equal(reopened.headNodeId, parentNodeId)
  const secondPrompt = 'Continue after reopening.'
  const secondRun = await send(secondPrompt, 'native-second')
  assert.equal(secondRun.output, secondAnswer.content)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2].messages, [...calls[1].messages, firstAnswer, { role: 'user', content: secondPrompt }])
  const runRecords = host.root.get('personal-agent.session-runs')
  const resumed = await runRecords.loadRunResume(secondRun.id)
  assert.ok(resumed.history)
  assert.ok(resumed.history.records.every(record => record.runId === firstRun.id))
  assert.deepEqual(resumed.history.records.filter(record => record.kind === 'response').map(record => record.payload.choices[0].message),
    [toolRequest, firstAnswer])

  await host.close()
  host = undefined
  // Represent those same two linked Runs in the pre-upgrade schema.
  const legacyRootId = 'legacy-continuous-root'
  const legacyDatabase = new DatabaseSync(personalConfig.harnessDatabasePath)
  try {
    legacyDatabase.prepare(`INSERT INTO harness_continuous_roots (id, session_id, cutoff_seq, evicted_node_ids_json)
      VALUES (?, ?, 0, '[]')`).run(legacyRootId, session.id)
    legacyDatabase.prepare(`INSERT INTO harness_continuous_run_contexts (run_id, root_id, initialization_json, selection_json)
      SELECT id, ?, continuous_initialization_json, ? FROM harness_runs WHERE id IN (?, ?)`)
      .run(legacyRootId, JSON.stringify({ rootId: legacyRootId, recentNodeIds: [], memoryNodeIds: [] }), firstRun.id, secondRun.id)
    legacyDatabase.exec(`CREATE VIRTUAL TABLE harness_continuous_search USING fts5(terms, session_id UNINDEXED, project_id UNINDEXED);
      DROP TABLE harness_run_environment_access;
      DROP TABLE harness_session_environments;
      DROP TABLE harness_environment_preferences;
      DROP TRIGGER harness_runs_history_insert;
      DROP TRIGGER harness_runs_application_prefix_immutable;
      DROP TRIGGER harness_runs_continuous_initialization_immutable;
      ALTER TABLE harness_runs DROP COLUMN estimated_input_tokens;
      ALTER TABLE harness_runs DROP COLUMN application_prefix;
      ALTER TABLE harness_runs DROP COLUMN continuous_initialization_json;
      DROP TABLE harness_application_turns;
      CREATE TRIGGER harness_runs_history_insert BEFORE INSERT ON harness_runs
        WHEN NEW.history_kind != 'tree' OR NEW.context_version IS NOT 'native-local-v1'
          OR NEW.result_node_id IS NOT NULL OR NEW.binding_json IS NULL OR NEW.native_input_json IS NULL
          OR NEW.initialization_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM harness_sessions s WHERE s.id = NEW.session_id AND s.history_mode = 'native-local-v1'
            AND (s.continuous = 0 OR s.head_node_id IS NEW.parent_node_id)
            AND ((s.continuous = 1 AND NEW.parent_context_ref IS NULL)
              OR (s.continuous = 0 AND NEW.parent_node_id IS NULL)
              OR EXISTS (SELECT 1 FROM harness_nodes WHERE id = NEW.parent_node_id AND session_id = s.id
                AND context_ref = NEW.parent_context_ref)))
        BEGIN SELECT RAISE(ABORT, 'invalid native Run history'); END;
      UPDATE schema_migrations SET version = 15 WHERE domain = 'run-state'`)
    legacyDatabase.prepare('INSERT INTO harness_continuous_search (terms, session_id, project_id) VALUES (?, ?, ?)')
      .run('legacy recall', session.id, project.id)
  } finally { legacyDatabase.close() }

  execution = await openExecution()
  const migratedResume = await host.root.get('personal-agent.session-runs').loadRunResume(secondRun.id)
  assert.equal(migratedResume.run.estimatedInputTokens, undefined)
  assert.deepEqual(migratedResume.history, resumed.history)
  assert.deepEqual(migratedResume.initialization, resumed.initialization)
  const thirdPrompt = 'Continue one more time.'
  await send(thirdPrompt, 'native-third')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[3].messages, [...calls[2].messages, secondAnswer, { role: 'user', content: thirdPrompt }])

  await host.close()
  host = undefined
  // Simulate a pre-upgrade Run that started a new native segment with a recalled excerpt.
  const database = new DatabaseSync(personalConfig.harnessDatabasePath)
  const legacyMemory = JSON.stringify({ type: 'historical-memory', sources: [
    { nodeId: firstRun.resultNodeId, user: 'Old question', assistant: 'LEGACY-RECALL-ONLY' },
  ] })
  try {
    const triggers = database.prepare('SELECT name, sql FROM sqlite_schema WHERE name IN (?, ?, ?, ?)')
      .all('harness_continuous_run_contexts_immutable', 'harness_native_records_immutable', 'harness_runs_native_immutable', 'harness_native_contexts_immutable')
    assert.equal(triggers.length, 4)
    for (const { name } of triggers) database.exec(`DROP TRIGGER ${name}`)
    database.prepare(`UPDATE harness_continuous_run_contexts SET selection_json = json_set(selection_json, '$.memoryNodeIds', json(?)) WHERE run_id = ?`)
      .run(JSON.stringify([firstRun.resultNodeId]), secondRun.id)
    const stored = database.prepare("SELECT id, payload_json FROM harness_native_records WHERE run_id = ? AND kind = 'request'").get(secondRun.id)
    const payload = JSON.parse(stored.payload_json)
    payload.messages.splice(-1, 0, { role: 'user', content: legacyMemory })
    database.prepare('UPDATE harness_native_records SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), stored.id)
    database.prepare('UPDATE harness_runs SET parent_context_ref = NULL WHERE id = ?').run(secondRun.id)
    database.prepare('UPDATE harness_native_contexts SET parent_ref = NULL WHERE run_id = ?').run(secondRun.id)
    for (const { sql } of triggers) database.exec(sql)
  } finally { database.close() }

  execution = await openExecution()
  const legacyView = await execution(`/runs/${secondRun.id}/view`)
  assert.ok(legacyView.exchanges[0].inputs.some(input => input.role === 'context' && input.text === legacyMemory))
  const fourthPrompt = 'Continue after the upgrade.'
  const upgradedRun = await send(fourthPrompt, 'native-after-legacy-recall')
  assert.equal(upgradedRun.output, fourthAnswer.content)
  assert.equal((await execution(sessionRoute, { projectId: project.id })).headNodeId, upgradedRun.resultNodeId)
  assert.equal(calls.length, 5)
  const upgradedMessages = calls[4].messages
  assert.doesNotMatch(JSON.stringify(upgradedMessages), /historical-memory|LEGACY-RECALL-ONLY/)
  assert.deepEqual(upgradedMessages.filter(message => message.role === 'user').map(message => message.content),
    [firstPrompt, secondPrompt, thirdPrompt, fourthPrompt])
  assert.deepEqual(upgradedMessages.filter(message => message.role === 'assistant' && message.content).map(message => message.content),
    [firstAnswer.content, secondAnswer.content, thirdAnswer.content])
  const upgradedTool = upgradedMessages.find(message => message.tool_calls?.length).tool_calls[0]
  assert.deepEqual(upgradedTool.function, toolCall.function)
  const upgradedResult = upgradedMessages.find(message => message.role === 'tool')
  assert.equal(upgradedResult.tool_call_id, upgradedTool.id)
  assert.equal(upgradedResult.content, toolResult.content)

  const provider = (await execution('/models/provider-settings')).find(item => item.id === model.providerId)
  assert.ok(provider)
  await execution(`/models/provider-settings/${encodeURIComponent(provider.id)}/key`,
    { apiKey: rotatedKey, expectedRevision: provider.revision })
  const fifthPrompt = 'Continue with the rotated Key.'
  const rotatedRun = await send(fifthPrompt, 'continue-after-key-rotation')
  assert.equal(rotatedRun.output, fifthAnswer.content)
  assert.deepEqual(authorizations, [...Array(5).fill(`Bearer ${originalKey}`), `Bearer ${rotatedKey}`])
  assert.deepEqual(calls[5].messages, [...upgradedMessages, assistant(fourthAnswer.content), { role: 'user', content: fifthPrompt }])
  const rotatedSession = await execution(sessionRoute, { projectId: project.id })
  assert.equal(rotatedSession.id, session.id)
  assert.equal(rotatedSession.headNodeId, rotatedRun.resultNodeId)

  await host.close()
  host = undefined
  const upgraded = new DatabaseSync(personalConfig.harnessDatabasePath, { readOnly: true })
  try {
    assert.equal(upgraded.prepare("SELECT version FROM schema_migrations WHERE domain = 'run-state'").get().version, 20)
    assert.equal(upgraded.prepare("SELECT name FROM sqlite_schema WHERE name = 'harness_continuous_search'").get(), undefined)
  } finally { upgraded.close() }
})

async function captureProvider(t, replies) {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const reply = replies[requests.length]
      requests.push({ method: request.method, path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      response.writeHead(reply ? 200 : 500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(reply ?? { error: 'Unexpected provider request' }))
    } catch {
      response.writeHead(400).end()
    }
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

const nativeRead = { id: 'read-tool-call', name: 'claude_code_Read', args: { file_path: 'fixture.txt' } }
const textBlock = text => ({ type: 'text', text })
const assistant = content => ({ role: 'assistant', content })
const responsesText = (id, text) => ({ type: 'message', id, role: 'assistant', phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }] })
const geminiText = text => ({ type: 'model_output', content: [textBlock(text)] })
const firstAnswerText = 'I read the fixture.'
const secondAnswerText = 'I remember the fixture.'
const nativeContinuationCases = [
  {
    protocolId: 'responses', endpoint: 'responses', field: 'input', resultType: 'function_call_output',
    reasoning: { support: 'supported', efforts: ['medium'] }, parameters: { reasoning: { effort: 'medium' } },
    user: content => ({ role: 'user', content }),
    toolRequest: [
      { type: 'reasoning', id: 'reasoning-before', encrypted_content: 'opaque-before', summary: [] },
      { type: 'function_call', id: 'tool-item', call_id: nativeRead.id, name: nativeRead.name,
        arguments: JSON.stringify(nativeRead.args), status: 'completed' },
    ],
    firstAnswer: [{ type: 'reasoning', id: 'reasoning-after', encrypted_content: 'opaque-after', summary: [] },
      responsesText('msg-first', firstAnswerText)],
    secondAnswer: [responsesText('msg-second', secondAnswerText)],
    reply: output => ({ object: 'response', status: 'completed', output }),
    toolResult: item => [item.type, item.call_id, item.output],
  },
  {
    protocolId: 'anthropic-messages', endpoint: 'messages', field: 'messages', resultType: 'tool_result',
    reasoning: { support: 'supported', modes: ['enabled'] },
    parameters: { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 } },
    user: text => ({ role: 'user', content: [textBlock(text)] }),
    toolRequest: [assistant([
      { type: 'thinking', thinking: 'Read before answering.', signature: 'signed-before' },
      { type: 'redacted_thinking', data: 'opaque-redacted' },
      { type: 'tool_use', id: nativeRead.id, name: nativeRead.name, input: nativeRead.args },
    ])],
    firstAnswer: [assistant([{ type: 'thinking', thinking: 'Use the file contents.', signature: 'signed-after' }, textBlock(firstAnswerText)])],
    secondAnswer: [assistant([textBlock(secondAnswerText)])],
    reply: ([message], tool) => ({ type: 'message', ...message, stop_reason: tool ? 'tool_use' : 'end_turn' }),
    toolResult: item => {
      assert.equal(item.role, 'user')
      const [block] = item.content
      return [block.type, block.tool_use_id, block.content]
    },
  },
  {
    protocolId: 'gemini-interactions', endpoint: 'interactions', field: 'input', resultType: 'function_result',
    reasoning: { support: 'supported', efforts: ['high'] }, parameters: { generation_config: { thinking_level: 'high' } },
    user: text => ({ type: 'user_input', content: [textBlock(text)] }),
    toolRequest: [
      { type: 'thought', signature: 'signed-before', summary: [textBlock('Check the fixture.')] },
      { type: 'function_call', id: nativeRead.id, name: nativeRead.name, arguments: nativeRead.args },
    ],
    firstAnswer: [{ type: 'thought', signature: 'signed-after', summary: [] }, geminiText(firstAnswerText)],
    secondAnswer: [geminiText(secondAnswerText)],
    reply: (steps, tool) => ({ status: tool ? 'requires_action' : 'completed', steps }),
    toolResult: item => [item.type, item.call_id, item.result[0].text],
  },
]

for (const protocol of nativeContinuationCases) test(`Personal Agent sends native ${protocol.protocolId} history across Runs over HTTP`,
  { timeout: 60_000 }, async t => {
    const provider = await captureProvider(t, [protocol.reply(protocol.toolRequest, true), protocol.reply(protocol.firstAnswer),
      protocol.reply(protocol.secondAnswer)])
    const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-wire-continuation-'))
    const workerDirectory = join(directory, 'computer-worker')
    const worker = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
    let host
    t.after(async () => {
      try { await host?.close() } finally {
        try { await worker.shutdown() } finally {
          await worker.closeObserver()
          await rm(directory, { recursive: true, force: true })
        }
      }
    })

    const clientPath = join(directory, 'client.sqlite')
    const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'execution.sqlite'),
      ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
    const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
    const { openEntry } = vault()
    const [model] = await seedPersonalModels(personalConfig, openEntry, {
      id: protocol.protocolId, protocolId: protocol.protocolId, baseUrl: provider.baseUrl,
      capabilities: { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' },
        reasoning: protocol.reasoning },
      limits: { context: 32_000, output: 4096 }, parameters: protocol.parameters,
    })
    const application = personalAgentServerApplication(personalConfig, { localWorkerDirectory: workerDirectory,
      agents: [{ id: 'assistant', instructions: 'Use the available file tool when needed.', modelId: model.runtimeModelId, environmentIds: ['computer'] }],
      models: { openEntry, catalogAutoRefresh: false } })
    async function openExecution() {
      host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
        execution: { config: executionConfig, options: { applications: [application] } } })
      const execution = personalExecution(host.url, await managedConnection(host.url, 'personal-agent'))
      assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
      return execution
    }

    const projectPath = join(directory, 'project')
    const fixturePath = join(projectPath, 'fixture.txt')
    const savedFile = 'This is the original fixture.'
    await mkdir(projectPath)
    await writeFile(fixturePath, savedFile)
    let execution = await openExecution()
    const project = await execution('/projects', { path: projectPath })
    await execution('/agents/assistant/tools', { toolIds: ['claude-code.Read'], expectedRevision: 0 })
    const sessionRoute = '/agents/assistant/session'
    const session = await execution(sessionRoute, { projectId: project.id })
    assert.equal(session.continuous, true)
    async function send(input, parentNodeId, idempotencyKey) {
      const run = await execution(`/sessions/${session.id}/runs`, { input, projectId: project.id, parentNodeId, idempotencyKey })
      const { done, run: settled } = await execution(`/runs/${run.id}/wait`)
      assert.equal(done, true)
      assert.equal(settled.status, 'completed', JSON.stringify(settled))
      return settled
    }

    const firstPrompt = 'Read the fixture.'
    const first = await send(firstPrompt, null, 'native-first')
    assert.equal(first.output, firstAnswerText)
    assert.ok(first.resultNodeId)
    assert.equal(provider.requests.length, 2)
    const [initial, toolExchange] = provider.requests.map(request => request.body)
    const initialItems = initial[protocol.field]
    const toolItems = toolExchange[protocol.field]
    const toolResult = toolItems.at(-1)
    const [resultType, callId, resultText] = protocol.toolResult(toolResult)
    assert.equal(resultType, protocol.resultType)
    assert.equal(callId, nativeRead.id)
    assert.equal(JSON.parse(resultText).text, `1: ${savedFile}`)
    assert.deepEqual(initialItems.at(-1), protocol.user(firstPrompt))
    assert.deepEqual(toolItems, [...initialItems, ...protocol.toolRequest, toolResult])

    await host.close()
    host = undefined
    await writeFile(fixturePath, 'This changed after the tool returned.')
    execution = await openExecution()
    assert.equal((await execution(sessionRoute, { projectId: project.id })).headNodeId, first.resultNodeId)
    const secondPrompt = 'What did you read?'
    const second = await send(secondPrompt, first.resultNodeId, 'native-second')
    assert.equal(second.output, secondAnswerText)
    assert.equal(provider.requests.length, 3)
    for (const request of provider.requests) {
      assert.equal(request.method, 'POST')
      assert.equal(request.path, `/v1/${protocol.endpoint}`)
    }
    assert.deepEqual(provider.requests[2].body, { ...toolExchange,
      [protocol.field]: [...toolItems, ...protocol.firstAnswer, protocol.user(secondPrompt)] })
  })

test('Personal Agent reuses compatible context and rebuilds complete history across all four APIs', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-api-switch-'))
  const workerDirectory = join(directory, 'computer-worker')
  const worker = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
  let host
  t.after(async () => {
    try { await host?.close() } finally {
      try { await worker.shutdown() } finally {
        await worker.closeObserver()
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  const historyReads = []
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql)
    let method, kind
    if (sql === 'SELECT * FROM harness_native_records WHERE run_id = ? ORDER BY seq') {
      method = 'all'; kind = 'native'
    } else if (sql === 'SELECT events_json FROM harness_application_turns WHERE run_id = ?') {
      method = 'get'; kind = 'application'
    }
    if (method) {
      const read = statement[method].bind(statement)
      statement[method] = (...params) => {
        historyReads.push({ kind, runId: params[0] })
        return read(...params)
      }
    }
    return statement
  })

  const tool = nativeRead.name
  const chatArgs = { file_path: 'chat.txt' }, responsesArgs = { file_path: 'responses.txt' }, anthropicArgs = { file_path: 'anthropic.txt' }
  const prompts = ['Read chat.txt.', 'Read responses.txt.', 'Read anthropic.txt.', 'Compare all three files.']
  const answers = ['Chat finished.', 'Responses finished.', 'Anthropic finished.', 'All three files compared.']
  const geminiFollowUp = 'What did you compare?'
  const geminiFollowUpAnswer = 'I compared the three saved readings.'
  const geminiAfterRestart = 'What did you read after reopening?'
  const geminiAfterRestartAnswer = 'The three readings are still here.'
  const chatFollowUp = 'Continue in Chat Completions.'
  const chatFollowUpAnswer = 'I kept the same conversation.'
  const chatCall = 'chat-read', responsesCall = 'call_responses_read', anthropicCall = 'toolu_anthropic_read'
  const chatReply = (message, finish_reason) => ({ choices: [{ index: 0, message, finish_reason }] })
  const responsesReply = output => ({ object: 'response', status: 'completed', output })
  const anthropicReply = (content, stop_reason) => ({ type: 'message', ...assistant(content), stop_reason })
  const geminiReply = (text, inputTokens) => ({ status: 'completed', steps: [geminiText(text)],
    usage: { total_input_tokens: inputTokens, total_output_tokens: 32 } })
  const providers = await Promise.all([
    captureProvider(t, [chatReply({ ...assistant(null), reasoning_content: 'private-chat-thinking', tool_calls: [
      { type: 'function', id: chatCall, function: { name: tool, arguments: JSON.stringify(chatArgs) } },
    ] }, 'tool_calls'), chatReply(assistant(answers[0]), 'stop'), chatReply(assistant(chatFollowUpAnswer), 'stop')]),
    captureProvider(t, [responsesReply([{ type: 'reasoning', id: 'reasoning-responses', encrypted_content: 'private-responses-encrypted', summary: [] },
      { type: 'function_call', id: 'fc_responses_read', call_id: responsesCall, name: tool, arguments: JSON.stringify(responsesArgs), status: 'completed' },
    ]), responsesReply([responsesText('msg_responses', answers[1])])]),
    captureProvider(t, [anthropicReply([{ type: 'thinking', thinking: 'Read the third file.', signature: 'private-anthropic-signature' },
      { type: 'tool_use', id: anthropicCall, name: tool, input: anthropicArgs },
    ], 'tool_use'), anthropicReply([textBlock(answers[2])], 'end_turn')]),
    captureProvider(t, [geminiReply(answers[3], 1024), geminiReply(geminiFollowUpAnswer, 1048),
      geminiReply(geminiAfterRestartAnswer, 1060)]),
  ])

  const clientPath = join(directory, 'client.sqlite')
  const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'execution.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const { openEntry } = vault()
  const protocolIds = ['chat-completions', 'responses', 'anthropic-messages', 'gemini-interactions']
  const models = await seedPersonalModels(personalConfig, openEntry, ...protocolIds.map((protocolId, index) => ({
    id: protocolId, protocolId, baseUrl: providers[index].baseUrl, remoteModelId: `${protocolId}-model`, apiKey: `key-for-${protocolId}`,
    capabilities: { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' }, imageInput: { support: 'supported' } },
    limits: { context: 32_000, output: 4096 }, ...(protocolId === 'anthropic-messages' ? { parameters: { max_tokens: 4096 } } : {}),
  })))
  const application = personalAgentServerApplication(personalConfig, { localWorkerDirectory: workerDirectory,
    agents: [{ id: 'assistant', instructions: 'Read the requested files.', modelId: models[0].runtimeModelId, environmentIds: ['computer'] }],
    models: { openEntry, catalogAutoRefresh: false } })
  async function openExecution() {
    host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
      execution: { config: executionConfig, options: { applications: [application] } } })
    const execution = personalExecution(host.url, await managedConnection(host.url, 'personal-agent'))
    assert.equal((await execution('/products/personal-agent/open', {})).state, 'running')
    return execution
  }

  const projectPath = join(directory, 'project')
  await mkdir(projectPath)
  const files = [chatArgs.file_path, responsesArgs.file_path, anthropicArgs.file_path]
  const original = ['Original Chat file.', 'Original Responses file.', 'Original Anthropic file.']
  await Promise.all(files.map((file, index) => writeFile(join(projectPath, file), original[index])))
  let execution = await openExecution()
  const project = await execution('/projects', { path: projectPath })
  await execution('/agents/assistant/tools', { toolIds: ['claude-code.Read'], expectedRevision: 0 })
  const sessionRoute = '/agents/assistant/session'
  const session = await execution(sessionRoute, { projectId: project.id })
  assert.equal(session.continuous, true)
  const picture = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
  const uploaded = host.root.get('personal-agent.sessions').importImage(session.id, (async function* () { yield picture })())
  const image = await uploaded.result
  await uploaded.done
  let parentNodeId = session.headNodeId
  const runIds = [], inputEstimates = []
  async function send(model, input, expectedAnswer, idempotencyKey, images) {
    historyReads.length = 0
    const defaultsPath = '/agents/assistant/session-defaults'
    const defaults = await execution(defaultsPath)
    if (defaults.modelId !== model.runtimeModelId) {
      const saved = await execution(defaultsPath, { modelId: model.runtimeModelId, expectedRevision: defaults.revision })
      assert.equal(saved.modelId, model.runtimeModelId)
    }
    assert.equal((await execution(`/sessions/${session.id}`)).modelId, model.runtimeModelId)
    const run = await execution(`/sessions/${session.id}/runs`, { input, projectId: project.id,
      parentNodeId, idempotencyKey, ...(images ? { images } : {}) })
    const { done, run: settled } = await execution(`/runs/${run.id}/wait`)
    assert.equal(done, true)
    assert.equal(settled.status, 'completed', JSON.stringify(settled))
    assert.equal(settled.output, expectedAnswer)
    assert.equal(settled.history.parentNodeId, parentNodeId)
    assert.ok(settled.resultNodeId)
    parentNodeId = settled.resultNodeId
    const readAncestors = historyReads.filter(read => runIds.includes(read.runId))
    assert.equal(run.estimatedInputTokens, settled.estimatedInputTokens)
    inputEstimates.push(settled.estimatedInputTokens)
    runIds.push(settled.id)
    return readAncestors
  }
  const readIds = (reads, kind) => new Set(reads.filter(read => read.kind === kind).map(read => read.runId))
  for (const [index, model] of models.entries()) {
    if (index === 3) {
      await Promise.all(files.map(file => writeFile(join(projectPath, file), 'The file was overwritten after the tool returned.')))
    }
    const reads = await send(model, prompts[index], answers[index], `api-switch-${index}`,
      index === 0 ? [{ assetId: image.assetId }] : undefined)
    assert.deepEqual(readIds(reads, 'application'), new Set(runIds.slice(0, -1)), 'API switch reads all earlier application turns')
  }
  assert.deepEqual(await send(models[3], geminiFollowUp, geminiFollowUpAnswer, 'gemini-follow-up'), [],
    'same Gemini configuration does not scan any earlier native or application records')

  await host.close()
  host = undefined
  execution = await openExecution()
  const reopened = await execution(sessionRoute, { projectId: project.id })
  assert.equal(reopened.id, session.id)
  assert.equal(reopened.headNodeId, parentNodeId)
  const coldReads = await send(models[3], geminiAfterRestart, geminiAfterRestartAnswer, 'gemini-after-restart')
  assert.deepEqual(readIds(coldReads, 'native'), new Set(runIds.slice(3, 5)), 'restart rebuilds the two prior Gemini Runs')
  assert.deepEqual(readIds(coldReads, 'application'), new Set(runIds.slice(0, 3)), 'restart also rebuilds the earlier translated prefix')
  const chatReads = await send(models[0], chatFollowUp, chatFollowUpAnswer, 'chat-follow-up-after-switches')
  assert.deepEqual(readIds(chatReads, 'application'), new Set(runIds.slice(0, -1)), 'switching back rebuilds from the whole conversation')
  assert.equal((await execution(sessionRoute, { projectId: project.id })).headNodeId, parentNodeId)

  const endpoints = ['chat/completions', 'responses', 'messages', 'interactions']
  const authHeaders = ['authorization', 'authorization', 'x-api-key', 'x-goog-api-key']
  for (const [index, provider] of providers.entries()) {
    assert.equal(provider.requests.length, index === 0 || index === 3 ? 3 : 2)
    for (const request of provider.requests) {
      assert.equal(request.method, 'POST')
      assert.equal(request.path, `/v1/${endpoints[index]}`)
      assert.equal(request.body.model, `${protocolIds[index]}-model`)
      const key = `key-for-${protocolIds[index]}`
      assert.deepEqual(Object.entries(request.headers).filter(([name]) => authHeaders.includes(name)),
        [[authHeaders[index], index < 2 ? `Bearer ${key}` : key]])
    }
  }

  const messageText = content => typeof content === 'string' ? content : content.map(part => part.text).join('')
  const resultText = value => JSON.parse(value).text
  const responseInput = providers[1].requests[0].body.input.filter(message => !['system', 'developer'].includes(message.role))
  assert.equal(responseInput.length, 5)
  const [responseUser, responseTool, responseResult, responseAnswer, responseNext] = responseInput
  assert.deepEqual([responseUser.role, messageText(responseUser.content)], ['user', prompts[0]])
  const pictureData = picture.toString('base64')
  assert.equal(responseUser.content[1].image_url, `data:image/png;base64,${pictureData}`)
  assert.deepEqual([responseTool.type, responseTool.name, JSON.parse(responseTool.arguments)], ['function_call', tool, chatArgs])
  assert.ok(responseTool.call_id)
  assert.deepEqual([responseResult.type, responseResult.call_id, resultText(responseResult.output)],
    ['function_call_output', responseTool.call_id, `1: ${original[0]}`])
  assert.deepEqual([responseAnswer.role, messageText(responseAnswer.content)], ['assistant', answers[0]])
  assert.deepEqual([responseNext.role, messageText(responseNext.content)], ['user', prompts[1]])
  assert.doesNotMatch(JSON.stringify(responseInput), /private-chat-thinking/)
  const responseFirstRequest = providers[1].requests[0].body.input
  const responseSecondRequest = providers[1].requests[1].body.input
  assert.deepEqual(responseSecondRequest.slice(0, -3), responseFirstRequest)
  assert.equal(responseSecondRequest.at(-3).encrypted_content, 'private-responses-encrypted')
  assert.deepEqual([responseSecondRequest.at(-1).call_id, resultText(responseSecondRequest.at(-1).output)],
    [responsesCall, `1: ${original[1]}`])

  const anthropicInput = providers[2].requests[0].body.messages
  assert.deepEqual(anthropicInput[0].content[1].source, { type: 'base64', media_type: 'image/png', data: pictureData })
  assert.deepEqual(anthropicInput.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])
  for (const [index, args] of [chatArgs, responsesArgs].entries()) {
    const [user, callMessage, resultMessage, answer] = anthropicInput.slice(index * 4, index * 4 + 4)
    const [call] = callMessage.content, [result] = resultMessage.content
    assert.equal(messageText(user.content), prompts[index])
    assert.deepEqual([call.type, call.name, call.input], ['tool_use', tool, args])
    assert.ok(call.id)
    assert.deepEqual([result.type, result.tool_use_id, resultText(messageText(result.content))], ['tool_result', call.id, `1: ${original[index]}`])
    assert.equal(messageText(answer.content), answers[index])
  }
  assert.equal(messageText(anthropicInput.at(-1).content), prompts[2])
  assert.doesNotMatch(JSON.stringify(anthropicInput), /private-chat-thinking|private-responses-encrypted/)
  const anthropicSecondRequest = providers[2].requests[1].body.messages
  assert.deepEqual(anthropicSecondRequest.slice(0, -2), anthropicInput)
  assert.equal(anthropicSecondRequest.at(-2).content[0].signature, 'private-anthropic-signature')
  const [anthropicResult] = anthropicSecondRequest.at(-1).content
  assert.deepEqual([anthropicResult.tool_use_id, resultText(messageText(anthropicResult.content))], [anthropicCall, `1: ${original[2]}`])

  const geminiInput = providers[3].requests[0].body.input
  assert.deepEqual(geminiInput[0].content[1], { type: 'image', mime_type: 'image/png', data: pictureData })
  assert.equal(geminiInput.length, 13)
  for (const [index, args] of [chatArgs, responsesArgs, anthropicArgs].entries()) {
    const [user, call, result, answer] = geminiInput.slice(index * 4, index * 4 + 4)
    assert.deepEqual([user.type, messageText(user.content)], ['user_input', prompts[index]])
    assert.deepEqual([call.type, call.name, call.arguments], ['function_call', tool, args])
    assert.ok(call.id)
    assert.deepEqual([result.type, result.call_id, resultText(messageText(result.result))], ['function_result', call.id, `1: ${original[index]}`])
    assert.deepEqual([answer.type, messageText(answer.content)], ['model_output', answers[index]])
  }
  assert.deepEqual(geminiInput.at(-1), { type: 'user_input', content: [textBlock(prompts[3])] })
  assert.equal(providers[3].requests[0].body.store, false)
  assert.doesNotMatch(JSON.stringify(geminiInput), /private-chat-thinking|private-responses-encrypted|private-anthropic-signature|overwritten/)
  const geminiWarm = providers[3].requests[1].body
  assert.deepEqual(geminiWarm, { ...providers[3].requests[0].body, input: [...geminiInput, geminiText(answers[3]),
    { type: 'user_input', content: [textBlock(geminiFollowUp)] }] })
  assert.deepEqual(providers[3].requests[2].body, { ...geminiWarm, input: [...geminiWarm.input, geminiText(geminiFollowUpAnswer),
    { type: 'user_input', content: [textBlock(geminiAfterRestart)] }] })
  const geminiDelta = (answer, prompt) => Math.ceil(Buffer.byteLength(JSON.stringify([geminiText(answer)])) / 3) +
    Math.ceil(Buffer.byteLength(JSON.stringify({ input: [{ type: 'user_input', content: [textBlock(prompt)] }] })) / 3)
  assert.equal(inputEstimates[4], 1024 + geminiDelta(answers[3], geminiFollowUp))
  assert.equal(inputEstimates[5], 1048 + geminiDelta(geminiFollowUpAnswer, geminiAfterRestart))
  for (const [index, inputTokens] of [1024, 1048, 1060].entries()) {
    const view = await execution(`/runs/${runIds[index + 3]}/view`)
    assert.deepEqual(view.exchanges.map(exchange => exchange.usage), [{ inputTokens, outputTokens: 32 }])
  }
  const chatInput = providers[0].requests[2].body.messages.filter(message => !['system', 'developer'].includes(message.role))
  for (const [index, args] of [chatArgs, responsesArgs, anthropicArgs].entries()) {
    const [user, callMessage, result, answer] = chatInput.slice(index * 4, index * 4 + 4)
    const [call] = callMessage.tool_calls
    assert.deepEqual([user.role, messageText(user.content)], ['user', prompts[index]])
    assert.deepEqual([call.function.name, JSON.parse(call.function.arguments)], [tool, args])
    assert.deepEqual([result.role, result.tool_call_id, resultText(result.content)], ['tool', call.id, `1: ${original[index]}`])
    assert.deepEqual([answer.role, answer.content], ['assistant', answers[index]])
  }
  assert.deepEqual(chatInput.slice(12), [
    { role: 'user', content: prompts[3] }, assistant(answers[3]),
    { role: 'user', content: geminiFollowUp }, assistant(geminiFollowUpAnswer),
    { role: 'user', content: geminiAfterRestart }, assistant(geminiAfterRestartAnswer),
    { role: 'user', content: chatFollowUp },
  ])
  const runRecords = host.root.get('personal-agent.session-runs')
  const switched = await runRecords.loadRunResume(runIds[3])
  const continued = await runRecords.loadRunResume(runIds[4])
  assert.equal(switched.applicationPrefix.filter(event => event.role === 'tool').length, 3)
  assert.deepEqual(continued.history.applicationPrefix, switched.applicationPrefix)
  assert.deepEqual(continued.history.records.map(record => record.runId), [runIds[3], runIds[3]])

  await host.close()
  host = undefined
  const database = new DatabaseSync(personalConfig.harnessDatabasePath, { readOnly: true })
  try {
    const storedTurns = database.prepare('SELECT events_json FROM harness_application_turns WHERE run_id = ?')
    const expectedPrompts = [...prompts, geminiFollowUp, geminiAfterRestart, chatFollowUp]
    const expectedAnswers = [...answers, geminiFollowUpAnswer, geminiAfterRestartAnswer, chatFollowUpAnswer]
    for (const [index, runId] of runIds.entries()) {
      const { schemaVersion, events } = JSON.parse(storedTurns.get(runId).events_json)
      assert.equal(schemaVersion, 1)
      assert.deepEqual(events[0].parts[0], textBlock(expectedPrompts[index]))
      assert.equal(events[0].role, 'user')
      if (index === 0) assert.equal(events[0].parts[1].resource.id, image.assetId)
      else assert.equal(events[0].parts.length, 1)
      assert.deepEqual(events.at(-1), { role: 'assistant', parts: [textBlock(expectedAnswers[index])] })
      if (index < 3) {
        assert.deepEqual(events.map(event => event.role), ['user', 'assistant', 'tool', 'assistant'])
        const [call] = events[1].parts, result = events[2]
        assert.deepEqual([call.type, call.name, call.arguments], ['tool-call', tool, { file_path: files[index] }])
        assert.deepEqual([result.id, result.name, resultText(result.output)], [call.id, tool, `1: ${original[index]}`])
      } else assert.equal(events.length, 2)
    }
  } finally { database.close() }
})

test('Personal Agent gateway explicitly adopts a hosted environment into an existing empty continuous conversation', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-environments-'))
  let host
  t.after(async () => {
    try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const clientPath = join(directory, 'client.sqlite'), { openEntry } = vault()
  const config = parsePersonalAgentServerConfig({}, clientPath)
  const [model] = await seedPersonalModels(config, openEntry, { id: 'hosted-model', protocolId: 'responses' })
  const executionConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite') })
  const application = personalAgentServerApplication(config, { models: { openEntry, catalogAutoRefresh: false } })
  host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry },
    execution: { config: executionConfig, options: { applications: [application] } } })
  const execution = personalExecution(host.url, await managedConnection(host.url, 'personal-agent'))
  await execution('/products/personal-agent/open', {})
  const agent = await execution('/agents', { name: 'Reader', instructions: 'Read the sources.', description: '', modelId: model.id,
    requestId: 'new-reader' }, 201)
  const path = '/agents/' + encodeURIComponent(agent.id)
  const project = await execution('/projects', { path: directory })
  const continuous = await execution(path + '/session', { projectId: project.id })
  const sessionPath = '/sessions/' + encodeURIComponent(continuous.id) + '/environments'
  const initialSession = await execution(sessionPath)
  const initial = await execution(path + '/environment-access')
  assert.deepEqual(initialSession.environmentIds, [])
  assert.deepEqual(initial.authorization.grants, [])
  const target = initial.targets.find(value => value.environmentId === 'model-search')
  assert.ok(target?.tools.length)
  const tool = target.tools[0]
  const catalog = await execution('/tool-environments')
  assert.ok(catalog.some(value => value.targetId === target.targetId))
  const preferences = { environmentIds: ['model-search'], toolIdsByEnvironment: { 'model-search': [tool.toolId] },
    expectedVersion: initial.preference.version }
  const preference = await execution(path + '/environment-access/preferences', preferences)
  assert.deepEqual(preference.toolIdsByEnvironment, preferences.toolIdsByEnvironment)
  const access = await execution(path + '/environment-access')
  assert.deepEqual(access.authorization, initial.authorization)
  const adoption = { environmentIds: preference.environmentIds, expectedVersion: initialSession.version,
    expectedGrantRevision: access.authorization.revision }
  await execution(sessionPath, adoption, 409)
  assert.deepEqual(await execution(sessionPath), initialSession)
  await execution(path + '/environment-access/grants', { tools: [{ ...tool, targetId: 'untrusted' }], requestId: 'wrong-target',
    expectedRevision: access.authorization.revision }, 403)
  const change = await execution(path + '/environment-access/grants', { tools: [tool], requestId: 'hosted-grant',
    expectedRevision: access.authorization.revision })
  await execution(sessionPath, adoption, 409)
  const adopted = await execution(sessionPath, { ...adoption, expectedGrantRevision: change.revision })
  assert.deepEqual(adopted.environmentIds, ['model-search'])
  assert.equal(adopted.version, initialSession.version + 1)
  await execution(sessionPath, { ...adoption, expectedGrantRevision: change.revision }, 409)
  const ordinary = await execution('/sessions', { projectId: project.id, agentId: agent.id })
  await execution('/sessions/' + ordinary.id + '/environments', { ...adoption, expectedGrantRevision: change.revision }, 409)
})

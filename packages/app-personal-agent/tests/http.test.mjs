import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

async function seedPersonalModels(config, openEntry, ...definitions) {
  const root = new Context()
  try {
    await root.installComponent(createModelsJsonStoreComponent({ path: config.modelsConfigPath }))
    await root.installComponent(createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry }))
    await root.installComponent(createModelsComponent())
    await root.installComponent(createChatCompletionsProtocolComponent())
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

test('Personal Agent keeps one continuous history and recalls rolled-over records only in the selected project', { timeout: 60_000 }, async t => {
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
  const calls = []
  const application = personalAgentServerApplication(personalConfig, { models: {
    openEntry, catalogAutoRefresh: false,
    async fetch(_url, init) {
      const input = JSON.parse(init.body)
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
    modelId: model.id, requestId: 'create-continuous-agent' }, 201)
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
  async function send(projectId, input, files) {
    const body = { input, projectId, parentNodeId, idempotencyKey: `continuous-${++next}`, ...(files ? { files } : {}) }
    const run = await execution(`${session}/runs`, body)
    const { done, run: settled } = await execution(`/runs/${run.id}/wait`)
    assert.equal(done, true)
    assert.equal(settled.status, 'completed')
    assert.equal(settled.projectId, projectId)
    assert.equal(settled.history.parentNodeId, parentNodeId)
    parentNodeId = settled.resultNodeId
    return { body, run: settled, request: JSON.stringify(calls.at(-1).messages) }
  }

  const original = '周报格式定为先风险再进度。旧代号 VIOLETOWL。'
  const opening = await send(alpha.id, original)
  const early = await send(beta.id, '记下这批采购单。')
  assert.ok(early.request.includes(original))
  const logistics = number => `物流进度记录 ${number}，等待回执。${' parcel dispatch awaiting acknowledgement.'.repeat(100)} END-${number}`
  for (let number = 0; number < 9; number++) await send(alpha.id, logistics(number))
  const unrelated = await send(alpha.id, '检查今天的库存。')
  assert.ok(!unrelated.request.includes('VIOLETOWL'), unrelated.request)
  assert.ok(unrelated.request.includes(logistics(8)))

  const recalled = await send(alpha.id, '请按刚才定的周报格式写一版。')
  assert.ok(recalled.request.includes(original), recalled.request)
  assert.ok(!((await send(beta.id, '周报格式是什么？')).request.includes('VIOLETOWL')))
  assert.ok(!((await send(alpha.id, '再检查一下库存。')).request.includes('VIOLETOWL')))
  const cited = await send(alpha.id, `重新查看这条旧记录。[历史:${opening.run.resultNodeId}]`)
  assert.ok(cited.request.includes(original), cited.request)
  const prior = await execution(`${session}/runs`, recalled.body)
  assert.equal(prior.id, recalled.run.id)
  const duplicate = await execution(`${session}/runs`, { ...recalled.body, projectId: beta.id }, 409)
  assert.equal(duplicate.error.code, 'conflict')
  assert.equal(calls.length, next)
  const stale = await execution(`${session}/runs`, { ...opening.body, idempotencyKey: 'stale-position' }, 409)
  assert.equal(stale.error.code, 'history-position-changed')
  const oversize = await execution(`${session}/runs`, { input: 'x'.repeat(50_000), parentNodeId, projectId: alpha.id,
    idempotencyKey: 'input-over-budget' }, 400)
  assert.equal(oversize.error.code, 'context-too-large')
  assert.equal(calls.length, next)
  assert.equal((await execution(`${session}/nodes/${opening.run.resultNodeId}`)).input, original)

  await host.close()
  host = undefined
  const database = new DatabaseSync(personalConfig.harnessDatabasePath, { readOnly: true })
  try {
    const roots = database.prepare('SELECT id, parent_id, evicted_node_ids_json FROM harness_continuous_roots WHERE session_id = ? ORDER BY seq').all(first.id)
    assert.ok(roots.length > 1)
    assert.equal(roots[0].parent_id, null)
    assert.ok(roots.slice(1).every((root, index) => root.parent_id === roots[index].id))
    assert.ok(roots.some(root => JSON.parse(root.evicted_node_ids_json).includes(opening.run.resultNodeId)))
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
  const managedRun = await send(managed.projectId, '检查 Agent 文件。', [{ snapshotId: managedRef.snapshotId }])
  assert.ok(managedRun.request.includes('Only the Agent workspace has this file.'))
  assert.equal((await execution(sessionRoute, {})).headNodeId, parentNodeId)
  const newInstructions = 'Use the updated reporting instructions.'
  await execution(`/agents/${agent.id}`, { name: agent.name, description: agent.description, instructions: newInstructions,
    modelId: updatedModel.id, expectedRevision: agent.revision })
  assert.equal((await execution(session)).modelId, updatedModel.id)
  const continued = await send(beta.id, '检查本轮文件。', [{ snapshotId: reference.snapshotId }])
  assert.equal(calls.at(-1).model, 'model-after')
  assert.ok(continued.request.includes(newInstructions))
  assert.ok(continued.request.includes('Only the Beta project has this file.'))
})

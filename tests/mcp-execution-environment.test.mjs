import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { createChatCompletionsProtocolComponent, createModelsComponent, createModelsJsonStoreComponent, createModelsVaultComponent } from '@anybox/models'
import { createLocalWebHost } from '../packages/distribution/dist/composition/local-web.js'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'
import { parsePersonalAgentServerConfig } from '../packages/app-personal-agent/dist/server-config.js'
import { personalAgentServerApplication } from '../packages/app-personal-agent/dist/registration.js'
import { seedHarnessModel } from './helpers/configured-models.mjs'

const clientApi = '/api/client/v1'
const accessPath = '/agents/assistant/environment-access'
const search = { name: 'search', description: 'Search this fixture.', inputSchema: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
} }

async function openMcpServer(label, useEvents) {
  const calls = []
  const sessions = new Set()
  let sequence = 0
  const server = createServer((request, response) => {
    const handle = async () => {
      assert.equal(request.url, '/mcp')
      const sessionId = request.headers['mcp-session-id']
      if (request.method === 'DELETE') {
        sessions.delete(sessionId)
        response.writeHead(204).end()
        return
      }
      assert.equal(request.method, 'POST')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const rpc = JSON.parse(Buffer.concat(chunks))
      assert.equal(rpc.jsonrpc, '2.0')
      assert.match(request.headers.accept, /application\/json/)
      assert.match(request.headers.accept, /text\/event-stream/)
      let result
      if (rpc.method === 'initialize') {
        const opened = `${label}-${++sequence}`
        sessions.add(opened)
        response.setHeader('Mcp-Session-Id', opened)
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
      } else {
        assert.ok(sessions.has(sessionId), 'the client must use the initialized MCP session')
        assert.equal(request.headers['mcp-protocol-version'], '2025-11-25')
        if (rpc.method === 'notifications/initialized') {
          response.writeHead(202).end()
          return
        }
        if (rpc.method === 'tools/list') {
          result = { tools: [search] }
        } else {
          assert.equal(rpc.method, 'tools/call')
          assert.equal(rpc.params.name, 'search')
          calls.push(rpc.params)
          result = { content: [{ type: 'text', text: `${label}:${rpc.params.arguments.query}` }] }
        }
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })
      if (useEvents) response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${body}\n\n`)
      else response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    }
    void handle().catch(error => response.writeHead(500).end(String(error)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function seed(config, openEntry) {
  const root = new Context()
  try {
    await root.installComponent(createModelsJsonStoreComponent({ path: config.modelsConfigPath }))
    await root.installComponent(createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry }))
    await root.installComponent(createModelsComponent())
    await root.installComponent(createChatCompletionsProtocolComponent())
    const capabilities = { tools: { support: 'supported' }, streaming: { support: 'unsupported' },
      imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } }
    return (await seedHarnessModel(root.get('models.settings'), { capabilities })).runtimeModelId
  } finally { await root.fiber.dispose() }
}

function modelFixture() {
  const declared = []
  let forced
  return { declared, force(name, query = 'proof') { forced = { name, query } }, async fetch(_url, init) {
    const request = JSON.parse(init.body)
    const turn = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user') + 1)
    const observed = turn.filter(message => message.role === 'tool')
    if (observed.length) return Response.json({ choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: observed.map(message => message.content).join('\n') } }] })
    const names = (request.tools ?? []).map(tool => tool.function.name)
    declared.push(names)
    const requested = forced ? [forced] : names.map(name => ({ name, query: 'proof' }))
    forced = undefined
    if (!requested.length) return Response.json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'no tools' } }] })
    return Response.json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: requested.map(({ name, query }, index) => ({ id: `search-${declared.length}-${index}`, type: 'function', function: {
        name, arguments: JSON.stringify({ query }),
      } })) } }] })
  } }
}

async function request(origin, path, body, headers = {}, expected = 200) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
  const data = await response.json()
  assert.equal(response.status, expected, `${path} ${JSON.stringify(data)}`)
  return data
}

async function appApi(host, appId) {
  const base = `${clientApi}/apps/${appId}`
  await request(host.url, `${clientApi}/products/${appId}/open`, {})
  const deadline = Date.now() + 10_000
  for (;;) {
    const state = await request(host.url, `${base}/local`)
    if (state.status?.state === 'ready') break
    assert.notEqual(state.status?.state, 'failed', JSON.stringify(state))
    assert.ok(Date.now() < deadline, JSON.stringify(state))
    await delay(20)
  }
  await host.execution.products.open(appId)
  const [connection] = await request(host.url, `${base}/connections`)
  const binding = { 'X-Anybox-Product-Id': appId, 'X-Anybox-Expected-Instance-Id': connection.instanceId,
    'X-Anybox-Connection-Revision': String(connection.revision) }
  return (path, input, expected) => request(host.url, `${base}/connections/${encodeURIComponent(connection.id)}/v1${path}`, input, binding, expected)
}

function openAgentSession(api, appId, projectId, modelId, agentId = 'assistant') {
  return appId === 'personal-agent' ? api(`/agents/${agentId}/session`, { projectId })
    : api('/sessions', { projectId, agentId, modelId })
}

function startRun(api, session, key, modelId, expected) {
  return api(`/sessions/${session.id}/runs`, { input: key, idempotencyKey: key, parentNodeId: session.headNodeId ?? null,
    ...(session.continuous ? { projectId: session.projectId, modelId } : {}) }, expected)
}

async function createMcpAgent(api, purpose, modelId, tools, toolIdsByTarget) {
  const agent = await api('/agents', { name: purpose, description: '', instructions: 'Use MCP tools to answer.',
    modelId, requestId: purpose }, 201)
  const path = `/agents/${agent.id}/environment-access`
  const { authorization, preference } = await api(path)
  const grant = await api(`${path}/grants`, { requestId: purpose, expectedRevision: authorization.revision, tools })
  const saved = await api(`${path}/preferences`, { environmentIds: ['mcp'], toolIdsByTarget, expectedVersion: preference.version })
  return { id: agent.id, path, grant, preference: saved }
}

async function openMcpApps(directory) {
  const clientPath = join(directory, 'client.sqlite'), secrets = new Map()
  const openEntry = (namespace, id) => {
    const key = `${namespace}:${id}`
    return { getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) },
      deleteCredential: async () => { secrets.delete(key) } }
  }
  const harnessConfig = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'),
    ANYBOX_MODELS_DATABASE: join(directory, 'harness-models.sqlite') })
  const personalConfig = parsePersonalAgentServerConfig({}, clientPath)
  const [harnessModel, personalModel] = await Promise.all([seed(harnessConfig, openEntry), seed(personalConfig, openEntry)])
  const harness = modelFixture(), agent = modelFixture()
  const modelOptions = fixture => ({ openEntry, catalogAutoRefresh: false, fetch: fixture.fetch })
  const host = await createLocalWebHost({ client: { path: clientPath, port: 0, openEntry }, execution: { config: harnessConfig,
    options: { models: modelOptions(harness), additionalApplications: [personalAgentServerApplication(personalConfig, { models: modelOptions(agent) })] } } })
  return { host, apps: [['agent', harnessModel, harness], ['personal-agent', personalModel, agent]] }
}

test('both applications route same-named MCP tools by granted connection through their normal HTTP and native Run paths', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-mcp-environment-'))
  const servers = []
  let host
  t.after(async () => {
    try { await host?.close() }
    finally { await Promise.all(servers.map(server => server.close())); await rm(directory, { recursive: true, force: true }) }
  })
  const work = await openMcpServer('work', false), personal = await openMcpServer('personal', true)
  servers.push(work, personal)
  const applications = await openMcpApps(directory)
  host = applications.host

  for (const [appId, modelId, fixture] of applications.apps) {
    await t.test(appId, async () => {
      const api = await appApi(host, appId)
      assert.deepEqual(await api('/mcp-connections'), [], 'each application owns its connection catalog')
      const connections = []
      for (const [name, server] of [['Work documents', work], ['Personal documents', personal]]) {
        const connection = await api('/mcp-connections', { name, endpoint: server.url }, 201)
        assert.equal(connection.status, 'unverified')
        const ready = await api(`/mcp-connections/${connection.id}/refresh`, {})
        assert.equal(ready.status, 'ready', JSON.stringify(ready))
        assert.equal(ready.toolCount, 1)
        connections.push(ready)
      }
      const view = await api(accessPath)
      assert.equal(view.mcpManagement, true)
      const targets = connections.map(connection => view.targets.find(target => target.targetId === connection.targetId))
      assert.deepEqual(targets.map(({ name, selectionId }) => [name, selectionId]),
        connections.map(({ name, id }) => [name, id]))
      const [workSearch, personalSearch] = targets.map(target => target.tools[0])
      assert.ok((await api('/tool-environments')).some(target => target.targetId === personalSearch.targetId))
      assert.ok(view.authorization.grants.every(grant => grant.tool.environmentId !== 'mcp'))
      await api(`${accessPath}/grants`, { requestId: 'cross-target', expectedRevision: view.authorization.revision,
        tools: [{ ...workSearch, targetId: personalSearch.targetId }] }, 403)
      const first = await api(`${accessPath}/grants`, { requestId: 'only-work', expectedRevision: view.authorization.revision, tools: [workSearch] })
      const toolIdsByTarget = Object.fromEntries(targets.map(target => [JSON.stringify(['mcp', target.selectionId]), [target.tools[0].toolId]]))
      await api(`${accessPath}/preferences`, { environmentIds: ['mcp'], toolIdsByTarget, expectedVersion: view.preference.version })
      const project = await api('/projects', { path: directory })
      const openSession = agentId => openAgentSession(api, appId, project.id, modelId, agentId)
      const run = async (session, key) => {
        const accepted = await startRun(api, session, key, modelId)
        const status = await api(`/runs/${accepted.id}/wait`)
        assert.equal(status.done, true, JSON.stringify(status))
        return status.run
      }
      const one = await openSession()
      assert.equal(one.toolEnvironments.schemaVersion, 2)
      const definitions = one.toolEnvironments.environments.find(item => item.environmentId === 'mcp').tools
      const workName = definitions.find(tool => tool.targetId === workSearch.targetId).definition.name
      const personalName = definitions.find(tool => tool.targetId === personalSearch.targetId).definition.name
      assert.notEqual(workName, personalName)
      const counts = () => [work.calls.length, personal.calls.length]
      const [workBefore, personalBefore] = counts()
      const onlyWork = await run(one, 'allowed-search')
      assert.equal(onlyWork.status, 'completed', JSON.stringify({ run: onlyWork, declared: fixture.declared, counts: counts() }))
      assert.deepEqual(fixture.declared.at(-1), [workName])
      assert.deepEqual(counts(), [workBefore + 1, personalBefore])

      fixture.force(personalName)
      const rejected = await run(await openSession(), 'ungranted-search')
      assert.match(rejected.output, /unknown-tool/)
      assert.deepEqual(counts(), [workBefore + 1, personalBefore], 'an ungranted alias reaches neither connection')

      await api(`${accessPath}/grants`, { requestId: 'both', expectedRevision: first.revision, tools: [workSearch, personalSearch] })
      const both = await openSession()
      const result = await run(both, 'both-searches')
      assert.equal(result.status, 'completed', JSON.stringify(result))
      assert.deepEqual(new Set(fixture.declared.at(-1)), new Set([workName, personalName]))
      assert.match(result.output, /work:proof/)
      assert.match(result.output, /personal:proof/)
      assert.deepEqual(counts(), [workBefore + 2, personalBefore + 1])
      assert.deepEqual(work.calls.at(-1), { name: 'search', arguments: { query: 'proof' } })
      assert.deepEqual(personal.calls.at(-1), { name: 'search', arguments: { query: 'proof' } })

      if (appId === 'personal-agent') {
        const workKey = JSON.stringify(['mcp', targets[0].selectionId])
        const adopting = await createMcpAgent(api, 'test-environment-adoption', modelId, [workSearch, personalSearch],
          { [workKey]: [workSearch.toolId] })
        const continuous = await openSession(adopting.id)
        const environmentsPath = `/sessions/${continuous.id}/environments`
        await api(`${adopting.path}/preferences`, { environmentIds: ['mcp'], toolIdsByTarget, expectedVersion: adopting.preference.version })
        const beforeAdoption = await api(environmentsPath)
        assert.deepEqual(Object.keys(beforeAdoption.toolIdsByTarget), [workKey])
        const adopted = await api(environmentsPath, { environmentIds: ['mcp'], toolIdsByTarget,
          expectedVersion: beforeAdoption.version, expectedGrantRevision: adopting.grant.revision })
        assert.deepEqual(adopted.toolIdsByTarget, toolIdsByTarget)
        const continuousResult = await run(continuous, 'adopted-searches')
        assert.equal(continuousResult.status, 'completed', JSON.stringify(continuousResult))
        assert.match(continuousResult.output, /work:proof/)
        assert.match(continuousResult.output, /personal:proof/)
      }

      const beforeDisable = counts()
      assert.equal((await api(`/mcp-connections/${connections[1].id}/disable`, {})).status, 'disabled')
      if (both.continuous) {
        fixture.force(personalName)
        const stale = await run(await openSession(), 'stale')
        assert.equal(stale.status, 'completed', JSON.stringify(stale))
        assert.deepEqual(fixture.declared.at(-1), [workName])
        assert.match(stale.output, /unknown-tool/)
      } else {
        const previous = await startRun(api, both, 'stale', modelId, 409)
        assert.equal(previous.error.code, 'history-incompatible')
      }
      assert.deepEqual(counts(), beforeDisable)
    })
  }
})

const stdioFixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))

function assertExited(pid, label) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, label)
}

async function waitFor(read, label) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const found = await read()
    if (found) return found
    assert.ok(Date.now() < deadline, label)
    await delay(20)
  }
}

test('both applications authorize stdio targets independently and join their real local process trees', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-mcp-stdio-'))
  let host
  t.after(async () => {
    try { await host?.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const applications = await openMcpApps(directory)
  host = applications.host

  for (const [appId, modelId, fixture] of applications.apps) {
    await t.test(appId, async () => {
      const api = await appApi(host, appId)
      const targets = await Promise.all(['work', 'personal'].map(async label => {
        const path = join(directory, `${appId}-${label}.jsonl`)
        await writeFile(path, '')
        const events = async () => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const connection = await api('/mcp-connections', { name: label, transport: 'stdio',
          command: process.execPath, args: [stdioFixture, label, path], cwd: directory }, 201)
        assert.equal(connection.transport, 'stdio')
        assert.equal(connection.status, 'unverified')
        assert.deepEqual(await events(), [], 'saving a connection must not launch a process')
        const ready = await api(`/mcp-connections/${connection.id}/refresh`, {})
        assert.equal(ready.status, 'ready', JSON.stringify(ready))
        assert.equal(ready.toolCount, 1)
        const discovery = await events()
        assert.equal(discovery.filter(item => item.event === 'start').length, 1)
        assert.equal(discovery.some(item => item.event === 'call'), false)
        assertExited(discovery[0].pid, 'discovery waits for the launched server to exit')
        return { connection, events }
      }))
      const [work, personal] = targets
      const view = await api(accessPath)
      const tools = targets.map(({ connection }) => view.targets.find(target => target.targetId === connection.targetId))
      assert.deepEqual(tools.map(({ name, selectionId }) => [name, selectionId]),
        targets.map(({ connection: { name, id } }) => [name, id]))
      const [workSearch, personalSearch] = tools.map(target => target.tools[0])
      const grant = (requestId, expectedRevision, tools) =>
        api(`${accessPath}/grants`, { requestId, expectedRevision, tools })
      const onlyWork = await grant('stdio-only-work', view.authorization.revision, [workSearch])
      const toolIdsByTarget = Object.fromEntries(tools.map(target => [JSON.stringify(['mcp', target.selectionId]), [target.tools[0].toolId]]))
      await api(`${accessPath}/preferences`, { environmentIds: ['mcp'], toolIdsByTarget, expectedVersion: view.preference.version })
      const project = await api('/projects', { path: directory })
      const openSession = agentId => openAgentSession(api, appId, project.id, modelId, agentId)
      const start = (session, key) => startRun(api, session, key, modelId)
      const wait = async id => {
        const status = await api(`/runs/${id}/wait`)
        assert.equal(status.done, true, JSON.stringify(status))
        return status.run
      }
      const firstSession = await openSession()
      const sessionTools = firstSession.toolEnvironments.environments.find(environment => environment.environmentId === 'mcp').tools
      const workName = sessionTools.find(tool => tool.targetId === workSearch.targetId).definition.name
      const personalName = sessionTools.find(tool => tool.targetId === personalSearch.targetId).definition.name
      assert.notEqual(workName, personalName)

      const allowed = await wait((await start(firstSession, 'stdio-allowed')).id)
      assert.equal(allowed.status, 'completed', JSON.stringify(allowed))
      assert.match(allowed.output, /work:proof/)
      assert.deepEqual(fixture.declared.at(-1), [workName])
      const workBeforeDenied = await work.events(), personalBeforeDenied = await personal.events()
      assert.equal(workBeforeDenied.filter(item => item.event === 'start').length, 2)
      assert.equal(workBeforeDenied.filter(item => item.event === 'call').length, 1)
      assert.equal(personalBeforeDenied.filter(item => item.event === 'start').length, 1)
      assert.equal(personalBeforeDenied.filter(item => item.event === 'call').length, 0)
      assertExited(workBeforeDenied.find(item => item.event === 'call').pid, 'completed Run waits for its stdio server')

      fixture.force(personalName)
      assert.match((await wait((await start(await openSession(), 'stdio-denied')).id)).output, /unknown-tool/)
      assert.deepEqual(await work.events(), workBeforeDenied)
      assert.deepEqual(await personal.events(), personalBeforeDenied, 'an ungranted tool cannot launch a process')

      const allGrants = await grant('stdio-both', onlyWork.revision, [workSearch, personalSearch])
      const both = await wait((await start(await openSession(), 'stdio-both')).id)
      assert.equal(both.status, 'completed', JSON.stringify(both))
      assert.match(both.output, /work:proof/)
      assert.match(both.output, /personal:proof/)
      assert.deepEqual(new Set(fixture.declared.at(-1)), new Set([workName, personalName]))
      for (const target of targets) {
        const called = (await target.events()).filter(item => item.event === 'call').at(-1)
        assert.equal(called.name, 'search')
        assertExited(called.pid, 'both routed children must exit before successful Run settlement')
      }

      async function hold(target, alias, key, agentId) {
        const previous = (await target.events()).length
        fixture.force(alias, 'hold')
        const run = await start(await openSession(agentId), key)
        const processTree = await waitFor(async () => (await target.events()).slice(previous).find(item => item.event === 'holding'),
          `${key} did not start the resistant process tree`)
        assert.doesNotThrow(() => process.kill(processTree.pid, 0))
        assert.doesNotThrow(() => process.kill(processTree.childPid, 0))
        return { run, processTree }
      }

      const workSelection = { [JSON.stringify(['mcp', tools[0].selectionId])]: [workSearch.toolId] }
      const otherAgent = appId === 'personal-agent' ? await createMcpAgent(api, 'test-concurrent-cancellation', modelId, [workSearch], workSelection) : undefined
      const activeWork = await hold(work, workName, 'stdio-cancel', otherAgent?.id)
      const activePersonal = await hold(personal, personalName, 'stdio-revoke')
      await api(`/runs/${activeWork.run.id}/cancel`, {})
      const cancelled = await wait(activeWork.run.id)
      assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
      assertExited(activeWork.processTree.pid, 'explicit cancellation must wait for server exit')
      assertExited(activeWork.processTree.childPid, 'explicit cancellation must wait for descendant exit')
      assert.doesNotThrow(() => process.kill(activePersonal.processTree.pid, 0), 'another connection must stay alive')

      const revoked = await grant('stdio-revoke', allGrants.revision, [workSearch])
      const receipt = await waitFor(async () => {
        const receipt = await api(`${accessPath}/changes/${revoked.requestId}`)
        assert.notEqual(receipt.state, 'exit-unknown', JSON.stringify(receipt))
        return receipt.state === 'completed' && receipt
      }, 'revoking a stdio tool must drain its actual process tree')
      assert.equal(receipt.unknownCount, 0)
      assertExited(activePersonal.processTree.pid, 'revocation must wait for server exit')
      assertExited(activePersonal.processTree.childPid, 'revocation must wait for descendant exit')
      await wait(activePersonal.run.id)
      assert.equal((await api(`/mcp-connections/${personal.connection.id}/disable`, {})).status, 'disabled')
      const remainingSession = await openSession()
      if (remainingSession.continuous) {
        const path = `/sessions/${remainingSession.id}/environments`
        const previous = await api(path)
        await api(path, { environmentIds: ['mcp'], toolIdsByTarget: workSelection,
          expectedVersion: previous.version, expectedGrantRevision: revoked.revision })
      }
      const remaining = await wait((await start(remainingSession, 'stdio-work-still-authorized')).id)
      assert.equal(remaining.status, 'completed', JSON.stringify(remaining))
      assert.match(remaining.output, /work:proof/)

      const disabling = await hold(work, workName, 'stdio-disable')
      assert.equal((await api(`/mcp-connections/${work.connection.id}/disable`, {})).status, 'disabled')
      assertExited(disabling.processTree.pid, 'disabling a connection must wait for its active server to exit')
      assertExited(disabling.processTree.childPid, 'disabling a connection must wait for its descendants to exit')
      const stopped = await wait(disabling.run.id)
      assert.notEqual(stopped.errorCategory, 'tool-cleanup-failure', JSON.stringify(stopped))
    })
  }
})

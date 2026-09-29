import { startClientGateway } from '../dist/host/client/gateway.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness/index.js'
import { modelsError } from '@anybox/models'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../dist/harness/image/component.js'
import { createHarnessApiComponent, harnessApiServiceKey } from '../dist/host/component.js'
import { startHarnessApiServer } from '../dist/host/server.js'
import { createDirectoryPickerComponent } from '../dist/host/directory-picker.js'
import { controlledModels, deferred } from './helpers/controlled-models.mjs'
import { promptServiceKey } from '../dist/harness/prompt/component.js'
import { installManagedModels } from './helpers/managed-models.mjs'
import { installWebModels } from '../dist/host/models-startup.js'
import { parseWebStartupConfig } from '../dist/host/startup-config.js'
import { runChangedEvent } from '../dist/harness/run/notifications.js'
import sharp from 'sharp'

async function fixture(directory, pickerOptions = {}, startup) {
  const root = new Context()
  const llm = controlledModels()
  const secrets = new Map()
  let assets
  try {
    let apiFiber, keyFiber, reinstall
    if (startup) {
      await installWebModels(root, { ...startup, modelsDatabasePath: join(directory, 'models.sqlite'), modelsCatalogDatabasePath: join(directory, 'models-catalog.sqlite') }, {
        catalogAutoRefresh: false,
        openEntry(_namespace, id) { return { async getPassword() { return secrets.get(id) }, async setPassword(value) { secrets.set(id, value) }, async deleteCredential() { return secrets.delete(id) } } },
        readLegacyCredential: async () => undefined,
      })
    } else {
      const installed = await installManagedModels(root, directory, { controlled: llm, secrets })
      apiFiber = installed.apiFiber; keyFiber = installed.vaultFiber; reinstall = installed.installRuntime
    }
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', modelId: 'default', instructions: 'Private instructions.' }],
    })
    const project = await harness.openProject(directory)
    const pickerFiber = root.installComponent(createDirectoryPickerComponent({
      platform: 'darwin', runDialog: async () => undefined, ...pickerOptions,
    }))
    await pickerFiber
    const webFiber = root.installComponent(createHarnessApiComponent(harness.listAgents()))
    await webFiber
    const web = root.get(harnessApiServiceKey)
    assert.ok(web)
    assets = await startClientGateway({ list: async () => [] })
    return { root, keyFiber, apiFiber, pickerFiber, webFiber, harness, project, llm, web, assets, secrets, reinstall, close: async () => { await assets.close(); await harness.close() } }
  } catch (error) { await assets?.close(); await root.fiber.dispose(); throw error }
}

async function request(web, method, path, body, origin = web.url) {
  const response = await fetch(`${web.url}/api/v1${path}`, {
    method,
    headers: method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  return { response, data: await response.json() }
}

async function serviceReady(root, name) {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const probe = root.inject([name], () => ready())
  await started
  await probe.dispose()
}

async function changes(web, sessionIds) {
  const response = await fetch(`${web.url}/api/v1/changes?${new URLSearchParams(sessionIds.map(id => ['sessionId', id]))}`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  const readFrame = async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        if (event) return { event, data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]) }
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) return undefined
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return {
    async next() {
      let timer
      try { return await Promise.race([readFrame(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE frame timeout')), 2000) })]) }
      finally { clearTimeout(timer) }
    },
    close: () => reader.cancel().catch(() => {}),
  }
}

test('SSE follows committed Run changes and publishes the result node only after resource exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-changes-')), f = await fixture(directory)
  let stream
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const other = await f.harness.createSession(f.project.id, 'assistant')
    stream = await changes(f.web, [session.id])
    assert.equal((await stream.next()).event, 'ready')
    const outside = await f.harness.startRun({ sessionId: other.id, parentNodeId: null, input: 'outside', idempotencyKey: 'outside' })
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'inside', idempotencyKey: 'inside' })
    const hints = []
    while (!hints.some(frame => frame.data.revision >= 1)) hints.push(await stream.next())
    assert.ok(hints.every(frame => frame.event === 'run-changed' && frame.data.runId === run.id && frame.data.sessionId === session.id))
    assert.deepEqual(Object.keys(hints[0].data).sort(), ['revision', 'runId', 'sessionId'])
    f.llm.calls[1].result.resolve('answer')
    let notified = false
    const terminal = stream.next().then(frame => { notified = true; return frame })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(notified, false)
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    f.llm.calls[1].done.resolve()
    const frame = await terminal
    const completed = await f.harness.waitRun(run.id)
    assert.equal(frame.data.revision, completed.revision)
    assert.equal((await f.harness.getNode(session.id, completed.resultNodeId)).output, 'answer')
    await stream.close(); stream = undefined
    assert.equal((await f.harness.getRun(outside.id)).status, 'running')
  } finally {
    await stream?.close()
    for (const call of f.llm.calls) { call.result.resolve('done'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('SSE validates sessions, limits subscriptions, rejects foreign origins and rechecks shutdown after validation', async () => {
  const gate = deferred(), entered = deferred()
  let hold = false
  const web = await startHarnessApiServer({ getSession: async id => {
    if (hold) { entered.resolve(); await gate.promise }
    return id === 'a' ? { id } : undefined
  } })
  try {
    for (const [query, headers, status] of [
      ['', {}, 400], ['sessionId=a&sessionId=a', {}, 400],
      ['sessionId=a&sessionId=b&sessionId=c&sessionId=d&sessionId=e', {}, 400],
      ['sessionId=missing', {}, 404], ['sessionId=a&unknown=x', {}, 400],
      ['sessionId=a', { Origin: 'https://elsewhere.test' }, 403],
      ['sessionId=a', { 'Sec-Fetch-Site': 'same-site' }, 403],
    ]) {
      const response = await fetch(`${web.url}/api/v1/changes?${query}`, { headers })
      assert.equal(response.status, status); await response.text()
    }
    hold = true
    const request = fetch(`${web.url}/api/v1/changes?sessionId=a`)
    await entered.promise
    const closing = web.close()
    gate.resolve()
    const response = await request
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /event: ready/)
    await closing
  } finally { gate.resolve(); await web.close() }
})

test('Web dependency restart closes streams and installs exactly one new Nya listener', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-reconnect-')), f = await fixture(directory)
  let stream
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    stream = await changes(f.web, [session.id]); await stream.next()
    const disconnected = stream.next().then(() => true, () => true)
    await f.apiFiber.dispose()
    assert.equal(await disconnected, true)
    await stream.close(); stream = undefined
    await f.reinstall()
    await serviceReady(f.root, harnessApiServiceKey)
    const current = f.root.get(harnessApiServiceKey)
    assert.equal(current.url, f.web.url)
    assert.equal(f.webFiber.inspect().effects.filter(label => label === `ctx.on("${runChangedEvent}")`).length, 1)
    stream = await changes(current, [session.id])
    assert.equal((await stream.next()).event, 'ready')
    await f.root.parallel(runChangedEvent, { sessionId: session.id, runId: 'probe', revision: 9 })
    assert.equal((await stream.next()).data.runId, 'probe')
    const stopped = stream.next().then(() => true, () => true)
    await f.close()
    assert.equal(await stopped, true)
  } finally { await stream?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web Models settings manage provider keys, revisions and histories without exposing secrets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-key-')), f = await fixture(directory)
  try {
    const added = await request(f.web, 'POST', '/models/connections', { providerDefinitionId: 'default-provider-definition', id: 'managed', name: 'Work connection', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, apiKey: 'first-private-value' })
    assert.equal(added.response.status, 200)
    assert.equal(added.data.credentialConfigured, true)
    assert.ok([...f.secrets.values()].includes('first-private-value'))
    const saved = await request(f.web, 'POST', '/models/connections/managed/key', { apiKey: 'second-private-value', expectedRevision: added.data.revision })
    assert.equal(saved.response.status, 200)
    assert.ok([...f.secrets.values()].includes('second-private-value'))
    assert.equal([...f.secrets.values()].includes('first-private-value'), false)
    const stale = await request(f.web, 'POST', '/models/connections/managed/key', { apiKey: 'stale-private-value', expectedRevision: added.data.revision })
    assert.equal(stale.response.status, 409)
    assert.equal([...f.secrets.values()].includes('stale-private-value'), false)
    assert.equal((await request(f.web, 'POST', '/models/connections/managed/key', { apiKey: '', expectedRevision: saved.data.revision })).response.status, 400)
    const deleted = await request(f.web, 'POST', '/models/connections/managed/key/delete', { expectedRevision: saved.data.revision })
    assert.equal(deleted.response.status, 200)
    assert.equal(deleted.data.credentialConfigured, false)
    const history = await request(f.web, 'GET', '/models/connections/managed/history')
    assert.equal(history.data.length, 3)
    for (const data of [added.data, saved.data, deleted.data, history.data, (await request(f.web, 'GET', '/models/connections')).data]) assert.doesNotMatch(JSON.stringify(data), /private-value|credentialRef/)
    assert.equal((await request(f.web, 'GET', '/credentials')).response.status, 404)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web deletes only the selected connection with CAS and origin checks while preserving sessions and active Run settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-delete-')), f = await fixture(directory)
  try {
    const settings = f.root.get('models.settings')
    const connection = (await request(f.web, 'POST', '/models/connections', { providerDefinitionId: 'default-provider-definition', id: 'remove-account',
      name: 'Remove account', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 30000, apiKey: 'removed-private-key' })).data
    const baseline = settings.configurations(connection.id)[0]
    const preset = await settings.createConfiguration({ connectionId: connection.id, modelDefinitionId: baseline.modelDefinitionId,
      name: 'Preset', enabled: true, baseline: false, capabilities: baseline.capabilities, parameters: { protocolId: baseline.parameters.protocolId, formatVersion: 1, value: { temperature: 0.2 } } })
    const session = await f.harness.createSession(f.project.id, 'assistant', baseline.id)
    const started = await f.harness.startRun({ sessionId: session.id, modelId: baseline.id, parentNodeId: null, input: 'Keep running', idempotencyKey: 'before-delete' })
    const before = await f.harness.getRun(started.id)
    const path = `/models/connections/${connection.id}/delete`
    assert.equal((await request(f.web, 'POST', path, { expectedRevision: connection.revision }, 'https://elsewhere.test')).response.status, 403)
    assert.equal((await request(f.web, 'POST', path, {})).response.status, 400)
    assert.equal((await request(f.web, 'POST', path, { expectedRevision: connection.revision + 1 })).response.status, 409)
    assert.ok([...f.secrets.values()].includes('removed-private-key'))
    const deleted = await request(f.web, 'POST', path, { expectedRevision: connection.revision })
    assert.equal(deleted.response.status, 200); assert.deepEqual(deleted.data, { ok: true })
    assert.equal([...f.secrets.values()].includes('removed-private-key'), false)
    assert.deepEqual((await request(f.web, 'GET', '/models/connections')).data.map(value => value.id), ['default'])
    assert.deepEqual((await request(f.web, 'GET', `/models/configurations?connectionId=${connection.id}`)).data, [])
    assert.equal((await request(f.web, 'GET', '/models')).data.some(value => value.id === baseline.id || value.id === preset.id), false)
    assert.equal((await request(f.web, 'GET', `/sessions/${session.id}`)).data.modelId, baseline.id)
    assert.equal((await request(f.web, 'GET', `/models/connections/${connection.id}/history`)).data.length, 1)
    assert.equal((await request(f.web, 'GET', `/models/configurations/${preset.id}/history`)).data.length, 1)
    assert.equal((await request(f.web, 'POST', path, { expectedRevision: connection.revision })).response.status, 404)
    assert.equal(f.llm.calls[0].input.signal.aborted, false)
    f.llm.calls[0].result.resolve('Answer after deletion'); f.llm.calls[0].done.resolve()
    const completed = await f.harness.waitRun(started.id)
    assert.equal(completed.status, 'completed'); assert.deepEqual(completed.modelSnapshot, before.modelSnapshot)
    assert.equal((await f.harness.getNode(session.id, completed.resultNodeId)).output, 'Answer after deletion')
    assert.equal((await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: completed.resultNodeId, input: 'Next', idempotencyKey: 'after-delete' })).response.status, 409)
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('done'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('Web Responses startup registers its key and exposes the existing Bash Run events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-responses-'))
  const received = []
  const server = createServer(async (incoming, response) => {
    let body = ''
    for await (const chunk of incoming) body += chunk
    received.push({ path: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const finalResponse = {
      object: 'response', status: 'completed',
      output: received.length === 1 ? [
        { id: 'reasoning-web', type: 'reasoning', summary: [], encrypted_content: 'private-encrypted-context' },
        { id: 'message-web', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
          content: [{ type: 'output_text', text: 'Running Bash.' }] },
        { id: 'function-web', type: 'function_call', status: 'completed', call_id: 'call-web',
          name: 'bash', arguments: JSON.stringify({ command: 'printf web-response' }) },
      ] : [
        { id: 'final-web', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Bash printed web-response.' }] },
      ],
    }
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: finalResponse })}\n\n`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config = parseWebStartupConfig({
    ANYBOX_LLM_API: 'openai-responses', ANYBOX_LLM_MODEL: 'compatible-responses-model',
    ANYBOX_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ANYBOX_LLM_MAX_OUTPUT_TOKENS: '2048', ANYBOX_LLM_TEMPERATURE: '0.2',
  })
  let f
  try {
    f = await fixture(directory, {}, config)
    const providers = await request(f.web, 'GET', '/models/connections')
    assert.equal(providers.data.length, 1)
    const provider = providers.data[0]
    assert.equal(provider.credentialConfigured, false)
    assert.equal((await request(f.web, 'POST', `/models/connections/${provider.id}/key`, { apiKey: 'web-secret-key', expectedRevision: provider.revision })).response.status, 200)
    const session = (await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })).data
    const run = (await request(f.web, 'POST', `/sessions/${session.id}/runs`, {
      parentNodeId: null, input: 'Run Bash', idempotencyKey: 'responses-web',
    })).data
    await f.harness.waitRun(run.id)
    const terminal = (await request(f.web, 'GET', `/runs/${run.id}`)).data
    assert.equal(terminal.status, 'completed', JSON.stringify(terminal))
    assert.equal(terminal.output, 'Bash printed web-response.')
    const events = (await request(f.web, 'GET', `/runs/${run.id}/events?afterSeq=0`)).data
    assert.deepEqual(events.map(event => event.kind), [
      'operation-started', 'operation-observed', 'tool-started', 'tool-observed', 'operation-started', 'operation-observed', 'terminal',
    ])
    assert.equal(events.find(event => event.kind === 'tool-observed').stdout, 'web-response')
    assert.equal(events.find(event => event.kind === 'tool-started').requestId, 'call-web')
    assert.doesNotMatch(JSON.stringify({ terminal, events }), /private-encrypted-context|web-secret-key|Private instructions/)
    assert.equal(received.length, 2)
    for (const incoming of received) {
      assert.equal(incoming.path, '/v1/responses')
      assert.equal(incoming.authorization, 'Bearer web-secret-key')
      assert.equal(incoming.body.model, 'compatible-responses-model')
      assert.equal(incoming.body.max_output_tokens, 2048)
      assert.equal(incoming.body.temperature, 0.2)
    }
    const observation = received[1].body.input.find(item => item.type === 'function_call_output')
    assert.equal(observation.call_id, 'call-web')
    assert.equal(JSON.parse(observation.output).stdout, 'web-response')
  } finally {
    await f?.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web Prompt bindings apply to new Sessions while existing Sessions retain their first accepted instructions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompts-'))
  let f = await fixture(directory)
  try {
    const defaults = await request(f.web, 'GET', '/agents/assistant/prompts')
    assert.equal(defaults.data[0].content, 'Private instructions.')
    assert.deepEqual((await request(f.web, 'GET', '/prompts')).data, [])
    const created = await request(f.web, 'POST', '/prompts', {
      name: 'Assistant instructions', description: 'Shared across projects',
      kind: 'agent-instruction', role: 'system', content: 'First instruction.',
    })
    assert.equal(created.response.status, 200)
    const id = created.data.id
    assert.equal(created.data.draft.revision, 1)
    assert.equal(created.data.ownerId, undefined)
    const published = await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 1 })
    assert.equal(published.response.status, 200)
    const v1 = published.data.id
    assert.equal((await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v1 })).response.status, 200)
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const first = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'First', idempotencyKey: 'one' })
    assert.equal(f.llm.calls[0].input.messages[0].content, 'First instruction.')
    const edited = await request(f.web, 'POST', `/prompts/${id}`, { expectedRevision: 1, content: 'Second instruction.' })
    assert.equal(edited.data.draft.revision, 2)
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].content, 'First instruction.')
    const v2 = (await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).data.id
    // Publication alone does not change the selected Agent version.
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].versionId, v1)
    await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v2 })
    assert.equal(f.llm.calls[0].input.messages[0].content, 'First instruction.')
    f.llm.calls[0].result.resolve('First answer')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(first.data.id)
    const second = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Second', idempotencyKey: 'two' })
    assert.equal(second.response.status, 200)
    assert.equal(f.llm.calls[1].input.messages[0].content, 'First instruction.', 'a sibling root Run retains the Session initialization')
    f.llm.calls[1].result.resolve('Second answer')
    f.llm.calls[1].done.resolve()
    await f.harness.waitRun(second.data.id)
    const newSession = await f.harness.createSession(f.project.id, 'assistant')
    const third = await request(f.web, 'POST', `/sessions/${newSession.id}/runs`, { parentNodeId: null, input: 'New session', idempotencyKey: 'three' })
    assert.equal(third.response.status, 200)
    assert.equal(f.llm.calls[2].input.messages[0].content, 'Second instruction.', 'a new Session captures the currently bound instruction')
    f.llm.calls[2].result.resolve('New session answer')
    f.llm.calls[2].done.resolve()
    await f.harness.waitRun(third.data.id)
    assert.deepEqual((await request(f.web, 'GET', `/prompts/${id}/versions`)).data.map(item => item.content),
      ['First instruction.', 'Second instruction.'])
    await f.close()
    f = await fixture(directory)
    assert.equal((await request(f.web, 'GET', '/prompts')).data[0].id, id)
    assert.equal((await request(f.web, 'GET', `/prompts/${id}`)).data.draft.revision, 2)
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].versionId, v2)
    // Selecting an older immutable version rolls back the binding, not the draft.
    await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v1 })
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].content, 'First instruction.')
    assert.equal((await request(f.web, 'GET', `/prompts/${id}`)).data.draft.content, 'Second instruction.')
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Done'); call.done.resolve() }
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web Prompt writes enforce host identity, origin, revisions and domain validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompt-validation-'))
  const f = await fixture(directory)
  const input = { name: 'Context', kind: 'context', role: 'user', content: '文'.repeat(30_000) }
  try {
    assert.equal((await request(f.web, 'POST', '/prompts', input, 'https://example.com')).response.status, 403)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, actorId: 'someone' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, role: 'system' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, kind: 'task-template' })).response.status, 400)
    assert.deepEqual((await request(f.web, 'GET', '/prompts')).data, [])
    // Prompt's character limit is independent of the smaller general HTTP body limit.
    const created = await request(f.web, 'POST', '/prompts', input)
    assert.equal(created.response.status, 200)
    assert.equal(created.data.draft.content, input.content)
    const id = created.data.id
    assert.equal((await request(f.web, 'POST', `/prompts/${id}`, { content: 'No revision' })).response.status, 400)
    const edits = await Promise.all(['a', 'b'].map(content => request(f.web, 'POST', `/prompts/${id}`, { expectedRevision: 1, content })))
    assert.deepEqual(edits.map(item => item.response.status).sort(), [200, 409])
    assert.equal(edits.find(item => item.response.status === 409).data.error.code, 'prompt-conflict')
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 1 })).data.error.code, 'prompt-conflict')
    assert.deepEqual((await request(f.web, 'GET', `/prompts/${id}/versions`)).data, [])
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).response.status, 200)
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).data.error.code, 'prompt-publication-conflict')
    assert.equal((await request(f.web, 'GET', '/prompts/missing')).response.status, 404)
    assert.equal((await request(f.web, 'GET', '/agents/missing/prompts')).response.status, 404)
    const foreign = await f.harness.createPrompt('another-owner', { ...input, content: 'Private other user content' })
    const foreignVersion = await f.harness.publishPrompt('another-owner', foreign.id)
    for (const suffix of ['', '/versions']) {
      const denied = await request(f.web, 'GET', `/prompts/${foreign.id}${suffix}`)
      assert.equal(denied.response.status, 403)
      assert.doesNotMatch(JSON.stringify(denied.data), /Private other user content/)
    }
    assert.equal((await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: foreignVersion.id })).response.status, 403)
    assert.equal((await request(f.web, 'GET', '/prompts')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web shutdown joins an accepted Prompt write before its dependencies close', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompt-close-'))
  const f = await fixture(directory)
  const entered = deferred()
  const release = deferred()
  const prompts = f.root.get(promptServiceKey)
  const original = prompts.createPrompt
  prompts.createPrompt = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  try {
    const saving = request(f.web, 'POST', '/prompts', { name: 'Held', kind: 'context', role: 'user', content: 'Keep this.' })
    await entered.promise
    let closed = false
    const closing = f.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release.resolve()
    assert.equal((await saving).response.status, 200)
    await closing
    const restored = await fixture(directory)
    try { assert.equal((await request(restored.web, 'GET', '/prompts')).data[0].draft.content, 'Keep this.') }
    finally { await restored.close() }
  } finally { release.resolve(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web client contract serves assets and completes one idempotent Harness Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const html = await fetch(f.assets.url)
    assert.equal(html.status, 200)
    assert.match(await html.text(), /Anybox/)
    const client = await fetch(`${f.assets.url}/client.js`)
    assert.equal(client.status, 200)
    const clientSource = await client.text()
    assert.match(clientSource, /\/api\/client\/v1\/connections/)
    assert.doesNotMatch(clientSource, /@nya\/core|deepseek-chat-completions/)
    for (const asset of ['workspace-client', 'workspace-layout', 'session-client', 'session-view', 'tool-trace', 'prompt-client', 'protocols/modules', 'protocols/view']) {
      const response = await fetch(`${f.assets.url}/${asset}.js`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /javascript/)
      assert.doesNotMatch(await response.text(), /from ['"]@nya\/core/)
    }
    assert.equal((await fetch(`${f.assets.url}/harness.js`)).status, 404)


    const agents = await request(f.web, 'GET', '/agents')
    assert.deepEqual(agents.data, [{ id: 'assistant' }])
    assert.doesNotMatch(JSON.stringify(agents.data), /Private instructions/)
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    assert.equal(created.response.status, 200)
    const sessionId = created.data.id
    const body = { parentNodeId: null, input: 'Hello', idempotencyKey: 'send-1' }
    const first = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    const replay = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    assert.equal(first.response.status, 200)
    assert.equal(replay.data.id, first.data.id)
    assert.equal(f.llm.calls.length, 1)
    assert.deepEqual(Object.keys(first.data).sort(), ['createdAt', 'files', 'history', 'id', 'images', 'input', 'modelId', 'modelSnapshot', 'protocolBinding', 'requestedModelId', 'revision', 'sessionId', 'status', 'updatedAt'])
    assert.doesNotMatch(JSON.stringify(first.data), /Private instructions|llmSnapshot|promptVersionIds|idempotencyKey/)
    const inFlight = await request(f.web, 'GET', `/runs/${first.data.id}`)
    assert.equal(inFlight.data.status, 'running')
    f.llm.calls[0].result.resolve('Hello back')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(first.data.id)
    const final = await request(f.web, 'GET', `/runs/${first.data.id}`)
    assert.equal(final.data.status, 'completed')
    assert.equal(final.data.output, 'Hello back')
    const session = await request(f.web, 'GET', `/sessions/${sessionId}`)
    assert.equal('turns' in session.data, false)
    const nodes = await request(f.web, 'GET', `/sessions/${sessionId}/nodes?parentNodeId=root`)
    assert.deepEqual(nodes.data.nodes.map(({input, output}) => ({input, output})), [{ input: 'Hello', output: 'Hello back' }])
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web serves bounded Run events for an active Bash loop and its completed history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-events-'))
  const f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const accepted = await request(f.web, 'POST', `/sessions/${created.data.id}/runs`,
      { parentNodeId: null, input: 'Inspect output', idempotencyKey: 'events' })
    assert.equal((await request(f.web, 'GET', '/runs/missing/events')).response.status, 404)
    assert.deepEqual((await request(f.web, 'GET', `/runs/${accepted.data.id}/events`)).data.map(event => event.kind),
      ['operation-started'])
    f.llm.calls[0].result.resolve({ status: 'completed', text: '', toolCalls: [{
      id: 'call-1', name: 'bash', arguments: { command: "printf '%*s' 5000 '' | tr ' ' a" },
    }] })
    f.llm.calls[0].done.resolve()
    for (let attempt = 0; attempt < 100 && f.llm.calls.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(f.llm.calls.length, 2)
    f.llm.calls[1].result.resolve('Done')
    f.llm.calls[1].done.resolve()
    assert.equal((await f.harness.waitRun(accepted.data.id)).status, 'completed')
    const events = await request(f.web, 'GET', `/runs/${accepted.data.id}/events`)
    assert.equal(events.response.status, 200)
    assert.deepEqual(events.data.map(event => event.kind), [
      'operation-started', 'operation-observed', 'tool-started', 'tool-observed', 'operation-started', 'operation-observed', 'terminal',
    ])
    assert.equal(events.data[2].command, "printf '%*s' 5000 '' | tr ' ' a")
    assert.equal(events.data[2].requestId, 'call-1')
    assert.equal(events.data[3].exitCode, 0)
    assert.equal(events.data[3].stdout.length, 2048)
    assert.equal(events.data[3].truncated, true)
    assert.equal(events.data.at(-1).status, 'completed')
    assert.doesNotMatch(JSON.stringify(events.data), /Private instructions|llmSnapshot|local-key/)
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web Apply Patch events bound Unicode previews and preserve partial, cancelled and cleanup results', async () => {
  const patch = '*** Begin Patch\n*** Add File: 中文.txt\n+' + '字'.repeat(1_000) + '\n*** End Patch'
  const call = { id: 'patch', name: 'apply_patch', arguments: { patch } }
  const makeResult = status => ({ status, changes: [{ kind: 'added', path: '/project/中文.txt' }],
    pending: [{ kind: 'update', path: '/project/old.txt', moveTo: '/project/new.txt' }],
    diagnostic: { code: 'io-error', message: 'Could not remove source', path: '/project/old.txt' } })
  const source = [
    { kind: 'model-tool-calls', calls: [call] }, { kind: 'tool-started', call },
    ...['applied', 'rejected', 'partial', 'cancelled'].map(status => ({
      kind: 'tool-observed', name: 'apply_patch', requestId: call.id, result: makeResult(status),
    })),
    { kind: 'tool-failed', name: 'apply_patch', requestId: call.id, category: 'tool-cleanup-failure', result: makeResult('partial') },
  ].map((event, i) => ({ ...event, seq: i + 1, at: '2026-01-01T00:00:00.000Z' }))
  const web = await startHarnessApiServer({ getRunEvents: async (_id, after) => source.filter(event => event.seq > after) })
  try {
    const { data: events } = await request(web, 'GET', '/runs/run/events')
    assert.equal(events[0].calls[0].name, 'apply_patch')
    assert.equal(events[0].calls[0].patchTruncated, true)
    assert.ok(Buffer.byteLength(events[0].calls[0].patch, 'utf8') <= 2048)
    assert.ok(patch.startsWith(events[0].calls[0].patch))
    assert.doesNotMatch(events[0].calls[0].patch, /�/)
    assert.equal(events[1].patch, events[0].calls[0].patch)
    assert.equal(events[1].requestId, call.id)
    for (let i = 2; i < source.length; i++) assert.deepEqual(events[i].result, source[i].result)
    assert.equal(events.at(-1).category, 'tool-cleanup-failure')
    assert.deepEqual((await request(web, 'GET', '/runs/run/events?afterSeq=5')).data.map(event => event.seq), [6, 7])
  } finally { await web.close() }
})

test('Web exposes a rejected patch followed by a corrected patch as separate process cards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-patch-'))
  const f = await fixture(directory)
  try {
    const session = (await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })).data
    const run = (await request(f.web, 'POST', `/sessions/${session.id}/runs`, {
      parentNodeId: null, input: 'Create a file', idempotencyKey: 'patch-events',
    })).data
    for (const [index, patch] of ['not a patch', '*** Begin Patch\n*** Add File: created.txt\n+hello\n*** End Patch'].entries()) {
      f.llm.calls[index].result.resolve({ status: 'completed', text: '', toolCalls: [{ id: `patch-${index}`, name: 'apply_patch', arguments: { patch } }] })
      f.llm.calls[index].done.resolve()
      for (let attempt = 0; attempt < 100 && f.llm.calls.length < index + 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(f.llm.calls.length, index + 2)
    }
    f.llm.calls[2].result.resolve('Created'); f.llm.calls[2].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
    const events = (await request(f.web, 'GET', `/runs/${run.id}/events`)).data
    const observations = events.filter(event => event.kind === 'tool-observed')
    assert.deepEqual(observations.map(event => event.result.status), ['rejected', 'applied'])
    assert.equal(observations[0].result.changes.length, 0)
    assert.equal(observations[1].result.changes[0].kind, 'added')
    assert.match(observations[1].result.changes[0].path, /created.txt$/)
    assert.equal(events.filter(event => event.kind === 'tool-started').every(event => event.name === 'apply_patch'), true)
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web host rejects cross-origin writes, maps errors, and waits for cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const cross = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' }, 'https://example.invalid')
    assert.equal(cross.response.status, 403)
    assert.equal(cross.data.error.code, 'forbidden-origin')
    assert.equal(cross.response.headers.get('access-control-allow-origin'), null)
    const invalid = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'missing' })
    assert.equal(invalid.response.status, 404)
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const path = `/sessions/${created.data.id}/runs`
    const run = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Cancel me', idempotencyKey: 'one' })
    const conflict = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Again', idempotencyKey: 'one' })
    assert.equal(conflict.response.status, 409)
    const cancelled = await request(f.web, 'POST', `/runs/${run.data.id}/cancel`, {})
    assert.equal(cancelled.data.status, 'cancelling')
    assert.ok(f.llm.calls[0].cancellations.length > 0)
    f.llm.calls[0].result.reject(modelsError('provider-failure'))
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.data.id)
    const final = await request(f.web, 'GET', `/runs/${run.data.id}`)
    assert.equal(final.data.status, 'cancelled')
    const failed = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Fail me', idempotencyKey: 'failure' })
    f.llm.calls[1].result.reject(modelsError('provider-failure'))
    f.llm.calls[1].done.resolve()
    await f.harness.waitRun(failed.data.id)
    const failedFinal = await request(f.web, 'GET', `/runs/${failed.data.id}`)
    assert.equal(failedFinal.data.status, 'failed')
    assert.equal(failedFinal.data.errorCategory, 'provider-failure')
    assert.equal(failedFinal.data.error, 'model provider failed')
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a fresh Web host restores persistent sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  let f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const oldId = created.data.id
    await f.close()
    f = await fixture(directory)
    const old = await request(f.web, 'GET', `/sessions/${oldId}`)
    assert.equal(old.response.status, 200)
    assert.equal(old.data.id, oldId)
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web host shutdown cancels and joins an accepted Run before releasing Harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const accepted = await request(f.web, 'POST', `/sessions/${created.data.id}/runs`, {
      parentNodeId: null, input: 'Stay active', idempotencyKey: 'one',
    })
    assert.equal(accepted.data.status, 'running')
    let closed = false
    const shutdown = f.close().then(() => { closed = true })
    await f.llm.calls[0].cancelled.promise
    assert.ok(f.llm.calls[0].cancellations.length > 0)
    assert.equal(closed, false)
    f.llm.calls[0].result.reject(modelsError('provider-failure'))
    f.llm.calls[0].done.resolve()
    await shutdown
    assert.equal(closed, true)
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Nya stops and restarts the Web frontend with its Run dependency on the same port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const originalUrl = f.web.url
    await f.apiFiber.dispose()
    assert.equal(f.root.get(harnessApiServiceKey), undefined)
    await f.reinstall()
    await serviceReady(f.root, harnessApiServiceKey)
    const current = f.root.get(harnessApiServiceKey)
    assert.equal(current?.url, originalUrl)
    const agents = await request(current, 'GET', '/agents')
    assert.deepEqual(agents.data, [{ id: 'assistant' }])
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Web frontend can be replaced without closing Harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const port = Number(new URL(f.web.url).port)
    await f.webFiber.dispose()
    assert.equal(f.root.get(harnessApiServiceKey), undefined)
    const session = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(session.agentId, 'assistant')
    await f.root.installComponent(createHarnessApiComponent(f.harness.listAgents(), port))
    const replacement = f.root.get(harnessApiServiceKey)
    assert.equal(replacement?.url, f.web.url)
    const fetched = await request(replacement, 'GET', `/sessions/${session.id}`)
    assert.equal(fetched.response.status, 200)
    assert.equal(fetched.data.id, session.id)
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('active native views survive Web replacement and committed views survive application restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-native-view-'))
  let f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Show progress', idempotencyKey: 'view' })
    f.llm.calls[0].input.onEvent({ type: 'text-delta', delta: 'Already streamed before replacement' })
    const before = await request(f.web, 'GET', `/runs/${run.id}/view`)
    assert.equal(before.response.status, 200)
    assert.match(JSON.stringify(before.data), /Already streamed/)
    const port = Number(new URL(f.web.url).port)
    await f.webFiber.dispose()
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    await f.root.installComponent(createHarnessApiComponent(f.harness.listAgents(), port))
    const replacement = f.root.get(harnessApiServiceKey)
    assert.deepEqual((await request(replacement, 'GET', `/runs/${run.id}/view`)).data, before.data)
    f.llm.calls[0].result.resolve('Persisted native answer'); f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.id)
    const committed = (await request(replacement, 'GET', `/runs/${run.id}/view`)).data
    assert.equal(committed.status, 'committed')
    assert.match(JSON.stringify(committed), /Persisted native answer/)
    assert.doesNotMatch(JSON.stringify(committed), /Already streamed|Private instructions/)
    await f.close()
    f = await fixture(directory)
    assert.deepEqual((await request(f.web, 'GET', `/runs/${run.id}/view`)).data, committed)
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('Web project routes register directories and switching views leaves Runs active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-projects-'))
  const secondPath = join(directory, '中文 项目')
  mkdirSync(secondPath)
  const picked = [directory, secondPath, undefined]
  const f = await fixture(directory, { runDialog: async () => picked.shift() })
  try {
    const listed = await request(f.web, 'GET', '/projects')
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0].id, f.project.id)
    assert.deepEqual((await request(f.web, 'GET', '/projects/picker')).data, { supported: true })
    assert.equal((await request(f.web, 'POST', '/projects/pick', {}, 'https://example.invalid')).response.status, 403)
    const duplicate = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(duplicate.data.id, f.project.id)
    const added = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(added.response.status, 200)
    assert.equal(added.data.path, realpathSync(secondPath))
    const cancelled = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(cancelled.response.status, 200)
    assert.equal(cancelled.data, null)
    assert.equal((await request(f.web, 'POST', '/projects/pick', { path: secondPath })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/projects', { path: secondPath })).response.status, 200)
    const session = await request(f.web, 'POST', '/sessions', {
      projectId: f.project.id, agentId: 'assistant',
    })
    assert.equal(session.data.projectId, f.project.id)
    const run = await request(f.web, 'POST', `/sessions/${session.data.id}/runs`, {
      parentNodeId: null, input: 'Keep running', idempotencyKey: 'one',
    })
    const otherSessions = await request(f.web, 'GET', `/projects/${added.data.id}/sessions`)
    assert.deepEqual(otherSessions.data, [])
    assert.deepEqual(f.llm.calls[0].cancellations, [])
    const projectSessions = await request(f.web, 'GET', `/projects/${f.project.id}/sessions`)
    assert.equal(projectSessions.data[0].id, session.data.id)
    f.llm.calls[0].result.resolve('Still running')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.data.id)
    const history = await request(f.web, 'GET', `/sessions/${session.data.id}/runs`)
    assert.equal(history.data[0].output, 'Still running')
    const unknownHistory = await request(f.web, 'GET', '/sessions/missing/runs')
    assert.equal(unknownHistory.response.status, 404)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('native project picker maps failures and rejects concurrent selection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let finish
  const entered = new Promise(resolve => { started = resolve })
  const selection = new Promise(resolve => { finish = resolve })
  const f = await fixture(directory, { runDialog: () => { started(); return selection } })
  try {
    const pending = request(f.web, 'POST', '/projects/pick', {})
    await entered
    const busy = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(busy.response.status, 409)
    assert.deepEqual(busy.data, { error: { code: 'picker-busy' } })
    finish(undefined)
    assert.equal((await pending).data, null)
  } finally { finish(undefined); await f.close(); rmSync(directory, { recursive: true, force: true }) }

  const failedDirectory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  const failed = await fixture(failedDirectory, {
    runDialog: async () => { throw new Error('private native details') },
  })
  try {
    const response = await request(failed.web, 'POST', '/projects/pick', {})
    assert.equal(response.response.status, 503)
    assert.deepEqual(response.data, { error: { code: 'picker-unavailable' } })
  } finally { await failed.close(); rmSync(failedDirectory, { recursive: true, force: true }) }
})

test('unsupported project picker leaves Web available', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  const f = await fixture(directory, { platform: 'linux' })
  try {
    assert.deepEqual((await request(f.web, 'GET', '/projects/picker')).data, { supported: false })
    const selected = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(selected.response.status, 503)
    assert.deepEqual(selected.data, { error: { code: 'picker-unsupported' } })
    assert.equal((await request(f.web, 'GET', '/projects')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web shutdown cancels an open picker and waits for it to exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let aborted
  let release
  const entered = new Promise(resolve => { started = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const exit = new Promise(resolve => { release = resolve })
  const f = await fixture(directory, { runDialog: async signal => {
    started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    aborted()
    await exit
    return undefined
  } })
  try {
    const pending = request(f.web, 'POST', '/projects/pick', {})
    await entered
    let closed = false
    const closing = f.close().then(() => { closed = true })
    await cancelled
    assert.equal(closed, false)
    release()
    await closing
    const response = await pending
    assert.equal(response.response.status, 503)
  } finally { release(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('disconnecting a picker request cancels the host dialog without adding a project', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let aborted
  const entered = new Promise(resolve => { started = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const f = await fixture(directory, { runDialog: signal => new Promise(resolve => {
    started()
    signal.addEventListener('abort', () => { aborted(); resolve(directory) }, { once: true })
  }) })
  try {
    const controller = new AbortController()
    const pending = fetch(`${f.web.url}/api/v1/projects/pick`, {
      method: 'POST', headers: { Origin: f.web.url, 'Content-Type': 'application/json' },
      body: '{}', signal: controller.signal,
    })
    await entered
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    await cancelled
    assert.equal((await request(f.web, 'GET', '/projects')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('tree HTTP contract requires ancestry, supports sibling attempts and restores accepted keys read-only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-tree-'))
  const f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const path = `/sessions/${session.id}`
    const submit = body => request(f.web, 'POST', `${path}/runs`, body)
    assert.equal((await submit({ input: 'Missing parent', idempotencyKey: 'bad' })).response.status, 400)
    assert.deepEqual((await request(f.web, 'GET', `${path}/runs`)).data, [])
    const input = { parentNodeId: null, input: 'Root', idempotencyKey: 'root/key' }
    const [a, retry, b] = await Promise.all([submit(input), submit(input), submit({ ...input, idempotencyKey: 'other' })])
    assert.equal(a.data.id, retry.data.id)
    assert.notEqual(a.data.id, b.data.id)
    assert.equal(f.llm.calls.length, 2)
    assert.equal((await request(f.web, 'GET', `${path}/runs?status=active&parentNodeId=root`)).data.length, 2)
    const recovered = (await request(f.web, 'GET', `${path}/runs/by-key/root%2Fkey`)).data
    assert.equal(recovered.id, a.data.id)
    assert.deepEqual(recovered.history, { kind: 'tree', parentNodeId: null })
    assert.equal(typeof recovered.revision, 'number')
    assert.equal((await request(f.web, 'GET', `${path}/runs/by-key/missing`)).response.status, 404)
    assert.equal(f.llm.calls.length, 2)
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes?parentNodeId=root`)).data.nodes, [])
    for (const [i, call] of f.llm.calls.entries()) { call.result.resolve(`Answer ${i}`); call.done.resolve() }
    await Promise.all([f.harness.waitRun(a.data.id), f.harness.waitRun(b.data.id)])
    const page = (await request(f.web, 'GET', `${path}/nodes?parentNodeId=root&limit=1`)).data
    assert.equal(page.nodes.length, 1)
    assert.ok(page.nextCursor)
    const rest = (await request(f.web, 'GET', `${path}/nodes?parentNodeId=root&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).data
    assert.equal(rest.nodes.length, 1)
    assert.equal(rest.nextCursor, undefined)
    assert.notEqual(rest.nodes[0].id, page.nodes[0].id)
    const node = page.nodes[0]
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/${node.id}`)).data, node)
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/${node.id}/path`)).data, [node])
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/root/path`)).data, [])
    assert.equal((await submit({ ...input, parentNodeId: node.id })).response.status, 409)
    assert.equal((await submit({ ...input, input: 'Changed' })).response.status, 409)
    const continued = await submit({ parentNodeId: node.id, input: 'Continue', idempotencyKey: 'child' })
    assert.equal(continued.response.status, 200)
    assert.equal((await request(f.web, 'GET', `${path}/runs?status=active&parentNodeId=${node.id}`)).data.length, 1)
    const events = (await request(f.web, 'GET', `/runs/${continued.data.id}/events?afterSeq=0`)).data
    assert.deepEqual(events.map(e => e.kind), ['operation-started'])
    f.llm.calls[2].result.resolve('Child answer')
    f.llm.calls[2].done.resolve()
    const done = await f.harness.waitRun(continued.data.id)
    assert.deepEqual((await request(f.web, 'GET', `/runs/${done.id}/events?afterSeq=${events[0].seq}`)).data.map(e => e.kind), ['operation-observed', 'terminal'])
    assert.equal((await request(f.web, 'GET', `${path}/nodes/${done.resultNodeId}/path`)).data.length, 2)
    const publicRun = (await request(f.web, 'GET', `/runs/${done.id}`)).data
    assert.equal(publicRun.resultNodeId, done.resultNodeId)
    assert.equal(publicRun.modelSnapshot.modelId, 'default')
    assert.doesNotMatch(JSON.stringify(publicRun.modelSnapshot), /credential|secret/)
    assert.equal(publicRun.promptVersionIds, undefined)
    assert.equal(publicRun.idempotencyKey, undefined)
    assert.doesNotMatch(JSON.stringify(publicRun), /Private instructions/)
    for (const suffix of ['/nodes', '/nodes?parentNodeId=root&limit=0', '/nodes?parentNodeId=root&limit=101', '/runs?status=bogus']) {
      assert.equal((await request(f.web, 'GET', `${path}${suffix}`)).response.status, 400)
    }
    assert.equal((await request(f.web, 'GET', `${path}/nodes/missing/path`)).response.status, 404)
    assert.equal((await request(f.web, 'GET', `/runs/${done.id}/events?afterSeq=-1`)).response.status, 400)
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP wait distinguishes timeout from completion and waits for actual resource exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-wait-'))
  const f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'wait' })
    const waiting = `/runs/${run.id}/wait`
    const timeout = await request(f.web, 'GET', `${waiting}?timeoutMs=0`)
    assert.equal(timeout.data.done, false)
    assert.equal(timeout.data.timedOut, true)
    assert.equal(timeout.data.run.status, 'running')
    for (const ms of ['-1', '25001', '1.5', 'NaN']) assert.equal((await request(f.web, 'GET', `${waiting}?timeoutMs=${ms}`)).response.status, 400)
    f.llm.calls[0].result.resolve('Done but still exiting')
    assert.equal((await request(f.web, 'GET', `${waiting}?timeoutMs=5`)).data.done, false)
    const joined = request(f.web, 'GET', `${waiting}?timeoutMs=25000`)
    f.llm.calls[0].done.resolve()
    const terminal = (await joined).data
    assert.equal(terminal.done, true)
    assert.equal(terminal.timedOut, false)
    assert.equal(terminal.run.status, 'completed')
    assert.ok(terminal.run.resultNodeId)
    assert.deepEqual(f.llm.calls[0].cancellations, [])
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('disconnecting wait and closing Web release waiters without cancelling the Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-wait-close-'))
  const f = await fixture(directory)
  try {
    const { runServiceKey } = await import('../dist/harness/run/component.js')
    const port = f.root.get(runServiceKey)
    const original = port.waitRun.bind(port)
    const registrations = []
    let entered = deferred()
    port.waitRun = (id, signal) => { registrations.push(signal); entered.resolve(); return original(id, signal) }
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'wait' })
    const controller = new AbortController()
    const connection = fetch(`${f.web.url}/api/v1/runs/${run.id}/wait?timeoutMs=25000`, { signal: controller.signal })
    await entered.promise
    controller.abort()
    await assert.rejects(connection, { name: 'AbortError' })
    for (let i = 0; i < 30 && !registrations[0].aborted; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(registrations[0].aborted, true)
    entered = deferred()
    const pending = request(f.web, 'GET', `/runs/${run.id}/wait?timeoutMs=25000`)
    await entered.promise
    await f.webFiber.dispose()
    assert.equal((await pending).response.status, 503)
    assert.equal(registrations[1].aborted, true)
    assert.deepEqual(f.llm.calls[0].cancellations, [])
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    f.llm.calls[0].result.resolve('Still completed')
    f.llm.calls[0].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP Models configuration and session selection use persisted model IDs with revision conflicts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-model-config-')), f = await fixture(directory)
  try {
    const catalog = await request(f.web, 'GET', '/models')
    assert.equal(catalog.data[0].id, 'default')
    assert.equal(catalog.data[0].effectiveCapabilities.tools, true)
    assert.equal((await request(f.web, 'GET', '/models/protocols')).data[0].id, 'chat-completions')
    const definition = await request(f.web, 'POST', '/models/providers', { id: 'second-definition', name: 'Second service', connectionHints: { protocolIds: ['chat-completions'], baseUrl: 'https://second.example.invalid/v1' } })
    assert.equal(definition.response.status, 200)
    const provider = await request(f.web, 'POST', '/models/connections', { providerDefinitionId: definition.data.id, id: 'second', name: 'Second connection', protocolId: 'chat-completions', baseUrl: 'https://second.example.invalid/v1', enabled: true, auth: 'none', timeoutMs: 1000 })
    assert.equal(provider.response.status, 200)
    const modelDefinition = await request(f.web, 'POST', '/models/definitions', { id: 'second-model-definition', name: 'Second model', providerId: definition.data.id, remoteModelId: 'remote-test', capabilities: catalog.data[0].capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } })
    assert.equal(modelDefinition.response.status, 200)
    const added = await request(f.web, 'POST', '/models/configurations', {
      id: 'alternate', name: 'Alternate defaults', enabled: true, connectionId: 'second', modelDefinitionId: modelDefinition.data.id, baseline: true,
      capabilities: catalog.data[0].capabilities, parameters: { protocolId: 'chat-completions', formatVersion: 1, value: { temperature: 0.4 } },
    })
    assert.equal(added.response.status, 200)
    const updated = await request(f.web, 'POST', '/models/configurations/alternate', { expectedRevision: added.data.revision, patch: { parameters: { protocolId: 'chat-completions', formatVersion: 1, value: { temperature: 0.8 } } } })
    assert.equal(updated.response.status, 200)
    assert.equal((await request(f.web, 'POST', '/models/configurations/alternate', { expectedRevision: added.data.revision, patch: { name: 'Stale' } })).response.status, 409)
    assert.equal((await request(f.web, 'GET', '/models/configurations/alternate/history')).data.length, 2)
    assert.deepEqual((await request(f.web, 'POST', '/models/connections/second/check', {})).data, { ok: true })
    assert.equal((await request(f.web, 'POST', '/models/connections/second/discover', {})).data[0].remoteModelId, 'candidate')
    assert.equal((await request(f.web, 'GET', '/models/configurations')).data.length, 2)
    const session = (await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant', modelId: 'alternate' })).data
    assert.equal(session.modelId, 'alternate')
    const first = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Override', idempotencyKey: 'override', modelId: 'default' })
    const second = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Selection', idempotencyKey: 'selection' })
    assert.equal(first.data.modelId, 'default'); assert.equal(second.data.modelId, 'alternate')
    assert.equal(f.llm.calls.length, 2)
    assert.equal(f.llm.calls[1].input.request.temperature, 0.8)
    assert.equal((await request(f.web, 'POST', `/sessions/${session.id}/model`, { modelId: 'default' })).data.modelId, 'default')
    assert.equal((await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Selection', idempotencyKey: 'selection' })).data.id, second.data.id)
    const disabled = await request(f.web, 'POST', '/models/configurations/alternate', { expectedRevision: updated.data.revision, patch: { enabled: false } })
    assert.equal(disabled.response.status, 200)
    assert.equal((await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Disabled', idempotencyKey: 'disabled', modelId: 'alternate' })).response.status, 409)
    for (const call of f.llm.calls) { call.result.resolve('Done'); call.done.resolve() }
    assert.equal((await f.harness.waitRun(second.data.id)).status, 'completed')
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('SSE protocol-view is provisional and the Run result remains authoritative', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-model-progress-')), f = await fixture(directory)
  let stream
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    stream = await changes(f.web, [session.id]); await stream.next()
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Stream', idempotencyKey: 'stream' })
    f.llm.calls[0].input.onEvent({ type: 'text-delta', delta: 'Provisional text' })
    let progress
    for (let count = 0; count < 10; count++) { const event = await stream.next(); if (event.event === 'protocol-view') { progress = event.data; break } }
    assert.equal(progress.sessionId, session.id)
    assert.equal(progress.runId, run.id)
    assert.equal(progress.snapshot.status, 'provisional')
    assert.match(JSON.stringify(progress.snapshot), /Provisional text/)
    const liveView = (await request(f.web, 'GET', `/runs/${run.id}/view`)).data
    assert.equal(liveView.viewRevision, progress.snapshot.viewRevision)
    assert.match(JSON.stringify(liveView), /Provisional text/)
    assert.equal((await f.harness.getRun(run.id)).output, undefined)
    f.llm.calls[0].result.resolve('Authoritative final text'); f.llm.calls[0].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).output, 'Authoritative final text')
    const history = (await request(f.web, 'GET', `/runs/${run.id}/events`)).data
    assert.doesNotMatch(JSON.stringify(history), /Provisional text/)
    const finalView = (await request(f.web, 'GET', `/runs/${run.id}/view`)).data
    assert.equal(finalView.status, 'committed')
    assert.match(JSON.stringify(finalView), /Authoritative final text/)
  } finally {
    await stream?.close()
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('Web imports immutable images, serves scoped content and validates small Run image references', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-images-')), f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const other = await f.harness.createSession(f.project.id, 'assistant')
    const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    const url = `${f.web.url}/api/v1/sessions/${session.id}/images`
    const imported = await fetch(url, { method: 'POST', headers: { Origin: f.web.url, 'Content-Type': 'application/octet-stream' }, body: bytes })
    assert.equal(imported.status, 201)
    const image = await imported.json()
    assert.deepEqual([image.width, image.height, image.mediaType, image.byteLength], [2, 3, 'image/png', bytes.length])
    assert.equal(image.sha256.length, 64)
    assert.ok(image.expiresAt)
    assert.doesNotMatch(JSON.stringify(image), /directory|path|base64/)
    const content = await fetch(`${url}/${image.assetId}/content`)
    assert.equal(content.status, 200)
    assert.equal(content.headers.get('content-type'), 'image/png')
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes)
    const foreign = await fetch(`${f.web.url}/api/v1/sessions/${other.id}/images/${image.assetId}/content`)
    assert.equal(foreign.status, 404)
    assert.equal((await fetch(`${url}/${image.assetId}/content`, { headers: { Origin: 'https://foreign.invalid' } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://foreign.invalid', 'Content-Type': 'image/png' }, body: bytes })).status, 403)
    const renewal = await request(f.web, 'POST', `/sessions/${session.id}/images/renew`, { assetIds: [image.assetId, 'missing'] })
    assert.equal(renewal.response.status, 200)
    assert.deepEqual(renewal.data.invalid, ['missing'])
    assert.equal(renewal.data.valid[0].assetId, image.assetId)
    for (const images of [[{ assetId: image.assetId, url: 'https://outside.invalid/image' }], [{ url: 'data:image/png;base64,x' }], new Array(9).fill({ assetId: image.assetId })]) {
      const result = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { input: '', parentNodeId: null, idempotencyKey: 'invalid-images', images })
      assert.equal(result.response.status, 400)
    }
    const invalid = await fetch(url, { method: 'POST', headers: { Origin: f.web.url, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not an image') })
    assert.equal(invalid.status, 400)
    await f.harness.archiveSession(session.id)
    const archivedContent = await fetch(`${url}/${image.assetId}/content`)
    assert.deepEqual(Buffer.from(await archivedContent.arrayBuffer()), bytes)
    const blockedUpload = await fetch(url, { method: 'POST', headers: { Origin: f.web.url, 'Content-Type': 'application/octet-stream' }, body: bytes })
    assert.equal(blockedUpload.status, 409)
    assert.equal((await blockedUpload.json()).error.code, 'session-archived')
    assert.equal((await request(f.web, 'POST', `/sessions/${session.id}/images/renew`, { assetIds: [image.assetId] })).data.valid[0].assetId, image.assetId)
    for (const path of ['/image-client.js', '/harness/image/limits.js', '/harness/image/port.js']) assert.equal((await fetch(`${f.assets.url}${path}`)).status, 200)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web waits for image call exit after result and on request cancellation before closing', async () => {
  const result = deferred(), done = deferred(), started = deferred(), cancelled = deferred()
  const image = { assetId: 'asset', sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 1, width: 1, height: 1 }
  const server = await startHarnessApiServer({ importImage(_session, bytes, signal) {
    void (async () => { for await (const _chunk of bytes) {} started.resolve() })()
    return { result: result.promise, done: done.promise, cancel: reason => cancelled.resolve(reason) }
  } })
  let received = false, closed = false
  const abort = new AbortController()
  const upload = fetch(`${server.url}/api/v1/sessions/s/images`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/octet-stream' }, body: 'x', signal: abort.signal }).then(value => { received = true; return value }, () => undefined)
  try {
    await started.promise; result.resolve(image)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(received, false, 'HTTP success must wait for actual resource exit')
    abort.abort(); await cancelled.promise
    const close = server.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    done.resolve(); await close; await upload
  } finally { done.resolve(); result.resolve(image); await server.close(); await upload }
})

test('a failed image done rejects the HTTP request even when replacement result never settles', async () => {
  let cancellations = 0
  const server = await startHarnessApiServer({ getImage() {
    return { result: new Promise(() => {}), done: Promise.reject(new Error('untrusted cleanup details')), cancel() { cancellations++ } }
  } })
  try {
    const response = await fetch(`${server.url}/api/v1/sessions/s/images/a/content`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: { code: 'asset-cleanup-failed' } })
    assert.ok(cancellations > 0)
  } finally { await server.close() }
})

test('Web project references prepare atomically, preserve history and expose safe scoped errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-files-'))
  const f = await fixture(directory)
  const { writeFile, unlink } = await import('node:fs/promises')
  try {
    await writeFile(join(directory, '.reference.txt'), 'first\nsecond\n')
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default'), base = `/sessions/${session.id}/project-files`
    const search = await request(f.web, 'GET', `${base}/search?q=reference`)
    assert.equal(search.response.status, 200); assert.ok(search.data.paths.includes('.reference.txt'))
    const preview = await request(f.web, 'POST', `${base}/preview`, { path: '.reference.txt', range: { start: 2, end: 2 } })
    assert.equal(preview.data.text, 'second\n')
    const prepared = await request(f.web, 'POST', `${base}/prepare`, { preparationKey: 'key', selections: [{ kind: 'project-file', path: '.reference.txt' }] })
    assert.equal(prepared.response.status, 200); const ref = prepared.data[0]
    await unlink(join(directory, '.reference.txt'))
    assert.equal((await request(f.web, 'POST', `${base}/prepare`, { preparationKey: 'key', selections: [{ kind: 'project-file', path: '.reference.txt' }] })).data[0].snapshotId, ref.snapshotId)
    const submitted = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { input: '', parentNodeId: null, files: [{ snapshotId: ref.snapshotId }], idempotencyKey: 'run' })
    assert.equal(submitted.response.status, 200)
    f.llm.calls[0].result.resolve('file answer'); f.llm.calls[0].done.resolve()
    const terminal = await f.harness.waitRun(submitted.data.id)
    assert.equal(terminal.status, 'completed')
    assert.deepEqual(terminal.files.map(value => value.snapshotId), [ref.snapshotId])
    const snapshot = await request(f.web, 'GET', `${base}/snapshots/${ref.snapshotId}`)
    assert.equal(snapshot.data.text, 'first\nsecond\n'); assert.ok(!JSON.stringify(snapshot.data).includes(directory))
    const other = await f.harness.createSession(f.project.id, 'assistant', 'default')
    assert.equal((await request(f.web, 'GET', `/sessions/${other.id}/project-files/snapshots/${ref.snapshotId}`)).response.status, 404)
    const invalid = await request(f.web, 'POST', `${base}/prepare`, { preparationKey: 'bad', selections: [{ kind: 'project-file', path: 'missing.txt' }] })
    assert.deepEqual(invalid.data, { error: { code: 'file-missing', fileIndex: 0 } })
    assert.equal((await request(f.web, 'POST', `${base}/preview`, { path: '../escape' })).response.status, 400)
    const response = await fetch(`${f.web.url}/api/v1${base}/snapshots/${ref.snapshotId}`, { headers: { Origin: 'https://different.invalid' } })
    assert.equal(response.status, 403)
    await f.harness.archiveSession(session.id)
    assert.equal((await request(f.web, 'GET', `${base}/snapshots/${ref.snapshotId}`)).data.text, 'first\nsecond\n')
    assert.equal((await request(f.web, 'POST', `${base}/prepare`, { preparationKey: 'after-archive', selections: [{ kind: 'snapshot', snapshotId: ref.snapshotId }] })).data.error.code, 'session-archived')
    assert.equal((await request(f.web, 'POST', `${base}/renew`, { snapshotIds: [ref.snapshotId] })).response.status, 200)
    for (const asset of ['/draft-client.js', '/file-client.js', '/file-view.js', '/harness/project-files/domain.js']) assert.equal((await fetch(`${f.assets.url}${asset}`)).status, 200)
  } finally { for (const call of f.llm.calls) { call.result.resolve('cleanup'); call.done.resolve() } await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web archive routes enforce read-only state, active conflict, static route precedence and restoration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-archive-'))
  const f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const base = `/sessions/${session.id}`
    const run = await f.harness.startRun({ sessionId: session.id, input: 'active', parentNodeId: null, idempotencyKey: 'active' })
    const conflict = await request(f.web, 'POST', `${base}/archive`, {})
    assert.equal(conflict.response.status, 409); assert.equal(conflict.data.error.code, 'session-has-active-runs')
    f.llm.calls[0].result.resolve('done'); f.llm.calls[0].done.resolve(); await f.harness.waitRun(run.id)
    const archived = await request(f.web, 'POST', `${base}/archive`, {})
    assert.equal(archived.response.status, 200); assert.ok(archived.data.archivedAt)
    assert.deepEqual((await request(f.web, 'GET', `/projects/${f.project.id}/sessions`)).data, [])
    assert.deepEqual((await request(f.web, 'GET', '/sessions/archived')).data, [archived.data])
    assert.deepEqual((await request(f.web, 'GET', base)).data, archived.data)
    for (const [path, body] of [[`${base}/model`, { modelId: 'default' }], [`${base}/runs`, { input: 'new', parentNodeId: null, idempotencyKey: 'new' }]]) {
      const rejected = await request(f.web, 'POST', path, body)
      assert.equal(rejected.response.status, 409); assert.equal(rejected.data.error.code, 'session-archived')
    }
    const replay = await request(f.web, 'POST', `${base}/runs`, { input: 'active', parentNodeId: null, idempotencyKey: 'active' })
    assert.equal(replay.data.id, run.id)
    for (const action of ['archive', 'restore']) assert.equal((await request(f.web, 'POST', `/sessions/missing/${action}`, {})).response.status, 404)
    const restored = await request(f.web, 'POST', `${base}/restore`, {})
    assert.equal(restored.response.status, 200); assert.equal(restored.data.archivedAt, null)
    assert.deepEqual((await request(f.web, 'GET', '/sessions/archived')).data, [])
    assert.equal((await request(f.web, 'GET', `/projects/${f.project.id}/sessions`)).data[0].id, session.id)
    assert.equal((await fetch(`${f.assets.url}/archive-client.js`)).status, 200)
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

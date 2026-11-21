import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { runViewEvent } from '../packages/app-harness/dist/core/run/notifications.js'
import { catalogModelsData, startCatalogModelsHost } from './helpers/catalog-models-host.mjs'
import { deferred } from './helpers/controlled-models.mjs'
import { settingsProviderGroups, settingsProviderSelection } from '../packages/app-harness/dist/web/models-client.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function request(host, method, path, body) {
  const response = await fetch(`${host.web.url}/api/v1${path}`, { method,
    ...(method === 'POST' ? { headers: { Origin: host.web.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, data: await response.json() }
}
async function accepted(host, method, path, body) {
  const result = await request(host, method, path, body)
  assert.equal(result.status, 200, JSON.stringify(result.data))
  return result.data
}
async function saveNative(host, providerId, protocolId, remoteModelId, { streaming = true } = {}) {
  const providers = await accepted(host, 'GET', '/models/providers')
  const provider = providers.find(item => item.source.kind === 'external' && item.source.providerId === providerId)
  const recipe = provider.connections.find(item => item.values.protocolId === protocolId)
  assert.ok(recipe)
  const models = await accepted(host, 'GET', `/models/definitions?providerId=${encodeURIComponent(provider.id)}`)
  const candidate = models.find(item => item.remoteModelId === remoteModelId)
  const { sourceRef, ...values } = recipe.values
  const local = await accepted(host, 'POST', '/models/provider-settings', {
    ...values, providerId: provider.id, name: `${provider.name} proxy`,
    baseUrl: protocolId === 'anthropic-messages' ? 'https://proxy.qa.invalid/custom/v1' : 'https://proxy.qa.invalid/custom/v1beta', apiKey: `${providerId}-qa-private-key`,
  })
  const settings = await accepted(host, 'GET', `/models/settings?providerId=${encodeURIComponent(local.id)}`)
  const current = settings.find(item => item.id === candidate.id)
  assert.ok(current, 'saving provider settings initializes compatible models')
  const model = await accepted(host, 'POST', `/models/settings/${current.id}`, {
    expectedRevision: current.revision,
    patch: { capabilities: { ...candidate.capabilities, streaming: { support: streaming ? 'supported' : 'unsupported' } }, parameters: { protocolId, formatVersion: 1, value: protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : { generation_config: { max_output_tokens: 4096 } } } },
  })
  return { provider: local, model, candidate, definition: provider }
}
async function selectSession(host, modelId) {
  const session = await accepted(host, 'POST', '/sessions', { projectId: host.project.id, agentId: 'assistant' })
  assert.equal(session.modelId, null)
  return accepted(host, 'POST', `/sessions/${session.id}/model`, { modelId })
}
async function run(host, session, input, key, parentNodeId = null, modelId) {
  const started = await accepted(host, 'POST', `/sessions/${session.id}/runs`, {
    input, parentNodeId, idempotencyKey: key, ...(modelId === undefined ? {} : { modelId }),
  })
  const waited = await accepted(host, 'GET', `/runs/${started.id}/wait?timeoutMs=5000`)
  assert.equal(waited.done, true)
  assert.equal(waited.run.status, 'completed', JSON.stringify(waited))
  const node = await accepted(host, 'GET', `/sessions/${session.id}/nodes/${waited.run.resultNodeId}`)
  return { run: waited.run, node }
}

test('Web directory status, filtering and native connection suggestions are advisory and make no generation requests', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  assert.equal(host.network.catalog.length, 1)
  assert.equal(host.network.generations.length, 0)
  const status = await accepted(host, 'GET', '/models/catalog')
  assert.equal(status.sourceId, 'models.dev')
  assert.equal(status.origin, 'network')
  assert.equal(status.refreshing, false)
  assert.equal(status.cache.persistence, 'sqlite')
  const providers = await accepted(host, 'GET', '/models/providers?search=anthropic')
  assert.deepEqual(providers.map(item => item.source.providerId), ['anthropic'])
  assert.deepEqual(providers[0].connections.map(item => item.values.protocolId), ['anthropic-messages'])
  assert.deepEqual(providers[0].connections[0].values.sourceRef, { sourceId: 'models.dev', providerId: 'anthropic' })
  const active = await accepted(host, 'GET', `/models/definitions?providerId=${encodeURIComponent(providers[0].id)}&search=claude`)
  assert.deepEqual(active.map(item => item.remoteModelId), ['claude-qa'])
  assert.equal(active[0].limits.output, 8192)
  assert.equal(active[0].cost.unit, 'million-tokens')
  assert.deepEqual(active[0].connections.map(item => item.values.protocolId), ['anthropic-messages'])
  const all = await accepted(host, 'GET', `/models/definitions?providerId=${encodeURIComponent(providers[0].id)}&includeDeprecated=true`)
  assert.equal(all.length, 2)
  const unsupported = await accepted(host, 'GET', '/models/providers?search=unsupported')
  assert.deepEqual(unsupported[0].connections, [])
  const google = await accepted(host, 'GET', '/models/providers?search=google')
  assert.deepEqual(google[0].connections.map(item => item.values.protocolId), ['gemini-interactions'])
  assert.equal(google[0].connections[0].values.baseUrl, 'https://generativelanguage.googleapis.com/v1beta')
  assert.equal(host.network.protocol.length, 0)
  assert.deepEqual(host.root.get('models.settings').configuredProviders(), [])
  assert.deepEqual(host.root.get('models.settings').modelSettings(), [])
  for (const path of ['/models/definitions?includeDeprecated=1', '/models/providers?includeMissing=1']) {
    const rejected = await request(host, 'GET', path)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.data.error.code, 'invalid-input')
  }
  assert.equal((await request(host, 'POST', '/models/catalog/refresh', { unsupported: true })).status, 400)
});

test('the provider list shows directory entries and saved custom settings by identity', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  const custom = await accepted(host, 'POST', '/models/providers', { id: 'user-provider-definition', name: 'Anthropic（迁入）',
    connectionHints: { baseUrl: 'https://custom.invalid/v1', protocolIds: ['anthropic-messages'] } })
  const definitions = await accepted(host, 'GET', '/models/providers?includeMissing=true')
  assert.ok(definitions.some(provider => provider.id === custom.id && provider.source.kind === 'user'))
  const directoryNames = ['Anthropic QA', 'Google QA', 'Unsupported QA']
  assert.deepEqual(settingsProviderGroups([], definitions).other.map(provider => provider.name), directoryNames)

  const settings = await accepted(host, 'POST', '/models/provider-settings', { providerId: custom.id,
    name: 'My configured custom provider', enabled: true, protocolId: 'anthropic-messages', baseUrl: 'https://custom.invalid/v1', auth: 'api-key', timeoutMs: 30_000 })
  const existing = await accepted(host, 'GET', '/models/provider-settings')
  assert.deepEqual(settingsProviderSelection(existing, settings.id), settings)
  const beforeEdit = settingsProviderGroups(existing, definitions)
  assert.deepEqual(beforeEdit.configured, [])
  assert.deepEqual(beforeEdit.other.filter(provider => provider.id === custom.id).map(provider => provider.settings), [settings])

  const updated = await accepted(host, 'POST', `/models/provider-settings/${settings.id}`, { patch: { name: 'Renamed custom provider' }, expectedRevision: settings.revision })
  assert.equal(updated.name, 'Renamed custom provider')
  assert.equal(updated.id, custom.id)
  assert.equal(updated.revision, settings.revision + 1)
  const visible = await accepted(host, 'GET', '/models/provider-settings')
  assert.deepEqual(settingsProviderSelection(visible, settings.id), updated)
  const afterEdit = settingsProviderGroups(visible, definitions)
  assert.deepEqual(afterEdit.other.find(provider => provider.id === custom.id)?.settings, updated)
  assert.equal(host.network.protocol.length, 0)
})

test('one configured provider exposes one set of parameters per compatible model', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  const definition = (await accepted(host, 'GET', '/models/providers?search=google')).find(item => item.source.kind === 'external')
  const { sourceRef, ...recipe } = definition.connections[0].values
  const settings = await accepted(host, 'POST', '/models/provider-settings', {
    ...recipe, providerId: definition.id, name: 'Configured Google', apiKey: 'google-private-key',
  })
  assert.equal(settings.id, definition.id)
  assert.equal(settings.sync.state, 'ready')
  const duplicate = await request(host, 'POST', '/models/provider-settings', {
    ...recipe, providerId: definition.id, name: 'Duplicate Google', apiKey: 'duplicate-private-key',
  })
  assert.deepEqual(duplicate, { status: 409, data: { error: { code: 'conflict' } } })
  assert.deepEqual(await accepted(host, 'GET', '/models/provider-settings'), [settings])

  const models = await accepted(host, 'GET', '/models')
  const providerModels = models.filter(model => model.providerId === settings.id)
  assert.equal(providerModels.length, 1)
  assert.equal(providerModels[0].available, true)
  const inventory = await accepted(host, 'GET', `/models/provider-settings/${settings.id}/models`)
  assert.equal(inventory.filter(model => model.state === 'present').length, 2)
  assert.equal(inventory.find(model => model.remoteModelId === 'gemini-image').unavailableReason, 'text-unsupported')
  const runnable = providerModels[0]
  assert.equal(inventory.find(model => model.remoteModelId === 'gemini-qa').runtimeModelId, runnable.id)
  const settingsPath = `/models/settings?providerId=${settings.id}`
  const entries = await accepted(host, 'GET', settingsPath)
  assert.equal(entries.length, 1)
  const [current] = entries
  assert.equal(current.id, runnable.modelDefinitionId)
  assert.equal(current.runtimeModelId, runnable.id)
  const parameters = { protocolId: 'gemini-interactions', formatVersion: 1, value: { generation_config: { max_output_tokens: 8192 } } }
  const second = await request(host, 'POST', '/models/settings', { modelId: current.id, name: 'Duplicate Google settings', enabled: true,
    capabilities: current.capabilities, parameters })
  assert.deepEqual(second, { status: 409, data: { error: { code: 'conflict' } } })

  const session = await selectSession(host, runnable.id)
  const updated = await accepted(host, 'POST', `/models/settings/${current.id}`, { patch: { parameters }, expectedRevision: current.revision })
  assert.equal(updated.runtimeModelId, runnable.id)
  assert.equal(updated.revision, current.revision + 1)
  assert.deepEqual(updated.parameters, parameters)
  const versions = await accepted(host, 'GET', `/models/settings/${current.id}/history`)
  assert.ok(versions.some(version => version.versionId === current.versionId))
  const retried = await accepted(host, 'POST', `/models/provider-settings/${settings.id}/retry`, {})
  assert.equal(retried.sync.state, 'ready')
  assert.deepEqual(await accepted(host, 'GET', settingsPath), [updated])
  assert.equal((await accepted(host, 'GET', `/sessions/${session.id}`)).modelId, runnable.id)
  const result = await run(host, session, 'Hello', 'automatic-model')
  assert.equal(result.run.modelSnapshot.schemaVersion, 3)
  assert.equal(result.run.modelSnapshot.providerDefinitionId, definition.id)
  assert.equal(result.run.modelSnapshot.modelDefinitionId, current.id)
  assert.ok(!JSON.stringify([models, inventory, result.run]).includes('private-key'))
});

test('Web saves an Anthropic proxy and 4096-token model, selects it, streams text, runs Bash and preserves final output', async t => {
  const host = await startCatalogModelsHost(), progress = []
  t.after(() => host.close())
  await host.root.installComponent({ name: 'catalog-native-progress-observer', apply(ctx) { ctx.on(runViewEvent, value => progress.push(value)) } })
  const saved = await saveNative(host, 'anthropic', 'anthropic-messages', 'claude-qa')
  assert.equal(saved.provider.baseUrl, 'https://proxy.qa.invalid/custom/v1')
  assert.equal(saved.provider.id, saved.definition.id)
  assert.equal(saved.definition.source.kind, 'external')
  assert.deepEqual(saved.model.parameters.value, { max_tokens: 4096 })
  assert.equal(host.network.generations.length, 0)
  assert.deepEqual(await accepted(host, 'POST', `/models/provider-settings/${saved.provider.id}/check`, {}), { ok: true })
  assert.equal(host.network.checks.length, 1)
  assert.equal(host.network.generations.length, 0)
  const session = await selectSession(host, saved.model.runtimeModelId)
  const first = await run(host, session, 'Hello native', 'plain-text')
  assert.equal(first.node.output, 'Mock native answer: Hello native')
  const second = await run(host, session, 'Use Bash tool', 'bash-tool', first.node.id)
  assert.equal(second.node.output, 'Mock native final answer: catalog-tool-observed')
  assert.equal(second.run.modelId, saved.model.runtimeModelId)
  assert.equal(second.run.modelSnapshot.parameters.value.max_tokens, 4096)
  const events = await accepted(host, 'GET', `/runs/${second.run.id}/events`)
  assert.ok(events.some(event => event.kind === 'tool-started' && event.name === 'bash'))
  assert.ok(events.some(event => event.kind === 'tool-observed' && event.name === 'bash' && event.stdout === 'catalog-tool-observed'))
  assert.ok(progress.some(value => value.runId === second.run.id && JSON.stringify(value.frame.payload).includes('I will run Bash.')))
  const generated = host.network.generations
  assert.equal(generated.length, 3)
  assert.ok(generated.every(record => record.url === 'https://proxy.qa.invalid/custom/v1/messages' && record.body.max_tokens === 4096 && record.body.stream === true))
  assert.ok(generated.every(record => record.headers['x-api-key'] === 'anthropic-qa-private-key' && record.headers.Authorization === undefined))
  const tool = generated[1].body.messages.find(message => message.role === 'assistant')
  const observation = generated[2].body.messages.at(-1).content.find(block => block.type === 'tool_result')
  assert.equal(observation.tool_use_id, `toolu_qa_2`)
  assert.equal(JSON.parse(observation.content).stdout, 'catalog-tool-observed')
  assert.ok(tool.content.some(block => block.type === 'text' && block.text === 'Mock native answer: Hello native'))
  assert.ok(!JSON.stringify([first.run, second.run, first.node, second.node, events]).includes('qa-private-key'))
});

test('Web runs Gemini Interactions from a selected saved model through native tool IDs and a stateless final answer', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  const saved = await saveNative(host, 'google', 'gemini-interactions', 'gemini-qa')
  const session = await selectSession(host, saved.model.runtimeModelId)
  const result = await run(host, session, 'Use Bash tool', 'gemini-tool')
  assert.equal(result.node.output, 'Mock native final answer: catalog-tool-observed')
  assert.equal(result.run.modelId, saved.model.runtimeModelId)
  assert.equal(host.network.generations.length, 2)
  const [first, second] = host.network.generations
  assert.ok(first.body.input.every(step => step.type !== 'function_result'))
  const toolResult = second.body.input.at(-1)
  assert.equal(toolResult.type, 'function_result')
  assert.equal(toolResult.call_id, 'gemini_native_qa_1')
  assert.equal(JSON.parse(toolResult.result[0].text).stdout, 'catalog-tool-observed')
  for (const record of [first, second]) {
    assert.equal(record.url, 'https://proxy.qa.invalid/custom/v1beta/interactions')
    assert.equal(record.headers['x-goog-api-key'], 'google-qa-private-key')
    assert.equal(record.headers.Authorization, undefined)
    assert.equal(record.body.store, false)
    assert.equal(record.body.stream, true)
    assert.deepEqual(record.body.generation_config, { max_output_tokens: 4096 })
    assert.equal(record.body.previous_interaction_id, undefined)
    assert.equal(record.body.background, undefined)
    assert.equal(record.body.temperature, undefined)
  }
});

test('Web native JSON responses run through the same saved-model and session boundaries', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  const saved = await saveNative(host, 'anthropic', 'anthropic-messages', 'claude-qa', { streaming: false })
  const session = await selectSession(host, saved.model.runtimeModelId)
  const result = await run(host, session, 'Plain JSON answer', 'json-text')
  assert.equal(result.node.output, 'Mock native answer: Plain JSON answer')
  assert.equal(host.network.generations.length, 1)
  assert.equal(host.network.generations[0].body.stream, false)
});

test('Web uses different protocols on one Session path through selection and Run override', async t => {
  const host = await startCatalogModelsHost({ seedModels: true })
  t.after(() => host.close())
  const [anthropic, gemini] = host.seededModels
  const session = await selectSession(host, anthropic.runtimeModelId)
  const first = await run(host, session, 'Hello protocol binding', 'bound')
  const bound = await accepted(host, 'GET', `/sessions/${session.id}`)
  assert.equal(bound.historyMode, 'native-local-v1')
  assert.equal(bound.protocolId, 'anthropic-messages')
  const changed = await accepted(host, 'POST', `/sessions/${session.id}/model`, { modelId: gemini.runtimeModelId })
  const second = await run(host, changed, 'Follow up in Gemini', 'other-protocol', first.node.id)
  assert.equal(second.run.protocolBinding.protocolId, 'gemini-interactions')
  assert.equal(second.node.parentId, first.node.id)
  const overridden = await run(host, changed, 'Follow up in Anthropic', 'override-protocol', second.node.id, anthropic.runtimeModelId)
  assert.equal(overridden.run.protocolBinding.protocolId, 'anthropic-messages')
  assert.equal(overridden.node.parentId, second.node.id)
  assert.equal((await accepted(host, 'GET', `/sessions/${session.id}`)).modelId, gemini.runtimeModelId)
  assert.equal(host.network.generations.length, 3)
  assert.match(JSON.stringify(host.network.generations[1].body.input), /Hello protocol binding/)
  assert.match(JSON.stringify(host.network.generations[2].body.messages), /Follow up in Gemini/)
});

test('Web source removal preserves saved model settings, proxy address, Key and session selection', async t => {
  const host = await startCatalogModelsHost()
  t.after(() => host.close())
  const saved = await saveNative(host, 'anthropic', 'anthropic-messages', 'claude-qa')
  const session = await selectSession(host, saved.model.runtimeModelId)
  const modelSettingsBefore = await accepted(host, 'GET', '/models/settings')
  const vaultReads = host.vaultOperations.filter(item => item.kind === 'read').length
  const data = structuredClone(catalogModelsData)
  delete data.anthropic
  host.setCatalogData(data)
  const refreshed = await accepted(host, 'POST', '/models/catalog/refresh', {})
  assert.equal(refreshed.origin, 'network')
  assert.deepEqual(await accepted(host, 'GET', `/models/definitions?providerId=${encodeURIComponent(saved.definition.id)}`), [])
  const missing = await accepted(host, 'GET', `/models/definitions?providerId=${encodeURIComponent(saved.definition.id)}&includeMissing=true`)
  assert.ok(missing.every(model => model.state === 'missing'))
  assert.deepEqual(await accepted(host, 'GET', '/models/settings'), modelSettingsBefore)
  const definitions = await accepted(host, 'GET', '/models/providers?includeMissing=true')
  assert.equal(definitions.find(value => value.id === saved.provider.id)?.state, 'missing')
  const settings = (await accepted(host, 'GET', '/models/provider-settings')).find(value => value.id === saved.provider.id)
  assert.equal(settings.baseUrl, saved.provider.baseUrl)
  assert.equal(settings.revision, saved.provider.revision)
  assert.equal(settings.credentialConfigured, true)
  assert.equal((await accepted(host, 'GET', `/sessions/${session.id}`)).modelId, saved.model.runtimeModelId)
  assert.equal(host.vaultOperations.filter(item => item.kind === 'read').length, vaultReads)
  assert.equal(host.network.generations.length, 0)
  const result = await run(host, session, 'Still available', 'after-removal')
  assert.equal(result.node.output, 'Mock native answer: Still available')
  assert.equal(result.run.modelSnapshot.schemaVersion, 3)
  assert.equal(result.run.modelSnapshot.modelDefinitionId, saved.candidate.id)
});

test('Web refresh failures retain the prior directory and local settings with sanitized errors', async t => {
  const host = await startCatalogModelsHost({ seedModels: true, seedSession: true })
  t.after(() => host.close())
  const before = await accepted(host, 'GET', '/models/catalog')
  const providers = await accepted(host, 'GET', '/models/provider-settings')
  const models = await accepted(host, 'GET', '/models/settings')
  host.queueCatalogResponse(new Response('private remote diagnostics', { status: 503 }))
  const failure = await request(host, 'POST', '/models/catalog/refresh', {})
  assert.equal(failure.status, 503)
  assert.deepEqual(failure.data, { error: { code: 'unavailable' } })
  const after = await accepted(host, 'GET', '/models/catalog')
  assert.equal(after.snapshotVersion, before.snapshotVersion)
  assert.equal(after.error, 'unavailable')
  assert.deepEqual(await accepted(host, 'GET', '/models/provider-settings'), providers)
  assert.deepEqual(await accepted(host, 'GET', '/models/settings'), models)
  assert.equal((await accepted(host, 'GET', `/sessions/${host.session.id}`)).modelId, host.session.modelId)
  assert.equal(host.network.generations.length, 0)
});

function controlledRefresh(host) {
  const entered = deferred(), cancelled = deferred(), release = deferred()
  host.queueCatalogResponse((_url, init) => new Response(new ReadableStream({
    start() { entered.resolve(init.signal) }, cancel() { cancelled.resolve(); return release.promise },
  })))
  return { entered, cancelled, release }
}

test('Disconnecting a Web refresh aborts its source and waits for reader cancellation before allowing another refresh', { timeout: 15_000 }, async t => {
  const host = await startCatalogModelsHost()
  const before = host.root.get('models.catalog').status(), controlled = controlledRefresh(host), controller = new AbortController()
  t.after(() => { controller.abort(); controlled.release.resolve(); return host.close() })
  const pending = fetch(`${host.web.url}/api/v1/models/catalog/refresh`, { method: 'POST', headers: { Origin: host.web.url, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  const signal = await controlled.entered.promise
  controller.abort()
  await controlled.cancelled.promise
  assert.equal(signal.aborted, true)
  assert.equal(host.root.get('models.catalog').status().refreshing, true)
  await assert.rejects(host.root.get('models.catalog').refresh(), { code: 'busy' })
  controlled.release.resolve()
  await rejected
  await tick()
  const after = host.root.get('models.catalog').status()
  assert.equal(after.refreshing, false)
  assert.equal(after.snapshotVersion, before.snapshotVersion)
  assert.equal((await accepted(host, 'POST', '/models/catalog/refresh', {})).snapshotVersion, before.snapshotVersion)
});

test('Closing the Web host aborts a directory refresh and joins actual HTTP reader exit before deleting owned storage files', { timeout: 15_000 }, async t => {
  const host = await startCatalogModelsHost(), controlled = controlledRefresh(host)
  t.after(() => { controlled.release.resolve(); return host.close() })
  const pending = request(host, 'POST', '/models/catalog/refresh', {}).catch(error => ({ error }))
  let closed = false
  const signal = await controlled.entered.promise
  const closing = host.close().then(() => { closed = true })
  try {
    await controlled.cancelled.promise
    await tick()
    assert.equal(signal.aborted, true)
    assert.equal(closed, false)
    await access(host.config.modelsConfigPath)
    await access(join(host.directory, 'models-catalog.sqlite'))
    await access(join(host.directory, 'harness.sqlite'))
  } finally { controlled.release.resolve(); await closing; await pending }
  assert.equal(closed, true)
  await assert.rejects(access(host.directory), { code: 'ENOENT' })
});

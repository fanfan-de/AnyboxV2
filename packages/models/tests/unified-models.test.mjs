import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js'
import { createAnthropicMessagesProtocol } from '../dist/protocols/anthropic-messages.js'
import { capabilities, deferred, fakeProtocol, fixture, memoryStore, memoryVault, tick } from './helpers.mjs'

const rawModel = (id, extra = {}) => ({ id, name: id, tool_call: true, streaming: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 10000, output: 1000 }, ...extra })
const snapshot = (models = [rawModel('a'), rawModel('b')], time = 1, provider = 'test-provider', npm = '@ai-sdk/openai-compatible') => normalizeModelsDevCatalog({ [provider]: { id: provider, name: 'Same name', api: 'https://example.invalid/v1', npm, models: Object.fromEntries(models.map(model => [model.id, model])) } }, 'models.dev', time)
const account = (provider, id = 'account', extras = {}) => ({ id, providerDefinitionId: provider.id, name: id, enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, apiKey: 'private-key', ...extras })
async function setup(input = snapshot(), protocols = [fakeProtocol('chat-completions')]) {
  const f = await fixture({ protocols }); await f.sourceData.accept(input)
  return { f, provider: f.settings.providers()[0] }
}

test('one connection unlocks all compatible definitions; accounts and variants keep distinct stable selections', async () => {
  const { f, provider } = await setup(snapshot([rawModel('a'), rawModel('b'), rawModel('image', { type: 'image', modalities: { input: ['text'], output: ['image'] } }), rawModel('old', { status: 'deprecated' })]))
  try {
    const connection = await f.settings.createConnection(account(provider))
    assert.equal(connection.sync.state, 'ready'); assert.equal(f.settings.providers().length, 1)
    assert.equal(f.models.list({ available: true }).length, 2)
    assert.ok(f.models.list().every(model => model.source.kind === 'external' && model.connectionId === connection.id && model.providerDefinitionId === provider.id))
    assert.equal(f.vault.reads.length, 0)
    assert.equal(f.settings.connectionModels(connection.id).find(model => model.remoteModelId === 'image').unavailableReason, 'text-unsupported')
    assert.equal(f.settings.connectionModels(connection.id).find(model => model.remoteModelId === 'old').unavailableReason, 'deprecated')
    const saved = f.settings.configurations()[0]
    await f.settings.createConfiguration({ ...Object.fromEntries(['name','enabled','modelDefinitionId','connectionId','capabilities'].map(key => [key, saved[key]])), id: 'variant', baseline: false, defaults: { temperature: 0.9 } })
    await f.settings.createConnection(account(provider, 'second'))
    assert.equal(f.models.list().length, 5)
    const changed = await f.settings.updateConfiguration(saved.id, { name: 'My name', enabled: false, defaults: { temperature: 0.4 } }, saved.revision)
    const source = snapshot([rawModel('a'), rawModel('b'), rawModel('new')], 2)
    await f.sourceData.accept(source); await f.settings.retryConnection(connection.id)
    assert.equal(f.models.list().length, 7)
    assert.deepEqual(f.settings.configurations().find(model => model.id === saved.id), changed)
    assert.equal(f.settings.connections().find(c => c.id === connection.id).revision, connection.revision)
    const fresh = await f.settings.setApiKey(connection.id, 'replacement', connection.revision)
    assert.equal(f.models.list().length, 7)
    await f.settings.deleteApiKey(connection.id, fresh.revision)
    assert.ok(f.models.list({ connectionId: connection.id }).every(model => !model.available))
    assert.ok(f.models.list({ connectionId: 'second' }).every(model => model.available))
  } finally { await f.close() }
})

test('user definitions may belong to external providers; source namespace and names never collapse identities', async () => {
  const { f, provider } = await setup()
  try {
    const sameName = await f.settings.createProvider({ name: provider.name, connectionHints: { protocolIds: ['chat-completions'] } })
    assert.equal(sameName.source.kind, 'user'); assert.notEqual(sameName.id, provider.id)
    const first = f.settings.models()[0]
    const custom = await f.settings.createModel({ name: first.name, providerId: provider.id, remoteModelId: first.remoteModelId, capabilities: capabilities(), controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } })
    assert.equal(custom.source.kind, 'user')
    await f.settings.createConnection(account(provider))
    assert.equal(f.models.list().length, 3)
    const other = normalizeModelsDevCatalog({ p: { id: 'test-provider', name: provider.name, npm: '@ai-sdk/openai-compatible', api: 'https://example.invalid/v1', models: { a: rawModel('a') } } }, 'another.source', 2)
    await f.sourceData.accept(other)
    assert.equal(f.settings.providers().length, 3)
    await assert.rejects(f.settings.updateModel(first.id, { name: 'overwrite' }, first.revision), { code: 'invalid-config' })
    assert.equal(f.settings.models().find(model => model.id === custom.id).source.kind, 'user')
  } finally { await f.close() }
})

test('missing source entries preserve configured versions and in-flight execution snapshots', async () => {
  const { f, provider } = await setup()
  try {
    const connection = await f.settings.createConnection(account(provider))
    const config = f.settings.configurations().find(model => model.remoteModelId === 'a')
    const execution = await f.models.open({ modelId: config.id })
    assert.equal(execution.snapshot.schemaVersion, 2)
    assert.equal(execution.snapshot.modelDefinitionVersionId, config.modelDefinitionVersionId)
    await f.sourceData.accept(snapshot([rawModel('b')], 2))
    assert.equal(f.settings.models({ includeMissing: true }).find(model => model.id === config.modelDefinitionId).state, 'missing')
    assert.equal(f.models.get(config.id).available, true)
    const removed = await f.models.open({ modelId: config.id }); await removed.close()
    await f.settings.setApiKey(connection.id, 'new-private-key', connection.revision)
    await execution.generate({ messages: [{ role: 'user', content: 'still old' }] }).result
    assert.equal(f.protocols[0].calls[0].input.credential, 'private-key')
    assert.equal(execution.snapshot.modelVersionId, config.versionId)
    await execution.close()
  } finally { await f.close() }
})

test('saved key survives atomic model batch failure; retry and restart reconcile idempotently', async () => {
  const store = memoryStore(), vault = memoryVault(), f = await fixture({ store, vault, protocols: [fakeProtocol('chat-completions')] })
  await f.sourceData.accept(snapshot())
  const provider = f.settings.providers()[0], original = store.commit.bind(store)
  let fail = true
  store.commit = change => { if (fail && change.configurations?.length) { fail = false; return Promise.reject(Object.assign(new Error('private failure'), { code: 'storage-unavailable' })) } return original(change) }
  const connection = await f.settings.createConnection(account(provider))
  assert.equal(connection.credentialConfigured, true); assert.equal(connection.sync.state, 'failed')
  assert.equal(f.models.list().length, 0); assert.deepEqual([...vault.secrets.values()], ['private-key'])
  const repaired = await f.settings.retryConnection(connection.id)
  assert.equal(repaired.sync.state, 'ready'); assert.equal(repaired.revision, connection.revision)
  const ids = f.models.list().map(model => model.id).sort(); await f.close()
  const restarted = await fixture({ store, vault, protocols: [fakeProtocol('chat-completions')] })
  try { await restarted.settings.retryConnection(connection.id); assert.deepEqual(restarted.models.list().map(model => model.id).sort(), ids) } finally { await restarted.close() }
})

test('definitions import before protocol installation and registration resumes missing initializations', async () => {
  const { f, provider } = await setup()
  try {
    const connection = await f.settings.createConnection(account(provider))
    await f.registrations[0].unregister()
    await f.sourceData.accept(snapshot([rawModel('a'), rawModel('b'), rawModel('c')], 2))
    assert.equal(f.settings.connections()[0].sync.state, 'pending')
    assert.equal(f.models.list().length, 2)
    const replacement = fakeProtocol('chat-completions', '2'); f.protocols.push(replacement); f.registry.register(replacement)
    await f.settings.retryConnection(connection.id)
    assert.equal(f.models.list({ available: true }).length, 3)
  } finally { await f.close() }
})

test('Anthropic required defaults are saved explicitly and bounded by output limits', async () => {
  const protocol = createAnthropicMessagesProtocol(), data = snapshot([rawModel('claude')], 1, 'anthropic', '@ai-sdk/anthropic')
  const { f, provider } = await setup(data, [protocol])
  try {
    await f.settings.createConnection(account(provider, 'anthropic', { protocolId: 'anthropic-messages' }))
    assert.equal(f.settings.configurations()[0].defaults.maxOutputTokens, 1000)
    assert.equal(f.models.list()[0].effectiveCapabilities.imageInput, false)
  } finally { await f.root.fiber.dispose() }
})

test('source ledger blocks older and ambiguous cache candidates while complete confirmation resolves equal timestamps', async () => {
  const f = await fixture({ protocols: [] })
  try {
    const latest = snapshot([rawModel('new')], 20); await f.sourceData.accept(latest)
    assert.equal((await f.sourceData.accept(snapshot([rawModel('old')], 10))).accepted, false)
    assert.equal((await f.sourceData.accept(snapshot([rawModel('other')], 20))).accepted, false)
    assert.equal(f.sourceData.accepted('models.dev').snapshotVersion, latest.snapshotVersion)
    assert.equal((await f.sourceData.accept(snapshot([rawModel('confirmed')], 20), { confirmed: true })).accepted, true)
    assert.equal(f.settings.models()[0].remoteModelId, 'confirmed')
  } finally { await f.close() }
})

test('source and Key updates serialize configurations; core close waits admitted definition transactions', async () => {
  const { f, provider } = await setup()
  const connection = await f.settings.createConnection(account(provider)), original = f.store.commit.bind(f.store)
  const entered = deferred(), release = deferred(); let hold = true
  f.store.commit = async change => { if (hold && change.providers?.length) { hold = false; entered.resolve(); await release.promise } return original(change) }
  const next = snapshot([rawModel('a'), rawModel('b'), rawModel('c')], 2)
  const refreshing = f.sourceData.accept(next); await entered.promise
  const replacing = f.settings.setApiKey(connection.id, 'rotated', connection.revision)
  let stopped = false; const closing = f.component.dispose().then(() => { stopped = true })
  await tick(); assert.equal(stopped, false); release.resolve()
  await Promise.all([refreshing, replacing, closing])
  assert.equal(f.store.sources()[0].snapshotVersion, next.snapshotVersion)
  assert.equal(f.store.syncState(connection.id).targetSourceVersion, next.snapshotVersion)
  assert.deepEqual([...f.vault.secrets.values()], ['rotated'])
  await f.close()
})

test('a stale admitted baseline batch retries against the latest source target without overwriting it', async () => {
  const { f, provider } = await setup()
  try {
    const connection = await f.settings.createConnection(account(provider))
    const original = f.store.commit.bind(f.store), entered = deferred(), release = deferred(); let hold = true
    f.store.commit = async change => {
      if (hold && change.configurations?.length) { hold = false; entered.resolve(); await release.promise }
      return original(change)
    }
    const earlier = f.sourceData.accept(snapshot([rawModel('a'), rawModel('b'), rawModel('c')], 2))
    await entered.promise
    const latest = snapshot([rawModel('a'), rawModel('b'), rawModel('c'), rawModel('d')], 3)
    const later = f.sourceData.accept(latest)
    await tick()
    assert.equal(f.store.syncState(connection.id).targetSourceVersion, latest.snapshotVersion)
    release.resolve(); await Promise.all([earlier, later])
    assert.equal(f.models.list().length, 4)
    assert.equal(f.store.syncState(connection.id).state, 'ready')
    assert.equal(f.store.syncState(connection.id).syncedSourceVersion, latest.snapshotVersion)
    assert.equal(f.settings.connections()[0].revision, connection.revision)
  } finally { await f.close() }
})

test('offline connection/configuration persistence allows stable bootstrap IDs before protocol registration', async () => {
  const f = await fixture({ protocols: [] })
  try {
    const provider = await f.settings.createProvider({ id: 'imported-provider', name: 'Imported', connectionHints: { protocolIds: ['test'] } })
    const connection = await f.settings.createConnection({ id: 'imported-connection', providerDefinitionId: provider.id, name: 'Imported account', protocolId: 'test', baseUrl: 'https://example.invalid/v1', enabled: true, auth: 'none', timeoutMs: 1000 })
    assert.equal(connection.sync.state, 'pending')
    const definition = await f.settings.createModel({ id: 'imported-definition', name: 'Imported model', providerId: provider.id, remoteModelId: 'remote', capabilities: capabilities(), controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['test'] } })
    const config = await f.settings.createConfiguration({ id: 'default', connectionId: connection.id, modelDefinitionId: definition.id, baseline: true, name: 'Imported', enabled: true, defaults: { temperature: 0.2 }, capabilities: definition.capabilities })
    assert.equal(f.models.get(config.id).unavailableReason, 'protocol-unavailable')
    const protocol = fakeProtocol(); f.protocols.push(protocol); f.registry.register(protocol)
    await f.settings.retryConnection(connection.id)
    assert.deepEqual(f.models.list().map(value => value.id), ['default'])
    const execution = await f.models.open({ modelId: 'default' }); await execution.close()
  } finally { await f.close() }
})

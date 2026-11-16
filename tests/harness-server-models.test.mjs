import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createModelsStoreComponent, createModelsVaultComponent, createModelsComponent, createResponsesProtocolComponent, createChatCompletionsProtocolComponent } from '@anybox/models'
import { installHarnessServerModels as installModels } from '../packages/app-harness/dist/server-models.js'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'

async function openNative(root, modelId = 'default') {
  const model = root.get('models').get(modelId)
  const lease = root.get('models.protocols').acquire(model.parameters.protocolId)
  try {
    const execution = await root.get('models').openNative({ modelId, lease })
    return { snapshot: execution.snapshot, async close() { try { return await execution.close() } finally { lease.release() } } }
  } catch (error) { lease.release(); throw error }
}

const entryKey = (namespace, id) => `${namespace}\0${id}`
const installHarnessServerModels = (root, config, options = {}) => installModels(root, config, {
  catalogAutoRefresh: false,
  catalogFetch: async () => { throw new Error('startup must use the bundled catalog without network access') },
  ...options,
})
const capabilities = { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } }
function memoryKeyring() {
  const values = new Map(), operations = []
  return {
    values, operations,
    openEntry(namespace, id) {
      const key = entryKey(namespace, id)
      return {
        async getPassword() { operations.push({ kind: 'read', namespace, id }); return values.get(key) },
        async setPassword(secret) { operations.push({ kind: 'write', namespace, id }); values.set(key, secret) },
        async deleteCredential() { operations.push({ kind: 'delete', namespace, id }); return values.delete(key) },
      }
    },
  }
}
async function fixture(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-models-startup-'))
  const roots = []
  t.after(async () => {
    for (const root of roots) await root.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ...env })
  return { directory, config, root() { const root = new Context(); roots.push(root); return root } }
}
async function seedProvider(root, config, keyring, input = {}) {
  for (const component of [createModelsStoreComponent({ path: config.modelsDatabasePath }),
    createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry: keyring.openEntry }), createModelsComponent(), createChatCompletionsProtocolComponent(), createResponsesProtocolComponent()]) await root.installComponent(component)
  const settings = root.get('models.settings')
  const provider = { id: 'anybox-imported-default', name: 'Saved connection', enabled: true, protocolId: 'chat-completions',
    baseUrl: 'https://saved.invalid/v1', auth: 'api-key', timeoutMs: 30_000, ...input }
  const definition = await settings.createProvider({ id: `${provider.id}-definition`, name: provider.name, connectionHints: { protocolIds: [provider.protocolId], baseUrl: provider.baseUrl } })
  return settings.createConnection({ ...provider, providerDefinitionId: definition.id })
}
async function seedDefaultModel(root, connection) {
  const settings = root.get('models.settings')
  const definition = await settings.createModel({ id: 'anybox-imported-model', providerId: connection.providerDefinitionId,
    name: 'Saved model definition', remoteModelId: 'saved-remote-model', capabilities,
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [connection.protocolId] } })
  return settings.createConfiguration({ id: 'default', connectionId: connection.id, modelDefinitionId: definition.id, name: 'My saved model',
    enabled: true, baseline: true, capabilities, parameters: { protocolId: connection.protocolId, formatVersion: 1, value: { temperature: 0.3 } } })
}

test('fresh Models startup loads the directory and protocols without connections, configurations or legacy credential access', async t => {
  const f = await fixture(t, { ANYBOX_LLM_API: 'openai-responses', ANYBOX_LLM_MODEL: 'unused-model', ANYBOX_LLM_BASE_URL: 'https://unused.invalid/v1' })
  const keyring = memoryKeyring(), root = f.root(), oldKey = entryKey('anybox', 'llm/openai-responses/default')
  keyring.values.set(oldKey, 'untouched-legacy-private-value')
  await installHarnessServerModels(root, f.config, { openEntry: keyring.openEntry })
  const settings = root.get('models.settings')
  assert.deepEqual(settings.connections(), [])
  assert.deepEqual(settings.configurations(), [])
  assert.deepEqual(root.get('models').list(), [])
  assert.deepEqual(settings.protocols().map(protocol => protocol.id).sort(), ['anthropic-messages', 'chat-completions', 'gemini-interactions', 'responses'])
  assert.ok(settings.providers({ sourceId: 'models.dev' }).some(provider => provider.source.providerId === 'deepseek'))
  assert.ok(settings.models({ sourceId: 'models.dev' }).length > 0)
  assert.equal(settings.providers().some(provider => provider.source.kind === 'user'), false)
  assert.equal(settings.models().some(model => model.source.kind === 'user'), false)
  assert.equal(root.get('models.catalog').status().origin, 'bundled')
  assert.deepEqual(keyring.operations, [])
  assert.equal(keyring.values.get(oldKey), 'untouched-legacy-private-value')
  await root.fiber.dispose()
  const reopened = f.root()
  await installHarnessServerModels(reopened, f.config, { openEntry: keyring.openEntry })
  assert.deepEqual(reopened.get('models.settings').connections(), [])
  assert.deepEqual(reopened.get('models.settings').configurations(), [])
  assert.deepEqual(keyring.operations, [])
  assert.doesNotMatch(await readFile(f.config.modelsConfigPath, 'utf8'), /untouched-legacy-private-value/)
})

test('a models.dev DeepSeek connection is created explicitly and prepares catalog models only after a Key is configured', async t => {
  const f = await fixture(t), root = f.root(), keyring = memoryKeyring()
  await installHarnessServerModels(root, f.config, { openEntry: keyring.openEntry })
  const settings = root.get('models.settings')
  const definition = settings.providers({ sourceId: 'models.dev' }).find(provider => provider.source.providerId === 'deepseek')
  const connection = await settings.createConnection({ providerDefinitionId: definition.id, id: 'explicit-deepseek', name: 'DeepSeek', enabled: true,
    protocolId: 'chat-completions', baseUrl: 'https://api.deepseek.com', auth: 'api-key', timeoutMs: 30_000 })
  assert.equal(connection.credentialConfigured, false)
  assert.equal(connection.sync.state, 'pending')
  assert.deepEqual(settings.configurations(), [])
  const saved = await settings.setApiKey(connection.id, 'explicit-deepseek-private-value', connection.revision)
  assert.equal(saved.credentialConfigured, true)
  assert.equal(saved.sync.state, 'ready')
  const models = settings.configurations(connection.id)
  assert.ok(models.length > 0)
  for (const model of models) {
    const source = settings.models({ providerId: definition.id }).find(value => value.id === model.modelDefinitionId).source
    assert.equal(source.kind, 'external')
    assert.equal(source.sourceId, 'models.dev')
    assert.equal(source.providerId, 'deepseek')
    assert.equal(model.baseline, true)
  }
  assert.equal(settings.connections().length, 1)
  assert.equal(settings.configurations().some(model => model.id === 'default'), false)
  const execution = await openNative(root, models[0].id)
  await execution.close()
  assert.doesNotMatch(await readFile(f.config.modelsConfigPath, 'utf8'), /explicit-deepseek-private-value/)
})

test('deleting the last explicit connection stays empty after restart without recreating a default', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const connection = await seedProvider(first, f.config, keyring, { apiKey: 'saved-private-value' })
  await seedDefaultModel(first, connection)
  await first.fiber.dispose()
  const second = f.root()
  await installHarnessServerModels(second, f.config, { openEntry: keyring.openEntry })
  const settings = second.get('models.settings'), imported = settings.connections()[0]
  await settings.deleteConnection(imported.id, imported.revision)
  assert.deepEqual(settings.connections(), [])
  assert.deepEqual(settings.configurations(), [])
  assert.equal(keyring.values.size, 0)
  await second.fiber.dispose()
  const third = f.root()
  await installHarnessServerModels(third, f.config, { openEntry: keyring.openEntry })
  assert.deepEqual(third.get('models.settings').connections(), [])
  assert.deepEqual(third.get('models').list(), [])
  assert.equal(third.get('models.settings').connectionHistory(connection.id).length, 1)
  assert.equal(third.get('models.settings').configurationHistory('default').length, 1)
})

test('existing SQLite connection, Key and stable default configuration remain usable without being rewritten on startup', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const connection = await seedProvider(first, f.config, keyring, { name: 'Committed import', apiKey: 'already-copied-private-value' })
  const original = await seedDefaultModel(first, connection)
  await first.fiber.dispose()
  const second = f.root()
  await installHarnessServerModels(second, f.config, { openEntry: keyring.openEntry })
  const settings = second.get('models.settings')
  await access(f.config.modelsDatabasePath)
  assert.deepEqual(settings.connections(), [connection])
  assert.deepEqual(settings.configurations(), [original])
  assert.equal(second.get('models').get('default').available, true)
  const execution = await openNative(second)
  const visible = JSON.stringify([settings.connections(), settings.configurations(), settings.connectionHistory(connection.id), execution.snapshot])
  assert.doesNotMatch(visible, /already-copied-private-value|credentialRef/)
  await execution.close()
  assert.doesNotMatch(await readFile(f.config.modelsConfigPath, 'utf8'), /already-copied-private-value/)
  assert.equal(keyring.operations.filter(operation => operation.kind === 'write').length, 1)
})

test('editable JSON capability changes retain configuration identity, parameters, Key and revision history across restarts', async t => {
  const f = await fixture(t), keyring = memoryKeyring(), seed = f.root()
  const connection = await seedProvider(seed, f.config, keyring, { protocolId: 'responses', apiKey: 'private-json-test-key' })
  await seedDefaultModel(seed, connection)
  await seed.fiber.dispose()
  const first = f.root()
  await installHarnessServerModels(first, f.config, { openEntry: keyring.openEntry })
  const before = first.get('models.settings').configurations().find(model => model.id === 'default')
  await first.fiber.dispose()
  const document = JSON.parse(await readFile(f.config.modelsConfigPath, 'utf8'))
  const edited = document.configurations.find(model => model.id === 'default')
  edited.capabilities.reasoning = { support: 'supported', efforts: ['low', 'high'] }
  await writeFile(f.config.modelsConfigPath, JSON.stringify(document, null, 2) + '\n')
  const second = f.root()
  await installHarnessServerModels(second, f.config, { openEntry: keyring.openEntry })
  const after = second.get('models.settings').configurations().find(model => model.id === 'default')
  assert.deepEqual(after.capabilities.reasoning, edited.capabilities.reasoning)
  assert.equal(after.revision, before.revision + 1)
  assert.deepEqual(after.parameters, before.parameters)
  assert.equal(after.modelDefinitionVersionId, before.modelDefinitionVersionId)
  const history = second.get('models.settings').configurationHistory('default')
  assert.deepEqual(history.at(-2), before)
  assert.deepEqual(history.at(-1), after)
  assert.equal(second.get('models.settings').connections()[0].credentialConfigured, true)
  assert.equal(keyring.operations.filter(operation => operation.kind === 'write').length, 1)
  assert.doesNotMatch(await readFile(f.config.modelsConfigPath, 'utf8'), /private-json-test-key/)
  await second.fiber.dispose()
  const third = f.root()
  await installHarnessServerModels(third, f.config, { openEntry: keyring.openEntry })
  assert.equal(third.get('models.settings').configurations().find(model => model.id === 'default').revision, after.revision)
})

for (const id of ['anybox-imported-default', 'user-managed']) test(`startup preserves the existing ${id} connection without inventing a missing model`, async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const connection = await seedProvider(first, f.config, keyring, { id, name: 'Saved partial connection', apiKey: 'saved-partial-key' })
  await first.fiber.dispose()
  const second = f.root()
  await installHarnessServerModels(second, f.config, { openEntry: keyring.openEntry })
  const settings = second.get('models.settings')
  assert.deepEqual(settings.connections(), [connection])
  assert.deepEqual(settings.configurations(), [])
  assert.equal(settings.models({ providerId: connection.providerDefinitionId }).length, 0)
  assert.deepEqual([...keyring.values.values()], ['saved-partial-key'])
})

for (const hasKey of [false, true]) test(`a saved partial import with a model definition ${hasKey ? 'uses normal baseline synchronization' : 'and no Key remains incomplete'} without an invented default`, async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const connection = await seedProvider(first, f.config, keyring, hasKey ? { apiKey: 'saved-partial-definition-key' } : {})
  const definition = await first.get('models.settings').createModel({ id: 'anybox-imported-model', providerId: connection.providerDefinitionId,
    name: 'Saved partial definition', remoteModelId: 'saved-remote-model', capabilities,
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [connection.protocolId] } })
  await first.fiber.dispose()
  const second = f.root()
  await installHarnessServerModels(second, f.config, { openEntry: keyring.openEntry })
  const settings = second.get('models.settings')
  const configurations = settings.configurations()
  if (hasKey) {
    assert.equal(configurations.length, 1)
    assert.equal(configurations[0].modelDefinitionId, definition.id)
    assert.equal(configurations[0].remoteModelId, definition.remoteModelId)
    assert.equal(configurations[0].baseline, true)
    assert.notEqual(configurations[0].id, 'default')
  } else assert.deepEqual(configurations, [])
  assert.deepEqual(settings.models({ providerId: connection.providerDefinitionId }), [definition])
  assert.equal(settings.connections()[0].credentialConfigured, hasKey)
  if (!hasKey) assert.deepEqual(keyring.operations, [])
})

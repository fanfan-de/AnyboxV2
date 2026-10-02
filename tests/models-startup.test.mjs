import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createModelsStoreComponent, createModelsVaultComponent, createModelsComponent, createResponsesProtocolComponent } from '@anybox/models'
import { createDeepSeekProtocolComponent } from '../dist/applications/harness/deepseek-protocol.js'
import { installWebModels as installModels } from '../dist/applications/harness/models-startup.js'
import { parseWebStartupConfig } from '../dist/applications/harness/startup-config.js'


async function openNative(root, modelId = 'default') {
  const model = root.get('models').get(modelId)
  const lease = root.get('models.protocols').acquire(model.parameters.protocolId)
  try {
    const execution = await root.get('models').openNative({ modelId, lease })
    return { snapshot: execution.snapshot, async close() { try { return await execution.close() } finally { lease.release() } } }
  } catch (error) { lease.release(); throw error }
}

const entryKey = (namespace, id) => `${namespace}\0${id}`
const installWebModels = (root, config, options = {}) => installModels(root, config, { catalogAutoRefresh: false, ...options })
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
  const config = parseWebStartupConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ...env })
  return { directory, config, root() { const root = new Context(); roots.push(root); return root } }
}
async function seedProvider(root, config, keyring, provider) {
  for (const component of [createModelsStoreComponent({ path: config.modelsDatabasePath }),
    createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry: keyring.openEntry }), createModelsComponent(), createDeepSeekProtocolComponent(), createResponsesProtocolComponent()]) await root.installComponent(component)
  const settings = root.get('models.settings')
  const definition = await settings.createProvider({ id: `${provider.id}-definition`, name: provider.name, connectionHints: { protocolIds: [provider.protocolId], baseUrl: provider.baseUrl } })
  return settings.createConnection({ ...provider, providerDefinitionId: definition.id })
}

test('deleting all connections stays empty after restart without reimporting legacy credentials or default models', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring();
  let reads = 0;
  const options = { openEntry: keyring.openEntry, readLegacyCredential: async () => { reads++; return 'legacy-private-key'; } };
  await installWebModels(first, f.config, options);
  const settings = first.get('models.settings'), connection = settings.connections()[0];
  await settings.deleteConnection(connection.id, connection.revision);
  assert.deepEqual(settings.connections(), []); assert.deepEqual(settings.configurations(), []);
  assert.equal(keyring.values.size, 0);
  await first.fiber.dispose();
  const second = f.root(), result = await installWebModels(second, f.config, options);
  assert.deepEqual(result, {}); assert.equal(reads, 1);
  assert.deepEqual(second.get('models.settings').connections(), []); assert.deepEqual(second.get('models').list(), []);
  assert.equal(second.get('models.settings').connectionHistory(connection.id).length, 1);
  assert.equal(second.get('models.settings').configurationHistory('default').length, 1);
});

test('An unavailable legacy credential store still opens Models configuration with an explicit missing-key state', async t => {
  const f = await fixture(t), root = f.root(), keyring = memoryKeyring()
  await installWebModels(root, f.config, { openEntry: keyring.openEntry,
    readLegacyCredential: async () => { throw new Error('legacy failure contains private details') } })
  const settings = root.get('models.settings')
  assert.equal(settings.connections()[0].credentialConfigured, false)
  assert.equal(root.get('models').get('default').unavailableReason, 'credential-missing')
  assert.equal(settings.configurations().length, 1)
  assert.equal(settings.protocols().length, 5)
})

test('A failed new-vault write keeps editable provider/model metadata and sanitized failure state', async t => {
  const f = await fixture(t), root = f.root()
  await installWebModels(root, f.config, {
    readLegacyCredential: async () => 'private-import-value',
    openEntry: () => ({ async getPassword() { throw new Error('private-import-value') },
      async setPassword() { throw new Error('private-import-value') }, async deleteCredential() { return false } }),
  })
  const settings = root.get('models.settings')
  assert.equal(settings.connections().length, 1)
  assert.equal(settings.connections()[0].credentialConfigured, false)
  assert.equal(settings.configurations().length, 1)
  assert.ok(!JSON.stringify(settings.connections()).includes('private-import-value'))
  await assert.rejects(openNative(root), { code: 'credential-missing' })
})

test('Interrupted bootstrap creates only its missing model and preserves the committed provider/key', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const provider = await seedProvider(first, f.config, keyring, { ...f.config.legacy.provider,
    id: 'anybox-imported-default', name: 'Committed import', baseUrl: 'http://saved.invalid/api', apiKey: 'already-copied-private-value' })
  await first.fiber.dispose()
  const second = f.root()
  let reads = 0
  await installWebModels(second, f.config, { openEntry: keyring.openEntry,
    readLegacyCredential: async () => { reads++; throw new Error('old entry should not be read') } })
  assert.equal(reads, 0)
  const settings = second.get('models.settings')
  assert.deepEqual(settings.protocols().map(protocol => protocol.id).sort(), ['anthropic-messages', 'chat-completions', 'deepseek-chat-completions', 'gemini-interactions', 'responses'])
  const execution = await openNative(second)
  const visible = JSON.stringify([settings.connections(), settings.configurations(), settings.connectionHistory(provider.id), execution.snapshot])
  assert.ok(!visible.includes('already-copied-private-value'))
  assert.ok(!visible.includes('credentialRef'))
  await execution.close()
  assert.deepEqual(second.get('models.settings').connections(), [provider])
  assert.equal(second.get('models.settings').configurations()[0].connectionId, provider.id)
  assert.equal(second.get('models').get('default').available, true)
})

test('An existing user-managed provider with no models is not mistaken for an interrupted import', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const provider = await seedProvider(first, f.config, keyring, { ...f.config.legacy.provider, id: 'user-managed', name: 'User connection' })
  await first.fiber.dispose()
  const second = f.root()
  const result = await installWebModels(second, f.config, { openEntry: keyring.openEntry,
    readLegacyCredential: async () => { throw new Error('old entry should not be read') } })
  assert.deepEqual(result, {})
  assert.deepEqual(second.get('models.settings').connections(), [provider])
  assert.deepEqual(second.get('models.settings').configurations(), [])
})

test('The default legacy-vault adapter only reads the old namespace and copies into the Models namespace', async t => {
  const f = await fixture(t), root = f.root(), keyring = memoryKeyring()
  const legacyId = 'llm/deepseek-chat-completions/default'
  keyring.values.set(entryKey('anybox', legacyId), 'legacy-copy-value')
  await installWebModels(root, f.config, { openEntry: keyring.openEntry })
  assert.deepEqual(keyring.operations.filter(operation => operation.namespace === 'anybox'), [{ kind: 'read', namespace: 'anybox', id: legacyId }])
  assert.equal(keyring.values.get(entryKey('anybox', legacyId)), 'legacy-copy-value')
  assert.equal(keyring.operations.filter(operation => operation.namespace === f.config.credentialNamespace && operation.kind === 'write').length, 1)
  assert.equal(root.get('models.settings').connections()[0].credentialConfigured, true)
})

test('Partial import with a different protocol keeps its provider without inventing a model from changed environment defaults', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const provider = await seedProvider(first, f.config, keyring, { ...f.config.legacy.provider,
    id: 'anybox-imported-default', name: 'Original Responses import', protocolId: 'responses',
    baseUrl: 'https://saved.invalid/v1', apiKey: 'committed-response-key' })
  await first.fiber.dispose()
  const second = f.root()
  let legacyReads = 0
  const result = await installWebModels(second, f.config, { openEntry: keyring.openEntry,
    readLegacyCredential: async () => { legacyReads++; return 'new-environment-key' } })
  assert.deepEqual(result, {})
  assert.equal(legacyReads, 0)
  assert.deepEqual(second.get('models.settings').connections(), [provider])
  assert.deepEqual(second.get('models.settings').configurations(), [])
  assert.deepEqual([...keyring.values.values()], ['committed-response-key'])
})


test('Interrupted bootstrap after its model definition preserves the stable default configuration ID on restart', async t => {
  const f = await fixture(t), first = f.root(), keyring = memoryKeyring()
  const connection = await seedProvider(first, f.config, keyring, { ...f.config.legacy.provider,
    id: 'anybox-imported-default', name: 'Committed import', apiKey: 'committed-import-key' })
  const definition = await first.get('models.settings').createModel({ id: 'anybox-imported-model', providerId: connection.providerDefinitionId,
    name: 'Saved default definition', remoteModelId: f.config.legacy.remoteModelId,
    capabilities: { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unsupported' } },
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [connection.protocolId] } })
  assert.deepEqual(first.get('models.settings').configurations(), [])
  await first.fiber.dispose()
  const second = f.root()
  const result = await installWebModels(second, f.config, { openEntry: keyring.openEntry,
    readLegacyCredential: async () => { throw new Error('committed Key must be preserved') } })
  assert.deepEqual(result, { defaultModelId: 'default' })
  const configurations = second.get('models.settings').configurations()
  assert.equal(configurations.length, 1)
  assert.equal(configurations[0].id, 'default')
  assert.equal(configurations[0].modelDefinitionId, definition.id)
  assert.equal(configurations[0].connectionId, connection.id)
  assert.equal(configurations[0].baseline, true)
  const execution = await openNative(second)
  await execution.close()
  assert.deepEqual([...keyring.values.values()], ['committed-import-key'])
})

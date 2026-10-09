import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { parseHarnessServerConfig } from '../dist/applications/harness/server-config.js'
import { installHarnessServerModels } from '../dist/applications/harness/server-models.js'

test('harness server startup separates persistent Models storage from the one-time legacy import', () => {
  const config = parseHarnessServerConfig({})
  assert.equal(config.port, 0)
  assert.equal(config.harnessDatabasePath, './data/harness.sqlite')
  assert.equal(config.imageAssetsDirectory, './data/harness.sqlite.images')
  assert.equal(config.modelsDatabasePath, './data/models.sqlite')
  assert.equal(config.modelsConfigPath, './data/models.json')
  assert.equal(config.modelsCatalogDatabasePath, 'data/models-catalog.sqlite')
  assert.equal(config.credentialNamespace, 'anybox.models')
  assert.equal(config.legacy.provider.protocolId, 'chat-completions')
  assert.equal(config.legacy.remoteModelId, 'deepseek-flash')
  assert.deepEqual(config.legacy.parameters.value, {})
  assert.equal(config.legacy.credentialId, 'llm/chat-completions/default')
})

test('Responses initial import requires a model and preserves unspecified API defaults', () => {
  const config = parseHarnessServerConfig({ ANYBOX_LLM_API: 'openai-responses', ANYBOX_LLM_MODEL: 'responses-model' })
  assert.equal(config.legacy.provider.protocolId, 'responses')
  assert.equal(config.legacy.remoteModelId, 'responses-model')
  assert.deepEqual(config.legacy.parameters.value, {})
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_LLM_API: 'openai-responses' }), /ANYBOX_LLM_MODEL/)
})

test('harness server startup accepts explicit import parameters, data locations and vault namespace', () => {
  for (const api of ['chat-completions', 'openai-responses']) {
    const env = Object.freeze({ ANYBOX_LLM_API: api, ANYBOX_LLM_MODEL: ' compatible-model ', ANYBOX_LLM_BASE_URL: ' https://models.example/v1/ ',
      ANYBOX_LLM_TIMEOUT_MS: '60000', ANYBOX_LLM_MAX_OUTPUT_TOKENS: '8192', ANYBOX_LLM_TEMPERATURE: '0', ANYBOX_WEB_PORT: '8080',
      ANYBOX_HARNESS_DATABASE: '/tmp/harness.sqlite', ANYBOX_MODELS_DATABASE: '/tmp/models.sqlite', ANYBOX_MODELS_NAMESPACE: 'test.models' })
    const config = parseHarnessServerConfig(env)
    assert.equal(config.port, 8080)
    assert.equal(config.legacy.provider.baseUrl, 'https://models.example/v1/')
    assert.equal(config.legacy.provider.timeoutMs, 60000)
    assert.deepEqual(config.legacy.parameters.value, { [api === 'openai-responses' ? 'max_output_tokens' : 'max_completion_tokens']: 8192, temperature: 0 })
    assert.equal(config.legacy.remoteModelId, 'compatible-model')
    assert.equal(config.credentialNamespace, 'test.models')
    assert.equal(env.ANYBOX_LLM_MODEL, ' compatible-model ')
  }
})

test('harness server validates startup configuration before installing resources', () => {
  const invalid = {
    ANYBOX_LLM_API: ['', ' ', 'unknown', 'responses', 'deepseek-chat-completions'], ANYBOX_LLM_MODEL: ['', ' '],
    ANYBOX_LLM_BASE_URL: ['', 'invalid', 'file:///tmp/model', 'https://models.example/v1?token=secret', 'https://models.example/v1#responses', 'https://user:secret@models.example/v1'],
    ANYBOX_LLM_TIMEOUT_MS: ['', '0', '-1', '1.5', 'Infinity', 'NaN', '2147483648'],
    ANYBOX_LLM_MAX_OUTPUT_TOKENS: ['', '0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992'],
    ANYBOX_LLM_TEMPERATURE: ['', '-0.1', '2.1', 'Infinity', 'NaN'], ANYBOX_WEB_PORT: ['', '-1', '65536', '1.5', 'NaN'],
    ANYBOX_HARNESS_PORT: ['', '-1', '65536', '1.5', 'NaN'],
    ANYBOX_IMAGE_ASSETS_DIRECTORY: ['', ' ', '\0'], ANYBOX_MODELS_DATABASE: ['', ' '], ANYBOX_MODELS_CONFIG: ['', ' ', '\0'], ANYBOX_MODELS_CATALOG_DATABASE: ['', ' '], ANYBOX_MODELS_NAMESPACE: ['', '\0'], ANYBOX_HARNESS_DATABASE: ['', ' '],
  }
  for (const [name, values] of Object.entries(invalid)) for (const value of values) assert.throws(() => parseHarnessServerConfig({ [name]: value }), new RegExp(name))
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_DATABASE: './same.sqlite', ANYBOX_HARNESS_DATABASE: './same.sqlite' }), /different files/)
  for (const path of ['./data/models.sqlite', './data/harness.sqlite']) assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CATALOG_DATABASE: path }), /must be different/)
  for (const path of ['./data/models.sqlite', './data/harness.sqlite']) assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CONFIG: path }), /must be different/)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CATALOG_DATABASE: './data/models.json' }), /must be different/)
  assert.equal(parseHarnessServerConfig({ ANYBOX_MODELS_DATABASE: '/tmp/custom.sqlite' }).modelsConfigPath, '/tmp/custom.json')
  assert.equal(parseHarnessServerConfig({ ANYBOX_MODELS_CONFIG: '/tmp/edited-models.json' }).modelsConfigPath, '/tmp/edited-models.json')
  assert.equal(parseHarnessServerConfig({ ANYBOX_LLM_TIMEOUT_MS: '2147483647' }).legacy.provider.timeoutMs, 2147483647)
})

test('harness server port takes precedence while the previous web port remains readable', () => {
  assert.equal(parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '3001', ANYBOX_WEB_PORT: '3000' }).port, 3001)
  assert.equal(parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_WEB_PORT: '3000' }).port, 0)
  assert.equal(parseHarnessServerConfig({ ANYBOX_WEB_PORT: '3000' }).port, 3000)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '', ANYBOX_WEB_PORT: '3000' }), /ANYBOX_HARNESS_PORT/)
})

test('Models bootstrap imports the old key once and never overwrites user configuration on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-models-bootstrap-')), secrets = new Map()
  const config = parseHarnessServerConfig({ ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite') })
  let reads = 0, root = new Context()
  const options = {
    catalogAutoRefresh: false,
    readLegacyCredential: async id => { reads++; assert.equal(id, 'llm/chat-completions/default'); return 'legacy-private-key' },
    openEntry(namespace, id) { const key = `${namespace}/${id}`; return { async getPassword() { return secrets.get(key) }, async setPassword(value) { secrets.set(key, value) }, async deleteCredential() { return secrets.delete(key) } } },
  }
  try {
    assert.deepEqual(await installHarnessServerModels(root, config, options), { defaultModelId: 'default' })
    const settings = root.get('models.settings')
    assert.equal(settings.protocols().length, 4)
    assert.equal(settings.connections()[0].credentialConfigured, true)
    const original = settings.configurations()[0]
    await settings.updateConfiguration(original.id, { name: 'My model', parameters: { protocolId: original.parameters.protocolId, formatVersion: 1, value: { temperature: 0.3 } } }, original.revision)
    const provider = settings.connections()[0]
    await settings.setApiKey(provider.id, 'new-private-key', provider.revision)
    await root.fiber.dispose(); root = new Context()
    await installHarnessServerModels(root, { ...config, legacy: { ...config.legacy, remoteModelId: 'changed-environment' } }, options)
    assert.equal(reads, 1)
    assert.equal(root.get('models.settings').configurations()[0].name, 'My model')
    assert.equal(root.get('models.settings').configurations()[0].remoteModelId, original.remoteModelId)
    assert.deepEqual(root.get('models.settings').configurations()[0].parameters.value, { temperature: 0.3 })
    assert.deepEqual([...secrets.values()], ['new-private-key'])
    assert.doesNotMatch(readFileSync(config.modelsConfigPath).toString('utf8'), /legacy-private-key|new-private-key/)
  } finally { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

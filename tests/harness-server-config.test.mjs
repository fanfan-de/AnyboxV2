import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'

test('harness server startup configures persistent Models storage without an initial model import', () => {
  const config = parseHarnessServerConfig({})
  assert.equal(config.port, 0)
  assert.equal(config.harnessDatabasePath, './data/harness.sqlite')
  assert.equal(config.imageAssetsDirectory, './data/harness.sqlite.images')
  assert.equal(config.modelsDatabasePath, './data/models.sqlite')
  assert.equal(config.modelsConfigPath, './data/models.json')
  assert.equal(config.modelsCatalogDatabasePath, join('data', 'models-catalog.sqlite'))
  assert.equal(config.credentialNamespace, 'anybox.models')
  assert.equal('legacy' in config, false)
})

test('retired ANYBOX_LLM environment settings do not define connections or block startup', () => {
  const env = Object.freeze({ ANYBOX_LLM_API: 'deepseek-chat-completions', ANYBOX_LLM_MODEL: ' ',
    ANYBOX_LLM_BASE_URL: 'not-a-url', ANYBOX_LLM_TIMEOUT_MS: '-1', ANYBOX_LLM_MAX_OUTPUT_TOKENS: 'invalid',
    ANYBOX_LLM_TEMPERATURE: 'Infinity' })
  assert.deepEqual(parseHarnessServerConfig(env), parseHarnessServerConfig({}))
  assert.equal(env.ANYBOX_LLM_MODEL, ' ')
  assert.deepEqual(parseHarnessServerConfig({ ANYBOX_LLM_API: 'openai-responses' }), parseHarnessServerConfig({}))
})

test('harness server startup accepts explicit data locations and vault namespace', () => {
  const env = Object.freeze({ ANYBOX_WEB_PORT: '8080', ANYBOX_HARNESS_DATABASE: '/tmp/harness.sqlite',
    ANYBOX_IMAGE_ASSETS_DIRECTORY: '/tmp/images', ANYBOX_MODELS_DATABASE: '/tmp/models.sqlite',
    ANYBOX_MODELS_CONFIG: '/tmp/config/models.json', ANYBOX_MODELS_CATALOG_DATABASE: '/tmp/catalog.sqlite', ANYBOX_MODELS_NAMESPACE: 'test.models' })
  const config = parseHarnessServerConfig(env)
  assert.equal(config.port, 8080)
  assert.equal(config.harnessDatabasePath, '/tmp/harness.sqlite')
  assert.equal(config.imageAssetsDirectory, '/tmp/images')
  assert.equal(config.modelsDatabasePath, '/tmp/models.sqlite')
  assert.equal(config.modelsConfigPath, '/tmp/config/models.json')
  assert.equal(config.modelsCatalogDatabasePath, '/tmp/catalog.sqlite')
  assert.equal(config.credentialNamespace, 'test.models')
})

test('harness server validates active startup configuration before installing resources', () => {
  const invalid = {
    ANYBOX_WEB_PORT: ['', '-1', '65536', '1.5', 'NaN'], ANYBOX_HARNESS_PORT: ['', '-1', '65536', '1.5', 'NaN'],
    ANYBOX_IMAGE_ASSETS_DIRECTORY: ['', ' ', '\0'], ANYBOX_MODELS_DATABASE: ['', ' '], ANYBOX_MODELS_CONFIG: ['', ' ', '\0'],
    ANYBOX_MODELS_CATALOG_DATABASE: ['', ' '], ANYBOX_MODELS_NAMESPACE: ['', '\0'], ANYBOX_HARNESS_DATABASE: ['', ' '],
  }
  for (const [name, values] of Object.entries(invalid)) for (const value of values) assert.throws(() => parseHarnessServerConfig({ [name]: value }), new RegExp(name))
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_DATABASE: './same.sqlite', ANYBOX_HARNESS_DATABASE: './same.sqlite' }), /different files/)
  for (const path of ['./data/models.sqlite', './data/harness.sqlite']) assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CATALOG_DATABASE: path }), /must be different/)
  for (const path of ['./data/models.sqlite', './data/harness.sqlite']) assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CONFIG: path }), /must be different/)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_MODELS_CATALOG_DATABASE: './data/models.json' }), /must be different/)
  assert.equal(parseHarnessServerConfig({ ANYBOX_MODELS_DATABASE: '/tmp/custom.sqlite' }).modelsConfigPath, '/tmp/custom.json')
  assert.equal(parseHarnessServerConfig({ ANYBOX_MODELS_CONFIG: '/tmp/edited-models.json' }).modelsConfigPath, '/tmp/edited-models.json')
})

test('harness server port takes precedence while the previous web port remains readable', () => {
  assert.equal(parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '3001', ANYBOX_WEB_PORT: '3000' }).port, 3001)
  assert.equal(parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_WEB_PORT: '3000' }).port, 0)
  assert.equal(parseHarnessServerConfig({ ANYBOX_WEB_PORT: '3000' }).port, 3000)
  assert.throws(() => parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '', ANYBOX_WEB_PORT: '3000' }), /ANYBOX_HARNESS_PORT/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { harnessDefinition } from '@anybox/app-harness/definition'
import { parseHarnessServerConfig } from '@anybox/app-harness/server-config'
import { harnessAssets } from '@anybox/app-harness/assets'

test('the independent Harness package keeps application identity and resolves every browser asset', async () => {
  assert.equal(harnessDefinition.id, 'agent')
  assert.equal(new Set(harnessAssets.map(asset => asset.path)).size, harnessAssets.length)
  await Promise.all(harnessAssets.map(asset => access(asset.file)))
  const template = harnessAssets.find(asset => asset.path === '/apps/agent/template.html')
  assert.match(await readFile(template.file, 'utf8'), /agent-product-template/)
})

test('source packaging preserves existing configured data and credential locations', () => {
  const defaults = parseHarnessServerConfig({})
  assert.equal(defaults.harnessDatabasePath, './data/harness.sqlite')
  assert.equal(defaults.modelsDatabasePath, './data/models.sqlite')
  assert.equal(defaults.modelsConfigPath, './data/models.json')
  assert.equal(defaults.credentialNamespace, 'anybox.models')
  const configured = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: '/existing/harness.db', ANYBOX_MODELS_DATABASE: '/existing/models.db', ANYBOX_MODELS_NAMESPACE: 'existing.models' })
  assert.equal(configured.harnessDatabasePath, '/existing/harness.db')
  assert.equal(configured.imageAssetsDirectory, '/existing/harness.db.images')
  assert.equal(configured.modelsConfigPath, '/existing/models.json')
  assert.equal(configured.credentialNamespace, 'existing.models')
})

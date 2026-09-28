import { join } from 'node:path'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createModelsDevCatalogSourceComponent, createModelsCatalogCacheComponent, createModelsCatalogComponent, normalizeModelsDevCatalog } from '@anybox/models'
import { controlledModels } from './controlled-models.mjs'

/** Actual module storage, settings and executions with controllable protocol resources. */
export async function installManagedModels(root, directory, { controlled = controlledModels(), secrets = new Map() } = {}) {
  await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite') }))
  const vaultFiber = root.installComponent(createModelsVaultComponent({ namespace: 'models-test', openEntry(_namespace, id) {
    return { async getPassword() { return secrets.get(id) }, async setPassword(value) { secrets.set(id, value) }, async deleteCredential() { return secrets.delete(id) } }
  } }))
  await vaultFiber
  const installRuntime = async () => {
    const fiber = root.installComponent(createModelsComponent()); await fiber
    root.get('models.protocols').register(controlled.protocol())
    return { apiFiber: fiber }
  }
  const { apiFiber } = await installRuntime()
  const directoryData = { test: { id: 'test', name: 'Test catalog', api: 'https://example.invalid/v1', npm: '@ai-sdk/openai-compatible',
    models: { text: { id: 'catalog-text', name: 'Catalog text model', tool_call: true, streaming: true, reasoning: false,
      modalities: { input: ['text'], output: ['text'] }, limit: { context: 8192, output: 4096 }, cost: { input: 1, output: 2 } } } } }
  await root.installComponent(createModelsDevCatalogSourceComponent({ fetch: async () => new Response(JSON.stringify(directoryData), { headers: { etag: 'test-directory' } }) }))
  await root.installComponent(createModelsCatalogCacheComponent({ path: join(directory, 'models-catalog.sqlite') }))
  await root.installComponent(createModelsCatalogComponent({ autoRefresh: false, bundledSnapshot: normalizeModelsDevCatalog(directoryData) }))
  const settings = root.get('models.settings')
  const declarations = { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'supported' } }
  if (!settings.connections().length) {
    const provider = await settings.createProvider({ id: 'default-provider-definition', name: 'Test service', connectionHints: { baseUrl: 'https://example.invalid/v1', protocolIds: ['controlled'] } })
    const connection = await settings.createConnection({ id: 'default', providerDefinitionId: provider.id, name: 'Test service', enabled: true, protocolId: 'controlled', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 30000 })
    const model = await settings.createModel({ id: 'default-model-definition', name: 'Test model', providerId: provider.id, remoteModelId: 'remote-test', capabilities: declarations,
      controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['controlled'], baseUrl: connection.baseUrl } })
    await settings.createConfiguration({ id: 'default', name: 'Test model', enabled: true, connectionId: connection.id, modelDefinitionId: model.id, capabilities: declarations, defaults: {}, baseline: true })
  }
  return { controlled, secrets, apiFiber, vaultFiber, installRuntime }
}

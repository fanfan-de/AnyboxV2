import { Context, FiberState } from '@nya/core'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import {
  builtinProviderTemplates, createModelsStoreComponent, createModelsVaultComponent, createModelsComponent, isModelsError,
  createResponsesProtocolComponent, createChatCompletionsProtocolComponent, modelsSettingsServiceKey,
  createAnthropicMessagesProtocolComponent, createGeminiInteractionsProtocolComponent,
  createModelsDevCatalogSourceComponent, createModelsCatalogCacheComponent, createModelsCatalogComponent,
} from '@anybox/models'
import type { ModelsSettingsService, ModelsVaultOptions, ProviderTemplate, ProtocolOptions } from '@anybox/models'
import type { WebStartupConfig } from './startup-config.js'
import { createDeepSeekProtocolComponent } from './deepseek-protocol.js'

export const webProviderTemplates: readonly ProviderTemplate[] = Object.freeze([
  Object.freeze({ id: 'deepseek', name: 'DeepSeek 非推理', values: Object.freeze({ enabled: true, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'deepseek' }),
    protocolId: 'deepseek-chat-completions', baseUrl: 'https://api.deepseek.com', auth: 'api-key' as const, timeoutMs: 30_000 }) }),
  ...builtinProviderTemplates,
])
export interface WebModelsOptions extends ProtocolOptions {
  readonly openEntry?: ModelsVaultOptions['openEntry']
  readonly readLegacyCredential?: (credentialId: string) => Promise<string | undefined>
  readonly catalogFetch?: typeof globalThis.fetch
  readonly catalogAutoRefresh?: boolean
}

/** Finite, trusted startup assembly. Nya owns all installed resource lifetimes. */
export async function installWebModels(root: Context, config: WebStartupConfig, options: WebModelsOptions = {}): Promise<{ readonly defaultModelId?: string }> {
  const install = async (components: readonly Parameters<Context['installComponent']>[0][]) => {
    for (const component of components) {
      const fiber = root.installComponent(component)
      await fiber
      if (fiber.state !== FiberState.ACTIVE) throw new Error('Models startup failed')
    }
  }
  await install([
    createModelsStoreComponent({ path: config.modelsDatabasePath }),
    createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry: options.openEntry }),
    createModelsComponent(),
  ])
  const settings = root.get<ModelsSettingsService>(modelsSettingsServiceKey)!
  const connections = settings.connections()
  const importedConnectionId = 'anybox-imported-default'
  // Only our interrupted bootstrap can be completed from the legacy environment.
  const partial = connections.length === 1 && connections[0].id === importedConnectionId && settings.configurations().length === 0
  const recoverable = !partial || connections[0].protocolId === config.legacy.provider.protocolId
  // Retained history and user model definitions distinguish intentional deletion from first use.
  const empty = connections.length === 0 && settings.connectionHistory(importedConnectionId).length === 0 &&
    !settings.models({ includeMissing: true }).some(model => model.source.kind === 'user')
  if (empty || partial && recoverable) {
    let secret: string | undefined
    if (!partial) {
      try {
        if (options.readLegacyCredential) secret = await options.readLegacyCredential(config.legacy.credentialId)
        else {
          const legacy = createSystemKeyringStore({ namespace: 'anybox', openEntry: options.openEntry })
          try { secret = await legacy.read(config.legacy.credentialId) } finally { await legacy.close() }
        }
      } catch { /* Old credentials may be unavailable while editable metadata remains useful. */ }
    }
    if (!partial) {
      const definitionId = 'anybox-imported-provider'
      if (!settings.providers({ includeMissing: true }).some(provider => provider.id === definitionId)) {
        await settings.createProvider({ id: definitionId, name: config.legacy.provider.name,
          connectionHints: { baseUrl: config.legacy.provider.baseUrl, protocolIds: [config.legacy.provider.protocolId] } })
      }
      const input = { ...config.legacy.provider, providerDefinitionId: definitionId, id: importedConnectionId }
      try { await settings.createConnection({ ...input, ...(secret ? { apiKey: secret } : {}) }) }
      catch (error) {
        if (!secret || settings.connections().length || !isModelsError(error) || error.code !== 'credential-unavailable') throw error
        await settings.createConnection(input)
      }
      secret = undefined
    }
    const connection = settings.connections().find(connection => connection.id === importedConnectionId)!
    const definitionId = 'anybox-imported-model'
    let definition = settings.models({ providerId: connection.providerDefinitionId, includeMissing: true }).find(model => model.id === definitionId)
    if (!definition) {
      definition = await settings.createModel({ id: definitionId, name: '默认模型（迁入）', providerId: connection.providerDefinitionId,
        remoteModelId: config.legacy.remoteModelId,
        capabilities: { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' },
          reasoning: { support: connection.protocolId === 'deepseek-chat-completions' ? 'unsupported' : 'unknown' } },
        controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {},
        connectionHints: { baseUrl: connection.baseUrl, protocolIds: [connection.protocolId] },
      })
    }
    if (!settings.configurations().some(model => model.id === 'default')) {
      await settings.createConfiguration({ id: 'default', name: '默认模型（迁入）', connectionId: connection.id,
        modelDefinitionId: definition.id, enabled: true, baseline: true, defaults: config.legacy.defaults, capabilities: definition.capabilities })
    }
  }
  // Bootstrap persists the stable default ID before protocol registration can
  // reconcile missing baselines after an interrupted definition/config write.
  await install([
    createResponsesProtocolComponent({ fetch: options.fetch }),
    createChatCompletionsProtocolComponent({ fetch: options.fetch }),
    createDeepSeekProtocolComponent({ fetch: options.fetch }),
    createAnthropicMessagesProtocolComponent({ fetch: options.fetch }),
    createGeminiInteractionsProtocolComponent({ fetch: options.fetch }),
    createModelsDevCatalogSourceComponent({ fetch: options.catalogFetch }),
    createModelsCatalogCacheComponent({ path: config.modelsCatalogDatabasePath, reservedPaths: [config.modelsDatabasePath, config.harnessDatabasePath] }),
    createModelsCatalogComponent({ autoRefresh: options.catalogAutoRefresh }),
  ])
  return Object.freeze(settings.configurations().some(model => model.id === 'default') ? { defaultModelId: 'default' } : {})
}

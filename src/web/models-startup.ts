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
  Object.freeze({ id: 'deepseek', name: 'DeepSeek 非推理', values: Object.freeze({ enabled: true,
    protocolId: 'deepseek-chat-completions', baseUrl: 'https://api.deepseek.com', auth: 'api-key' as const, timeoutMs: 30_000,
    catalogRef: Object.freeze({ sourceId: 'models.dev', providerId: 'deepseek' }) }) }),
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
  for (const component of [
    createModelsStoreComponent({ path: config.modelsDatabasePath }),
    createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry: options.openEntry }),
    createModelsComponent(),
    createResponsesProtocolComponent({ fetch: options.fetch }),
    createChatCompletionsProtocolComponent({ fetch: options.fetch }),
    createDeepSeekProtocolComponent({ fetch: options.fetch }),
    createAnthropicMessagesProtocolComponent({ fetch: options.fetch }),
    createGeminiInteractionsProtocolComponent({ fetch: options.fetch }),
    createModelsDevCatalogSourceComponent({ fetch: options.catalogFetch }),
    createModelsCatalogCacheComponent({ path: config.modelsCatalogDatabasePath, reservedPaths: [config.modelsDatabasePath, config.harnessDatabasePath] }),
    createModelsCatalogComponent({ autoRefresh: options.catalogAutoRefresh }),
  ]) {
    const fiber = root.installComponent(component)
    await fiber
    if (fiber.state !== FiberState.ACTIVE) throw new Error('Models startup failed')
  }
  const settings = root.get<ModelsSettingsService>(modelsSettingsServiceKey)!
  const providers = settings.providers()
  const importedProviderId = 'anybox-imported-default'
  // Recognize only our own interrupted bootstrap; never overwrite user-managed configuration.
  const partial = providers.length === 1 && providers[0].id === importedProviderId && settings.models().length === 0
  // A changed startup template cannot recover the original model selection. Keep
  // the committed connection available in settings for explicit configuration.
  if (partial && providers[0].protocolId !== config.legacy.provider.protocolId) return Object.freeze({})
  if (providers.length === 0 || partial) {
    let secret: string | undefined
    if (!partial) {
      try {
        if (options.readLegacyCredential) secret = await options.readLegacyCredential(config.legacy.credentialId)
        else {
          const legacy = createSystemKeyringStore({ namespace: 'anybox', openEntry: options.openEntry })
          try { secret = await legacy.read(config.legacy.credentialId) } finally { await legacy.close() }
        }
      } catch { /* An unavailable old vault must not prevent opening Web settings. */ }
    }
    if (!partial) {
      // Writes go through the module's journal; metadata remains usable if the vault is unavailable.
      try { await settings.createProvider({ ...config.legacy.provider, id: importedProviderId, ...(secret ? { apiKey: secret } : {}) }) }
      catch (error) {
        if (!secret || settings.providers().length || !isModelsError(error) || error.code !== 'credential-unavailable') throw error
        await settings.createProvider({ ...config.legacy.provider, id: importedProviderId })
      }
      secret = undefined
    }
    const provider = settings.providers().find(provider => provider.id === importedProviderId)!
    await settings.createModel({ id: 'default', name: '默认模型（迁入）', providerId: importedProviderId, enabled: true,
      remoteModelId: config.legacy.remoteModelId, defaults: config.legacy.defaults,
      capabilities: { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' },
        reasoning: { support: provider.protocolId === 'deepseek-chat-completions' ? 'unsupported' : 'unknown' } },
    })
  }
  return Object.freeze(settings.models().some(model => model.id === 'default') ? { defaultModelId: 'default' } : {})
}

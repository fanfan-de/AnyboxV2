import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import {
  builtinProviderTemplates, createModelsJsonStoreComponent, createModelsVaultComponent, createModelsComponent,
  createResponsesProtocolComponent, createChatCompletionsProtocolComponent,
  createAnthropicMessagesProtocolComponent, createGeminiInteractionsProtocolComponent,
  createModelsDevCatalogSourceComponent, createModelsCatalogCacheComponent, createModelsCatalogComponent,
} from '@anybox/models'
import type { ModelsVaultOptions, ProviderTemplate, ProtocolOptions } from '@anybox/models'
import type { HarnessServerConfig } from './server-config.js'

export const harnessServerProviderTemplates: readonly ProviderTemplate[] = Object.freeze([
  Object.freeze({ id: 'deepseek', name: 'DeepSeek · Chat Completions', values: Object.freeze({ enabled: true, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'deepseek' }),
    protocolId: 'chat-completions', baseUrl: 'https://api.deepseek.com', auth: 'api-key' as const, timeoutMs: 30_000 }) }),
  ...builtinProviderTemplates,
])
export interface HarnessServerModelsOptions extends ProtocolOptions {
  readonly openEntry?: ModelsVaultOptions['openEntry']
  readonly catalogFetch?: typeof globalThis.fetch
  readonly catalogAutoRefresh?: boolean
}

/** Finite, trusted startup assembly. Nya owns all installed resource lifetimes. */
export async function installHarnessServerModels(root: Context, config: HarnessServerConfig, options: HarnessServerModelsOptions = {}, installed?: (fiber: Fiber) => void, serviceBindings: Readonly<Record<string, string>> = {}): Promise<void> {
  const install = async (components: readonly Parameters<Context['installComponent']>[0][]) => {
    for (const component of components) {
      const fiber = root.installComponent(component, undefined, { bindings: serviceBindings })
      installed?.(fiber)
      await fiber
      if (fiber.state !== FiberState.ACTIVE) throw new Error('Models startup failed')
    }
  }
  await install([
    createModelsJsonStoreComponent({ path: config.modelsConfigPath, legacyPath: config.modelsDatabasePath,
      reservedPaths: [config.harnessDatabasePath, config.modelsCatalogDatabasePath] }),
    createModelsVaultComponent({ namespace: config.credentialNamespace, openEntry: options.openEntry }),
    createModelsComponent({ requireManagedTools: true }),
    createResponsesProtocolComponent({ fetch: options.fetch }),
    createChatCompletionsProtocolComponent({ fetch: options.fetch }),
    createAnthropicMessagesProtocolComponent({ fetch: options.fetch }),
    createGeminiInteractionsProtocolComponent({ fetch: options.fetch }),
    createModelsDevCatalogSourceComponent({ fetch: options.catalogFetch }),
    createModelsCatalogCacheComponent({ path: config.modelsCatalogDatabasePath, reservedPaths: [config.modelsConfigPath, config.modelsDatabasePath, config.harnessDatabasePath] }),
    createModelsCatalogComponent({ autoRefresh: options.catalogAutoRefresh }),
  ])
}

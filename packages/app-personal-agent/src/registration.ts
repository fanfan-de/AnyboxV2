import { dirname, join, resolve } from 'node:path'
import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import type { ModelsVaultOptions, ProtocolOptions } from '@anybox/models'
import { personalAgentAssets, personalAgentAssetPrefix } from './assets.js'
import { personalAgentAdmissionServiceKey, personalAgentHttpServiceKey } from './contracts.js'
import type { PersonalAgentAdmissionPort } from './contracts.js'

export interface PersonalAgentOptions extends ProtocolOptions {
  /** Host-owned business path is used only to locate the separate Models configuration. */
  readonly databasePath?: string
  readonly modelsPath?: string
  readonly namespace?: string
  readonly openEntry?: ModelsVaultOptions['openEntry']
}
export const personalAgentId = 'personal-agent'

/** Local application runtime. Preparation declares resources without opening business or credentials. */
export function personalAgentApplication(options: PersonalAgentOptions = {}): ApplicationRegistration {
  const databasePath = options.databasePath ?? process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
  const modelsPath = options.modelsPath ?? process.env.ANYBOX_PERSONAL_AGENT_MODELS_CONFIG ?? join(dirname(resolve(databasePath)), 'personal-agent-models.json')
  return {
    definition: {
      id: personalAgentId, name: 'Personal Agent', icon: 'sparkles',
      description: '配置自己的 Agent，交流、推进独立任务并整理成果。',
      web: { entry: `${personalAgentAssetPrefix}/web/app.js`, styles: [`${personalAgentAssetPrefix}/style.css`] },
    },
    capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' } },
    assets: personalAgentAssets,
    http: { service: personalAgentHttpServiceKey },
    createRuntime: root => createApplicationRuntime(root, async installation => {
      const [models, { createPersonalAgentComponent }, { createPersonalAgentHttpComponent }] = await Promise.all([
        import('@anybox/models'), import('./core/component.js'), import('./http.js'),
      ])
      const { createModelsJsonStoreComponent, createModelsVaultComponent, createModelsComponent,
        createChatCompletionsProtocolComponent, createResponsesProtocolComponent,
        createAnthropicMessagesProtocolComponent, createGeminiInteractionsProtocolComponent } = models
      installation.install(createModelsJsonStoreComponent({ path: modelsPath, reservedPaths: [databasePath] }))
      installation.install(createModelsVaultComponent({ namespace: options.namespace ?? 'anybox.personal-agent.models', openEntry: options.openEntry }))
      installation.install(createModelsComponent())
      installation.install(createChatCompletionsProtocolComponent({ fetch: options.fetch }))
      installation.install(createResponsesProtocolComponent({ fetch: options.fetch }))
      installation.install(createAnthropicMessagesProtocolComponent({ fetch: options.fetch }))
      installation.install(createGeminiInteractionsProtocolComponent({ fetch: options.fetch }))
      installation.install(createPersonalAgentComponent())
      installation.install(createPersonalAgentHttpComponent())
    }, () => root.get<PersonalAgentAdmissionPort>(personalAgentAdmissionServiceKey)?.closeAdmission()),
  }
}

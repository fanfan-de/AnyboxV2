import type { Context } from '@nya/core'
import { modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsSettingsService } from '@anybox/models'
import { createHarnessServerAgentComponents, validateComputerEnvironmentOptions } from './core/index.js'
import type { HarnessServerCoreOptions } from './core/index.js'
import type { AgentDefinition } from './core/agent/domain.js'
import { createImageAssetsComponent } from './core/image/component.js'
import { runAdmissionServiceKey } from './core/run/component.js'
import type { RunAdmissionPort } from './core/run/component.js'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import type { ApplicationInstallation } from '@anybox/application-api/nya'
import { installHarnessServerModels } from './server-models.js'
import type { HarnessServerModelsOptions } from './server-models.js'
import type { HarnessServerConfig } from './server-config.js'
import { createHarnessServerHttpComponent } from './http/harness-http.js'
import type { HarnessServerHttpIntegration, HarnessServerHttpIntegrationSource } from './http/harness-http.js'
export interface HarnessServerRuntimeOptions extends Omit<HarnessServerCoreOptions, 'agents'> {
  readonly agents?: readonly AgentDefinition[]
  readonly models?: HarnessServerModelsOptions
  readonly projects?: readonly string[]
  readonly authenticated?: boolean
}
/** Optional Anybox integration; business assembly does not require host services. */
export interface HarnessServerRuntimeIntegration {
  readonly serviceBindings?: Readonly<Record<string, string>>
  readonly installStorage?: (installation: ApplicationInstallation) => void
  readonly registerStopGuard?: (guard: () => (() => void) | undefined) => (() => void)
  readonly http?: HarnessServerHttpIntegrationSource | (() => HarnessServerHttpIntegration)
}
export function createHarnessServerRuntime(root: Context, config: HarnessServerConfig, options: HarnessServerRuntimeOptions = {}, integration: HarnessServerRuntimeIntegration = {}) {
  validateComputerEnvironmentOptions(options)
  const definitions = options.agents ?? [{ id: 'assistant', instructions: 'You are a helpful assistant.' }]
  const service = <T>(key: string) => root.get<T>(integration.serviceBindings?.[key] ?? key)
  return createApplicationRuntime(root, async installation => {
    integration.installStorage?.(installation)
    if (integration.registerStopGuard) installation.effect(() => integration.registerStopGuard!(() => {
      const admission = service<RunAdmissionPort>(runAdmissionServiceKey)
      return admission ? admission.pauseIfIdle() : () => {}
    }), 'unregister Personal Agent stop protection')
    await installHarnessServerModels(root, config, options.models, installation.track, installation.serviceBindings)
    const hasDefault = service<ModelsSettingsService>(modelsSettingsServiceKey)?.modelSettings().some(model => model.runtimeModelId === 'default') ?? false
    const serverCoreOptions: HarnessServerCoreOptions = { ...options, serviceBindings: integration.serviceBindings, localWorkerDirectory: options.localWorkerDirectory ?? `${config.harnessDatabasePath}.computer-worker`, initialProjects: options.projects ?? options.initialProjects,
      agentWorkspacesDirectory: options.agentWorkspacesDirectory ?? `${config.harnessDatabasePath}.workspaces`,
      agents: options.agents ?? definitions.map(agent => ({ ...agent, ...(hasDefault ? { modelId: 'default' } : {}) })) }
    for (const component of [createImageAssetsComponent({ directory: config.imageAssetsDirectory }),
      ...createHarnessServerAgentComponents(root, serverCoreOptions, installation), createHarnessServerHttpComponent(root, integration.http)]) installation.install(component)
  }, () => service<RunAdmissionPort>(runAdmissionServiceKey)?.closeAdmission(), integration.serviceBindings)
}

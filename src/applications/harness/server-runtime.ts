import type { Context } from '@nya/core'
import { modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsSettingsService } from '@anybox/models'
import { createHarnessServerAgentComponents, createHarnessServerPromptComponents } from './core/index.js'
import type { HarnessServerCoreOptions } from './core/index.js'
import type { AgentDefinition } from './core/agent/domain.js'
import { createImageAssetsComponent } from './core/image/component.js'
import { runAdmissionServiceKey } from './core/run/component.js'
import type { RunAdmissionPort } from './core/run/component.js'
import { productActivityServiceKey } from '../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../host/applications/contracts.js'
import { createApplicationRuntime } from '../../host/applications/runtime.js'
import { installHarnessServerModels } from './server-models.js'
import type { HarnessServerModelsOptions } from './server-models.js'
import type { HarnessServerConfig } from './server-config.js'
import { createHarnessServerHttpComponent } from './http/harness-http.js'
export interface HarnessServerRuntimeOptions extends Omit<HarnessServerCoreOptions, 'agents'> {
  readonly agents?: readonly AgentDefinition[]
  readonly models?: HarnessServerModelsOptions
  readonly projects?: readonly string[]
  readonly authenticated?: boolean
}
export function createHarnessServerRuntime(root: Context, config: HarnessServerConfig, options: HarnessServerRuntimeOptions = {}) {
  const definitions = options.agents ?? [{ id: 'assistant', instructions: 'You are a helpful assistant.' }]
  return createApplicationRuntime(root, async installation => {
    installation.effect(() => root.get<ProductActivityPort>(productActivityServiceKey)!.registerGuard('agent', () => {
      const admission = root.get<RunAdmissionPort>(runAdmissionServiceKey)
      return admission ? admission.pauseIfIdle() : () => {}
    }), 'unregister harness server stop protection')
    await installHarnessServerModels(root, config, options.models, installation.track)
    const hasDefault = root.get<ModelsSettingsService>(modelsSettingsServiceKey)?.configurations().some(model => model.id === 'default') ?? false
    const serverCoreOptions: HarnessServerCoreOptions = { ...options, localWorkerDirectory: options.localWorkerDirectory ?? `${config.harnessDatabasePath}.computer-worker`, initialProjects: options.projects ?? options.initialProjects,
      agents: options.agents ?? definitions.map(agent => ({ ...agent, ...(hasDefault ? { modelId: 'default' } : {}) })) }
    for (const component of [...createHarnessServerPromptComponents(serverCoreOptions), createImageAssetsComponent({ directory: config.imageAssetsDirectory }),
      ...createHarnessServerAgentComponents(root, serverCoreOptions, installation), createHarnessServerHttpComponent(root, definitions, { authenticated: options.authenticated ?? true })]) installation.install(component)
  }, () => root.get<RunAdmissionPort>(runAdmissionServiceKey)?.closeAdmission())
}

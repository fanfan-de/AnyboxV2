import type { Context } from '@nya/core'
import { modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsSettingsService } from '@anybox/models'
import { createHarnessAgentComponents, createHarnessPromptComponents } from './core/index.js'
import type { HarnessOptions } from './core/index.js'
import type { AgentDefinition } from './core/agent/domain.js'
import { createImageAssetsComponent } from './core/image/component.js'
import { runAdmissionServiceKey } from './core/run/component.js'
import type { RunAdmissionPort } from './core/run/component.js'
import { productActivityServiceKey } from '../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../host/applications/contracts.js'
import { createApplicationRuntime } from '../../host/applications/runtime.js'
import { installWebModels } from './models-startup.js'
import type { WebModelsOptions } from './models-startup.js'
import type { WebStartupConfig } from './startup-config.js'
import { createHarnessHttpComponent } from './http/harness-http.js'
export interface HarnessRuntimeOptions extends Omit<HarnessOptions, 'agents'> {
  readonly agents?: readonly AgentDefinition[]
  readonly models?: WebModelsOptions
  readonly projects?: readonly string[]
  readonly authenticated?: boolean
}
export function createHarnessRuntime(root: Context, config: WebStartupConfig, options: HarnessRuntimeOptions = {}) {
  const definitions = options.agents ?? [{ id: 'assistant', instructions: 'You are a helpful assistant.' }]
  return createApplicationRuntime(root, async installation => {
    installation.effect(() => root.get<ProductActivityPort>(productActivityServiceKey)!.registerGuard('agent', () => {
      const admission = root.get<RunAdmissionPort>(runAdmissionServiceKey)
      return admission ? admission.pauseIfIdle() : () => {}
    }), 'unregister Harness stop protection')
    await installWebModels(root, config, options.models, installation.track)
    const hasDefault = root.get<ModelsSettingsService>(modelsSettingsServiceKey)?.configurations().some(model => model.id === 'default') ?? false
    const harnessOptions: HarnessOptions = { ...options, initialProjects: options.projects ?? options.initialProjects,
      agents: options.agents ?? definitions.map(agent => ({ ...agent, ...(hasDefault ? { modelId: 'default' } : {}) })) }
    for (const component of [...createHarnessPromptComponents(harnessOptions), createImageAssetsComponent({ directory: config.imageAssetsDirectory }),
      ...createHarnessAgentComponents(root, harnessOptions, installation), createHarnessHttpComponent(root, definitions, { authenticated: options.authenticated ?? true })]) installation.install(component)
  }, () => root.get<RunAdmissionPort>(runAdmissionServiceKey)?.closeAdmission())
}

import type { Component } from '@nya/core'
import type { ApplicationRegistration } from '../../host/applications/registration.js'
import { createApplicationRuntime } from '../../host/applications/runtime.js'
import { productActivityServiceKey } from '../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../host/applications/contracts.js'
import type { ClaudeAgentConfig } from './config.js'
import { claudeAgentDefinition, claudeAgentId, claudeAgentServerHttp } from './definition.js'
import { createClaudeAgentStoreComponent } from './core/store/component.js'
import { createClaudeAgentSdkComponent } from './core/sdk/adapter.js'
import type { ClaudeAgentSdkOptions } from './core/sdk/adapter.js'
import { claudeAgentRunAdmissionServiceKey, createClaudeAgentRunsComponent } from './core/runs/component.js'
import type { ClaudeAgentRunAdmissionPort, ClaudeAgentRunsOptions } from './core/runs/component.js'
import { createClaudeAgentHttpComponent } from './http/component.js'

export interface ClaudeAgentServerOptions {
  readonly sdk?: Partial<ClaudeAgentSdkOptions>
  readonly runs?: ClaudeAgentRunsOptions
  /** Test seam: a replacement adapter component providing `claude-agent.sdk`. */
  readonly sdkComponent?: Component.Object<void>
}
/** Execution-side registration: index store, SDK adapter, runs and the HTTP adapter, installed when the product is opened. */
export function claudeAgentServerApplication(config: ClaudeAgentConfig, options: ClaudeAgentServerOptions = {}): ApplicationRegistration {
  return { definition: claudeAgentDefinition, http: claudeAgentServerHttp, createRuntime: root => createApplicationRuntime(root, installation => {
    // Stopping the application waits for idle; active Runs refuse the stop until they have exited.
    installation.effect(() => root.get<ProductActivityPort>(productActivityServiceKey)!.registerGuard(claudeAgentId, () => {
      const admission = root.get<ClaudeAgentRunAdmissionPort>(claudeAgentRunAdmissionServiceKey)
      return admission ? admission.pauseIfIdle() : () => {}
    }), 'unregister Claude Agent stop protection')
    for (const component of [createClaudeAgentStoreComponent(), options.sdkComponent ?? createClaudeAgentSdkComponent({ executableOverride: config.executableOverride, ...options.sdk }),
      createClaudeAgentRunsComponent(options.runs), createClaudeAgentHttpComponent(root)]) installation.install(component)
  }, () => root.get<ClaudeAgentRunAdmissionPort>(claudeAgentRunAdmissionServiceKey)?.closeAdmission()) }
}

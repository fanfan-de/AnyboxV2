import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { productActivityServiceKey } from '@anybox/application-api/contracts'
import type { ProductActivityPort } from '@anybox/application-api/contracts'
import type { ClaudeAgentConfig } from './config.js'
import { claudeAgentDefinition, claudeAgentId, claudeAgentServerHttp } from './definition.js'
import { claudeAgentRunAdmissionServiceKey } from './core/runs/component.js'
import type { ClaudeAgentRunAdmissionPort } from './core/runs/component.js'
import { installClaudeAgentBusiness } from './server-runtime.js'
import type { ClaudeAgentServerOptions } from './server-runtime.js'
import { createClaudeAgentLocalExecutionChannel } from './local-execution/component.js'
export type { ClaudeAgentServerOptions } from './server-runtime.js'

/** Execution-side registration: index store, SDK adapter, runs and the HTTP adapter, installed when the product is opened. */
export function claudeAgentServerApplication(config: ClaudeAgentConfig, options: ClaudeAgentServerOptions = {}): ApplicationRegistration {
  return { capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' } }, definition: claudeAgentDefinition, http: claudeAgentServerHttp, channel: createClaudeAgentLocalExecutionChannel(), createRuntime: root => createApplicationRuntime(root, installation => {
    // Stopping the application waits for idle; active Runs refuse the stop until they have exited.
    installation.effect(() => root.get<ProductActivityPort>(productActivityServiceKey)!.registerGuard(claudeAgentId, () => {
      const admission = root.get<ClaudeAgentRunAdmissionPort>(claudeAgentRunAdmissionServiceKey)
      return admission ? admission.pauseIfIdle() : () => {}
    }), 'unregister Claude Agent stop protection')
    installClaudeAgentBusiness(root, installation, config, options)
  }, () => root.get<ClaudeAgentRunAdmissionPort>(claudeAgentRunAdmissionServiceKey)?.closeAdmission()) }
}

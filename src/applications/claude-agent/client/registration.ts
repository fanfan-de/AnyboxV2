import type { ApplicationRegistration } from '../../../host/applications/registration.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
import { claudeAgentClientHttp, claudeAgentDefinition } from '../definition.js'
import { createClaudeAgentGatewayComponent } from './gateway.js'

export interface ClaudeAgentClientOptions {
  /** Instance confirmed by the launcher as this machine's execution host; marks the local device in the browser. */
  readonly localInstanceId?: string
}
/** Client-side registration: only the gateway over the host connection library. Execution code is never loaded here. */
export function claudeAgentClientApplication(options: ClaudeAgentClientOptions = {}): ApplicationRegistration {
  return { definition: claudeAgentDefinition, http: claudeAgentClientHttp,
    createRuntime: root => createApplicationRuntime(root, installation => { installation.install(createClaudeAgentGatewayComponent(options)) }) }
}

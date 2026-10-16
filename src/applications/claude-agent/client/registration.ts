import type { ApplicationRegistration } from '../../../host/applications/registration.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
import { claudeAgentClientHttp, claudeAgentDefinition } from '../definition.js'
import { claudeAgentAssets } from './assets.js'
import { createClaudeAgentGatewayComponent } from './gateway.js'

export interface ClaudeAgentClientOptions {
  /** Instance confirmed by the launcher as this machine's execution host; marks the local device in the browser. */
  readonly localInstanceId?: string
}
/** Client-side registration: the browser entry plus the gateway over the host connection library. Execution code is never loaded here. */
export function claudeAgentClientApplication(options: ClaudeAgentClientOptions = {}): ApplicationRegistration {
  return { definition: { ...claudeAgentDefinition, web: { entry: '/applications/claude-agent/web/app.js', styles: ['/apps/claude-agent/style.css'] } }, http: claudeAgentClientHttp, assets: claudeAgentAssets,
    createRuntime: root => createApplicationRuntime(root, installation => { installation.install(createClaudeAgentGatewayComponent(options)) }) }
}

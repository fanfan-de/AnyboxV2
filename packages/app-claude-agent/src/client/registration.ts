import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { claudeAgentClientHttp, claudeAgentDefinition } from '../definition.js'
import { claudeAgentAssets } from './assets.js'
import { createClaudeAgentGatewayComponent } from './gateway.js'
import { createConnectionsComponent } from './connections.js'
import type { ClientConnectionsOptions } from './connections.js'
import { directoryPickerCapabilityId } from '@anybox/directory-picker'
import type { LocalChannel } from './local-execution.js'

export interface ClaudeAgentClientOptions extends ClientConnectionsOptions {
  /** Instance confirmed by the launcher as this machine's execution host; marks the local device in the browser. */
  readonly localInstanceId?: string
  /** Private same-application transport supplied by a managed role launcher. */
  readonly localChannel?: LocalChannel
}
/** Claude Agent owns its connections, credentials and gateway. Execution code is never loaded here. */
export function claudeAgentClientApplication(options: ClaudeAgentClientOptions = {}): ApplicationRegistration {
  return { capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' }, optional: { 'system.directory-picker': '^1.0.0' } }, definition: { ...claudeAgentDefinition, web: { entry: '/applications/claude-agent/web/app.js', styles: ['/apps/claude-agent/style.css'] } }, http: claudeAgentClientHttp, assets: claudeAgentAssets,
    createRuntime: (root, context) => createApplicationRuntime(root, installation => {
      installation.install(createConnectionsComponent(options.localChannel ? { ...options, localPairing: undefined } : options))
      installation.install(createClaudeAgentGatewayComponent(options, !!context?.capabilities[directoryPickerCapabilityId]))
    }) }
}

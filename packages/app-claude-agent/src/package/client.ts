import { claudeAgentClientApplication } from '../client/registration.js'
import type { ClaudeAgentClientOptions } from '../client/registration.js'
import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'

/** Pure package preparation; connections and credentials open with the application. */
export function createRegistration(context?: ApplicationPackageRuntimeContext, config: ClaudeAgentClientOptions = {}) {
  return claudeAgentClientApplication({ ...config, localChannel: context?.phase === 'runtime' && context.role === 'client' ? context.channel : undefined })
}

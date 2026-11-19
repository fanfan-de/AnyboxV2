import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import { personalAgentServerApplication } from '../registration.js'
import { parsePersonalAgentServerConfig } from '../server-config.js'
import type { HarnessServerConfig } from '../server-config.js'

export function createRegistration(context?: ApplicationPackageRuntimeContext, config: HarnessServerConfig = parsePersonalAgentServerConfig({})) {
  const startRole = context?.phase === 'runtime' ? context.startRole : undefined
  return personalAgentServerApplication(config, startRole ? { localWorkerLaunch: directory => startRole('computer-worker', { ownership: 'independent', args: ['serve', directory] }) } : {})
}

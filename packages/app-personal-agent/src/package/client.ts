import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import { personalAgentClientApplication } from '../client/registration.js'
import type { PersonalAgentClientRuntimeOptions } from '../client/runtime.js'
import { parsePersonalAgentServerConfig } from '../server-config.js'

export function createRegistration(context?: ApplicationPackageRuntimeContext, config: PersonalAgentClientRuntimeOptions = {}) {
  const startRole = context?.phase === 'runtime' ? context.startRole : undefined
  const defaultDirectory = parsePersonalAgentServerConfig({}).harnessDatabasePath + '.computer-worker'
  return personalAgentClientApplication(startRole ? { ...config, computer: { directory: defaultDirectory, ...config.computer,
    launch: directory => startRole('computer-worker', { ownership: 'independent', args: ['serve', directory] }) } } : config)
}

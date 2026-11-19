import type { Context } from '@nya/core'
import { createClientGatewayComponent } from './gateway.js'
import { createClientComputerComponent } from './computer-worker.js'
import type { ComputerWorkerOptions } from '../core/computer/worker-port.js'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { createConnectionsComponent } from './connections.js'
import type { ClientConnectionsOptions } from './connections.js'
import type { ApplicationRuntimeContext } from '@anybox/application-api'
import { directoryPickerCapabilityId } from '@anybox/directory-picker'
import { parsePersonalAgentServerConfig } from '../server-config.js'
export interface PersonalAgentClientRuntimeOptions extends ClientConnectionsOptions {
  localInstanceId?: string
  computer?: ComputerWorkerOptions
}
/** Personal Agent owns its connections, credentials, gateway and Computer observer for this runtime generation. */
export function createPersonalAgentClientRuntime(root: Context, options: PersonalAgentClientRuntimeOptions = {}, context?: ApplicationRuntimeContext) {
  const computer = options.computer ?? { directory: `${parsePersonalAgentServerConfig({}).harnessDatabasePath}.computer-worker` }
  return createApplicationRuntime(root, installation => {
    for (const component of [createConnectionsComponent(options), createClientComputerComponent(computer),
      createClientGatewayComponent(options, !!context?.capabilities[directoryPickerCapabilityId])]) installation.install(component)
  }, undefined, context?.serviceBindings)
}

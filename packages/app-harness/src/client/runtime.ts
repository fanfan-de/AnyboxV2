import type { Context } from '@nya/core'
import { createClientGatewayComponent } from './gateway.js'
import { createClientComputerComponent } from './computer-worker.js'
import type { ComputerWorkerOptions } from '../core/computer/worker-port.js'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { createConnectionsComponent } from './connections.js'
import type { ClientConnectionsOptions } from './connections.js'
import type { ApplicationRuntimeContext } from '@anybox/application-api'
import { directoryPickerCapabilityId } from '@anybox/directory-picker'
export interface HarnessClientRuntimeOptions extends ClientConnectionsOptions {
  localInstanceId?: string
  computer?: ComputerWorkerOptions
}
/** Harness owns its connections, credentials, gateway and Computer observer for this runtime generation. */
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}, context?: ApplicationRuntimeContext) {
  return createApplicationRuntime(root, installation => {
    for (const component of [createConnectionsComponent(options), createClientComputerComponent(options.computer ?? { directory: './data/harness.sqlite.computer-worker' }),
      createClientGatewayComponent(options, !!context?.capabilities[directoryPickerCapabilityId])]) installation.install(component)
  })
}

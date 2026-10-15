import type { Context } from '@nya/core'
import { createConnectionsComponent } from './connections.js'
import type { DesktopLocalPairingOptions } from './connections.js'
import { createClientGatewayComponent } from './gateway.js'
import { createDirectoryPickerComponent } from './directory-picker.js'
import { createClientComputerComponent } from './computer-worker.js'
import type { ComputerWorkerOptions } from '../core/computer/worker-port.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
export interface HarnessClientRuntimeOptions {
  namespace?: string
  localInstanceId?: string
  localPairing?: DesktopLocalPairingOptions
  openEntry?: NonNullable<Parameters<typeof createConnectionsComponent>[0]>['openEntry']
  picker?: Parameters<typeof createDirectoryPickerComponent>[0]
  computer?: ComputerWorkerOptions
}
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}) {
  return createApplicationRuntime(root, installation => {
    for (const component of [createConnectionsComponent(options), createDirectoryPickerComponent(options.picker),
      createClientComputerComponent(options.computer ?? { directory: './data/harness.sqlite.computer-worker' }), createClientGatewayComponent(options)]) installation.install(component)
  })
}

import type { Context } from '@nya/core'
import { createConnectionsComponent } from './connections.js'
import { createClientGatewayComponent } from './gateway.js'
import { createDirectoryPickerComponent } from './directory-picker.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
export interface HarnessClientRuntimeOptions {
  namespace?: string
  localInstanceId?: string
  openEntry?: NonNullable<Parameters<typeof createConnectionsComponent>[0]>['openEntry']
  picker?: Parameters<typeof createDirectoryPickerComponent>[0]
}
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}) {
  return createApplicationRuntime(root, installation => {
    for (const component of [createConnectionsComponent(options), createDirectoryPickerComponent(options.picker), createClientGatewayComponent(options)]) installation.install(component)
  })
}

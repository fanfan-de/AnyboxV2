import type { Context } from '@nya/core'
import { createClientGatewayComponent } from './gateway.js'
import { createDirectoryPickerComponent } from './directory-picker.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
export interface HarnessClientRuntimeOptions {
  localInstanceId?: string
  picker?: Parameters<typeof createDirectoryPickerComponent>[0]
}
/** The connection library is a resident host provider; the application installs only its own directory window and gateway. */
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}) {
  return createApplicationRuntime(root, installation => {
    for (const component of [createDirectoryPickerComponent(options.picker), createClientGatewayComponent(options)]) installation.install(component)
  })
}

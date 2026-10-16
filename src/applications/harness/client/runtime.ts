import type { Context } from '@nya/core'
import { createClientGatewayComponent } from './gateway.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
export interface HarnessClientRuntimeOptions {
  localInstanceId?: string
}
/** The connection library and the native directory window are resident host providers; the application installs only its gateway. */
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}) {
  return createApplicationRuntime(root, installation => { installation.install(createClientGatewayComponent(options)) })
}

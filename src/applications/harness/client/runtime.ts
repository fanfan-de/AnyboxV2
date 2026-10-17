import type { Context } from '@nya/core'
import { createClientGatewayComponent } from './gateway.js'
import { createClientComputerComponent } from './computer-worker.js'
import type { ComputerWorkerOptions } from '../core/computer/worker-port.js'
import { createApplicationRuntime } from '../../../host/applications/runtime.js'
export interface HarnessClientRuntimeOptions {
  localInstanceId?: string
  computer?: ComputerWorkerOptions
}
/** The connection library and native directory window are resident host providers; the application owns its gateway and Computer observer. */
export function createHarnessClientRuntime(root: Context, options: HarnessClientRuntimeOptions = {}) {
  return createApplicationRuntime(root, installation => {
    for (const component of [createClientComputerComponent(options.computer ?? { directory: './data/harness.sqlite.computer-worker' }), createClientGatewayComponent(options)]) installation.install(component)
  })
}

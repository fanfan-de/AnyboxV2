import { homedir } from 'node:os'
import { createExecutionHost } from '../../host/execution.js'
import type { ApplicationRegistration } from '../../host/applications/registration.js'
import { createHarnessFacade } from './core/index.js'
import type { WebStartupConfig } from './startup-config.js'
import type { WebModelsOptions } from './models-startup.js'
import { harnessExecutionApplication } from './registration.js'

export interface HarnessHostOptions {
  readonly applications?: readonly ApplicationRegistration[]
  readonly name?: string
  readonly host?: string
  readonly projects?: readonly string[]
  readonly projectDirectoryHome?: string
  readonly models?: WebModelsOptions
}

/** Composes the Harness application with the generic execution host. */
export async function createHarnessHost(config: WebStartupConfig, options: HarnessHostOptions = {}) {
  const harnessOptions = { projectDirectoryHome: options.projectDirectoryHome ?? homedir(), models: options.models, projects: options.projects }
  const host = await createExecutionHost({ databasePath: config.harnessDatabasePath, port: config.port,
    applications: options.applications ?? [harnessExecutionApplication(config, harnessOptions)], name: options.name, host: options.host })
  const harness = createHarnessFacade(host.root, { agents: [{ id: 'assistant', instructions: 'You are a helpful assistant.' }] },
    { isClosing: () => host.closing || host.products.get('agent')?.state !== 'running' })
  return { root: host.root, products: host.products, ready: host.ready, url: host.url, instance: host.instance, close: host.close,
    get harness() { return host.products.get('agent')?.state === 'running' ? harness : undefined } }
}

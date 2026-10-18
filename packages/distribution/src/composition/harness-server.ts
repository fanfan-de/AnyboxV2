import { homedir } from 'node:os'
import { createExecutionHost } from '@anybox/host/execution'
import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createHarnessServerApi } from '@anybox/app-harness/core/index'
import type { HarnessServerConfig } from '@anybox/app-harness/server-config'
import type { HarnessServerModelsOptions } from '@anybox/app-harness/server-models'
import { harnessServerApplication } from '@anybox/app-harness/registration'

export interface HarnessServerOptions {
  readonly applications?: readonly ApplicationRegistration[]
  /** Further registrations composed beside the default Anybox Harness; the entrypoints choose them. */
  readonly additionalApplications?: readonly ApplicationRegistration[]
  readonly name?: string
  readonly host?: string
  readonly projects?: readonly string[]
  readonly projectDirectoryHome?: string
  readonly models?: HarnessServerModelsOptions
}

/** Composes harness server with the generic Anybox execution host. */
export async function createHarnessServer(config: HarnessServerConfig, options: HarnessServerOptions = {}) {
  const serverRuntimeOptions = { projectDirectoryHome: options.projectDirectoryHome ?? homedir(), models: options.models, projects: options.projects }
  const host = await createExecutionHost({ databasePath: config.harnessDatabasePath, port: config.port,
    applications: options.applications ?? [harnessServerApplication(config, serverRuntimeOptions), ...(options.additionalApplications ?? [])], name: options.name ?? 'harness server', host: options.host })
  const api = createHarnessServerApi(host.root, { agents: [{ id: 'assistant', instructions: 'You are a helpful assistant.' }] },
    { isClosing: () => host.closing || host.products.get('agent')?.state !== 'running' })
  return { root: host.root, products: host.products, ready: host.ready, url: host.url, instance: host.instance, prepareClose: host.prepareClose, close: host.close,
    get api() { return host.products.get('agent')?.state === 'running' ? api : undefined } }
}

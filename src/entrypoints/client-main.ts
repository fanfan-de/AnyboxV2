import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createClientHost as createApplicationClientHost } from '../host/client.js'
import { harnessClientApplication } from '../applications/harness/registration.js'
import type { HarnessClientRuntimeOptions } from '../applications/harness/client/runtime.js'
import type { ApplicationRegistration } from '../host/applications/registration.js'
import { defaultModelsConfigPath } from '../applications/harness/server-config.js'

export interface DefaultClientHostOptions extends HarnessClientRuntimeOptions {
  readonly applications?: readonly ApplicationRegistration[]
  readonly path: string
  readonly port?: number
  readonly transportSecret?: string
}

/** Trusted default composition; the generic host itself accepts an explicit catalog. */
export async function createClientHost(options: DefaultClientHostOptions) {
  return createApplicationClientHost({ path: options.path, port: options.port, transportSecret: options.transportSecret,
    applications: options.applications ?? [harnessClientApplication(options)] })
}

async function main() {
  const path = process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
  const legacyModelsPath = process.env.ANYBOX_MODELS_DATABASE ?? './data/models.sqlite'
  const forbidden = [process.env.ANYBOX_HARNESS_DATABASE ?? './data/harness.sqlite', legacyModelsPath,
    process.env.ANYBOX_MODELS_CONFIG ?? defaultModelsConfigPath(legacyModelsPath), process.env.ANYBOX_MODELS_CATALOG_DATABASE ?? './data/models-catalog.sqlite']
  if (forbidden.some(other => resolve(other) === resolve(path))) throw new Error('Client and execution databases must be different files')
  const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
  const host = await createClientHost({ path, port, namespace: process.env.ANYBOX_CLIENT_NAMESPACE, localInstanceId: process.env.ANYBOX_LOCAL_INSTANCE_ID })
  process.stdout.write(`Anybox Client: ${host.url}\n`)
  const stop = () => { void host.close().finally(() => { if (process.connected) process.disconnect() }).catch(() => { process.exitCode = 1; process.stderr.write('Client shutdown failed\n') }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1; process.stderr.write(`Client could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})

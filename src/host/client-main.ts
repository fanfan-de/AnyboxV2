import { Context } from '@nya/core'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createConnectionsComponent } from './client/connections.js'
import { createClientGatewayComponent, clientGatewayServiceKey } from './client/gateway.js'
import type { ClientGateway } from './client/gateway.js'
import { createDirectoryPickerComponent } from './directory-picker.js'

export async function createClientHost(options: { path: string; port?: number; namespace?: string; localInstanceId?: string; openEntry?: NonNullable<Parameters<typeof createConnectionsComponent>[0]>['openEntry'] }) {
  const root = new Context()
  try {
    await root.installComponent(createLocalSqliteComponent(options.path))
    await root.installComponent(createConnectionsComponent({ namespace: options.namespace, openEntry: options.openEntry }))
    await root.installComponent(createDirectoryPickerComponent())
    await root.installComponent(createClientGatewayComponent(options))
    const server = root.get<ClientGateway>(clientGatewayServiceKey)!
    return { root, url: server.url, close: () => root.fiber.dispose() }
  } catch (error) { await root.fiber.dispose(); throw error }
}
async function main() {
  const path = process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
  const forbidden = [process.env.ANYBOX_HARNESS_DATABASE ?? './data/harness.sqlite', process.env.ANYBOX_MODELS_DATABASE ?? './data/models.sqlite', process.env.ANYBOX_MODELS_CATALOG_DATABASE ?? './data/models-catalog.sqlite']
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

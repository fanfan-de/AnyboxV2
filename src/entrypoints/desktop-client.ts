import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerStart } from '../desktop/paths.js'
import { runDesktopWorker } from '../desktop/worker-runtime.js'
import type { DesktopRpc, DesktopRoleHost } from '../desktop/worker-runtime.js'
import { createClientHost } from './client-main.js'
import { connectionsServiceKey } from '../host/connections.js'
import type { ConnectionsPort } from '../host/connections.js'

export async function startDesktopClient(options: DesktopWorkerStart, rpc: DesktopRpc): Promise<DesktopRoleHost> {
  const paths = desktopPaths(options.userData)
  await mkdir(paths.data, { recursive: true })
  const host = await createClientHost({ path: paths.client, port: 0, namespace: `${options.namespace}.client`, transportSecret: options.transportSecret,
    computer: { directory: `${paths.harness}.computer-worker` },
    localPairing: { getLocal: signal => rpc.call('local.get', undefined, signal),
      start: signal => rpc.call<void>('local.start', undefined, signal),
      issue: signal => rpc.call('local.issue', undefined, signal),
      reconcile: (token, signal) => rpc.call('local.reconcile', { token }, signal) },
    picker: { runDialog: signal => rpc.call('directory.pick', undefined, signal) } })
  rpc.handle('retryLocal', (_value, signal) => host.root.get<ConnectionsPort>(connectionsServiceKey)?.retryLocal(signal))
  return { ready: { url: host.url }, prepareClose: host.prepareClose, close: host.close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDesktopWorker('client', startDesktopClient)

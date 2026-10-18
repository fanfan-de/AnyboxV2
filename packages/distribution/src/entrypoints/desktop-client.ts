import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerStart } from '../desktop/paths.js'
import { runDesktopWorker } from '@anybox/host/desktop/worker-runtime'
import type { DesktopRpc, DesktopRoleHost } from '@anybox/host/desktop/worker-runtime'
import { createClientHost } from './client-main.js'
import { readApplicationTrustPolicy } from '@anybox/host/package-management/policy'
import { connectionsServiceKey } from '@anybox/app-harness/client/connections'
import type { ConnectionsPort } from '@anybox/app-harness/client/connections'
import { connectionsServiceKey as claudeConnectionsServiceKey } from '@anybox/app-claude-agent/client/connections'
import type { ConnectionsPort as ClaudeConnectionsPort } from '@anybox/app-claude-agent/client/connections'

export async function startDesktopClient(options: DesktopWorkerStart, rpc: DesktopRpc): Promise<DesktopRoleHost> {
  const paths = desktopPaths(options.userData)
  await mkdir(paths.data, { recursive: true })
  const host = await createClientHost({ path: paths.client, packageDirectory: paths.applications, port: 0, namespace: `${options.namespace}.client`, transportSecret: options.transportSecret,
    packageTrustPolicy: process.env.ANYBOX_APPLICATION_TRUST ? await readApplicationTrustPolicy(process.env.ANYBOX_APPLICATION_TRUST) : undefined,
    computer: { directory: `${paths.harness}.computer-worker` },
    localPairing: { getLocal: signal => rpc.call('local.get', undefined, signal),
      start: signal => rpc.call<void>('local.start', undefined, signal),
      issue: signal => rpc.call('local.issue', { appId: 'agent' }, signal),
      reconcile: (token, signal) => rpc.call('local.reconcile', { appId: 'agent', token }, signal) },
    claudeAgent: { localPairing: {
      getLocal: signal => rpc.call('local.get', undefined, signal),
      start: signal => rpc.call<void>('local.start', undefined, signal),
      issue: signal => rpc.call('local.issue', { appId: 'claude-agent' }, signal),
      reconcile: (token, signal) => rpc.call('local.reconcile', { appId: 'claude-agent', token }, signal),
    } },
    picker: { runDialog: signal => rpc.call('directory.pick', undefined, signal) } })
  rpc.handle('retryLocal', async (_value, signal) => {
    const results = await Promise.all([
      host.root.get<ConnectionsPort>(connectionsServiceKey)?.retryLocal(signal),
      host.root.get<ClaudeConnectionsPort>(claudeConnectionsServiceKey)?.retryLocal(signal),
    ])
    return results.find(result => result !== undefined)
  })
  return { ready: { url: host.url }, prepareClose: host.prepareClose, close: host.close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDesktopWorker('client', startDesktopClient, async keyring => (await import('../desktop/native-smoke.js')).nativeDesktopSmoke(keyring))

import { mkdir } from 'node:fs/promises'
import { createPrivateRpc, rpcFailure } from '../desktop/rpc.js'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerStart, DesktopWorkerReady } from '../desktop/paths.js'
import { createClientHost } from './client-main.js'
import { connectionsServiceKey } from '../applications/harness/client/connections.js'
import type { ConnectionsPort } from '../applications/harness/client/connections.js'
import { createExecutionHost } from '../host/execution.js'
import { parseHarnessServerConfig } from '../applications/harness/server-config.js'
import { harnessServerApplication } from '../applications/harness/registration.js'
import { hostAccessServiceKey } from '../host/access.js'
import type { HostAccessPort } from '../host/access.js'
import { runAdmissionServiceKey } from '../applications/harness/core/run/component.js'
import type { RunAdmissionPort } from '../applications/harness/core/run/component.js'
import { nativeDesktopSmoke } from '../desktop/native-smoke.js'
import type { ParentPort } from 'electron'
import { productActivityServiceKey } from '../host/applications/contracts.js'
import type { ProductActivityPort, ActivityFreeze } from '../host/applications/contracts.js'

const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('Desktop worker requires a private utility port')
const rpc = createPrivateRpc(message => parent.postMessage(message))
parent.on('message', event => rpc.receive(event.data))
let host: Awaited<ReturnType<typeof createClientHost>> | Awaited<ReturnType<typeof createExecutionHost>> | undefined
let startTask: Promise<DesktopWorkerReady> | undefined, stopping = false, quitFreeze: ActivityFreeze | undefined
const managedOwner = 'anybox.desktop.local'
const start = async (value: unknown): Promise<DesktopWorkerReady> => {
  const options = value as DesktopWorkerStart, paths = desktopPaths(options.userData)
  await mkdir(paths.data, { recursive: true })
  if (options.kind === 'execution') {
    const config = parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_HARNESS_DATABASE: paths.harness,
      ANYBOX_MODELS_CONFIG: paths.models, ANYBOX_MODELS_DATABASE: paths.legacyModels, ANYBOX_MODELS_CATALOG_DATABASE: paths.catalog,
      ANYBOX_IMAGE_ASSETS_DIRECTORY: paths.images, ANYBOX_MODELS_NAMESPACE: `${options.namespace}.models` })
    const executionHost = await createExecutionHost({ databasePath: paths.harness, port: 0, name: '本机 Anybox Harness', host: '127.0.0.1',
      applications: [harnessServerApplication(config, { models: { readLegacyCredential: async () => undefined } })] })
    host = executionHost
    return { url: executionHost.url, instanceId: executionHost.instance.instanceId } satisfies DesktopWorkerReady
  }
  if (options.kind !== 'client' || !options.transportSecret) throw rpcFailure('invalid-startup')
  host = await createClientHost({ path: paths.client, port: 0, namespace: `${options.namespace}.client`, transportSecret: options.transportSecret,
    localPairing: { getLocal: signal => rpc.call('local.get', undefined, signal),
      issue: signal => rpc.call('local.issue', undefined, signal),
      reconcile: (token, signal) => rpc.call('local.reconcile', { token }, signal) },
    picker: { runDialog: signal => rpc.call('directory.pick', undefined, signal) } })
  return { url: host.url } satisfies DesktopWorkerReady
}
rpc.handle('start', value => {
  if (stopping) throw rpcFailure('service-unavailable')
  if (startTask) throw rpcFailure('already-started')
  return startTask = start(value)
})
const access = () => {
  const service = host?.root.get<HostAccessPort>(hostAccessServiceKey)
  if (!service) throw rpcFailure('service-unavailable')
  return service
}
rpc.handle('issue', async () => (await access().issueManaged(managedOwner, 'Anybox 桌面本机连接')).token)
rpc.handle('reconcile', async value => access().reconcileManaged(managedOwner, (value as { token?: string }).token))
rpc.handle('inspect', () => ({ busy: host?.root.get<RunAdmissionPort>(runAdmissionServiceKey)?.busy() ?? false }))
rpc.handle('inspectForQuit', async () => {
  await startTask?.catch(() => {})
  if (!host) return { busy: false }
  try {
    quitFreeze ??= host.root.get<ProductActivityPort>(productActivityServiceKey)!.freeze(host.products.list().map(product => product.definition.id))
    return { busy: false }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'product-busy') return { busy: true }
    throw error
  }
})
rpc.handle('releaseQuit', () => { quitFreeze?.release(); quitFreeze = undefined })
rpc.handle('prepareClose', async () => {
  stopping = true
  await startTask?.catch(() => {})
  await host?.prepareClose()
})
rpc.handle('close', async () => {
  stopping = true
  await startTask?.catch(() => {})
  await host?.close()
  setImmediate(() => process.exit(0))
})
rpc.handle('nativeSmoke', value => nativeDesktopSmoke((value as { keyring: boolean }).keyring))
rpc.handle('retryLocal', (_value, signal) => {
  const service = host?.root.get<ConnectionsPort>(connectionsServiceKey)
  return service?.retryLocal(signal)
})

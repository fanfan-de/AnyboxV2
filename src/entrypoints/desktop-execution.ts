import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerStart } from '../desktop/paths.js'
import { runDesktopWorker } from '../desktop/worker-runtime.js'
import type { DesktopRpc, DesktopRoleHost } from '../desktop/worker-runtime.js'
import { rpcFailure } from '../desktop/rpc.js'
import { createExecutionHost } from '../host/execution.js'
import { parseHarnessServerConfig } from '../applications/harness/server-config.js'
import { harnessServerApplication } from '../applications/harness/registration.js'
import { hostAccessServiceKey } from '../host/access.js'
import type { HostAccessPort } from '../host/access.js'
import { runAdmissionServiceKey } from '../applications/harness/core/run/component.js'
import type { RunAdmissionPort } from '../applications/harness/core/run/component.js'
import { productActivityServiceKey } from '../host/applications/contracts.js'
import type { ProductActivityPort, ActivityFreeze } from '../host/applications/contracts.js'

export async function startDesktopExecution(options: DesktopWorkerStart, rpc: DesktopRpc): Promise<DesktopRoleHost> {
  const paths = desktopPaths(options.userData)
  await mkdir(paths.data, { recursive: true })
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_HARNESS_DATABASE: paths.harness,
    ANYBOX_MODELS_CONFIG: paths.models, ANYBOX_MODELS_DATABASE: paths.legacyModels, ANYBOX_MODELS_CATALOG_DATABASE: paths.catalog,
    ANYBOX_IMAGE_ASSETS_DIRECTORY: paths.images, ANYBOX_MODELS_NAMESPACE: `${options.namespace}.models` })
  const host = await createExecutionHost({ databasePath: paths.harness, port: 0, name: '本机 Anybox Harness', host: '127.0.0.1',
    applications: [harnessServerApplication(config, { models: { readLegacyCredential: async () => undefined } })] })
  let quitFreeze: ActivityFreeze | undefined
  const access = () => {
    const service = host.root.get<HostAccessPort>(hostAccessServiceKey)
    if (!service) throw rpcFailure('service-unavailable')
    return service
  }
  const managedOwner = 'anybox.desktop.local'
  rpc.handle('issue', async () => (await access().issueManaged(managedOwner, 'Anybox 桌面本机连接')).token)
  rpc.handle('reconcile', async value => access().reconcileManaged(managedOwner, (value as { token?: string }).token))
  return { ready: { url: host.url, instanceId: host.instance.instanceId }, prepareClose: host.prepareClose, close: host.close,
    inspect: () => ({ busy: host.root.get<RunAdmissionPort>(runAdmissionServiceKey)?.busy() ?? false }),
    async inspectForQuit() {
      try {
        quitFreeze ??= host.root.get<ProductActivityPort>(productActivityServiceKey)!.freeze(host.products.list().map(product => product.definition.id))
        return { busy: false }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'product-busy') return { busy: true }
        throw error
      }
    },
    releaseQuit() { quitFreeze?.release(); quitFreeze = undefined },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDesktopWorker('execution', startDesktopExecution)

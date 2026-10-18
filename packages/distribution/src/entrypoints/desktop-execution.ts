import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerStart } from '../desktop/paths.js'
import { createDesktopApplicationLifecycle, runDesktopWorker } from '@anybox/host/desktop/worker-runtime'
import type { DesktopRpc, DesktopRoleHost } from '@anybox/host/desktop/worker-runtime'
import { rpcFailure } from '@anybox/host/desktop/rpc'
import { createExecutionHost } from '@anybox/host/execution'
import { parseHarnessServerConfig } from '@anybox/app-harness/server-config'
import { harnessServerApplication } from '@anybox/app-harness/registration'
import { parseClaudeAgentConfig } from '@anybox/app-claude-agent/config'
import { claudeAgentServerApplication } from '@anybox/app-claude-agent/registration'
import { hostAccessServiceKey } from '@anybox/host/access'
import type { HostAccessPort } from '@anybox/host/access'
import { productActivityServiceKey } from '@anybox/application-api'
import type { ProductActivityPort } from '@anybox/application-api'

export async function startDesktopExecution(options: DesktopWorkerStart, rpc: DesktopRpc): Promise<DesktopRoleHost> {
  const paths = desktopPaths(options.userData)
  await mkdir(paths.data, { recursive: true })
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_HARNESS_DATABASE: paths.harness,
    ANYBOX_MODELS_CONFIG: paths.models, ANYBOX_MODELS_DATABASE: paths.legacyModels, ANYBOX_MODELS_CATALOG_DATABASE: paths.catalog,
    ANYBOX_IMAGE_ASSETS_DIRECTORY: paths.images, ANYBOX_MODELS_NAMESPACE: `${options.namespace}.models` })
  const host = await createExecutionHost({ databasePath: paths.harness, port: 0, name: '本机 Anybox Harness', host: '127.0.0.1',
    applications: [harnessServerApplication(config, { models: { readLegacyCredential: async () => undefined } }), claudeAgentServerApplication(parseClaudeAgentConfig(process.env))] })
  const access = () => {
    const service = host.root.get<HostAccessPort>(hostAccessServiceKey)
    if (!service) throw rpcFailure('service-unavailable')
    return service
  }
  const managedOwner = (value: unknown) => {
    const appId = (value as { appId?: unknown } | undefined)?.appId ?? 'agent'
    if (appId !== 'agent' && appId !== 'claude-agent') throw rpcFailure('invalid-input')
    // Preserve existing Harness ownership; Claude Agent reconciles only its own tokens.
    return appId === 'agent' ? 'anybox.desktop.local' : 'anybox.desktop.local.claude-agent'
  }
  rpc.handle('issue', async value => (await access().issueManaged(managedOwner(value), 'Anybox 桌面本机连接')).token)
  rpc.handle('reconcile', async value => access().reconcileManaged(managedOwner(value), (value as { token?: string }).token))
  return { ready: { url: host.url, instanceId: host.instance.instanceId }, prepareClose: host.prepareClose, close: host.close,
    ...createDesktopApplicationLifecycle(() => {
      const activity = host.root.get<ProductActivityPort>(productActivityServiceKey)
      if (!activity) throw rpcFailure('service-unavailable')
      return activity
    }, () => host.products.list().map(product => product.definition.id)),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDesktopWorker('execution', startDesktopExecution, async keyring => (await import('../desktop/native-smoke.js')).nativeDesktopSmoke(keyring))

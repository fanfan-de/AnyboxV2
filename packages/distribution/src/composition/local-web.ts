import { Context } from '@nya/core'
import { productActivityServiceKey, productsServiceKey } from '@anybox/application-api'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import { hostAccessServiceKey } from '@anybox/host/access'
import type { HostAccessPort } from '@anybox/host/access'
import type { HarnessServerConfig } from '@anybox/app-harness/server-config'
import { createClientHost } from '../entrypoints/client-main.js'
import type { DefaultClientHostOptions } from '../entrypoints/client-main.js'
import { createHarnessServer } from './harness-server.js'
import type { HarnessServerOptions } from './harness-server.js'
import { createLocalPairingOptions } from '../entrypoints/local-pairing.js'

/** Explicit resource identities, not Contexts, security boundaries or another dependency graph. */
export const localExecutionServiceBindings: Readonly<Record<string, string>> = Object.freeze({
  [localStorageServiceKey]: 'host.execution.storage',
  [productsServiceKey]: 'host.execution.products',
  [productActivityServiceKey]: 'host.execution.activity',
  ...Object.fromEntries(['models', 'models.settings', 'models.protocols', 'models.store', 'models.vault',
    'models.source-data', 'models.catalog', 'models.catalog-source', 'models.catalog-cache'].map(key => [key, `harness.${key}`])),
})

/** Owns the sole root. Each side keeps its database, durable targets and admission boundary. */
export async function createLocalWebHost(options: {
  readonly client: Omit<DefaultClientHostOptions, 'root'>
  readonly execution?: { readonly config: HarnessServerConfig; readonly options?: HarnessServerOptions }
  readonly onExecutionError?: (error: unknown) => void
}) {
  const root = new Context()
  let execution: Awaited<ReturnType<typeof createHarnessServer>> | undefined
  let client: Awaited<ReturnType<typeof createClientHost>> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    const prepared = await Promise.allSettled([client?.prepareClose(), execution?.prepareClose()])
    // Retained HTTP work needs business cancellation from root disposal before it can drain.
    const exited = await Promise.allSettled([root.fiber.dispose(), client?.close(), execution?.close()])
    const errors = [...prepared, ...exited].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Local Web shutdown failed')
  })()
  try {
    if (options.execution) {
      try { execution = await createHarnessServer(options.execution.config, {
        ...options.execution.options, root, serviceBindings: localExecutionServiceBindings,
      }) } catch (error) {
        if (!options.onExecutionError || error && typeof error === 'object' && 'phase' in error && error.phase === 'cleanup') throw error
        options.onExecutionError(error)
      }
    }
    const access = () => {
      const service = root.get<HostAccessPort>(hostAccessServiceKey)
      if (!service) throw new Error('Local execution access unavailable')
      return service
    }
    const target = execution ? { endpoint: execution.url, instanceId: execution.instance.instanceId } : undefined
    client = await createClientHost({ ...options.client, root,
      ...(target ? { localInstanceId: target.instanceId, localPairing: createLocalPairingOptions(access, target, 'agent'),
        claudeAgent: { ...options.client.claudeAgent, localInstanceId: target.instanceId, localPairing: createLocalPairingOptions(access, target, 'claude-agent') } } : {}),
    })
    return { root, client, execution, url: client.url, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Local Web startup and cleanup failed') }
    throw error
  }
}

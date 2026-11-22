import type { ToolEnvironment } from '@anybox/tool-api'
import type { StorageReader } from '@anybox/storage-sqlite/port'
import { createFunctionBindings } from './bindings.js'
import { createToolEnvironmentCatalog } from './catalog.js'
import type { ContextualToolEnvironment, TargetedToolEnvironment, TargetedToolEnvironmentTarget, ToolEnvironmentCatalogEntry, ToolEnvironmentRuntimeBinding } from './catalog-port.js'

type Dependencies = Readonly<Record<string, unknown>>

interface RuntimeProvider<Provider> {
  readonly inject?: readonly string[]
  bind(deps: Dependencies): Provider
}

/** A trusted provider contributes its declarations and the factory for its current execution binding. */
export type ToolRegistration = {
  readonly catalog: ToolEnvironmentCatalogEntry
  readonly trustedConfiguration?: boolean
} & ({
  readonly kind: 'static'
  readonly contextualTarget?: boolean
  readonly runtime: RuntimeProvider<ContextualToolEnvironment>
} | {
  readonly kind: 'targeted'
  readonly inject?: readonly string[]
  targets(deps: Dependencies, reader?: StorageReader): readonly TargetedToolEnvironmentTarget[]
  readonly runtime: RuntimeProvider<TargetedToolEnvironment>
})

export interface ToolRegistrar {
  register(registration: ToolRegistration | ToolEnvironment): void
}

/** Assemble once, then bind descriptions and execution against each consumer's Nya dependency snapshot. */
export function createToolRegistry(generation: string, configure: (registry: ToolRegistrar) => void) {
  const registrations = new Map<string, ToolRegistration>()
  let configuring = true
  try {
    const configured: unknown = configure({
      register(input) {
        if (!configuring) throw new TypeError('tool registry configuration is closed')
        const registration: ToolRegistration = 'openScope' in input
          ? { kind: 'static', catalog: { descriptor: input }, trustedConfiguration: true, runtime: { bind: () => input } }
          : input
        const { catalog, runtime } = registration
        const { environmentId } = catalog.descriptor
        if (registrations.has(environmentId)) throw new TypeError('duplicate tool environment')
        if (catalog.targets !== undefined) throw new TypeError('register target discovery on the tool registration')
        const entry = registration.kind === 'targeted' ? { ...catalog, targets: () => [] } : catalog
        const [descriptor] = createToolEnvironmentCatalog([entry]).environments
        const capturedCatalog = {
          descriptor: descriptor!,
          ...(catalog.historyTools ? { historyTools: structuredClone(catalog.historyTools) } : {}),
          ...(catalog.validateSelection ? { validateSelection: catalog.validateSelection.bind(catalog) } : {}),
        }
        if (registration.kind === 'targeted') {
          registrations.set(environmentId, { ...registration, catalog: capturedCatalog, inject: [...registration.inject ?? []],
            targets: registration.targets.bind(registration), runtime: { inject: [...runtime.inject ?? []], bind: registration.runtime.bind.bind(runtime) } })
        } else {
          registrations.set(environmentId, { ...registration, catalog: capturedCatalog,
            runtime: { inject: [...runtime.inject ?? []], bind: registration.runtime.bind.bind(runtime) } })
        }
      },
    })
    if (typeof (configured as PromiseLike<unknown> | undefined)?.then === 'function') {
      void Promise.resolve(configured).catch(() => {})
      throw new TypeError('tool registration must be synchronous')
    }
  } finally {
    configuring = false
  }
  const providers = [...registrations.values()]
  const inject = Object.freeze([...new Set(providers.flatMap(provider => provider.kind === 'targeted' ? provider.inject ?? [] : []))])
  const contextual = providers.flatMap(provider =>
    provider.kind === 'static' && provider.contextualTarget ? [provider.catalog.descriptor.environmentId] : [])
  const trustedConfigurationEnvironmentIds: ReadonlySet<string> = new Set(providers.flatMap(provider =>
    provider.trustedConfiguration ? [provider.catalog.descriptor.environmentId] : []))
  const catalogFor = (deps: Dependencies) => createToolEnvironmentCatalog(providers.map(provider =>
    provider.kind === 'targeted' ? { ...provider.catalog, targets: reader => provider.targets(deps, reader) } : { ...provider.catalog, contextualTarget: provider.contextualTarget }))
  const runtime: ToolEnvironmentRuntimeBinding = Object.freeze({
    inject: Object.freeze([...new Set([...providers.flatMap(provider => provider.runtime.inject ?? []), ...inject])]),
    bind(deps: Dependencies) {
      const staticProviders: ContextualToolEnvironment[] = []
      const targetedProviders: TargetedToolEnvironment[] = []
      for (const provider of providers) {
        if (provider.kind === 'targeted') targetedProviders.push(provider.runtime.bind(deps))
        else staticProviders.push(provider.runtime.bind(deps))
      }
      return catalogFor(deps).bind(staticProviders, targetedProviders)
    },
  })
  return Object.freeze({
    inject, trustedConfigurationEnvironmentIds, runtime,
    describe(deps: Dependencies) {
      const catalog = catalogFor(deps)
      return { catalog, bindings: createFunctionBindings(catalog.environments, generation, catalog.targets, contextual) }
    },
  })
}

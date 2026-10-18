import { Context } from '@nya/core'
import { dirname } from 'node:path'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import { createClientShellComponent, clientShellServiceKey } from './client-http.js'
import type { ClientShell } from './client-http.js'
import { createApplicationCatalog, createApplicationRuntimes } from './applications/registration.js'
import type { ApplicationCapabilityProvider, ApplicationRegistration } from '@anybox/application-api/nya'
import { shellAssets } from './assets.js'
import { createProductsComponent } from './applications/component.js'
import { createProductActivityComponent } from './applications/activity.js'
import { productsServiceKey, productActivityServiceKey } from '@anybox/application-api'
import type { ProductsPort, ProductActivityPort } from '@anybox/application-api'
import { createPackageRegistryComponent } from './package-management/component.js'
import { packageRegistryDatabasePath } from './package-management/paths.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey } from './package-management/port.js'
import type { PackageRegistryPort, PackageUseCredential, PackageActualCatalog, PackageIdentity } from './package-management/port.js'
import { createPackageInstallerComponent, packageInstallerServiceKey } from './package-management/installer.js'
import type { PackageInstallerPort } from './package-management/installer.js'
import { currentApplicationRuntimeProfile } from './package-management/policy.js'
import type { ApplicationTrustPolicy } from './package-management/policy.js'
import { createPackageActivationComponent, packageActivationServiceKey } from './package-management/activation.js'
import type { PackageActivationPort, PackageLifecycleManager } from './package-management/activation.js'
import { loadInstalledApplicationCatalog, isInstalledPackageCorruption } from './package-management/loader.js'
import type { LoadedInstalledApplicationCatalog } from './package-management/loader.js'
import { planInstalledRoles } from './package-management/catalog-plan.js'
import { createPackagePageLifecycle } from './package-management/page-lifecycle.js'
import { randomUUID } from 'node:crypto'
import { tryAcquirePackageUsageExitLock } from './package-management/usage-locks.js'

export interface ClientHostOptions {
  readonly applications: readonly ApplicationRegistration[]
  readonly path: string
  readonly port?: number
  readonly transportSecret?: string
  /** The lifecycle manager is the sole writer of this installation root, when configured. */
  readonly packageDirectory?: string
  /** Administrative publisher and alias policy. Uploaded packages cannot extend it. */
  readonly packageTrustPolicy?: ApplicationTrustPolicy
  /** Trusted composition supplies optional providers; the host does not choose their implementations. */
  readonly providers?: readonly ApplicationCapabilityProvider[]
  readonly packageManager?: PackageLifecycleManager
  /** A trusted process owner can start the management shell after a failed role exit. */
  readonly packageManagementOnly?: boolean
  readonly packageRoleConfig?: Readonly<Record<string, unknown>>
  /** Private launcher hook, invoked before loading any installed registration. */
  readonly packageBootstrap?: (registry: PackageRegistryPort) => Promise<PackageUseCredential | undefined>
  readonly packageStartRole?: (identity: PackageIdentity, input: { readonly role: 'computer-worker'; readonly args: readonly string[]; readonly ownership: 'independent' }) => Promise<void>
  readonly packageChannel?: (identity: PackageIdentity, payload: unknown, signal: AbortSignal) => Promise<unknown>
  readonly packageOnCredential?: (credential: PackageUseCredential) => void
  readonly packageOnReady?: (actual: PackageActualCatalog) => Promise<void>
}

/** Owns the client root and shell without choosing an application. */
export async function createClientHost(options: ClientHostOptions) {
  options = { ...options }
  const registryPath = options.packageDirectory === undefined ? undefined : packageRegistryDatabasePath(options.packageDirectory, options.path)
  const profile = currentApplicationRuntimeProfile()
  const trustedPublisherCount = options.packageTrustPolicy?.trustedPublishers.length ?? 0
  // Capture the complete policy before the first asynchronous resource acquisition.
  const verification = { trustedPublishers: options.packageTrustPolicy?.trustedPublishers ?? [], target: { os: process.platform, arch: process.arch },
    applicationApiVersion: '0.1.0', runtimeProfiles: { client: profile, execution: profile, computerWorker: profile } }
  const installerComponent = registryPath === undefined ? undefined : createPackageInstallerComponent({ directory: dirname(registryPath),
    verification,
    preparation: { trustedAliases: options.packageTrustPolicy?.trustedAliases, commonAssets: shellAssets } })
  const root = new Context()
  let catalog = createApplicationCatalog(options.packageManagementOnly ? [] : options.applications, shellAssets)
  let runtime: ReturnType<typeof createApplicationRuntimes> | undefined
  let loaded: LoadedInstalledApplicationCatalog | undefined
  const pages = registryPath === undefined || !options.packageManager ? undefined : createPackagePageLifecycle()
  let products: ProductsPort | undefined
  let preparingClose: Promise<void> | undefined, closing: Promise<void> | undefined, drainingRequests: Promise<void> | undefined
  const prepareClose = () => {
    if (preparingClose) return preparingClose
    const admissionErrors: unknown[] = []
    const attempt = <T>(work: () => T): T | undefined => { try { return work() } catch (error) { admissionErrors.push(error) } }
    const stopping = attempt(() => root.get<ProductsPort>(productsServiceKey)?.stop())
    attempt(() => root.get<ProductActivityPort>(productActivityServiceKey)?.stop())
    attempt(() => runtime?.closeAdmission())
    const packages = root.get<PackageRegistryPort>(packageRegistryServiceKey)
    const installer = root.get<PackageInstallerPort>(packageInstallerServiceKey)
    attempt(() => installer?.closeAdmission())
    const activation = root.get<PackageActivationPort>(packageActivationServiceKey)
    attempt(() => activation?.closeAdmission())
    drainingRequests = attempt(() => root.get<ClientShell>(clientShellServiceKey)?.close())
    // HTTP can retain a Run until root cleanup cancels it; observe errors now, join after preparation.
    void drainingRequests?.catch(() => {})
    preparingClose = Promise.allSettled([stopping, runtime?.awaitIdle(), installer?.awaitIdle(), activation?.awaitIdle()]).then(async results => {
      // Installation cancellation must finish its ledger writes before registry admission closes.
      attempt(() => packages?.closeAdmission())
      const ledger = await Promise.allSettled([packages?.awaitIdle()])
      const errors = [...admissionErrors, ...[...results, ...ledger].flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Client admission shutdown failed')
    })
    return preparingClose
  }
  const close = () => closing ??= (async () => {
    const errors: unknown[] = []
    try { await prepareClose() } catch (error) { errors.push(error) }
    const results = await Promise.allSettled([root.fiber.dispose(), drainingRequests])
    try { await loaded?.close() } catch (error) { errors.push(error) }
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Client shutdown failed')
  })()
  try {
    if (registryPath !== undefined) {
      await root.installComponent(createLocalSqliteComponent(registryPath, { serviceKey: packageRegistryStorageServiceKey }))
      await root.installComponent(createPackageRegistryComponent({ directory: dirname(registryPath) }))
      await root.installComponent(installerComponent!)
    }
    if (registryPath !== undefined) {
      const registry = root.get<PackageRegistryPort>(packageRegistryServiceKey)!
      try {
        let credential = await options.packageBootstrap?.(registry)
        const unresolved = (await registry.listActivations()).some(activation => activation.phase !== 'completed' && activation.phase !== 'cancelled')
        if (!credential && !unresolved && !options.packageManagementOnly) {
          const view = await registry.inspect()
          const plans = await planInstalledRoles(view, { directory: dirname(registryPath), verification, roles: ['client'], providers: options.providers })
          const plan = plans[0]!
          if (plan.entries.length) credential = await registry.prepareUse({ expectedRegistryRevision: view.revision, ...plan, holderId: 'client', generation: randomUUID() })
        }
        if (credential) {
          options.packageOnCredential?.(credential)
          loaded = await loadInstalledApplicationCatalog({ directory: dirname(registryPath), credential, registry, verification,
            trustedAliases: options.packageTrustPolicy?.trustedAliases, roleConfig: options.packageRoleConfig, commonAssets: shellAssets, startRole: options.packageStartRole, channel: options.packageChannel })
          const replaced = new Set(loaded.applications.map(application => application.definition.id))
          catalog = createApplicationCatalog([...options.applications.filter(application => !replaced.has(application.definition.id)), ...loaded.applications], shellAssets)
        }
      } catch (error) {
        if (isInstalledPackageCorruption(error)) {
          const identity = error.packageIdentity, view = await registry.inspect(), facts = view.applications.find(item => item.appId === identity.appId)
          if (facts) await registry.quarantineInstallation({ identity, expectedAppRevision: facts.revision, errorCode: 'package-content-corrupt' }).catch(() => {})
        }
        throw error
      }
    }
    const selectedCapabilities = loaded?.snapshot.capabilities
    runtime = createApplicationRuntimes(root, catalog, [
      { id: 'storage.sqlite', version: '1.0.0', services: [localStorageServiceKey], resident: true,
        create: () => createLocalSqliteComponent(options.path) },
      ...(options.providers ?? []).filter(provider => !selectedCapabilities || selectedCapabilities.some(selected => selected.id === provider.id && selected.version === provider.version)),
    ])
    await root.installComponent(createLocalSqliteComponent(options.path))
    await root.installComponent(createProductActivityComponent())
    await root.installComponent(createProductsComponent({ directory: catalog.applications.map(app => app.definition), runtime: id => runtime!.get(id), capabilities: id => runtime!.capabilities(id), restoreLegacyAgent: false }))
    products = root.get<ProductsPort>(productsServiceKey)!
    if (registryPath !== undefined) await root.installComponent(createPackageActivationComponent({ manager: options.packageManager, pages,
      inspectExternalUses: async owned => {
        const registry = root.get<PackageRegistryPort>(packageRegistryServiceKey)!, usages = await registry.listUsages()
        for (const usage of usages) if (usage.state !== 'exited' && !owned.includes(usage.id)) {
          const proof = tryAcquirePackageUsageExitLock(dirname(registryPath), usage.id)
          // A live external role is left untouched. The registry rejects only
          // those uses affected by this exact role/app plan, including unready claims.
          if (!proof) continue
          await proof.release()
          await registry.confirmExit({ usageId: usage.id })
        }
      },
      plan: async (view, intent) => {
        const targets = await options.packageManager?.desiredTargets?.()
        return planInstalledRoles(view, { directory: dirname(registryPath), verification,
        roles: options.packageManager?.roles ?? ['client'], providers: options.providers,
        desired: (role, id) => role === 'client' ? root.get<ProductsPort>(productsServiceKey)?.get(id)?.desiredEnabled ?? false : targets?.[role]?.[id] ?? false }, intent)
      } }))
    await root.installComponent(createClientShellComponent(root, catalog, options.port, { transportSecret: options.transportSecret,
      packageManagement: () => ({ registry: root.get<PackageRegistryPort>(packageRegistryServiceKey),
        installer: root.get<PackageInstallerPort>(packageInstallerServiceKey), activation: root.get<PackageActivationPort>(packageActivationServiceKey), pages, trustedPublisherCount }) }))
    await products.restore()
    if (loaded) { const actual = await loaded.ready(); await options.packageOnReady?.(actual) }
    const server = root.get<ClientShell>(clientShellServiceKey)!
    return { root, products, url: server.url, get packages() { return root.get<PackageRegistryPort>(packageRegistryServiceKey) },
      get installer() { return root.get<PackageInstallerPort>(packageInstallerServiceKey) },
      get activation() { return root.get<PackageActivationPort>(packageActivationServiceKey) }, get packageUsage() { return loaded?.snapshot }, prepareClose, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Client startup and cleanup failed') }
    throw error
  }
}

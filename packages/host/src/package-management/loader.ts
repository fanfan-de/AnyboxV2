import { createPublicKey } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { satisfies } from 'semver'
import type { ApplicationAsset, ApplicationPackageRuntimeContext, ApplicationRegistration as RegistrationDeclaration } from '@anybox/application-api/node'
import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createApplicationCatalog } from '../applications/registration.js'
import { captureCommand, identityKey } from './domain.js'
import type { VerifiedApplicationArchive, VerifyApplicationArchiveOptions } from './archive.js'
import { acquirePackageUsageLock, type PackageUsageLock } from './usage-locks.js'
import { assertPreparedCatalog, freezePreparation, verifyPackageWebResources, type PackageAliasPolicies, type PreparedWebDeclaration } from './preparation-static.js'
import type { PackageActualCatalog, PackageCatalogSnapshot, PackageIdentity, PackageRegistryPort, PackageUseCredential } from './port.js'
import { loaderFailure, installedPackageError, assertInstalledApplicationLifecycle, verifyInstalledApplicationContainer } from './loader-files.js'
import { registerInstalledApplicationModules } from './module-loader.js'
import { captureApplicationChannelPayload } from './channel-payload.js'

export interface InstalledApplicationLoaderOptions {
  readonly directory: string
  readonly credential: PackageUseCredential
  readonly registry: Pick<PackageRegistryPort, 'claim' | 'ready'>
  readonly verification: Omit<VerifyApplicationArchiveOptions, 'signal'>
  readonly trustedAliases?: PackageAliasPolicies
  /** Application-owned construction data, opaque to the host lifecycle loader. */
  readonly roleConfig?: Readonly<Record<string, unknown>>
  /** Generic launch reservation is scoped by this loader to one signed package identity. */
  readonly startRole?: (identity: PackageIdentity, input: { readonly role: 'computer-worker'; readonly args: readonly string[]; readonly ownership: 'independent' }) => Promise<void>
  /** Private transport supplied only by the trusted role owner; identity is fixed by this loader. */
  readonly channel?: (identity: PackageIdentity, payload: unknown, signal: AbortSignal) => Promise<unknown>
  readonly commonAssets?: readonly ApplicationAsset[]
  readonly existingApplications?: readonly ApplicationRegistration[]
}
export interface LoadedInstalledApplicationCatalog {
  readonly applications: readonly ApplicationRegistration[]
  readonly snapshot: PackageCatalogSnapshot
  /** Called only after the actual role has completed its own startup. */
  ready(): Promise<PackageActualCatalog>
  /** Closes this handle. Imported code stays pinned until real process exit. */
  close(): Promise<void>
}
export interface LoadedInstalledComputerWorker {
  readonly snapshot: PackageCatalogSnapshot
  main(args: readonly string[]): Promise<void>
  ready(): Promise<PackageActualCatalog>
  close(): Promise<void>
}
// Imported ESM/CJS/native code and its lazy imports cannot be unloaded by disposing
// a Context. Strong process ownership survives successful close and failed import.
const processPins = new Map<string, PackageUsageLock>()
process.once('exit', () => { for (const pin of processPins.values()) void pin.release() })
function fail(code: string): never { throw loaderFailure(code) }
const comparable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(comparable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + comparable(item)).join(',') + '}'
  return JSON.stringify(value)
}
const contains = (prefix: string, path: string) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix.replace(/\/$/, '') + '/')
function noAccessors(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) fail('package-registration-invalid')
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Object.getOwnPropertySymbols(value).length) fail('package-registration-invalid')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) fail('package-registration-accessor')
    if (typeof descriptor.value !== 'function') noAccessors(descriptor.value, depth + 1, seen)
  }
}
function captureVerification(options: InstalledApplicationLoaderOptions['verification']): InstalledApplicationLoaderOptions['verification'] {
  return freezePreparation({ ...captureCommand({ target: options.target, applicationApiVersion: options.applicationApiVersion, runtimeProfiles: options.runtimeProfiles, limits: options.limits }),
    trustedPublishers: options.trustedPublishers.map(publisher => ({ publisher: publisher.publisher, keyId: publisher.keyId, appIds: [...publisher.appIds], publicKey: typeof publisher.publicKey === 'string' ? publisher.publicKey : createPublicKey(publisher.publicKey.export({ format: 'pem', type: 'spki' })).export({ format: 'pem', type: 'spki' }).toString() })) })
}
function checkCapabilities(archive: VerifiedApplicationArchive, role: 'client' | 'execution' | 'web' | 'computerWorker', snapshot: PackageCatalogSnapshot): void {
  const requirements = archive.manifest.capabilityRequirements?.[role]
  for (const selection of snapshot.capabilities) {
    const range = requirements?.required?.[selection.id] ?? requirements?.optional?.[selection.id]
    if (range && !satisfies(selection.version, range, { includePrerelease: true })) fail('package-loader-capability-mismatch')
  }
}
function checkRegistration(archive: VerifiedApplicationArchive, role: 'client' | 'execution', registration: ApplicationRegistration, directory: string, web: PreparedWebDeclaration | undefined, aliases?: PackageAliasPolicies): ApplicationRegistration {
  noAccessors(registration)
  if (!registration || typeof registration !== 'object' || registration.definition?.id !== archive.manifest.appId || registration.definition?.name !== archive.manifest.displayName) fail('package-registration-metadata-mismatch')
  if (comparable(registration.capabilityRequirements ?? {}) !== comparable(archive.manifest.capabilityRequirements?.[role] ?? {})) fail('package-registration-capability-mismatch')
  const assets = (registration.assets ?? []).map(asset => {
    if (typeof asset.file !== 'string' || !isAbsolute(asset.file)) return fail('package-registration-asset-invalid')
    const path = realpathSync(asset.file), name = relative(directory, path)
    if (path !== asset.file || name === '..' || name.startsWith('..' + sep) || isAbsolute(name) || !lstatSync(path).isFile()) fail('package-registration-asset-invalid')
    return { path: asset.path, file: name.split('\\').join('/'), type: asset.type }
  })
  if (comparable(assets.sort((a, b) => a.path < b.path ? -1 : 1)) !== comparable([...(role === 'client' ? web?.assets ?? [] : [])].sort((a, b) => a.path < b.path ? -1 : 1))) fail('package-registration-assets-mismatch')
  if (registration.definition.web) {
    if (role !== 'client' || !web || registration.definition.web.entry !== web.entry || comparable(registration.definition.web.styles ?? []) !== comparable(web.styles)) fail('package-registration-web-mismatch')
    const permitted = aliases?.[archive.manifest.appId]?.webLegacyRoutes ?? []
    if ((registration.definition.web.legacyRoutes ?? []).some(route => !permitted.includes(route))) fail('package-registration-route-not-owned')
  } else if (role === 'client' && web) fail('package-registration-web-mismatch')
  const routes = aliases?.[archive.manifest.appId]?.routePrefixes ?? []
  if ((registration.http?.legacyRoutes ?? []).some(route => !routes.some(prefix => contains(prefix, route.prefix)))) fail('package-registration-route-not-owned')
  return registration
}
async function claimUse(options: InstalledApplicationLoaderOptions) {
  const credential = freezePreparation(captureCommand(options.credential))
  if (processPins.has(credential.usageId)) fail('package-loader-usage-already-loaded')
  // This is intentionally before claim, file verification and every archive import.
  const lock = acquirePackageUsageLock(options.directory, credential)
  let snapshot: PackageCatalogSnapshot
  try {
    snapshot = await options.registry.claim(credential)
    if (comparable(snapshot) !== comparable(credential.snapshot)) fail('package-loader-snapshot-mismatch')
  } catch (error) { await lock.release(); throw error }
  processPins.set(credential.usageId, lock)
  return { credential, snapshot: freezePreparation(captureCommand(snapshot)) }
}
function lifecycle(options: InstalledApplicationLoaderOptions, credential: PackageUseCredential, snapshot: PackageCatalogSnapshot) {
  let closed = false
  const pending = new Set<Promise<PackageActualCatalog>>()
  return {
    ready(): Promise<PackageActualCatalog> {
      if (closed) return Promise.reject(loaderFailure('package-loader-closing'))
      const result = (async () => {
        const actual = await options.registry.ready(credential)
        if (comparable(actual.snapshot) !== comparable(snapshot)) fail('package-loader-snapshot-mismatch')
        if (closed) fail('package-loader-closing')
        return actual
      })()
      pending.add(result); void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    },
    async close(): Promise<void> { closed = true; await Promise.allSettled([...pending]) },
    check() { if (closed) fail('package-loader-closing') },
  }
}

/** Fixed role loading constructs declarations only; Products owns later business open/stop. */
export async function loadInstalledApplicationCatalog(options: InstalledApplicationLoaderOptions): Promise<LoadedInstalledApplicationCatalog> {
  options = { ...options, directory: realpathSync(resolve(options.directory)) }
  const verification = captureVerification(options.verification), aliases = options.trustedAliases ? freezePreparation(captureCommand(options.trustedAliases)) : undefined
  const roleConfig = { ...options.roleConfig }, existing = [...(options.existingApplications ?? [])], commonAssets = [...(options.commonAssets ?? [])]
  const { credential, snapshot } = await claimUse(options)
  if (snapshot.role !== 'client' && snapshot.role !== 'execution' && snapshot.role !== 'web') fail('package-loader-role-invalid')
  const applications: ApplicationRegistration[] = [], roleGates: { close(): Promise<void> }[] = []
  const referenced = new Set(snapshot.entries.map(entry => identityKey(entry.package)))
  for (const capability of snapshot.capabilities) if (capability.package && !referenced.has(identityKey(capability.package))) {
    await verifyInstalledApplicationContainer(options.directory, capability.package, verification)
    referenced.add(identityKey(capability.package))
  }
  for (const entry of snapshot.entries) {
    try {
    if (entry.entry !== snapshot.role && !(snapshot.role === 'client' && entry.entry === 'web')) fail('package-loader-entry-mismatch')
    const { archive, directory } = await verifyInstalledApplicationContainer(options.directory, entry.package, verification)
    assertInstalledApplicationLifecycle(archive)
    const role = snapshot.role as 'client' | 'execution' | 'web', web = verifyPackageWebResources(archive, aliases)
    const name = role === 'web' || entry.entry === 'web' ? undefined : archive.manifest.entries?.[role]
    checkCapabilities(archive, name ? role : 'web', snapshot)
    let registration: ApplicationRegistration
    if (!name) {
      if (role === 'execution' || !web || entry.desiredEnabled !== undefined) fail('package-loader-entry-missing')
      registration = { definition: { id: archive.manifest.appId, name: archive.manifest.displayName, icon: archive.manifest.appId, web: { entry: web.entry, styles: web.styles } },
        ...(archive.manifest.capabilityRequirements?.web ? { capabilityRequirements: archive.manifest.capabilityRequirements.web } : {}),
        assets: web.assets.map(asset => ({ ...asset, file: resolve(directory, asset.file) })) }
    } else {
      if (role === 'web') fail('package-loader-entry-mismatch')
      if (!archive.roleCompatibility[role]?.compatible) fail('package-loader-runtime-incompatible')
      const module = await registerInstalledApplicationModules(directory, archive).importEntry(name)
      if (typeof module.createRegistration !== 'function') fail('package-registration-factory-missing')
      let closed = false
      const active = new Set<object>(), startRole = options.startRole
      const channelTasks = new Map<AbortController, Promise<unknown>>()
      const cancelChannel = () => { for (const controller of channelTasks.keys()) controller.abort() }
      const drainChannel = async () => { await Promise.allSettled([...channelTasks.values()]) }
      const joinChannel = async (operation: () => Promise<void>) => {
        const [result] = await Promise.allSettled([Promise.resolve().then(operation), drainChannel()])
        if (result.status === 'rejected') throw result.reason
      }
      roleGates.push({ async close() { closed = true; active.clear(); cancelChannel(); await drainChannel() } })
      const context: ApplicationPackageRuntimeContext = Object.freeze({ phase: 'runtime', role, appId: archive.manifest.appId,
        ...(role === 'client' && options.channel ? { channel: Object.freeze({ request(payload: unknown, signal: AbortSignal) {
          if (closed || !active.size) fail('package-role-inactive')
          signal.throwIfAborted()
          const captured = captureApplicationChannelPayload(payload), controller = new AbortController()
          const abort = () => controller.abort()
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
          const result = Promise.resolve().then(() => options.channel!(archive.identity, captured, controller.signal)).then(captureApplicationChannelPayload).finally(() => {
            channelTasks.delete(controller); signal.removeEventListener('abort', abort)
          })
          channelTasks.set(controller, result)
          return result
        } }) } : {}),
        ...(startRole && archive.manifest.entries?.computerWorker ? { startRole(requested: 'computer-worker', input: { readonly args: readonly string[]; readonly ownership: 'independent' }) {
          if (closed || !active.size) fail('package-role-inactive')
          const command = captureCommand(input)
          if (requested !== 'computer-worker' || command.ownership !== 'independent' || !Array.isArray(command.args) || command.args.length > 1024 || command.args.some(value => typeof value !== 'string' || value.includes('\0')) || Buffer.byteLength(JSON.stringify(command.args)) > 65_536) fail('package-role-invalid-input')
          return startRole(archive.identity, Object.freeze({ role: requested, ownership: command.ownership, args: Object.freeze([...command.args]) }))
        } } : {}) })
      registration = await module.createRegistration(context, roleConfig[archive.manifest.appId]) as ApplicationRegistration
      checkRegistration(archive, role, registration, directory, web, aliases)
      if (!registration.createRuntime && entry.desiredEnabled !== undefined) fail('package-loader-interface-target-invalid')
      if (registration.createRuntime && (context.startRole || context.channel)) {
        const factory = registration.createRuntime
        registration = { ...registration, createRuntime(root, runtimeContext) {
          const runtime = factory(root, runtimeContext), token = {}
          return {
            inspect: () => runtime.inspect(), awaitIdle: () => joinChannel(() => runtime.awaitIdle()),
            ...(runtime.capabilities ? { capabilities: () => runtime.capabilities!() } : {}),
            async open() { if (closed) fail('package-role-inactive'); active.add(token); try { await runtime.open() } catch (error) { active.delete(token); cancelChannel(); await drainChannel(); throw error } },
            async retry() { if (closed) fail('package-role-inactive'); active.add(token); try { await runtime.retry() } catch (error) { active.delete(token); cancelChannel(); await drainChannel(); throw error } },
            async stop() { active.delete(token); cancelChannel(); await joinChannel(() => runtime.stop()) },
            closeAdmission() { active.delete(token); cancelChannel(); runtime.closeAdmission() },
          }
        } }
      }
    }
    assertPreparedCatalog([...existing, ...applications, registration] as unknown as readonly RegistrationDeclaration[], commonAssets)
    applications.push(registration)
    } catch (error) { throw installedPackageError(error, entry.package) }
  }
  const checked = createApplicationCatalog([...existing, ...applications], commonAssets).applications.slice(existing.length)
  const control = lifecycle(options, credential, snapshot)
  return Object.freeze({ applications: Object.freeze(checked), snapshot, ready: control.ready, async close() { await Promise.all(roleGates.map(gate => gate.close())); await control.close() } })
}

/** Worker bootstraps use the exact signed main; no arbitrary path or package command is accepted. */
export async function loadInstalledComputerWorkerEntry(options: InstalledApplicationLoaderOptions): Promise<LoadedInstalledComputerWorker> {
  options = { ...options, directory: realpathSync(resolve(options.directory)) }
  const verification = captureVerification(options.verification), { credential, snapshot } = await claimUse(options)
  if (snapshot.role !== 'computer-worker' || snapshot.entries.length !== 1 || snapshot.entries[0].entry !== 'computer-worker') fail('package-loader-role-invalid')
  for (const capability of snapshot.capabilities) if (capability.package && identityKey(capability.package) !== identityKey(snapshot.entries[0].package)) await verifyInstalledApplicationContainer(options.directory, capability.package, verification)
  const selected = snapshot.entries[0].package
  try {
  const { archive, directory } = await verifyInstalledApplicationContainer(options.directory, selected, verification)
  assertInstalledApplicationLifecycle(archive)
  const entry = archive.manifest.entries?.computerWorker
  if (!entry) fail('package-loader-entry-missing')
  if (!archive.roleCompatibility.computerWorker?.compatible) fail('package-loader-runtime-incompatible')
  checkCapabilities(archive, 'computerWorker', snapshot)
  const module = await registerInstalledApplicationModules(directory, archive).importEntry(entry)
  if (typeof module.main !== 'function') fail('package-loader-worker-main-missing')
  const main = module.main as (args: readonly string[]) => unknown, control = lifecycle(options, credential, snapshot)
  return Object.freeze({ snapshot, async main(args: readonly string[]) { control.check(); await main(Object.freeze([...args])) }, ready: control.ready, close: control.close })
  } catch (error) { throw installedPackageError(error, selected) }
}
export { isInstalledPackageCorruption } from './loader-files.js'

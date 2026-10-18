/** Fixed private role bootstrap. A package can select only its declared registration, never this entry. */
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPrivateRpc } from '../desktop/rpc.js'
import { createClientHost } from '../client.js'
import { createExecutionHost } from '../execution.js'
import { freezeApplicationRole } from '../applications/lifecycle.js'
import { productActivityServiceKey, type ActivityFreeze, type ProductActivityPort } from '@anybox/application-api'
import { parseApplicationArchiveJson } from './archive.js'
import { readApplicationPackageFile } from './archive-file.js'
import { readApplicationTrustPolicy, currentApplicationRuntimeProfile } from './policy.js'
import { planInstalledRoles } from './catalog-plan.js'
import { loadInstalledApplicationCatalog, type LoadedInstalledApplicationCatalog } from './loader.js'
import type { PackageRegistryPort, PackageUseCredential, PackageIdentity } from './port.js'
import { identity, identityKey } from './domain.js'
import { captureApplicationChannelPayload } from './channel-payload.js'
import { tryAcquirePackageUsageExitLock } from './usage-locks.js'
import { reclaimRemovedApplicationPackages } from './reclamation.js'
import type { ManagedRoleReady, ManagedRoleStart } from './managed-protocol.js'

const allowed = new Set(['claim', 'ready', 'inspect', 'getActivation', 'listActivations', 'prepareUse', 'confirmExit', 'recordActivationRoleReady', 'completeActivation', 'quarantineInstallation'])
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
export interface ManagedRoleRuntimeOptions {
  /** A trusted distribution may supply its fixed client composition; packages cannot choose this factory. */
  readonly createClient?: typeof createClientHost
}
export function installManagedRoleRpc(rpc: ReturnType<typeof createPrivateRpc>, exit: () => void, options: ManagedRoleRuntimeOptions = {}) {
  let client: Awaited<ReturnType<typeof createClientHost>> | undefined, execution: Awaited<ReturnType<typeof createExecutionHost>> | undefined
  let loaded: LoadedInstalledApplicationCatalog | undefined, freeze: ActivityFreeze | undefined, startup: Promise<ManagedRoleReady> | undefined, closing: Promise<void> | undefined
  let current: ManagedRoleStart | undefined, usageId: string | undefined, sourceCredential: PackageUseCredential | undefined
  let startupRegistry: PackageRegistryPort | undefined
  let channelFrozen = false
  const channelTasks = new Map<AbortController, Promise<unknown>>()
  const registry = () => { const service = client?.packages ?? startupRegistry; if (!service) fail('service-unavailable'); return service }
  const remoteRegistry = new Proxy({} as PackageRegistryPort, { get(_target, method) { if (typeof method !== 'string' || !allowed.has(method)) return undefined; return (...args: unknown[]) => rpc.call('registry', { method, args }) } })
  const close = () => closing ??= (async () => {
    await startup?.catch(() => {})
    channelFrozen = true
    for (const controller of channelTasks.keys()) controller.abort()
    try { freeze?.release(); freeze = undefined } catch (error) { throw error }
    const results = await Promise.allSettled([execution?.close(), client?.close(), ...[...channelTasks.values()].map(task => task.then(() => {}, () => {}))])
    await loaded?.close()
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Managed role channel and root cleanup failed')
  })()
  rpc.handle('start', raw => {
    if (startup || closing) fail('already-started')
    const input = raw as ManagedRoleStart
    if (!input || !['client', 'execution'].includes(input.role) || typeof input.path !== 'string' || !input.path || typeof input.packageDirectory !== 'string' || !input.packageDirectory || !Array.isArray(input.roles) || input.roles.some(role => !['client', 'execution'].includes(role)) || typeof input.transportSecret !== 'string' || !input.transportSecret || typeof input.generation !== 'string' || !input.generation) fail('invalid-startup')
    if (input.managementOnly !== undefined && (typeof input.managementOnly !== 'boolean' || input.managementOnly && (input.role !== 'client' || input.activation))) fail('invalid-startup')
    current = input
    return startup = (async () => {
      const policy = input.trustPolicyPath ? await readApplicationTrustPolicy(input.trustPolicyPath) : undefined
      const profile = currentApplicationRuntimeProfile(), verification = { trustedPublishers: policy?.trustedPublishers ?? [], target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { client: profile, execution: profile, computerWorker: profile } }
      let roleConfig: Readonly<Record<string, unknown>> | undefined
      if (input.roleConfigPath) {
        const config = parseApplicationArchiveJson(await readApplicationPackageFile(input.roleConfigPath, 1024 * 1024)) as { schemaVersion?: unknown; applications?: unknown }
        if (!config || config.schemaVersion !== 1 || !config.applications || typeof config.applications !== 'object' || Array.isArray(config.applications)) fail('invalid-role-config')
        roleConfig = Object.fromEntries(Object.entries(config.applications).map(([id, options]) => [id, options && typeof options === 'object' ? (options as Record<string, unknown>)[input.role] : undefined]))
      }
      if (input.role === 'client') {
        client = await (options.createClient ?? createClientHost)({ path: input.path, port: 0, packageDirectory: input.packageDirectory, packageTrustPolicy: policy,
          applications: [], transportSecret: input.transportSecret, packageRoleConfig: roleConfig, packageManagementOnly: input.managementOnly,
          packageManager: { roles: input.roles, freeze: () => rpc.call('peers.freeze'), release: () => rpc.call('peers.release'), ownedUsageIds: () => rpc.call('peers.owned'), desiredTargets: () => rpc.call('peers.targets'), closeTargets: appIds => rpc.call('peers.close-targets', { appIds }), handoff: launch => rpc.call('activation.stage', launch) },
          packageBootstrap: async packages => {
            startupRegistry = packages
            // Reconcile only an OS-proven exit. A disconnected independent
            // role keeps its lock and remains visible; no role is restarted here.
            let unconfirmed = false
            for (const use of await packages.listUsages()) if (use.state !== 'exited') {
              let proof
              try { proof = tryAcquirePackageUsageExitLock(input.packageDirectory, use.id) }
              catch (error) {
                if (!(error instanceof Error) || error.name !== 'PackageUsageLockError' || !('code' in error) || error.code !== 'unavailable') throw error
                // An old/unverifiable anchor must not prevent management from
                // observing the durable facts. It supplies no exit evidence.
                unconfirmed = true; continue
              }
              if (!proof) continue
              await proof.release()
              await packages.confirmExit({ usageId: use.id })
            }
            if (unconfirmed && !input.managementOnly) fail('package-role-exit-unconfirmed')
            if (!input.activation) return undefined
            let activation = await packages.getActivation(input.activation.id); if (!activation) fail('not-found')
            // A prior failed new role must actually exit before any second owner can import.
            for (const role of activation.roles) for (const id of role.usageIds) if (id !== role.handoffUsageId) await packages.confirmExit({ usageId: id })
            activation = (await packages.getActivation(activation.id))!
            const launch = await packages.adoptActivation({ activationId: activation.id, expectedRevision: activation.revision,
              parents: input.activation.parents, holderId: 'managed-role', generation: input.generation })
            await rpc.call('activation.adopted', launch)
            // Parent acknowledgement proves fresh anchors were acquired before these are released.
            for (const parent of input.activation.parents) await packages.confirmExit({ usageId: parent.usageId })
            const credential = launch.credentials.find(item => item.snapshot.role === 'client')
            if (!credential) fail('activation-client-role-missing')
            usageId = credential.usageId
            return credential
          },
          packageOnCredential: credential => { sourceCredential = credential },
          packageChannel: (identity, payload, signal) => {
            if (!sourceCredential || channelFrozen || closing) fail('application-channel-unavailable')
            return rpc.call('channel.request', { source: { usageId: sourceCredential.usageId, secret: sourceCredential.secret }, identity, payload }, signal)
          },
          packageStartRole: async (identity, request) => {
            if (!sourceCredential) fail('role-launch-unavailable')
            await rpc.call('role.launch', { source: { usageId: sourceCredential.usageId, secret: sourceCredential.secret }, identity, ...request })
          },
          packageOnReady: async actual => { usageId = actual.usage.id },
        })
        startupRegistry = undefined
        return { role: input.role, generation: input.generation, url: client.url, ...(usageId ? { usageId } : {}) }
      }
      if (!input.credential || input.credential.snapshot.role !== 'execution') fail('invalid-startup')
      loaded = await loadInstalledApplicationCatalog({ directory: input.packageDirectory, credential: input.credential, registry: remoteRegistry, verification, trustedAliases: policy?.trustedAliases, roleConfig,
        startRole: async (identity, request) => { await rpc.call('role.launch', { source: { usageId: input.credential!.usageId, secret: input.credential!.secret }, identity, ...request }) } })
      execution = await createExecutionHost({ databasePath: input.executionPath ?? resolve(dirname(input.path), 'execution.sqlite'), applications: loaded.applications, port: 0, name: 'Anybox execution' })
      await execution.ready
      const actual = await loaded.ready(); usageId = actual.usage.id
      return { role: input.role, generation: input.generation, url: execution.url, instanceId: execution.instance.instanceId, usageId }
    })()
  })
  rpc.handle('registry', async raw => {
    const input = raw as { method: string; args: unknown[] }
    if (!input || !allowed.has(input.method) || !Array.isArray(input.args)) fail('invalid-input')
    const service = registry(), method = service[input.method as keyof PackageRegistryPort]
    if (typeof method !== 'function') fail('invalid-input')
    return Reflect.apply(method, service, input.args)
  })
  rpc.handle('channel.authorize', raw => {
    const input = raw as { source?: { usageId?: unknown; secret?: unknown }; identity?: unknown }
    if (current?.role !== 'client' || channelFrozen || closing || !sourceCredential || input?.source?.usageId !== sourceCredential.usageId || input.source.secret !== sourceCredential.secret) fail('application-channel-unavailable')
    const selected = identity(input.identity)
    if (!sourceCredential.snapshot.entries.some(entry => entry.entry === 'client' && identityKey(entry.package) === identityKey(selected))) fail('application-channel-identity-mismatch')
    return true
  })
  rpc.handle('channel.request', (raw, signal) => {
    const input = raw as { usageId?: unknown; identity?: unknown; payload?: unknown }
    if (current?.role !== 'execution' || channelFrozen || closing || !execution || !loaded || input?.usageId !== current.credential?.usageId || signal.aborted) fail('application-channel-unavailable')
    const selected = identity(input.identity)
    if (!loaded.snapshot.entries.some(entry => entry.entry === 'execution' && identityKey(entry.package) === identityKey(selected))) fail('application-channel-identity-mismatch')
    const application = loaded.applications.find(app => app.definition.id === selected.appId)
    if (!application?.channel) fail('application-channel-unavailable')
    const payload = captureApplicationChannelPayload(input.payload), controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const context = Object.freeze({ signal: controller.signal, sourceRole: 'client' as const, appId: selected.appId })
    const result = Promise.resolve().then(() => application.channel!.handle(execution!.root, payload, context)).then(captureApplicationChannelPayload).finally(() => {
      channelTasks.delete(controller); signal.removeEventListener('abort', abort)
    })
    channelTasks.set(controller, result)
    return result
  })
  rpc.handle('role.reserve', async raw => {
    const role = (raw as { role?: unknown })?.role
    if (role !== 'execution' || !current?.roles.includes(role)) fail('invalid-input')
    const packages = registry(), unresolved = (await packages.listActivations()).some(item => item.phase !== 'completed' && item.phase !== 'cancelled')
    if (unresolved) return undefined
    const view = await packages.inspect(), policy = current.trustPolicyPath ? await readApplicationTrustPolicy(current.trustPolicyPath) : undefined, profile = currentApplicationRuntimeProfile()
    const plans = await planInstalledRoles(view, { directory: current.packageDirectory, verification: { trustedPublishers: policy?.trustedPublishers ?? [], target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { client: profile, execution: profile, computerWorker: profile } }, roles: [role] })
    const plan = plans[0]
    if (!plan?.entries.length) return undefined
    return packages.prepareUse({ ...plan, expectedRegistryRevision: view.revision, holderId: 'managed-execution', generation: randomUUID() })
  })
  rpc.handle('role.reserve-related', async raw => {
    const input = raw as { source: { usageId: string; secret: string }; identity: PackageIdentity; role: string; senderRole: string }
    if (!input || input.role !== 'computer-worker' || !['client', 'execution'].includes(input.senderRole) || !current) fail('invalid-input')
    const packages = registry(), source = await packages.validateUse(input.source)
    if (source.role !== input.senderRole || !source.entries.some(entry => identityKey(entry.package) === identityKey(input.identity))) fail('role-launch-unavailable')
    const view = await packages.inspect(), facts = view.applications.find(app => app.appId === input.identity.appId)
    if (!facts?.selected || identityKey(facts.selected) !== identityKey(input.identity)) fail('role-launch-unavailable')
    const policy = current.trustPolicyPath ? await readApplicationTrustPolicy(current.trustPolicyPath) : undefined, profile = currentApplicationRuntimeProfile()
    const plans = await planInstalledRoles({ ...view, applications: [facts] }, { directory: current.packageDirectory,
      verification: { trustedPublishers: policy?.trustedPublishers ?? [], target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { computerWorker: profile } }, roles: ['computer-worker'] })
    const plan = plans[0]
    if (!plan || plan.entries.length !== 1) fail('role-entry-missing')
    return packages.prepareUse({ ...plan, expectedRegistryRevision: view.revision, holderId: 'independent-role', generation: randomUUID() })
  })
  rpc.handle('activation.finish', async raw => {
    const input = raw as { id: string; previousUsageIds: readonly string[] }, packages = registry()
    try {
      let activation = await packages.getActivation(input.id); if (!activation) fail('not-found')
      const actual = (await packages.inspect()).actual
      const readyIds = new Set(activation.roles.map(role => actual.find(item => item.snapshot.role === role.role && item.usage.state === 'ready' && role.usageIds.includes(item.usage.id))?.usage.id))
      for (const id of new Set([...input.previousUsageIds, ...activation.supersededUsageIds, ...activation.roles.flatMap(role => role.usageIds)])) if (!readyIds.has(id)) await packages.confirmExit({ usageId: id })
      for (const role of activation.roles) {
        const ready = actual.find(item => item.snapshot.role === role.role && item.usage.state === 'ready' && role.usageIds.includes(item.usage.id))
        if (!ready) fail('activation-role-not-ready')
        activation = await packages.recordActivationRoleReady({ activationId: activation.id, expectedRevision: activation.revision, usageId: ready.usage.id })
      }
      activation = await packages.completeActivation({ activationId: activation.id, expectedRevision: activation.revision })
      if (activation.kind === 'remove' && activation.phase === 'reclaiming') {
        if (!current) fail('service-unavailable')
        return reclaimRemovedApplicationPackages({ registry: packages, directory: current.packageDirectory, activationId: activation.id })
      }
      return activation
    } catch (error) {
      const activation = await packages.getActivation(input.id)
      if (activation && activation.phase !== 'completed' && activation.phase !== 'cancelled') {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'activation-failed'
        await packages.interruptActivation({ activationId: activation.id, expectedRevision: activation.revision, errorCode: code })
      }
      throw error
    }
  })
  rpc.handle('freeze', async () => {
    const host = execution ?? client; if (!host) fail('service-unavailable')
    channelFrozen = true
    try { freeze ??= await freezeApplicationRole(host.products, host.root.get<ProductActivityPort>(productActivityServiceKey)!) }
    catch (error) { channelFrozen = false; throw error }
    return { busy: false }
  })
  rpc.handle('release', () => { freeze?.release(); freeze = undefined; channelFrozen = false })
  rpc.handle('targets', () => Object.fromEntries((execution ?? client)?.products.list().map(app => [app.definition.id, app.desiredEnabled]) ?? []))
  rpc.handle('close-targets', async raw => {
    const host = execution ?? client, input = raw as { appIds?: readonly string[] }
    if (!freeze || !host?.products.setClosedTargets || !Array.isArray(input?.appIds)) fail('activation-coordination-unavailable')
    await host.products.setClosedTargets(input.appIds)
  })
  rpc.handle('close', async () => { await close(); setImmediate(() => { rpc.disconnect(); exit() }) })
  return { close }
}
export function installManagedRoleProcess(options: ManagedRoleRuntimeOptions = {}) {
  if (!process.send) throw new Error('A managed role requires a private process channel')
  const rpc = createPrivateRpc(message => { if (process.connected) process.send!(message) })
  process.on('message', message => rpc.receive(message))
  const exit = () => { if (process.connected) process.disconnect(); process.exit(0) }
  const runtime = installManagedRoleRpc(rpc, exit, options)
  process.once('disconnect', () => { void runtime.close().then(exit, () => { process.exitCode = 1; setInterval(() => {}, 60_000) }) })
  process.once('SIGTERM', () => { void runtime.close().then(exit, () => { process.exitCode = 1 }) })
  return runtime
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) installManagedRoleProcess()

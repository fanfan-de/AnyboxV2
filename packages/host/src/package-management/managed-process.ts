import { fork } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateRpc, rpcFailure } from '../desktop/rpc.js'
import { captureCommand, identifier, identity, identityKey } from './domain.js'
import type { ManagedRoleReady, ManagedRoleStart } from './managed-protocol.js'
import type { PackageActivationLaunch, PackageUseCredential } from './port.js'
import { startManagedRoleProxy } from './role-proxy.js'
import { readApplicationTrustPolicy, currentApplicationRuntimeProfile } from './policy.js'
import { acquirePackageUsageLock } from './usage-locks.js'
import type { PackageUsageLock } from './usage-locks.js'
import { captureApplicationChannelPayload } from './channel-payload.js'

type Role = ManagedRoleStart['role']
type Rpc = ReturnType<typeof createPrivateRpc>
interface OwnedRole {
  readonly role: Role
  readonly generation: string
  readonly child: ManagedRoleChild
  readonly rpc: Rpc
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  ready?: ManagedRoleReady
  ended: boolean
  stopping: boolean
  outcome?: { code: number | null; signal: NodeJS.Signals | null }
  credential?: PackageUseCredential
}
interface HeldUse { readonly credential: PackageUseCredential; readonly lock: PackageUsageLock }
/** Trusted Node/Electron process adapters expose only the private lifecycle transport. */
export interface ManagedRoleChild {
  readonly connected: boolean
  readonly stdout?: Readable | null
  readonly stderr?: Readable | null
  send(message: unknown, callback?: (error: Error | null) => void): unknown
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
}
export interface ManagedApplicationHostOptions {
  readonly path: string
  readonly packageDirectory: string
  readonly port?: number
  readonly trustPolicyPath?: string
  readonly roles?: readonly Role[]
  readonly executionPath?: string
  readonly roleConfigPath?: string
  /** A trusted composition root may choose its own fixed client adapter. Never package metadata or browser input. */
  readonly clientEntry?: URL
  readonly roleEntry?: URL
  readonly createChild?: (entry: URL, role: Role) => ManagedRoleChild
  readonly incomingTransportSecret?: string
}
export interface ManagedApplicationHostState {
  readonly phase: 'starting' | 'ready' | 'restarting' | 'recovery-required' | 'failed' | 'closing' | 'closed'
  readonly activationId: string | null
  readonly errorCode: string | null
  readonly roles: readonly { readonly role: Role; readonly generation: string; readonly ready: boolean; readonly exited: boolean }[]
}
export interface ManagedApplicationHost {
  readonly url: string
  readonly state: ManagedApplicationHostState
  /** Stops only processes owned by this manager and waits for confirmed process exits. */
  close(): Promise<void>
  inspect(): Promise<{ readonly busy: boolean }>
  inspectForQuit(): Promise<{ readonly busy: boolean }>
  releaseQuit(): Promise<void>
}
const safeCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(error.code) ? error.code : 'managed-role-failed'
const path = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw rpcFailure('invalid-startup')
  return resolve(value)
}
const registryMethods = new Set(['claim', 'ready', 'inspect', 'getActivation', 'prepareUse', 'confirmExit', 'recordActivationRoleReady', 'completeActivation'])
function roleReady(value: unknown, role: OwnedRole): ManagedRoleReady {
  const result = captureCommand(value) as ManagedRoleReady
  if (!result || result.role !== role.role || result.generation !== role.generation || typeof result.url !== 'string') throw rpcFailure('invalid-role-ready')
  const url = new URL(result.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || result.usageId !== undefined && typeof result.usageId !== 'string') throw rpcFailure('invalid-role-ready')
  if (result.usageId !== undefined) identifier(result.usageId)
  return Object.freeze(result)
}

/**
 * A lifecycle-only process owner. It never opens a Nya root, registry connection,
 * application database, credential store, or an application package module.
 */
export async function startManagedApplicationHost(options: ManagedApplicationHostOptions): Promise<ManagedApplicationHost> {
  const captured = captureCommand({ path: options.path, packageDirectory: options.packageDirectory, port: options.port, trustPolicyPath: options.trustPolicyPath, roles: options.roles, executionPath: options.executionPath, roleConfigPath: options.roleConfigPath, incomingTransportSecret: options.incomingTransportSecret })
  const databasePath = path(captured.path), directory = path(captured.packageDirectory)
  const roles: readonly Role[] = Object.freeze(captured.roles === undefined ? ['client', 'execution'] : [...captured.roles])
  if (!roles.length || new Set(roles).size !== roles.length || !roles.includes('client') || roles.some(role => !['client', 'execution'].includes(role))) throw rpcFailure('invalid-startup')
  if (captured.port !== undefined && (!Number.isInteger(captured.port) || captured.port < 0 || captured.port > 65535)) throw rpcFailure('invalid-startup')
  const trustPolicyPath = captured.trustPolicyPath === undefined ? undefined : path(captured.trustPolicyPath)
  const executionPath = captured.executionPath === undefined ? undefined : path(captured.executionPath)
  const roleConfigPath = captured.roleConfigPath === undefined ? undefined : path(captured.roleConfigPath)
  const roleEntry = options.roleEntry === undefined ? new URL('./role-process.js', import.meta.url) : new URL(options.roleEntry.href)
  const clientEntry = options.clientEntry === undefined ? roleEntry : new URL(options.clientEntry.href)
  if ([roleEntry, clientEntry].some(entry => entry.protocol !== 'file:' || entry.search || entry.hash) || options.createChild !== undefined && typeof options.createChild !== 'function') throw rpcFailure('invalid-startup')
  const createChild = options.createChild ?? ((entry: URL) => fork(fileURLToPath(entry), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', execArgv: [] }))
  const transportSecret = randomBytes(32).toString('base64url'), children = new Map<Role, OwnedRole>(), allChildren = new Set<OwnedRole>(), frozenPeers = new Set<OwnedRole>()
  const parentUses = new Map<string, HeldUse>(), adoptedUses = new Map<string, HeldUse>(), independentParents = new Map<string, HeldUse>()
  const acceptedLaunches = new Set<Promise<unknown>>(), independentExits = new Set<Promise<unknown>>()
  const channelTasks = new Map<AbortController, Promise<unknown>>()
  const launchFreezeReasons = new Set<'activation' | 'inspection' | 'closing'>(), inspectionRoles = new Set<OwnedRole>()
  let inspectionTask: Promise<{ busy: boolean }> | undefined
  let phase: ManagedApplicationHostState['phase'] = 'starting', errorCode: string | null = null, activationId: string | null = null
  let currentClient: OwnedRole | undefined, closing = false, shutdown: Promise<void> | undefined, restartTask: Promise<void> | undefined, restartTimer: ReturnType<typeof setTimeout> | undefined
  let staged: PackageActivationLaunch | undefined, adopted: PackageActivationLaunch | undefined
  const target = () => !closing && (phase === 'ready' || phase === 'recovery-required') ? currentClient?.ready?.url : undefined
  const proxy = await startManagedRoleProxy({ port: captured.port, target, transportSecret, incomingTransportSecret: captured.incomingTransportSecret })
  const failure = (error: unknown): void => { errorCode ??= safeCode(error); if (!closing) phase = 'failed' }
  const acquireUses = async (credentials: readonly PackageUseCredential[], destination: Map<string, HeldUse>): Promise<void> => {
    const acquired: HeldUse[] = []
    try {
      for (const credential of credentials) {
        const previous = destination.get(credential.usageId)
        if (previous) { if (previous.credential.secret !== credential.secret) throw rpcFailure('request-conflict'); continue }
        const use = { credential, lock: acquirePackageUsageLock(directory, credential) }; acquired.push(use)
      }
      for (const use of acquired) destination.set(use.credential.usageId, use)
    } catch (error) {
      const released = await Promise.allSettled(acquired.map(use => use.lock.release()))
      const failures: unknown[] = []
      released.forEach((result, index) => {
        if (result.status === 'rejected') {
          // A failed rollback is still this manager's resource. Retain its
          // handle so neither recovery nor shutdown can invent a released pin.
          const use = acquired[index]!
          destination.set(use.credential.usageId, use); failures.push(result.reason)
        }
      })
      if (failures.length) throw new AggregateError([error, ...failures], 'Managed launch reservation cleanup failed')
      throw error
    }
  }
  const releaseUses = async (uses: Map<string, HeldUse>, ids?: readonly string[]): Promise<void> => {
    const selected = ids === undefined ? [...uses.values()] : ids.flatMap(id => uses.has(id) ? [uses.get(id)!] : [])
    const results = await Promise.allSettled(selected.map(use => use.lock.release())), errors: unknown[] = []
    results.forEach((result, index) => { if (result.status === 'fulfilled') uses.delete(selected[index]!.credential.usageId); else errors.push(result.reason) })
    if (errors.length) throw new AggregateError(errors, 'Managed launch reservations did not confirm release')
  }
  const launchShape = (value: unknown): PackageActivationLaunch => {
    const launch = captureCommand(value) as PackageActivationLaunch
    if (!launch || !launch.activation || typeof launch.activation.id !== 'string' || !Array.isArray(launch.credentials) || !Array.isArray(launch.activation.roles) || launch.credentials.length !== launch.activation.roles.length || !launch.credentials.length || launch.credentials.length > roles.length) throw rpcFailure('invalid-activation-launch')
    identifier(launch.activation.id)
    const launchedRoles = launch.credentials.map(credential => credential.snapshot?.role)
    if (!launchedRoles.includes('client') || new Set(launchedRoles).size !== launchedRoles.length || launchedRoles.some(role => !roles.includes(role as Role)) || new Set(launch.credentials.map(credential => credential.usageId)).size !== launch.credentials.length) throw rpcFailure('invalid-activation-launch')
    for (const credential of launch.credentials) {
      identifier(credential.usageId)
      if (typeof credential.secret !== 'string' || !credential.secret || credential.secret.length > 256 || !launch.activation.roles.some(role => role.role === credential.snapshot.role && role.usageIds.includes(credential.usageId))) throw rpcFailure('invalid-activation-launch')
    }
    return launch
  }
  const releasePeers = async (): Promise<void> => {
    const results = await Promise.allSettled([...frozenPeers].map(async role => { if (!role.ended) await role.rpc.call('release'); frozenPeers.delete(role) }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Managed peer protection cleanup failed')
    launchFreezeReasons.delete('activation')
  }
  const freezePeers = async (): Promise<void> => {
    if (launchFreezeReasons.has('inspection')) throw rpcFailure('product-busy')
    launchFreezeReasons.add('activation')
    if (phase === 'recovery-required') {
      if ([...allChildren].some(role => role !== currentClient && !role.ended)) throw rpcFailure('managed-role-exit-unconfirmed')
      await releaseUses(parentUses); await releaseUses(adoptedUses); await releaseUses(independentParents)
    }
    while (acceptedLaunches.size) await Promise.allSettled([...acceptedLaunches])
    try {
      for (const role of children.values()) if (role.role !== 'client' && !role.ended && !frozenPeers.has(role)) {
        const result = await role.rpc.call<{ busy?: boolean } | undefined>('freeze')
        if (result?.busy) throw rpcFailure('product-busy')
        frozenPeers.add(role)
      }
    } catch (error) {
      try { await releasePeers() } catch (cleanup) { failure(cleanup); throw new AggregateError([error, cleanup], 'Managed peer protection failed') }
      throw error
    }
  }
  const spawnRole = (kind: Role): OwnedRole => {
    if (closing || children.get(kind) && !children.get(kind)!.ended) throw rpcFailure(closing ? 'service-closing' : 'role-already-running')
    const generation = randomUUID()
    const entry = kind === 'client' ? clientEntry : roleEntry
    const child = createChild(entry, kind)
    const rpc = createPrivateRpc(message => {
      if (!child.connected) throw rpcFailure('worker-unavailable')
      child.send(message, error => { if (error) rpc.disconnect() })
    })
    let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveExit = resolve })
    const role: OwnedRole = { role: kind, generation, child, rpc, exited, ended: false, stopping: false }
    children.set(kind, role); allChildren.add(role)
    if (kind === 'client') currentClient = role
    child.on('message', message => rpc.receive(message))
    child.on('error', () => { rpc.disconnect(); failure(rpcFailure('managed-role-start-failed')) })
    child.on('disconnect', () => { rpc.disconnect(); if (!role.stopping && !role.ended) failure(rpcFailure('managed-role-disconnected')) })
    child.once('exit', (code, signal) => { role.ended = true; role.outcome = { code, signal }; rpc.disconnect(); if (!role.stopping) failure(rpcFailure('managed-role-exited')) })
    child.once('close', (code, signal) => { role.ended = true; role.outcome ??= { code, signal }; resolveExit(role.outcome); rpc.disconnect() })
    // The role owns its logging policy. Private RPC values are never printed.
    child.stdout?.pipe(process.stdout, { end: false }); child.stderr?.pipe(process.stderr, { end: false })
    rpc.handle('peers.owned', () => {
      if (kind !== 'client' || role !== currentClient) throw rpcFailure('worker-unavailable')
      return [...children.values()].flatMap(child => !child.ended && child.ready?.usageId ? [child.ready.usageId] : [])
    })
    rpc.handle('peers.targets', async () => {
      if (kind !== 'client' || role !== currentClient || closing) throw rpcFailure('worker-unavailable')
      const result: Record<string, Record<string, boolean>> = {}
      for (const peer of children.values()) if (peer.role !== 'client' && !peer.ended) {
        const value = captureCommand(await peer.rpc.call('targets')) as Record<string, unknown>
        if (!value || Array.isArray(value) || Object.values(value).some(target => typeof target !== 'boolean')) throw rpcFailure('invalid-role-targets')
        result[peer.role] = value as Record<string, boolean>
      }
      return result
    })
    rpc.handle('peers.close-targets', async raw => {
      if (kind !== 'client' || role !== currentClient || closing || !launchFreezeReasons.has('activation')) throw rpcFailure('activation-coordination-unavailable')
      const input = captureCommand(raw) as { appIds?: readonly string[] }
      if (!Array.isArray(input?.appIds) || !input.appIds.length || input.appIds.length > 10_000 || new Set(input.appIds).size !== input.appIds.length) throw rpcFailure('invalid-input')
      for (const id of input.appIds) identifier(id)
      for (const peer of children.values()) if (peer.role !== 'client' && !peer.ended) {
        if (!frozenPeers.has(peer)) throw rpcFailure('activation-coordination-unavailable')
        await peer.rpc.call('close-targets', input)
      }
    })
    rpc.handle('peers.freeze', async () => { if (kind !== 'client' || role !== currentClient || closing) throw rpcFailure('service-closing'); await freezePeers() })
    rpc.handle('peers.release', async () => { if (kind !== 'client' || role !== currentClient) throw rpcFailure('worker-unavailable'); await releasePeers() })
    rpc.handle('registry', (value, signal) => {
      if (kind === 'client' || !currentClient || currentClient.ended) throw rpcFailure('registry-unavailable')
      const input = captureCommand(value) as { method?: unknown; args?: unknown }
      if (!input || typeof input.method !== 'string' || !registryMethods.has(input.method) || !Array.isArray(input.args)) throw rpcFailure('unsupported-operation')
      return currentClient.rpc.call('registry', input, signal)
    })
    rpc.handle('channel.request', (raw, signal) => {
      const available = () => !closing && phase === 'ready' && launchFreezeReasons.size === 0 && kind === 'client' && role === currentClient && children.get(kind) === role && !role.ended && !role.stopping && !!role.ready?.usageId
      if (!available()) throw rpcFailure('application-channel-unavailable')
      const input = raw as { source?: { usageId?: unknown; secret?: unknown }; identity?: unknown; payload?: unknown }
      if (!input?.source || input.source.usageId !== role.ready!.usageId || typeof input.source.secret !== 'string' || !input.source.secret || input.source.secret.length > 256) throw rpcFailure('application-channel-unavailable')
      const selected = identity(input.identity), payload = captureApplicationChannelPayload(input.payload)
      const target = children.get('execution')
      if (!target?.ready?.usageId || target.ended || target.stopping || !target.credential || target.ready.usageId !== target.credential.usageId) throw rpcFailure('application-channel-unavailable')
      if (!target.credential.snapshot.entries.some(entry => entry.entry === 'execution' && identityKey(entry.package) === identityKey(selected))) throw rpcFailure('application-channel-identity-mismatch')
      const controller = new AbortController(), abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      const operation = (async () => {
        const authorized = await role.rpc.call('channel.authorize', { source: input.source, identity: selected }, controller.signal)
        if (authorized !== true || !available() || children.get('execution') !== target || target.ended || target.stopping) throw rpcFailure('application-channel-unavailable')
        return captureApplicationChannelPayload(await target.rpc.call('channel.request', { usageId: target.ready!.usageId, identity: selected, payload }, controller.signal))
      })().finally(() => { channelTasks.delete(controller); signal.removeEventListener('abort', abort) })
      channelTasks.set(controller, operation)
      return operation
    })
    rpc.handle('role.launch', value => {
      if (closing || launchFreezeReasons.size !== 0 || phase === 'failed' || phase === 'closed' || children.get(kind) !== role || role.ended || role.stopping) throw rpcFailure('role-launch-unavailable')
      const input = captureCommand(value) as { source?: { usageId: string; secret: string }; identity?: unknown; role?: unknown; args?: unknown; ownership?: unknown }
      if (!input || input.role !== 'computer-worker' || input.ownership !== 'independent' || !input.source || typeof input.source.secret !== 'string' || !input.source.secret || input.source.secret.length > 256 || !Array.isArray(input.args) || input.args.length > 256 || input.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(input.args)) > 65_536) throw rpcFailure('invalid-role-launch')
      identifier(input.source.usageId)
      const selected = identity(input.identity), source = input.source, args = input.args as readonly string[]
      const operation = (async () => {
        const owner = currentClient
        if (!owner || owner.ended) throw rpcFailure('registry-unavailable')
        const credential = await owner.rpc.call<PackageUseCredential>('role.reserve-related', { source, identity: selected, role: 'computer-worker', senderRole: kind })
        if (!credential || credential.snapshot.role !== 'computer-worker' || credential.snapshot.entries.length !== 1 || credential.snapshot.entries[0]?.entry !== 'computer-worker' || identityKey(credential.snapshot.entries[0].package) !== identityKey(selected)) throw rpcFailure('invalid-role-reservation')
        await acquireUses([credential], independentParents)
        let launchStarted = false
        try {
          const { launchIndependentInstalledRole } = await import('./independent-role.js')
          const policy = trustPolicyPath ? await readApplicationTrustPolicy(trustPolicyPath) : undefined, profile = currentApplicationRuntimeProfile()
          launchStarted = true
          const independent = await launchIndependentInstalledRole({ directory, credential, trustPolicyPath, args,
            verification: { trustedPublishers: policy?.trustedPublishers ?? [], target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { computerWorker: profile } },
            registry: {
              claim: value => owner.rpc.call('registry', { method: 'claim', args: [value] }),
              ready: value => owner.rpc.call('registry', { method: 'ready', args: [value] }),
            } })
          await releaseUses(independentParents, [credential.usageId])
          const observation = independent.exited.then(() => {}, () => {})
          independentExits.add(observation); void observation.finally(() => independentExits.delete(observation))
          // This process is now independently owned. Host close never stops it.
          return { pid: independent.pid, usageId: independent.usageId }
        } catch (error) {
          // Policy/import failures precede the launcher entirely. Once it is
          // called, only its explicit no-child/actual-exit proof permits release.
          if (!launchStarted || error && typeof error === 'object' && 'exitConfirmed' in error && error.exitConfirmed === true) await releaseUses(independentParents, [credential.usageId])
          throw error
        }
      })()
      acceptedLaunches.add(operation); void operation.finally(() => acceptedLaunches.delete(operation)).catch(() => {})
      return operation
    })
    rpc.handle('activation.stage', async value => {
      if (kind !== 'client' || role !== currentClient || closing || phase !== 'ready' && phase !== 'recovery-required') throw rpcFailure('activation-manager-unavailable')
      const launch = launchShape(value)
      if (staged) {
        if (staged.activation.id !== launch.activation.id) throw rpcFailure('activation-busy')
        if (phase !== 'recovery-required') {
          if (JSON.stringify(staged.credentials) !== JSON.stringify(launch.credentials)) throw rpcFailure('activation-busy')
          return { accepted: true }
        }
        if (parentUses.size || adoptedUses.size || [...allChildren].some(previous => previous !== currentClient && !previous.ended)) throw rpcFailure('managed-role-exit-unconfirmed')
      }
      try { await acquireUses(launch.credentials, parentUses) }
      catch (error) {
        // Selection is already durable, but the old client must first finish
        // recording this RPC failure. Recovery runs after returning the error,
        // closes the frozen applications and never replays their activation.
        staged = launch; adopted = undefined; activationId = launch.activation.id; failure(error)
        restartTimer = setTimeout(() => {
          restartTimer = undefined
          if (closing) return
          restartTask = recoverManagement().catch(recovery => { failure(recovery) })
        }, 0)
        throw error
      }
      staged = launch; adopted = undefined; activationId = launch.activation.id
      // The acknowledgment releases the old client's accepted commit. Its root
      // must never wait for the restart that first requires that root to close.
      restartTimer = setTimeout(() => {
        restartTimer = undefined
        if (closing) return
        restartTask = restart(launch).catch(async error => {
          failure(error)
          if (!closing) { try { await recoverManagement() } catch (recovery) { failure(recovery) } }
        })
      }, 0)
      return { accepted: true }
    })
    rpc.handle('activation.adopted', async value => {
      if (kind !== 'client' || role !== currentClient || closing || phase !== 'restarting' || !staged) throw rpcFailure('activation-manager-unavailable')
      const launch = launchShape(value)
      if (launch.activation.id !== staged.activation.id) throw rpcFailure('request-conflict')
      if (adopted && JSON.stringify(adopted.credentials) !== JSON.stringify(launch.credentials)) throw rpcFailure('request-conflict')
      await acquireUses(launch.credentials, adoptedUses)
      // Every new role reservation is held before any old handoff lock leaves.
      await releaseUses(parentUses)
      adopted = launch
      return { accepted: true }
    })
    return role
  }
  const startRole = async (kind: Role, extra: Pick<ManagedRoleStart, 'credential' | 'activation' | 'managementOnly'> = {}): Promise<OwnedRole> => {
    const role = spawnRole(kind)
    role.credential = extra.credential
    const options: ManagedRoleStart = { role: kind, path: databasePath, packageDirectory: directory, executionPath, trustPolicyPath, roleConfigPath, roles, generation: role.generation, transportSecret, ...extra }
    const result = await role.rpc.call('start', options)
    if (role.ended) throw rpcFailure('managed-role-exited')
    role.ready = roleReady(result, role)
    if (extra.credential && role.ready.usageId !== extra.credential.usageId) throw rpcFailure('invalid-role-ready')
    return role
  }
  const closeRole = async (role: OwnedRole): Promise<void> => {
    if (role.ended) { const result = await role.exited; if (result.code !== 0 || result.signal !== null || !role.stopping) throw rpcFailure('managed-role-exited'); return }
    role.stopping = true
    try { await role.rpc.call('close') }
    catch (error) {
      // IPC disconnect can precede the actual exit event. Observe that exit; it
      // is never inferred from transport loss or a deadline.
      if (!role.child.connected && !role.ended) await role.exited
      if (!role.ended || role.outcome?.code !== 0 || role.outcome.signal !== null) throw error
    }
    const result = await role.exited
    if (result.code !== 0 || result.signal !== null) throw rpcFailure('managed-role-shutdown-failed')
    frozenPeers.delete(role); inspectionRoles.delete(role)
  }
  const closeRoles = async (): Promise<void> => {
    const errors: unknown[] = []
    const peers = [...children.values()].filter(role => role.role !== 'client')
    for (const role of peers) { try { await closeRole(role) } catch (error) { errors.push(error) } }
    // A live peer may still need the sole writer for its cleanup receipts.
    if (peers.some(role => !role.ended)) throw new AggregateError(errors, 'Managed peer exit remains unconfirmed')
    if (currentClient) { try { await closeRole(currentClient) } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'Managed roles did not confirm clean exit')
  }
  const startExecution = async (credential: PackageUseCredential | undefined): Promise<void> => {
    if (!credential || !roles.includes('execution')) return
    if (credential.snapshot.role !== 'execution' || !credential.snapshot.entries.length) throw rpcFailure('invalid-role-reservation')
    await acquireUses([credential], adoptedUses)
    const execution = await startRole('execution', { credential })
    if (!execution.ready || execution.ready.usageId !== credential.usageId) throw rpcFailure('invalid-role-ready')
    await releaseUses(adoptedUses, [credential.usageId])
  }
  const restart = async (launch: PackageActivationLaunch): Promise<void> => {
    if (closing) return
    phase = 'restarting'
    const previousUsageIds = [...launch.credentials.map(credential => credential.usageId), ...[...children.values()].flatMap(role => role.ready?.usageId ? [role.ready.usageId] : [])]
    await closeRoles()
    if (closing) return
    const client = await startRole('client', { activation: { id: launch.activation.id, parents: launch.credentials } })
    if (!adopted || adopted.activation.id !== launch.activation.id) throw rpcFailure('activation-adoption-unconfirmed')
    const clientCredential = adopted.credentials.find(credential => credential.snapshot.role === 'client')
    if (!clientCredential || client.ready?.usageId !== clientCredential.usageId) throw rpcFailure('invalid-role-ready')
    await releaseUses(adoptedUses, [clientCredential.usageId])
    if (closing) return
    const executionCredential = adopted.credentials.find(credential => credential.snapshot.role === 'execution')
    await startExecution(executionCredential)
    if (closing) return
    await client.rpc.call('activation.finish', { id: launch.activation.id, previousUsageIds: [...new Set(previousUsageIds)] })
    staged = undefined; adopted = undefined; activationId = null; errorCode = null; phase = 'ready'
  }
  const recoverManagement = async (): Promise<void> => {
    // A fault never replays application startup. Only after every previous
    // process really exits may a new empty management root acquire the writer.
    for (const role of [...children.values()].sort((a, b) => Number(a.role === 'client') - Number(b.role === 'client'))) {
      if (role.ended) { await role.exited; continue }
      try { await closeRole(role) } catch (error) { if (!role.ended) throw error; await role.exited }
    }
    if ([...allChildren].some(role => !role.ended)) throw rpcFailure('managed-role-exit-unconfirmed')
    await releaseUses(parentUses); await releaseUses(adoptedUses); await releaseUses(independentParents)
    frozenPeers.clear(); inspectionRoles.clear(); launchFreezeReasons.delete('activation'); launchFreezeReasons.delete('inspection')
    if (closing) return
    const manager = await startRole('client', { managementOnly: true })
    if (manager.ready?.usageId) throw rpcFailure('recovery-management-not-empty')
    phase = 'recovery-required'
  }
  const releaseInspection = async (): Promise<void> => {
    const results = await Promise.allSettled([...inspectionRoles].map(async role => { if (!role.ended) await role.rpc.call('release'); inspectionRoles.delete(role) }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Managed quit protection cleanup failed')
    launchFreezeReasons.delete('inspection')
  }
  const inspectForQuit = (): Promise<{ busy: boolean }> => {
    if (inspectionTask) return inspectionTask
    if (inspectionRoles.size) return Promise.resolve({ busy: false })
    if (closing || phase !== 'ready' && phase !== 'recovery-required' || phase !== 'recovery-required' && staged || launchFreezeReasons.has('activation')) return Promise.resolve({ busy: true })
    launchFreezeReasons.add('inspection')
    inspectionTask = (async () => {
      while (acceptedLaunches.size) await Promise.allSettled([...acceptedLaunches])
      try {
        for (const role of children.values()) if (!role.ended) {
          const value = await role.rpc.call<{ busy?: boolean } | undefined>('freeze')
          if (value?.busy) throw rpcFailure('product-busy')
          inspectionRoles.add(role)
        }
        return { busy: false }
      } catch (error) {
        try { await releaseInspection() } catch (cleanup) { failure(cleanup); throw new AggregateError([error, cleanup], 'Managed quit protection failed') }
        if (safeCode(error) === 'product-busy') return { busy: true }
        throw error
      }
    })().finally(() => { inspectionTask = undefined })
    return inspectionTask
  }
  const releaseQuit = async (): Promise<void> => { await inspectionTask; await releaseInspection() }
  const inspect = async (): Promise<{ busy: boolean }> => {
    const held = inspectionRoles.size !== 0, value = await inspectForQuit()
    if (!held && !value.busy) await releaseQuit()
    return value
  }
  const close = (): Promise<void> => {
    if (shutdown) return shutdown
    const unrecoveredFailure = phase === 'failed'
    closing = true; launchFreezeReasons.add('closing'); phase = 'closing'; proxy.closeAdmission()
    for (const controller of channelTasks.keys()) controller.abort()
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
    shutdown = (async () => {
      const errors: unknown[] = []
      try { await inspectionTask } catch (error) { errors.push(error) }
      while (acceptedLaunches.size) await Promise.allSettled([...acceptedLaunches])
      await restartTask
      try { await closeRoles() } catch (error) { errors.push(error) }
      await Promise.allSettled([...channelTasks.values()])
      if (![...allChildren].every(role => role.ended)) errors.push(rpcFailure('managed-role-exit-unconfirmed'))
      if ([...allChildren].every(role => role.ended)) {
        try { await releaseUses(parentUses); await releaseUses(adoptedUses); await releaseUses(independentParents) } catch (error) { errors.push(error) }
      }
      try { await proxy.close() } catch (error) { errors.push(error) }
      if (errors.length || unrecoveredFailure) { phase = 'failed'; errorCode ??= 'managed-role-shutdown-failed'; throw new AggregateError(errors, 'Managed host shutdown failed') }
      phase = 'closed'
    })()
    return shutdown
  }
  try {
    const client = await startRole('client')
    if (roles.includes('execution')) await startExecution(await client.rpc.call<PackageUseCredential | undefined>('role.reserve', { role: 'execution' }))
    if (errorCode || [...children.values()].some(role => role.ended)) throw rpcFailure(errorCode ?? 'managed-role-exited')
    phase = 'ready'
  } catch (error) {
    failure(error)
    try { await recoverManagement() }
    catch (recovery) {
      try { await close() } catch (cleanup) { throw new AggregateError([error, recovery, cleanup], 'Managed host startup failed') }
      throw new AggregateError([error, recovery], 'Managed host startup failed')
    }
  }
  return Object.freeze({ url: proxy.url, get state(): ManagedApplicationHostState { return Object.freeze({ phase, activationId, errorCode, roles: Object.freeze([...children.values()].map(role => Object.freeze({ role: role.role, generation: role.generation, ready: role.ready !== undefined, exited: role.ended }))) }) }, close, inspect, inspectForQuit, releaseQuit })
}

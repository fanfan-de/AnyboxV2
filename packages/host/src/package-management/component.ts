import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Component } from '@nya/core'
import { valid } from 'semver'
import type { LocalStoragePort, StorageReader, StorageTransaction } from '@anybox/storage-sqlite/port'
import { assertTransition, captureCommand, digest, identifier, identity, identityKey, receipt, revision, terminalPhase } from './domain.js'
import { assertFileInstallTransition, fileInstallErrorCode, fileInstallGuardId, fileInstallIntent, fileInstallPhases, parseFileInstall, terminalFileInstall } from './file-install-domain.js'
import { activationErrorCode, activationPlans, parseActivation, terminalActivation } from './activation-domain.js'
import { packageRegistryMigrations } from './migrations.js'
import { packageRegistryFailure as fail, packageRegistryServiceKey, packageRegistryStorageServiceKey } from './port.js'
import type { ApplicationInstallationFacts, PackageActivation, PackageActivationPhase, PackageActivationRole, PackageActivationRolePlan, PackageCatalogSnapshot, PackageFileInstall, PackageFileInstallPhase, PackageIdentity, PackageInstallation, PackageOperation, PackageOperationKind, PackageOperationPhase, PackageReclamationRoot, PackageRegistryPort, PackageUseCredential, PackageUsage } from './port.js'
import type { PackageUsageExitLock } from './usage-locks.js'
import { prepareUsageLock, tryAcquirePackageUsageExitLock } from './usage-locks.js'

interface UsageRecord { usage: PackageUsage; secretDigest: string; fenced: boolean; readyConfirmed: boolean }
interface RegistryState {
  revision: number; ownerEpoch: number
  applications: Map<string, ApplicationInstallationFacts>
  operations: Map<string, PackageOperation>
  fileInstalls: Map<string, PackageFileInstall>
  activations: Map<string, PackageActivation>
  snapshots: Map<string, PackageCatalogSnapshot>
  usages: Map<string, UsageRecord>
}
const phases: readonly PackageOperationPhase[] = ['accepted', 'preparing', 'prepared', 'committing', 'awaiting-activation', 'activating', 'completed', 'failed', 'cancelled', 'recovery-required']
const kinds: readonly PackageOperationKind[] = ['install', 'activate', 'remove']
const roles = ['client', 'execution', 'computer-worker', 'web'] as const
const usageStates = ['reserved', 'claimed', 'ready', 'exit-unconfirmed', 'exited'] as const
const installationStates = ['installed', 'quarantined', 'reclaiming', 'removed'] as const
function assertOperationPhase(kind: PackageOperationKind, phase: PackageOperationPhase): void {
  if (kind !== 'install' && phase === 'awaiting-activation' || kind === 'remove' && phase === 'activating') throw fail('transition-invalid')
}
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }
  return value
}
const same = (a: PackageIdentity | null, b: PackageIdentity | null): boolean => a === null || b === null ? a === b : identityKey(a) === identityKey(b)
const text = (value: unknown, max = 4096): string => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail('invalid-input'); return value }
const timestamp = (value: unknown): string => { const result = text(value, 128); if (!Number.isFinite(Date.parse(result))) throw fail('invalid-input'); return result }
const member = <T extends string>(values: readonly T[], value: unknown): T => { if (!values.includes(value as T)) throw fail('invalid-input'); return value as T }
const source = (value: PackageInstallation['source']): PackageInstallation['source'] => frozen({ kind: member(['file', 'directory', 'catalog', 'migration'], value?.kind), reference: text(value?.reference), publisher: identifier(value?.publisher) })
function snapshotInput(input: Pick<PackageCatalogSnapshot, 'role' | 'entries' | 'capabilities'>) {
  const role = member(roles, input.role)
  if (!Array.isArray(input.entries) || !Array.isArray(input.capabilities)) throw fail('invalid-input')
  const entries = input.entries.map(item => {
    const selected = identity(item?.package), entry = member(roles, item?.entry)
    if (entry !== role && !(role === 'client' && entry === 'web') || item.desiredEnabled !== undefined && (typeof item.desiredEnabled !== 'boolean' || entry === 'web')) throw fail('invalid-input')
    return frozen({ package: selected, entry, ...(item.desiredEnabled === undefined ? {} : { desiredEnabled: item.desiredEnabled }) })
  })
  if (new Set(entries.map(item => item.package.appId)).size !== entries.length) throw fail('invalid-input')
  const capabilities = input.capabilities.map(item => {
    if (typeof item?.version !== 'string' || valid(item.version) !== item.version) throw fail('invalid-input')
    return frozen({ id: identifier(item.id), version: item.version, package: item.package === null ? null : identity(item.package) })
  })
  if (new Set(capabilities.map(item => item.id)).size !== capabilities.length) throw fail('invalid-input')
  return frozen({ role, entries, capabilities })
}
function parseOperation(raw: unknown): PackageOperation {
  const item = raw as PackageOperation
  const result: PackageOperation = { id: identifier(item.id), requestId: identifier(item.requestId), appId: identifier(item.appId), kind: member(kinds, item.kind), identity: identity(item.identity), revision: revision(item.revision), phase: member(phases, item.phase), receipt: receipt(item.receipt), recovery: item.recovery === null ? null : { from: member(phases, item.recovery?.from), reason: member(['owner-restarted', 'outcome-unconfirmed'], item.recovery?.reason) }, createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) }
  assertOperationPhase(result.kind, result.phase)
  if (result.appId !== result.identity.appId || result.phase === 'recovery-required' && !result.recovery || result.phase !== 'recovery-required' && result.recovery) throw fail('invalid-input')
  return frozen(result)
}
function parseFacts(raw: unknown): ApplicationInstallationFacts {
  const item = raw as ApplicationInstallationFacts
  if (!Array.isArray(item.installed)) throw fail('invalid-input')
  const appId = identifier(item.appId)
  const installed = item.installed.map(installation => frozen({ identity: identity(installation.identity), source: source(installation.source), installedAt: timestamp(installation.installedAt), operationId: identifier(installation.operationId), state: member(installationStates, installation.state) }))
  const result = frozen({ appId, revision: revision(item.revision), installed, selected: item.selected === null ? null : identity(item.selected), pending: item.pending === null ? null : identity(item.pending) })
  if (installed.some(installation => installation.identity.appId !== appId) || new Set(installed.map(installation => [installation.identity.version, installation.identity.target.os, installation.identity.target.arch].join(':'))).size !== installed.length ||
      [result.selected, result.pending].some(pointer => pointer !== null && (pointer.appId !== appId || !installed.some(installation => same(pointer, installation.identity) && ['installed', 'quarantined'].includes(installation.state))))) throw fail('invalid-input')
  return result
}
function parseSnapshot(raw: unknown): PackageCatalogSnapshot {
  const item = raw as PackageCatalogSnapshot
  if (typeof item.revoked !== 'boolean') throw fail('invalid-input')
  return frozen({ id: identifier(item.id), revision: revision(item.revision), registryRevision: revision(item.registryRevision), ownerEpoch: revision(item.ownerEpoch), ...snapshotInput(item), revoked: item.revoked })
}
function parseUsage(raw: unknown): PackageUsage {
  const item = raw as PackageUsage
  return frozen({ id: identifier(item.id), snapshotId: identifier(item.snapshotId), holderId: identifier(item.holderId), generation: identifier(item.generation), parentId: item.parentId === null ? null : identifier(item.parentId), state: member(usageStates, item.state), createdAt: timestamp(item.createdAt) })
}
function load(reader: StorageReader): RegistryState {
  try {
    const meta = reader.get('SELECT revision, owner_epoch FROM package_registry_meta WHERE id=1')
    if (!meta) throw fail('registry-corrupt')
    const state: RegistryState = { revision: revision(meta.revision), ownerEpoch: revision(meta.owner_epoch), applications: new Map(), operations: new Map(), fileInstalls: new Map(), activations: new Map(), snapshots: new Map(), usages: new Map() }
    for (const row of reader.all('SELECT * FROM package_registry_applications')) {
      const facts = parseFacts(JSON.parse(String(row.facts_json)))
      if (row.app_id !== facts.appId) throw fail('registry-corrupt')
      state.applications.set(facts.appId, facts)
    }
    const requests = new Set<string>()
    for (const row of reader.all('SELECT * FROM package_registry_operations')) {
      const operation = parseOperation(JSON.parse(String(row.operation_json)))
      if (row.id !== operation.id || row.request_id !== operation.requestId || requests.has(operation.requestId)) throw fail('registry-corrupt')
      requests.add(operation.requestId); state.operations.set(operation.id, operation)
    }
    const installRequests = new Set<string>()
    const ownedInstallOperations = new Set<string>()
    for (const row of reader.all('SELECT * FROM package_registry_file_installs')) {
      const install = parseFileInstall(JSON.parse(String(row.install_json)))
      if (row.id !== install.id || row.request_id !== install.requestId || installRequests.has(install.requestId)) throw fail('registry-corrupt')
      if (install.operationId !== null) {
        const operation = state.operations.get(install.operationId)
        if (!operation || operation.kind !== 'install' || !same(operation.identity, install.identity)) throw fail('registry-corrupt')
        if (!install.existingInstallation) {
          if (operation.requestId !== `file-${digest(install.id)}` || ownedInstallOperations.has(operation.id)) throw fail('registry-corrupt')
          ownedInstallOperations.add(operation.id)
        }
      }
      if ((install.existingInstallation || install.phase === 'installed') && ![...state.applications.values()].some(facts => facts.installed.some(item => same(item.identity, install.identity)))) throw fail('registry-corrupt')
      installRequests.add(install.requestId); state.fileInstalls.set(install.id, install)
    }
    for (const row of reader.all('SELECT * FROM package_registry_snapshots')) {
      const snapshot = parseSnapshot(JSON.parse(String(row.snapshot_json)))
      if (row.id !== snapshot.id || snapshot.registryRevision > state.revision || snapshot.ownerEpoch > state.ownerEpoch) throw fail('registry-corrupt')
      state.snapshots.set(snapshot.id, snapshot)
    }
    for (const row of reader.all('SELECT * FROM package_registry_usages')) {
      const usage = parseUsage(JSON.parse(String(row.usage_json)))
      if (row.id !== usage.id || typeof row.secret_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.secret_digest) || row.fenced !== 0 && row.fenced !== 1 || row.ready_confirmed !== 0 && row.ready_confirmed !== 1 || !state.snapshots.has(usage.snapshotId)) throw fail('registry-corrupt')
      state.usages.set(usage.id, { usage, secretDigest: row.secret_digest, fenced: row.fenced === 1, readyConfirmed: row.ready_confirmed === 1 })
    }
    const activationRequests = new Set<string>(), activationApps = new Set<string>()
    for (const row of reader.all('SELECT * FROM package_registry_activations')) {
      const activation = parseActivation(JSON.parse(String(row.activation_json)), snapshotInput)
      if (row.id !== activation.id || row.request_id !== activation.requestId || activationRequests.has(activation.requestId) || activation.registryRevision > state.revision || activation.ownerEpoch > state.ownerEpoch) throw fail('registry-corrupt')
      activationRequests.add(activation.requestId)
      for (const target of activation.targets) {
        const facts = state.applications.get(target.identity.appId), operation = state.operations.get(target.operationId)
        if (!facts?.installed.some(item => same(item.identity, target.identity)) || !operation || operation.kind !== (activation.kind === 'remove' ? 'remove' : 'install') || !same(operation.identity, target.identity) || activation.kind === 'remove' && operation.requestId !== `remove-${digest(activation.id + identityKey(target.identity))}`) throw fail('registry-corrupt')

      }
      if (!terminalActivation(activation.phase)) for (const appId of new Set(activation.targets.map(target => target.identity.appId))) {
        if (activationApps.has(appId)) throw fail('registry-corrupt'); activationApps.add(appId)
      }
      for (const role of activation.roles) for (const selected of snapshotPackages(role)) {
        if (!state.applications.get(selected.appId)?.installed.some(item => same(item.identity, selected))) throw fail('registry-corrupt')
      }
      if (activation.kind === 'activate' && activation.targets.some(target => !activation.roles.some(role => snapshotPackages(role).some(selected => same(selected, target.identity)))) || activation.kind === 'remove' && activation.roles.some(role => snapshotPackages(role).some(selected => activation.targets.some(target => selected.appId === target.identity.appId)))) throw fail('registry-corrupt')
      for (const role of activation.roles) for (const id of role.usageIds) {
        const record = state.usages.get(id), snapshot = record ? state.snapshots.get(record.usage.snapshotId) : undefined
        if (!record || !snapshot || !sameRole(role, snapshot)) throw fail('registry-corrupt')
      }
      if ([...activation.supersededUsageIds, ...activation.ownedUsageIds].some(id => !state.usages.has(id))) throw fail('registry-corrupt')
      state.activations.set(activation.id, activation)
    }
    for (const snapshot of state.snapshots.values()) for (const selected of snapshotPackages(snapshot)) {
      if (!state.applications.get(selected.appId)?.installed.some(item => same(item.identity, selected))) throw fail('registry-corrupt')
    }
    for (const { usage, readyConfirmed, fenced } of state.usages.values()) {
      const parent = usage.parentId === null ? undefined : state.usages.get(usage.parentId)
      if (usage.parentId !== null && (!parent || parent.usage.id === usage.id || parent.usage.snapshotId !== usage.snapshotId) ||
          readyConfirmed && (usage.state === 'reserved' || usage.state === 'claimed') || !readyConfirmed && usage.state === 'ready' ||
          fenced !== (usage.state === 'exit-unconfirmed' || usage.state === 'exited')) throw fail('registry-corrupt')
    }
    for (const facts of state.applications.values()) for (const installed of facts.installed) {
      const operation = state.operations.get(installed.operationId)
      if (!operation || operation.kind !== 'install' || !same(operation.identity, installed.identity)) throw fail('registry-corrupt')
    }
    const busyApps = new Map<string, PackageOperation[]>()
    for (const operation of state.operations.values()) if (!terminalPhase(operation.phase)) busyApps.set(operation.appId, [...(busyApps.get(operation.appId) ?? []), operation])
    for (const [appId, operations] of busyApps) if (operations.length > 1) {
      const removal = [...state.activations.values()].find(activation => activation.kind === 'remove' && !terminalActivation(activation.phase) && activation.targets.some(target => target.identity.appId === appId))
      if (!removal) throw fail('registry-corrupt')
      const allowed = new Set(removal.targets.filter(target => target.identity.appId === appId).flatMap(target => [target.operationId, ...factsFor(state, appId).installed.filter(item => same(item.identity, target.identity)).map(item => item.operationId)]))
      if (operations.some(operation => !allowed.has(operation.id) || operation.kind === 'install' && !['awaiting-activation', 'activating'].includes(operation.phase === 'recovery-required' ? operation.recovery!.from : operation.phase))) throw fail('registry-corrupt')
    }
    return state
  } catch { throw fail('registry-corrupt') }
}
function save(tx: StorageTransaction, state: RegistryState): void {
  tx.execute('UPDATE package_registry_meta SET revision=?,owner_epoch=? WHERE id=1', [state.revision, state.ownerEpoch])
  for (const [id, facts] of state.applications) tx.execute('INSERT INTO package_registry_applications VALUES(?,?) ON CONFLICT(app_id) DO UPDATE SET facts_json=excluded.facts_json', [id, JSON.stringify(facts)])
  for (const [id, operation] of state.operations) tx.execute('INSERT INTO package_registry_operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET operation_json=excluded.operation_json', [id, operation.requestId, JSON.stringify(operation)])
  for (const [id, install] of state.fileInstalls) tx.execute('INSERT INTO package_registry_file_installs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET install_json=excluded.install_json', [id, install.requestId, JSON.stringify(install)])
  for (const [id, activation] of state.activations) tx.execute('INSERT INTO package_registry_activations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET activation_json=excluded.activation_json', [id, activation.requestId, JSON.stringify(activation)])
  for (const [id, snapshot] of state.snapshots) tx.execute('INSERT INTO package_registry_snapshots VALUES(?,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json', [id, JSON.stringify(snapshot)])
  for (const [id, record] of state.usages) tx.execute('INSERT INTO package_registry_usages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET usage_json=excluded.usage_json, fenced=excluded.fenced, ready_confirmed=excluded.ready_confirmed', [id, JSON.stringify(record.usage), record.secretDigest, record.fenced ? 1 : 0, record.readyConfirmed ? 1 : 0])
}
function factsFor(state: RegistryState, appId: string): ApplicationInstallationFacts {
  return state.applications.get(appId) ?? frozen({ appId, revision: 0, installed: [], selected: null, pending: null })
}
function updateFacts(state: RegistryState, facts: ApplicationInstallationFacts, change: Partial<ApplicationInstallationFacts>): void {
  state.revision = revision(state.revision + 1); state.applications.set(facts.appId, frozen({ ...facts, ...change, revision: revision(facts.revision + 1) }))
}
function operationFor(state: RegistryState, id: string, expectedRevision: number): PackageOperation {
  const operation = state.operations.get(identifier(id)); if (!operation) throw fail('not-found')
  if (operation.revision !== revision(expectedRevision)) throw fail('revision-conflict')
  return operation
}
function assertAppRevision(facts: ApplicationInstallationFacts, expectedRevision: number): void { if (facts.revision !== revision(expectedRevision)) throw fail('revision-conflict') }
function snapshotPackages(snapshot: Pick<PackageCatalogSnapshot, 'entries' | 'capabilities'>): readonly PackageIdentity[] {
  return [...snapshot.entries.map(entry => entry.package), ...snapshot.capabilities.flatMap(capability => capability.package ? [capability.package] : [])]
}
function referenced(snapshot: PackageCatalogSnapshot, selected: PackageIdentity): boolean {
  return snapshotPackages(snapshot).some(item => same(item, selected))
}
function assertReferences(state: RegistryState, snapshot: Pick<PackageCatalogSnapshot, 'entries' | 'capabilities'>): void {
  if (snapshotPackages(snapshot).some(selected => [...state.activations.values()].some(activation => activation.kind === 'remove' && !terminalActivation(activation.phase) && activation.targets.some(target => same(target.identity, selected))))) throw fail('snapshot-stale')
  for (const entry of snapshot.entries) {
    const facts = factsFor(state, entry.package.appId)
    if (!same(facts.selected, entry.package) || !facts.installed.some(item => same(item.identity, entry.package) && item.state === 'installed')) throw fail('snapshot-stale')
  }
  for (const capability of snapshot.capabilities) if (capability.package !== null && !factsFor(state, capability.package.appId).installed.some(item => same(item.identity, capability.package) && item.state === 'installed')) throw fail('snapshot-stale')
}
function sameRole(left: Pick<PackageCatalogSnapshot, 'role' | 'entries' | 'capabilities'>, right: Pick<PackageCatalogSnapshot, 'role' | 'entries' | 'capabilities'>): boolean {
  return JSON.stringify(activationPlans([left], snapshotInput)) === JSON.stringify(activationPlans([right], snapshotInput))
}
function currentSnapshot(state: RegistryState, snapshot: PackageCatalogSnapshot): void {
  if (snapshot.revoked) throw fail('snapshot-revoked')
  if (snapshot.registryRevision !== state.revision || snapshot.ownerEpoch !== state.ownerEpoch) throw fail('snapshot-stale')
  assertReferences(state, snapshot)
}
function authenticate(state: RegistryState, credential: { usageId: string; secret: string }): UsageRecord {
  const record = state.usages.get(identifier(credential.usageId))
  const presented = digest(text(credential.secret, 256))
  if (!record || !timingSafeEqual(Buffer.from(record.secretDigest, 'hex'), Buffer.from(presented, 'hex'))) throw fail('use-unavailable')
  return record
}

/** Owns only installation facts, operation receipts and cross-role code-use reservations. */
export function createPackageRegistryComponent(config: { directory: string; now?: () => string; id?: () => string }): Component.Object<void, { [packageRegistryStorageServiceKey]: LocalStoragePort }> {
  const directoryInput = resolve(text(config.directory))
  const nowSource = config.now ?? (() => new Date().toISOString()), idSource = config.id ?? randomUUID
  if (typeof nowSource !== 'function' || typeof idSource !== 'function') throw fail('invalid-input')
  const now = () => timestamp(nowSource())
  const nextId = () => { const value = identifier(idSource()); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail('invalid-input'); return value }
  return { name: 'host-package-registry', inject: [packageRegistryStorageServiceKey], async apply(ctx, _config, deps) {
    const directory = realpathSync(directoryInput)
    let rootDescriptor: number | undefined, reclamationRoot!: PackageReclamationRoot
    const assertReclamationRoot = (): void => {
      if (rootDescriptor === undefined) throw fail('reclamation-root-unavailable')
      try {
        const current = lstatSync(directory), held = fstatSync(rootDescriptor)
        if (!current.isDirectory() || current.isSymbolicLink() || !held.isDirectory() || realpathSync(directory) !== directory || current.dev !== reclamationRoot.device || current.ino !== reclamationRoot.inode || held.dev !== reclamationRoot.device || held.ino !== reclamationRoot.inode) throw fail('reclamation-root-changed')
      } catch { throw fail('reclamation-root-changed') }
    }
    ctx.effect(() => {
      try {
        const initial = lstatSync(directory)
        if (!initial.isDirectory() || initial.isSymbolicLink() || realpathSync(directory) !== directory) throw fail('reclamation-root-changed')
        reclamationRoot = frozen({ directory, device: initial.dev, inode: initial.ino })
        // Windows may reject directory handles; its existing ledger and interface-only
        // installation remain usable, while destructive reclamation stays unavailable.
        if (process.platform === 'win32') return
        rootDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
        assertReclamationRoot()
      } catch (error) {
        if (rootDescriptor !== undefined) { const descriptor = rootDescriptor; rootDescriptor = undefined; closeSync(descriptor) }
        throw error
      }
      return () => { const descriptor = rootDescriptor; rootDescriptor = undefined; if (descriptor !== undefined) closeSync(descriptor) }
    }, 'pin the canonical package registry root until controlled work exits')
    const db = deps[packageRegistryStorageServiceKey]
    await db.read(reader => {
      if (reader.all('SELECT domain FROM schema_migrations').some(row => row.domain !== 'host-package-registry')) throw fail('registry-corrupt')
    })
    await db.migrate('host-package-registry', packageRegistryMigrations)
    await db.transaction(tx => {
      const state = load(tx); state.ownerEpoch = revision(state.ownerEpoch + 1)
      for (const operation of state.operations.values()) if (!terminalPhase(operation.phase)) state.operations.set(operation.id, frozen({ ...operation, revision: revision(operation.revision + 1), phase: 'recovery-required', recovery: operation.recovery ?? { from: operation.phase, reason: 'owner-restarted' }, updatedAt: now() }))
      for (const install of state.fileInstalls.values()) if (!terminalFileInstall(install.phase)) state.fileInstalls.set(install.id, frozen({ ...install, revision: revision(install.revision + 1), phase: 'recovery-required', recovery: install.recovery ?? { from: install.phase, reason: 'owner-restarted' }, updatedAt: now() }))
      for (const activation of state.activations.values()) if (!terminalActivation(activation.phase)) state.activations.set(activation.id, frozen({ ...activation, revision: revision(activation.revision + 1), phase: 'recovery-required', recovery: activation.recovery ?? { from: activation.phase, reason: 'owner-restarted' }, updatedAt: now() }))
      for (const [id, record] of state.usages) if (record.usage.state === 'claimed' || record.usage.state === 'ready') state.usages.set(id, { ...record, fenced: true, usage: frozen({ ...record.usage, state: 'exit-unconfirmed' }) })
      save(tx, state)
    })
    let accepting = true
    const pending = new Set<Promise<unknown>>(), controllers = new Set<AbortController>(), activeReclamations = new Set<string>(), cleanupFailures = new Set<unknown>()
    const fenceCleanup = (error: unknown): void => {
      cleanupFailures.add(error); accepting = false
      for (const controller of controllers) controller.abort()
    }
    const assertInactive = (id: string): void => { if (activeReclamations.has(id)) throw fail('operation-conflict') }
    const run = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(fail('service-closing'))
      const result = Promise.resolve().then(work).catch(error => {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'PackageUsageLockError' && 'code' in error && error.code === 'release-failed') fenceCleanup(error)
        throw error
      }); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const mutate = <T>(work: (state: RegistryState) => T): Promise<T> => db.transaction(tx => { const state = load(tx), result = work(state); save(tx, state); return result })
    const read = <T>(work: (state: RegistryState) => T): Promise<T> => db.read(reader => work(load(reader)))
    const command = <Input, Result>(input: Input, work: (accepted: Input) => Promise<Result>): Promise<Result> => {
      let accepted: Input
      try { accepted = captureCommand(input) } catch { return Promise.reject(fail('invalid-input')) }
      return run(() => work(accepted))
    }
    const changeOperation = (state: RegistryState, operation: PackageOperation, phase: PackageOperationPhase, changes: Partial<PackageOperation> = {}): PackageOperation => {
      const updated = frozen({ ...operation, ...changes, phase, revision: revision(operation.revision + 1), updatedAt: now() }); state.operations.set(updated.id, updated); return updated
    }
    const installFor = (state: RegistryState, id: string, expectedRevision: number): PackageFileInstall => {
      const install = state.fileInstalls.get(identifier(id)); if (!install) throw fail('not-found')
      if (install.revision !== revision(expectedRevision)) throw fail('revision-conflict')
      return install
    }
    const changeInstall = (state: RegistryState, install: PackageFileInstall, phase: PackageFileInstallPhase, changes: Partial<PackageFileInstall> = {}): PackageFileInstall => {
      const updated = frozen({ ...install, ...changes, phase, revision: revision(install.revision + 1), updatedAt: now() }); state.fileInstalls.set(updated.id, updated); return updated
    }
    const installedFact = (state: RegistryState, install: PackageFileInstall): boolean => install.identity !== null && factsFor(state, install.identity.appId).installed.some(item => same(item.identity, install.identity) && item.state === 'installed')
    const coordinateInstall = (state: RegistryState, install: PackageFileInstall, phase: PackageFileInstallPhase, recovery: boolean): void => {
      const operation = install.operationId === null ? undefined : state.operations.get(install.operationId)!
      if (phase === 'installed') {
        if (!operation || !installedFact(state, install) || !['awaiting-activation', 'activating', 'completed', 'recovery-required'].includes(operation.phase) ||
            operation.phase === 'recovery-required' && !['awaiting-activation', 'activating'].includes(operation.recovery!.from) || !recovery && !install.existingInstallation) throw fail('transition-invalid')
        return
      }
      if (['prepared', 'committing'].includes(phase) && !operation) throw fail('transition-invalid')
      if (!operation || install.existingInstallation) return
      const target = phase === 'verifying' ? 'preparing' : phase === 'prepared' ? 'prepared' : phase === 'committing' ? 'committing' : phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : phase === 'recovery-required' ? 'recovery-required' : null
      if (!target) return
      assertInactive(operation.id)
      if (target === 'recovery-required') {
        if (!terminalPhase(operation.phase) && operation.phase !== 'recovery-required') changeOperation(state, operation, target, { recovery: { from: operation.phase, reason: 'outcome-unconfirmed' } })
      } else if (recovery && operation.phase === 'recovery-required') {
        if (['awaiting-activation', 'activating'].includes(operation.recovery!.from)) throw fail('transition-invalid')
        changeOperation(state, operation, target, { recovery: null })
      } else if (target !== operation.phase) {
        assertTransition(operation.phase, target); changeOperation(state, operation, target, { recovery: null })
      }
    }
    const requireReady = (state: RegistryState, operation: PackageOperation): void => {
      const facts = factsFor(state, operation.appId)
      const relevant = [...state.usages.values()].filter(record => record.usage.state !== 'exited' && snapshotPackages(state.snapshots.get(record.usage.snapshotId)!).some(selected => selected.appId === operation.appId))
      if (relevant.some(record => record.usage.state !== 'ready' || snapshotPackages(state.snapshots.get(record.usage.snapshotId)!).some(selected => selected.appId === operation.appId && !same(selected, operation.identity)))) throw fail('transition-invalid')
      if (!facts.installed.some(item => same(item.identity, operation.identity) && item.state === 'installed') || !same(facts.selected, operation.identity) || ![...state.usages.values()].some(record => record.usage.state === 'ready' && referenced(state.snapshots.get(record.usage.snapshotId)!, operation.identity))) throw fail('transition-invalid')
    }
    const reserve = (state: RegistryState, snapshot: PackageCatalogSnapshot, holder: { holderId: string; generation: string }, parentId: string | null): PackageUseCredential => {
      const id = nextId(), secret = randomBytes(32).toString('base64url')
      if (state.usages.has(id)) throw fail('identity-conflict')
      const usage = frozen({ id, snapshotId: snapshot.id, holderId: identifier(holder.holderId), generation: identifier(holder.generation), parentId, state: 'reserved' as const, createdAt: now() })
      prepareUsageLock(directory, id, digest(secret))
      state.usages.set(id, { usage, secretDigest: digest(secret), fenced: false, readyConfirmed: false })
      return frozen({ usageId: id, secret, snapshot })
    }
    const assertLocked = async (usageId: string): Promise<void> => {
      const exit = tryAcquirePackageUsageExitLock(directory, usageId)
      if (exit) { await exit.release(); throw fail('use-lock-required') }
    }
    const activationFor = (state: RegistryState, id: string, expectedRevision: number): PackageActivation => {
      const activation = state.activations.get(identifier(id)); if (!activation) throw fail('not-found')
      if (activation.revision !== revision(expectedRevision)) throw fail('revision-conflict')
      return activation
    }
    const changeActivation = (state: RegistryState, activation: PackageActivation, phase: PackageActivationPhase, changes: Partial<PackageActivation> = {}): PackageActivation => {
      const updated = frozen({ ...activation, ...changes, phase, revision: revision(activation.revision + 1), updatedAt: now() }); state.activations.set(updated.id, updated); return updated
    }
    const assertActivationInactive = (state: RegistryState, appId: string): void => {
      if ([...state.activations.values()].some(item => !terminalActivation(item.phase) && item.targets.some(target => target.identity.appId === appId))) throw fail('operation-conflict')
    }
    const assertActivationTargets = (state: RegistryState, activation: PackageActivation, selected: boolean): void => {
      for (const target of activation.targets) {
        const facts = factsFor(state, target.identity.appId), installed = facts.installed.find(item => same(item.identity, target.identity))
        if (activation.kind === 'remove') {
          if (!installed || !['installed', 'quarantined', 'reclaiming', ...(selected ? ['removed'] : [])].includes(installed.state) || !same(facts.selected, selected ? null : target.previousSelected) || selected && facts.pending !== null) throw fail('snapshot-stale')
        } else if (!installed || installed.state !== 'installed' || !same(facts.selected, selected ? target.identity : target.previousSelected) || !same(facts.pending, target.identity)) throw fail('snapshot-stale')
      }
      if (selected) for (const role of activation.roles) assertReferences(state, role)
    }
    const assertActivationReady = (state: RegistryState, activation: PackageActivation): void => {
      const readyIds = new Set<string>(), affectedRoles = new Set(activation.roles.map(role => role.role))
      for (const role of activation.roles) {
        const record = role.readyUsageId === null ? undefined : state.usages.get(role.readyUsageId), snapshot = record ? state.snapshots.get(record.usage.snapshotId) : undefined
        if (!record || !snapshot || record.fenced || !record.readyConfirmed || record.usage.state !== 'ready' || snapshot.ownerEpoch !== state.ownerEpoch || snapshot.revoked || !sameRole(role, snapshot)) throw fail('transition-invalid')
        readyIds.add(record.usage.id)
      }
      if ([...activation.supersededUsageIds, ...activation.ownedUsageIds].some(id => state.usages.get(id)!.usage.state !== 'exited') || [...state.usages.values()].some(record => record.usage.state !== 'exited' && !readyIds.has(record.usage.id) && (affectedRoles.has(state.snapshots.get(record.usage.snapshotId)!.role) || snapshotPackages(state.snapshots.get(record.usage.snapshotId)!).some(selected => activation.targets.some(target => selected.appId === target.identity.appId))))) throw fail('version-in-use')
    }
    const issueActivationRoles = (state: RegistryState, activation: PackageActivation, holder: { holderId: string; generation: string }, parents?: ReadonlyMap<string, string>) => {
      const credentials: PackageUseCredential[] = []
      const rolePlans: PackageActivationRole[] = activation.roles.map(role => {
        const id = nextId(); if (state.snapshots.has(id)) throw fail('identity-conflict')
        const snapshot: PackageCatalogSnapshot = frozen({ id, revision: 0, registryRevision: state.revision, ownerEpoch: state.ownerEpoch, role: role.role, entries: role.entries, capabilities: role.capabilities, revoked: false })
        state.snapshots.set(id, snapshot)
        // parentId denotes a same-snapshot reservation only. Cross-owner handoff is
        // recorded by the activation, never by weakening ordinary parent snapshots.
        const credential = reserve(state, snapshot, { holderId: identifier(`${holder.holderId}-${role.role}`), generation: holder.generation }, null)
        credentials.push(credential)
        return frozen({ ...role, handoffUsageId: parents ? role.handoffUsageId : credential.usageId, usageIds: [...role.usageIds, credential.usageId], readyUsageId: null })
      })
      return { credentials: frozen(credentials), roles: frozen(rolePlans) }
    }
    const activateOperations = (state: RegistryState, activation: PackageActivation): void => {
      for (const target of activation.targets) {
        const operation = state.operations.get(target.operationId)!
        assertInactive(operation.id)
        if (activation.kind === 'remove') {
          const installed = factsFor(state, target.identity.appId).installed.find(item => same(item.identity, target.identity))!
          if (operation.phase === 'completed' && installed.state === 'removed') continue
          if (operation.kind !== 'remove' || !['accepted', 'prepared', 'committing', 'recovery-required'].includes(operation.phase)) throw fail('transition-invalid')
          changeOperation(state, operation, 'prepared', { recovery: null })
        } else {
          if (operation.phase === 'recovery-required' && !['awaiting-activation', 'activating'].includes(operation.recovery!.from) || !['awaiting-activation', 'activating', 'recovery-required'].includes(operation.phase)) throw fail('transition-invalid')
          changeOperation(state, operation, 'activating', { recovery: null })
        }
      }
    }
    const service: PackageRegistryPort = {
      inspect: () => run(() => read(state => frozen({ revision: state.revision, ownerEpoch: state.ownerEpoch, applications: [...state.applications.values()], actual: [...state.usages.values()].filter(record => record.readyConfirmed && record.usage.state !== 'exited').map(record => frozen({ usage: record.usage, snapshot: state.snapshots.get(record.usage.snapshotId)! })) }))),
      getOperation: id => run(() => read(state => state.operations.get(identifier(id)))),
      findOperation: requestId => run(() => read(state => [...state.operations.values()].find(item => item.requestId === identifier(requestId)))),
      listOperations: () => run(() => read(state => frozen([...state.operations.values()]))),
      acceptFileInstall: input => command(input, input => mutate(state => {
        const accepted = fileInstallIntent(input), duplicate = [...state.fileInstalls.values()].find(item => item.requestId === accepted.requestId)
        const expectedAppRevision = accepted.expectedAppRevision < 0 ? null : accepted.expectedAppRevision
        if (duplicate) {
          if (duplicate.filename !== accepted.filename || duplicate.archiveDigest !== accepted.archiveDigest || duplicate.archiveSize !== accepted.archiveSize || duplicate.expectedAppRevision !== expectedAppRevision || (duplicate.sourceFormat ?? 'archive') !== accepted.sourceFormat || (duplicate.localTrust ?? false) !== accepted.localTrust) throw fail('request-conflict')
          return duplicate
        }
        const id = nextId(); if (state.fileInstalls.has(id)) throw fail('identity-conflict')
        const at = now(), install = frozen({ ...accepted, expectedAppRevision, id, revision: 0, phase: 'accepted' as const, identity: null, operationId: null, existingInstallation: false, workGuardIds: [], receipt: null, errorCode: null, recovery: null, createdAt: at, updatedAt: at })
        state.fileInstalls.set(id, install); return install
      })),
      getFileInstall: id => run(() => read(state => state.fileInstalls.get(identifier(id)))),
      findFileInstall: requestId => run(() => read(state => [...state.fileInstalls.values()].find(item => item.requestId === identifier(requestId)))),
      listFileInstalls: () => run(() => read(state => frozen([...state.fileInstalls.values()]))),
      bindFileInstall: input => command(input, input => mutate(state => {
        const install = installFor(state, input.installId, input.expectedRevision), selected = identity(input.identity)
        if (install.phase !== 'verifying' || install.identity !== null) throw fail('transition-invalid')
        const facts = factsFor(state, selected.appId)
        assertActivationInactive(state, selected.appId)
        if (install.expectedAppRevision !== null) assertAppRevision(facts, install.expectedAppRevision)
        const prior = facts.installed.find(item => item.identity.version === selected.version && item.identity.target.os === selected.target.os && item.identity.target.arch === selected.target.arch)
        if (prior && (!same(prior.identity, selected) || !['installed', 'removed'].includes(prior.state))) throw fail('identity-conflict')
        if ([...state.operations.values()].some(item => item.appId === selected.appId && !terminalPhase(item.phase) && item.id !== prior?.operationId)) throw fail('operation-conflict')
        if (prior?.state === 'installed') return changeInstall(state, install, 'verifying', { identity: selected, operationId: prior.operationId, existingInstallation: true })
        const id = nextId(), requestId = `file-${digest(install.id)}`
        if (state.operations.has(id) || [...state.operations.values()].some(item => item.requestId === requestId)) throw fail('identity-conflict')
        const at = now(), operation = frozen({ id, requestId, appId: selected.appId, identity: selected, kind: 'install' as const, revision: 0, phase: 'preparing' as const, receipt: receipt({ fileInstallId: install.id }), recovery: null, createdAt: at, updatedAt: at })
        state.operations.set(id, operation)
        return changeInstall(state, install, 'verifying', { identity: selected, operationId: operation.id })
      })),
      advanceFileInstall: input => command(input, input => mutate(state => {
        const install = installFor(state, input.installId, input.expectedRevision), phase = member(fileInstallPhases, input.phase)
        if (phase === install.phase) { if (terminalFileInstall(phase)) throw fail('transition-invalid') }
        else { assertFileInstallTransition(install.phase, phase); coordinateInstall(state, install, phase, false) }
        const guardId = input.workGuardId === undefined ? undefined : fileInstallGuardId(input.workGuardId)
        const workGuardIds = guardId === undefined || install.workGuardIds.includes(guardId) ? install.workGuardIds : [...install.workGuardIds, guardId]
        if (workGuardIds.length > 10_000) throw fail('invalid-input')
        return changeInstall(state, install, phase, { workGuardIds, receipt: input.receipt === undefined ? install.receipt : receipt(input.receipt), errorCode: input.errorCode === undefined ? install.errorCode : fileInstallErrorCode(input.errorCode), recovery: phase === 'recovery-required' ? install.recovery ?? { from: install.phase, reason: 'outcome-unconfirmed' } : null })
      })),
      reconcileFileInstall: input => command(input, input => mutate(state => {
        const install = installFor(state, input.installId, input.expectedRevision), phase = member(['verifying', 'prepared', 'committing', 'installed', 'failed', 'cancelled'], input.phase)
        if (install.phase !== 'recovery-required') throw fail('transition-invalid')
        coordinateInstall(state, install, phase, true)
        return changeInstall(state, install, phase, { receipt: receipt(input.receipt), errorCode: input.errorCode === undefined ? install.errorCode : fileInstallErrorCode(input.errorCode), recovery: null })
      })),
      begin: input => command(input, input => mutate(state => {
        const requestId = identifier(input.requestId), kind = member(kinds, input.kind), selected = identity(input.identity)
        const duplicate = [...state.operations.values()].find(item => item.requestId === requestId)
        if (duplicate) { if (duplicate.kind !== kind || !same(duplicate.identity, selected)) throw fail('request-conflict'); return duplicate }
        const facts = factsFor(state, selected.appId); assertAppRevision(facts, input.expectedAppRevision)
        assertActivationInactive(state, selected.appId)
        if ([...state.operations.values()].some(item => item.appId === selected.appId && !terminalPhase(item.phase))) throw fail('operation-conflict')
        const id = nextId(); if (state.operations.has(id)) throw fail('identity-conflict')
        const at = now(), operation = frozen({ id, requestId, appId: selected.appId, identity: selected, kind, revision: 0, phase: 'accepted' as const, receipt: null, recovery: null, createdAt: at, updatedAt: at })
        state.operations.set(id, operation); return operation
      })),
      advance: input => command(input, input => mutate(state => {
        assertInactive(input.operationId)
        const operation = operationFor(state, input.operationId, input.expectedRevision), phase = member(phases, input.phase)
        assertActivationInactive(state, operation.appId)
        assertOperationPhase(operation.kind, phase)
        assertTransition(operation.phase, phase)
        if (phase === 'awaiting-activation' && operation.kind === 'install' || phase === 'completed' && operation.kind === 'remove') throw fail('transition-invalid')
        if (phase === 'completed') requireReady(state, operation)
        return changeOperation(state, operation, phase, { receipt: input.receipt === undefined ? operation.receipt : receipt(input.receipt), recovery: phase === 'recovery-required' ? { from: operation.phase, reason: 'outcome-unconfirmed' } : null })
      })),
      recordInstalled: input => command(input, input => mutate(state => {
        assertInactive(input.operationId)
        const operation = operationFor(state, input.operationId, input.expectedRevision)
        if (operation.kind !== 'install' || operation.phase !== 'committing') throw fail('transition-invalid')
        const facts = factsFor(state, operation.appId); assertAppRevision(facts, input.expectedAppRevision)
        const selectedSource = source(input.source)
        const prior = facts.installed.find(item => item.identity.version === operation.identity.version && item.identity.target.os === operation.identity.target.os && item.identity.target.arch === operation.identity.target.arch)
        if (prior && (!same(prior.identity, operation.identity) || prior.state !== 'removed' && (JSON.stringify(prior.source) !== JSON.stringify(selectedSource) || prior.state !== 'installed'))) throw fail('identity-conflict')
        const installation = frozen({ identity: operation.identity, source: selectedSource, installedAt: now(), operationId: operation.id, state: 'installed' as const })
        updateFacts(state, facts, { installed: prior ? prior.state === 'removed' ? facts.installed.map(item => item === prior ? installation : item) : facts.installed : [...facts.installed, installation], pending: operation.identity })
        const updated = changeOperation(state, operation, 'awaiting-activation')
        for (const install of state.fileInstalls.values()) if (install.operationId === operation.id && !install.existingInstallation && install.phase === 'committing') changeInstall(state, install, 'installed')
        return updated
      })),
      select: input => command(input, input => mutate(state => {
        assertInactive(input.operationId)
        const operation = operationFor(state, input.operationId, input.expectedRevision)
        assertActivationInactive(state, operation.appId)
        if (!(operation.kind === 'activate' && ['prepared', 'activating', 'committing'].includes(operation.phase) || operation.kind === 'install' && ['awaiting-activation', 'activating'].includes(operation.phase))) throw fail('transition-invalid')
        const facts = factsFor(state, operation.appId); assertAppRevision(facts, input.expectedAppRevision)
        if (!facts.installed.some(item => same(item.identity, operation.identity) && item.state === 'installed')) throw fail('not-found')
        updateFacts(state, facts, { selected: operation.identity, pending: same(facts.pending, operation.identity) ? null : facts.pending })
        return changeOperation(state, operation, 'activating')
      })),
      reconcile: input => command(input, input => mutate(state => {
        assertInactive(input.operationId)
        const operation = operationFor(state, input.operationId, input.expectedRevision)
        assertActivationInactive(state, operation.appId)
        if (operation.phase !== 'recovery-required') throw fail('transition-invalid')
        const phase = member(['prepared', 'committing', 'awaiting-activation', 'activating', 'failed', 'cancelled'], input.phase)
        assertOperationPhase(operation.kind, phase)
        if (phase === 'awaiting-activation' && !factsFor(state, operation.appId).installed.some(item => same(item.identity, operation.identity) && item.state === 'installed') || phase === 'activating' && !same(factsFor(state, operation.appId).selected, operation.identity)) throw fail('transition-invalid')
        return changeOperation(state, operation, phase, { receipt: receipt(input.receipt), recovery: null })
      })),
      prepareUse: input => command(input, input => mutate(state => {
        if (revision(input.expectedRegistryRevision) !== state.revision) throw fail('revision-conflict')
        const selected = snapshotInput({ role: input.role, entries: input.entries, capabilities: input.capabilities ?? [] }); assertReferences(state, selected)
        const id = nextId(); if (state.snapshots.has(id)) throw fail('identity-conflict')
        const snapshot = frozen({ id, revision: 0, registryRevision: state.revision, ownerEpoch: state.ownerEpoch, ...selected, revoked: false })
        state.snapshots.set(id, snapshot); return reserve(state, snapshot, input, null)
      })),
      prepareHandoff: (parent, holder) => command({ parent, holder }, ({ parent, holder }) => mutate(state => {
        const record = authenticate(state, parent)
        if (record.fenced || !['reserved', 'claimed', 'ready'].includes(record.usage.state)) throw fail('use-unavailable')
        const snapshot = state.snapshots.get(record.usage.snapshotId)!; currentSnapshot(state, snapshot)
        return reserve(state, snapshot, holder, record.usage.id)
      })),
      claim: credential => command(credential, async credential => {
        await assertLocked(credential.usageId)
        return mutate(state => {
          const record = authenticate(state, credential)
          if (record.fenced || !['reserved', 'claimed'].includes(record.usage.state)) throw fail('use-unavailable')
          const snapshot = state.snapshots.get(record.usage.snapshotId)!; currentSnapshot(state, snapshot)
          state.usages.set(record.usage.id, { ...record, usage: frozen({ ...record.usage, state: 'claimed' }) }); return snapshot
        })
      }),
      validateUse: credential => command(credential, async credential => {
        await assertLocked(credential.usageId)
        return read(state => {
          const record = authenticate(state, credential), snapshot = state.snapshots.get(record.usage.snapshotId)!
          if (record.fenced || !['claimed', 'ready'].includes(record.usage.state)) throw fail('use-unavailable')
          if (snapshot.revoked) throw fail('snapshot-revoked')
          if (snapshot.ownerEpoch !== state.ownerEpoch) throw fail('snapshot-stale')
          return snapshot
        })
      }),
      ready: credential => command(credential, async credential => {
        await assertLocked(credential.usageId)
        return mutate(state => {
          const record = authenticate(state, credential), snapshot = state.snapshots.get(record.usage.snapshotId)!
          if (record.fenced || !['claimed', 'ready'].includes(record.usage.state)) throw fail('use-unavailable')
          const usage = frozen({ ...record.usage, state: 'ready' as const }); state.usages.set(usage.id, { ...record, usage, readyConfirmed: true }); return frozen({ usage, snapshot })
        })
      }),
      revokeSnapshot: input => command(input, input => mutate(state => {
        const snapshot = state.snapshots.get(identifier(input.snapshotId)); if (!snapshot) throw fail('not-found')
        if (snapshot.revision !== revision(input.expectedRevision)) throw fail('revision-conflict')
        const revoked = frozen({ ...snapshot, revision: revision(snapshot.revision + 1), revoked: true }); state.snapshots.set(snapshot.id, revoked); return revoked
      })),
      listUsages: () => run(() => read(state => frozen([...state.usages.values()].map(record => record.usage)))),
      confirmExit: input => command(input, async input => {
        const id = identifier(input.usageId)
        const already = await mutate(state => {
          const record = state.usages.get(id); if (!record) throw fail('not-found')
          if (record.usage.state === 'exited') return record.usage
          state.usages.set(id, { ...record, fenced: true, usage: frozen({ ...record.usage, state: 'exit-unconfirmed' }) }); return undefined
        })
        if (already) return already
        const exit = tryAcquirePackageUsageExitLock(directory, id)
        if (!exit) throw fail('version-in-use')
        try {
          exit.revoke()
          return await mutate(state => {
            const record = state.usages.get(id)!, usage = frozen({ ...record.usage, state: 'exited' as const })
            state.usages.set(id, { ...record, fenced: true, usage }); return usage
          })
        } finally { await exit.release() }
      }),
      withReclamation: (input, work) => {
        try { input = captureCommand(input) } catch { return Promise.reject(fail('invalid-input')) }
        const id = identifier(input.operationId)
        if (activeReclamations.has(id)) return Promise.reject(fail('operation-conflict'))
        activeReclamations.add(id)
        return run(async () => {
          if (typeof work !== 'function') throw fail('invalid-input')
          assertReclamationRoot()
          const controller = new AbortController(); controllers.add(controller)
          let operation: PackageOperation | undefined
          const exits: PackageUsageExitLock[] = []
          try {
            operation = await mutate(state => {
              const current = operationFor(state, input.operationId, input.expectedRevision)
              if (current.kind !== 'remove' || !['prepared', 'committing'].includes(current.phase)) throw fail('transition-invalid')
              const removal = [...state.activations.values()].find(activation => activation.kind === 'remove' && activation.targets.some(target => target.operationId === current.id))
              if (removal && removal.phase !== 'reclaiming') throw fail('transition-invalid')
              const facts = factsFor(state, current.appId); assertAppRevision(facts, input.expectedAppRevision)
              const installed = facts.installed.find(item => same(item.identity, current.identity))
              if (!installed || !['installed', 'quarantined', 'reclaiming'].includes(installed.state)) throw fail('not-found')
              if (same(facts.selected, current.identity) || same(facts.pending, current.identity) || [...state.usages.values()].some(record => record.usage.state !== 'exited' && referenced(state.snapshots.get(record.usage.snapshotId)!, current.identity))) throw fail('version-in-use')
              updateFacts(state, facts, { installed: facts.installed.map(item => same(item.identity, current.identity) ? frozen({ ...item, state: 'reclaiming' as const }) : item) })
              return changeOperation(state, current, 'committing', { receipt: receipt({ reclamation: 'accepted' }) })
            })
            const references = await read(state => [...state.usages.values()].filter(record => referenced(state.snapshots.get(record.usage.snapshotId)!, operation!.identity)).map(record => record.usage.id))
            for (const usageId of references) {
              const exit = tryAcquirePackageUsageExitLock(directory, usageId)
              if (!exit) throw fail('version-in-use')
              exits.push(exit); exit.revoke()
            }
            if (!accepting) controller.abort()
            controller.signal.throwIfAborted()
            assertReclamationRoot()
            const result = await work(operation.identity, controller.signal, reclamationRoot)
            await mutate(state => {
              const current = operationFor(state, operation!.id, operation!.revision), facts = factsFor(state, current.appId)
              updateFacts(state, facts, { installed: facts.installed.map(item => same(item.identity, current.identity) ? frozen({ ...item, state: 'removed' as const }) : item) })
              changeOperation(state, current, 'completed', { receipt: receipt({ reclamation: 'completed' }) })
            })
            return result
          } catch (error) {
            if (operation) {
              try {
                await mutate(state => {
                  const current = operationFor(state, operation!.id, operation!.revision)
                  changeOperation(state, current, 'recovery-required', { recovery: { from: current.phase, reason: 'outcome-unconfirmed' }, receipt: receipt({ reclamation: 'outcome-unconfirmed' }) })
                })
              } catch (recoveryError) {
                const failure = new AggregateError([error, recoveryError], 'package reclamation outcome could not be recorded')
                fenceCleanup(failure); throw failure
              }
            }
            throw error
          } finally {
            const released = await Promise.allSettled(exits.reverse().map(exit => exit.release()))
            controllers.delete(controller)
            const errors = released.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (errors.length) {
              for (const error of errors) fenceCleanup(error)
              throw new AggregateError(errors, 'package usage exit lock cleanup failed')
            }
          }
        }).finally(() => activeReclamations.delete(id))
      },
      getActivation: id => run(() => read(state => state.activations.get(identifier(id)))),
      findActivation: requestId => run(() => read(state => [...state.activations.values()].find(item => item.requestId === identifier(requestId)))),
      listActivations: () => run(() => read(state => frozen([...state.activations.values()]))),
      prepareActivation: input => command(input, input => mutate(state => {
        const requestId = identifier(input.requestId), expectedRegistryRevision = revision(input.expectedRegistryRevision), kind = member(['activate', 'remove'], input.kind === undefined ? 'activate' : input.kind)
        if (input.appIds !== undefined && !Array.isArray(input.appIds) || kind === 'remove' && input.appIds === undefined) throw fail('invalid-input')
        const requestedApps = input.appIds === undefined ? null : [...input.appIds].map(identifier).sort()
        if (requestedApps && (!requestedApps.length || new Set(requestedApps).size !== requestedApps.length)) throw fail('invalid-input')
        const plans = activationPlans(input.roles, snapshotInput)
        const duplicate = [...state.activations.values()].find(item => item.requestId === requestId)
        if (duplicate) {
          const appIds = requestedApps ?? [...new Set(duplicate.targets.map(target => target.identity.appId))].sort()
          if (duplicate.kind !== kind || duplicate.registryRevision !== expectedRegistryRevision || JSON.stringify([...new Set(duplicate.targets.map(target => target.identity.appId))].sort()) !== JSON.stringify(appIds) || JSON.stringify(activationPlans(duplicate.roles, snapshotInput)) !== JSON.stringify(plans)) throw fail('request-conflict')
          return duplicate
        }
        if (expectedRegistryRevision !== state.revision) throw fail('revision-conflict')
        const appIds = requestedApps ?? [...state.applications.values()].filter(item => item.pending !== null).map(item => item.appId).sort()
        if (!appIds.length) throw fail('invalid-input')
        const id = nextId(); if (state.activations.has(id)) throw fail('identity-conflict')
        const targets = appIds.flatMap(appId => {
          assertActivationInactive(state, appId)
          const facts = factsFor(state, appId)
          if (kind === 'remove') {
            const installations = facts.installed.filter(item => item.state !== 'removed').sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)))
            if (!installations.length) throw fail('not-found')
            const installationIds = new Set(installations.map(item => item.operationId))
            if ([...state.operations.values()].some(operation => operation.appId === appId && !terminalPhase(operation.phase) && (!installationIds.has(operation.id) || operation.kind !== 'install' || !['awaiting-activation', 'activating'].includes(operation.phase === 'recovery-required' ? operation.recovery!.from : operation.phase)))) throw fail('operation-conflict')
            return installations.map(installation => {
              const operationId = nextId(), removalRequest = `remove-${digest(id + identityKey(installation.identity))}`
              if (state.operations.has(operationId) || [...state.operations.values()].some(operation => operation.requestId === removalRequest)) throw fail('identity-conflict')
              const at = now()
              state.operations.set(operationId, frozen({ id: operationId, requestId: removalRequest, appId, identity: installation.identity, kind: 'remove', revision: 0, phase: 'accepted', receipt: receipt({ removalActivationId: id }), recovery: null, createdAt: at, updatedAt: at }))
              return frozen({ identity: installation.identity, previousSelected: facts.selected, operationId })
            })
          }
          const installation = facts.installed.find(item => same(item.identity, facts.pending) && item.state === 'installed')
          if (!installation) throw fail('not-found')
          const operation = state.operations.get(installation.operationId)!
          if (!['awaiting-activation', 'activating'].includes(operation.phase) && !(operation.phase === 'recovery-required' && ['awaiting-activation', 'activating'].includes(operation.recovery!.from))) throw fail('operation-conflict')
          return [frozen({ identity: installation.identity, previousSelected: facts.selected, operationId: operation.id })]
        })
        const targetByApp = new Map(targets.map(target => [target.identity.appId, target]))
        for (const plan of plans) {
          for (const entry of plan.entries) {
            const facts = factsFor(state, entry.package.appId), target = targetByApp.get(entry.package.appId)
            if (kind === 'remove' && target || !same(entry.package, kind === 'activate' ? target?.identity ?? facts.selected : facts.selected) || !facts.installed.some(item => same(item.identity, entry.package) && item.state === 'installed')) throw fail('snapshot-stale')
            if (kind === 'activate' && target?.previousSelected === null && entry.entry !== 'web' && entry.desiredEnabled !== false) throw fail('invalid-input')
          }
          for (const capability of plan.capabilities) if (capability.package && (kind === 'remove' && targetByApp.has(capability.package.appId) || !factsFor(state, capability.package.appId).installed.some(item => same(item.identity, capability.package) && item.state === 'installed'))) throw fail('snapshot-stale')
        }
        if (kind === 'activate' && targets.some(target => !plans.some(plan => snapshotPackages(plan).some(selected => same(selected, target.identity))))) throw fail('invalid-input')
        const affectedRoles = new Set(plans.map(plan => plan.role))
        let ownedUsageIds: readonly string[] = []
        if (input.ownedUsageIds !== undefined) {
          if (!Array.isArray(input.ownedUsageIds) || input.ownedUsageIds.length > 10_000) throw fail('invalid-input')
          const owned = new Set(input.ownedUsageIds.map(identifier)); ownedUsageIds = [...owned]
          if (owned.size !== input.ownedUsageIds.length || ownedUsageIds.some(usageId => !state.usages.has(usageId))) throw fail('invalid-input')
          for (const record of state.usages.values()) if (record.usage.state !== 'exited' && !owned.has(record.usage.id)) {
            const snapshot = state.snapshots.get(record.usage.snapshotId)!
            if (affectedRoles.has(snapshot.role) || snapshotPackages(snapshot).some(selected => targetByApp.has(selected.appId))) throw fail('version-in-use')
          }
        }
        for (const record of state.usages.values()) if (record.usage.state !== 'exited') {
          const snapshot = state.snapshots.get(record.usage.snapshotId)!
          if (snapshotPackages(snapshot).some(selected => targetByApp.has(selected.appId)) && !affectedRoles.has(snapshot.role) && !(kind === 'remove' && ownedUsageIds.includes(record.usage.id))) throw fail(kind === 'remove' ? 'version-in-use' : 'invalid-input')
        }
        const at = now(), activation: PackageActivation = frozen({ kind, id, requestId, revision: 0, registryRevision: state.revision, ownerEpoch: state.ownerEpoch, phase: 'prepared', targets, roles: plans.map(plan => ({ ...plan, handoffUsageId: null, usageIds: [], readyUsageId: null })), supersededUsageIds: [], ownedUsageIds, receipt: null, errorCode: null, recovery: null, createdAt: at, updatedAt: at })
        state.activations.set(id, activation); return activation
      })),
      commitActivation: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision)
        if (activation.phase !== 'prepared' || activation.ownerEpoch !== state.ownerEpoch) throw fail('transition-invalid')
        if (activation.registryRevision !== state.revision) throw fail('revision-conflict')
        assertActivationTargets(state, activation, false)
        identifier(input.holderId); identifier(input.generation)
        const selectedReceipt = receipt(input.receipt), affectedRoles = new Set(activation.roles.map(role => role.role))
        const supersededUsageIds = [...state.usages.values()].filter(record => record.usage.state !== 'exited' && (affectedRoles.has(state.snapshots.get(record.usage.snapshotId)!.role) || activation.ownedUsageIds.includes(record.usage.id) || snapshotPackages(state.snapshots.get(record.usage.snapshotId)!).some(selected => activation.targets.some(target => selected.appId === target.identity.appId)))).map(record => record.usage.id)
        if (activation.kind === 'remove') {
          for (const appId of new Set(activation.targets.map(target => target.identity.appId))) {
            const facts = factsFor(state, appId)
            updateFacts(state, facts, { selected: null, pending: null })
            for (const installed of facts.installed) {
              const operation = state.operations.get(installed.operationId)!
              if (!terminalPhase(operation.phase)) changeOperation(state, operation, 'cancelled', { recovery: null, receipt: receipt({ removedByActivationId: activation.id }) })
            }
          }
        } else for (const target of activation.targets) { const facts = factsFor(state, target.identity.appId); updateFacts(state, facts, { selected: target.identity, pending: target.identity }) }
        for (const role of activation.roles) assertReferences(state, role)
        activateOperations(state, activation)
        const launch = issueActivationRoles(state, activation, input)
        const updated = changeActivation(state, activation, 'handoff', { roles: launch.roles, supersededUsageIds, ownerEpoch: state.ownerEpoch, receipt: selectedReceipt, errorCode: null, recovery: null })
        return frozen({ activation: updated, credentials: launch.credentials })
      })),
      adoptActivation: input => command(input, async input => {
        if (!Array.isArray(input.parents) || !input.parents.length || input.parents.length > 4 || new Set(input.parents.map(parent => parent.usageId)).size !== input.parents.length) throw fail('invalid-input')
        for (const parent of input.parents) await assertLocked(identifier(parent.usageId))
        return mutate(state => {
          const activation = activationFor(state, input.activationId, input.expectedRevision)
          if (!['handoff', 'recovery-required'].includes(activation.phase) || activation.ownerEpoch >= state.ownerEpoch || activation.roles.some(role => role.handoffUsageId === null) || input.parents.length !== activation.roles.length) throw fail('transition-invalid')
          assertActivationTargets(state, activation, true)
          if (activation.roles.some(role => role.usageIds.some(id => id !== role.handoffUsageId && state.usages.get(id)!.usage.state !== 'exited'))) throw fail('version-in-use')
          identifier(input.holderId); identifier(input.generation)
          const parents = new Map<string, string>()
          for (const credential of input.parents) {
            const record = authenticate(state, credential), snapshot = state.snapshots.get(record.usage.snapshotId)!
            const role = activation.roles.find(role => role.handoffUsageId === record.usage.id)
            if (!role || record.fenced || record.usage.state !== 'reserved' || snapshot.ownerEpoch > activation.ownerEpoch || snapshot.revoked || !sameRole(role, snapshot)) throw fail('use-unavailable')
            parents.set(role.role, record.usage.id)
          }
          activateOperations(state, activation)
          const launch = issueActivationRoles(state, activation, input, parents)
          const updated = changeActivation(state, activation, 'loading', { roles: launch.roles, ownerEpoch: state.ownerEpoch, errorCode: null, recovery: null })
          return frozen({ activation: updated, credentials: launch.credentials })
        })
      }),
      recordActivationRoleReady: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision), id = identifier(input.usageId)
        if (activation.phase !== 'loading' || activation.ownerEpoch !== state.ownerEpoch) throw fail('transition-invalid')
        assertActivationTargets(state, activation, true)
        const record = state.usages.get(id), snapshot = record ? state.snapshots.get(record.usage.snapshotId) : undefined
        const role = activation.roles.find(role => role.usageIds.includes(id) && role.handoffUsageId !== id)
        if (!role || !record || !snapshot || record.fenced || !record.readyConfirmed || record.usage.state !== 'ready' || snapshot.ownerEpoch !== state.ownerEpoch || snapshot.revoked || !sameRole(role, snapshot)) throw fail('use-unavailable')
        if (role.readyUsageId === id) return activation
        if (role.readyUsageId !== null) throw fail('operation-conflict')
        return changeActivation(state, activation, 'loading', { roles: activation.roles.map(item => item === role ? frozen({ ...item, readyUsageId: id }) : item) })
      })),
      completeActivation: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision)
        if (activation.phase !== 'loading' || activation.ownerEpoch !== state.ownerEpoch) throw fail('transition-invalid')
        assertActivationTargets(state, activation, true)
        assertActivationReady(state, activation)
        if (activation.kind === 'remove') return changeActivation(state, activation, 'reclaiming', { errorCode: null, recovery: null })
        for (const target of activation.targets) {
          const facts = factsFor(state, target.identity.appId); updateFacts(state, facts, { pending: null })
          changeOperation(state, state.operations.get(target.operationId)!, 'completed', { recovery: null, receipt: receipt({ activationId: activation.id, ready: true }) })
        }
        return changeActivation(state, activation, 'completed', { errorCode: null, recovery: null })
      })),
      completeRemoval: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision)
        if (activation.kind !== 'remove' || activation.phase !== 'reclaiming' || activation.ownerEpoch !== state.ownerEpoch) throw fail('transition-invalid')
        assertActivationTargets(state, activation, true); assertActivationReady(state, activation)
        for (const target of activation.targets) {
          const operation = state.operations.get(target.operationId)!
          if (operation.kind !== 'remove' || operation.phase !== 'completed' || !factsFor(state, target.identity.appId).installed.some(item => same(item.identity, target.identity) && item.state === 'removed')) throw fail('transition-invalid')
        }
        return changeActivation(state, activation, 'completed', { errorCode: null, recovery: null })
      })),
      interruptActivation: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision)
        if (terminalActivation(activation.phase)) throw fail('transition-invalid')
        for (const target of activation.targets) assertInactive(target.operationId)
        const updated = changeActivation(state, activation, 'recovery-required', { errorCode: activationErrorCode(input.errorCode), recovery: activation.recovery ?? { from: activation.phase, reason: 'outcome-unconfirmed' } })
        for (const target of activation.targets) {
          const operation = state.operations.get(target.operationId)!
          if (!terminalPhase(operation.phase) && operation.phase !== 'recovery-required') changeOperation(state, operation, 'recovery-required', { recovery: { from: operation.phase, reason: 'outcome-unconfirmed' }, receipt: receipt({ activationId: activation.id, errorCode: updated.errorCode }) })
        }
        return updated
      })),
      recoverActivation: input => command(input, input => mutate(state => {
        const activation = activationFor(state, input.activationId, input.expectedRevision), action = member(['resume', 'cancel'], input.action)
        if (activation.phase !== 'recovery-required' && !(activation.phase === 'prepared' && action === 'cancel')) throw fail('transition-invalid')
        const committed = activation.roles.some(role => role.handoffUsageId !== null)
        if (action === 'cancel') {
          if (committed) throw fail('transition-invalid')
          if (activation.kind === 'remove') for (const target of activation.targets) { const operation = state.operations.get(target.operationId)!; assertInactive(operation.id); if (!terminalPhase(operation.phase)) changeOperation(state, operation, 'cancelled', { recovery: null }) }
          return frozen({ activation: changeActivation(state, activation, 'cancelled', { recovery: null, errorCode: null }), credentials: [] })
        }
        if (!committed) {
          assertActivationTargets(state, activation, false)
          return frozen({ activation: changeActivation(state, activation, 'prepared', { ownerEpoch: state.ownerEpoch, registryRevision: state.revision, recovery: null, errorCode: null }), credentials: [] })
        }
        assertActivationTargets(state, activation, true)
        const affectedRoles = new Set(activation.roles.map(role => role.role))
        if ([...state.usages.values()].some(record => record.usage.state !== 'exited' && (affectedRoles.has(state.snapshots.get(record.usage.snapshotId)!.role) || activation.ownedUsageIds.includes(record.usage.id) || snapshotPackages(state.snapshots.get(record.usage.snapshotId)!).some(selected => activation.targets.some(target => selected.appId === target.identity.appId))))) throw fail('version-in-use')
        const holderId = identifier(input.holderId), generation = identifier(input.generation)
        activateOperations(state, activation)
        const launch = issueActivationRoles(state, activation, { holderId, generation })
        const updated = changeActivation(state, activation, 'handoff', { roles: launch.roles, ownerEpoch: state.ownerEpoch, recovery: null, errorCode: null })
        return frozen({ activation: updated, credentials: launch.credentials })
      })),
      quarantineInstallation: input => command(input, input => mutate(state => {
        const selected = identity(input.identity), facts = factsFor(state, selected.appId); assertAppRevision(facts, input.expectedAppRevision)
        const installed = facts.installed.find(item => same(item.identity, selected))
        if (!installed || !['installed', 'quarantined'].includes(installed.state)) throw fail('not-found')
        const errorCode = activationErrorCode(input.errorCode)
        if (installed.state !== 'quarantined') updateFacts(state, facts, { installed: facts.installed.map(item => item === installed ? frozen({ ...item, state: 'quarantined' as const }) : item) })
        for (const activation of state.activations.values()) if (!terminalActivation(activation.phase) && activation.roles.some(role => snapshotPackages(role).some(item => same(item, selected)))) {
          changeActivation(state, activation, 'recovery-required', { errorCode, recovery: activation.recovery ?? { from: activation.phase, reason: 'outcome-unconfirmed' } })
        }
        const operation = state.operations.get(installed.operationId)!
        if (!terminalPhase(operation.phase) && operation.phase !== 'recovery-required') changeOperation(state, operation, 'recovery-required', { recovery: { from: operation.phase, reason: 'outcome-unconfirmed' }, receipt: receipt({ quarantine: errorCode }) })
        return factsFor(state, selected.appId)
      })),
      closeAdmission() { accepting = false; for (const controller of controllers) controller.abort() },
      async awaitIdle() { while (pending.size) await Promise.allSettled([...pending]) },
    }
    ctx.effect(() => async () => {
      service.closeAdmission(); await service.awaitIdle()
      if (cleanupFailures.size) throw new AggregateError([...cleanupFailures], 'package usage resources did not confirm exit')
    }, 'stop package operations and await controlled resource exit')
    ctx.provide(packageRegistryServiceKey, service)
  } }
}

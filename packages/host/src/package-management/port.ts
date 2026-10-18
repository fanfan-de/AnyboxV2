/** Host lifecycle facts only. No application business or archive-driver types enter this port. */
export const packageRegistryServiceKey = 'host.package-registry'
export const packageRegistryStorageServiceKey = 'host.package-registry-storage'

export interface PackageIdentity {
  readonly appId: string
  readonly version: string
  readonly digest: string
  readonly target: { readonly os: string; readonly arch: string }
}
export interface PackageInstallation {
  readonly identity: PackageIdentity
  readonly source: { readonly kind: 'file' | 'directory' | 'catalog' | 'migration'; readonly reference: string; readonly publisher: string }
  readonly installedAt: string
  readonly operationId: string
  readonly state: 'installed' | 'quarantined' | 'reclaiming' | 'removed'
}
export interface ApplicationInstallationFacts {
  readonly appId: string
  readonly revision: number
  readonly installed: readonly PackageInstallation[]
  readonly selected: PackageIdentity | null
  readonly pending: PackageIdentity | null
}
export type PackageOperationKind = 'install' | 'activate' | 'remove'
export type PackageOperationPhase = 'accepted' | 'preparing' | 'prepared' | 'committing' | 'awaiting-activation' | 'activating' | 'completed' | 'failed' | 'cancelled' | 'recovery-required'
export type PackageReceiptValue = null | string | number | boolean | readonly PackageReceiptValue[] | { readonly [key: string]: PackageReceiptValue }
export interface PackageOperation {
  readonly id: string
  readonly requestId: string
  readonly appId: string
  readonly kind: PackageOperationKind
  readonly identity: PackageIdentity
  readonly revision: number
  readonly phase: PackageOperationPhase
  readonly receipt: PackageReceiptValue
  readonly recovery: { readonly from: PackageOperationPhase; readonly reason: 'owner-restarted' | 'outcome-unconfirmed' } | null
  readonly createdAt: string
  readonly updatedAt: string
}
/** Accepted file intent precedes all managed byte reads and has no trusted app identity yet. */
export interface PackageFileInstallIntent {
  readonly requestId: string
  readonly filename: string
  /** Missing in old file intents; normalized to archive at the registry boundary. */
  readonly sourceFormat?: 'archive' | 'directory'
  /** Explicit admission of this exact local directory content, never publisher authorization. */
  readonly localTrust?: boolean
  readonly archiveDigest: string
  readonly archiveSize: number
  readonly expectedAppRevision?: number
}
export type PackageFileInstallPhase = 'accepted' | 'receiving' | 'verifying' | 'prepared' | 'committing' | 'installed' | 'failed' | 'cancelled' | 'recovery-required'
export interface PackageFileInstall {
  readonly id: string
  readonly requestId: string
  readonly filename: string
  readonly sourceFormat?: 'archive' | 'directory'
  readonly localTrust?: boolean
  readonly archiveDigest: string
  readonly archiveSize: number
  readonly expectedAppRevision: number | null
  readonly revision: number
  readonly phase: PackageFileInstallPhase
  readonly identity: PackageIdentity | null
  readonly operationId: string | null
  /** True only when binding found this exact identity already installed; the adapter must still verify its directory. */
  readonly existingInstallation: boolean
  /** Append-only resource lifetime anchors; receipts cannot erase earlier attempts. Never contains secrets. */
  readonly workGuardIds: readonly string[]
  readonly receipt: PackageReceiptValue
  readonly errorCode: string | null
  readonly recovery: { readonly from: PackageFileInstallPhase; readonly reason: 'owner-restarted' | 'outcome-unconfirmed' } | null
  readonly createdAt: string
  readonly updatedAt: string
}
export interface PackageEntrySelection {
  readonly package: PackageIdentity
  readonly entry: 'client' | 'execution' | 'computer-worker' | 'web'
  /** Backend target is separate from installation. Interface-only entries omit it. */
  readonly desiredEnabled?: boolean
}
export interface PackageCapabilitySelection {
  readonly id: string
  readonly version: string
  /** null denotes immutable host-bundled code; external providers pin their package. */
  readonly package: PackageIdentity | null
}
export interface PackageCatalogSnapshot {
  readonly id: string
  readonly revision: number
  readonly registryRevision: number
  readonly ownerEpoch: number
  readonly role: 'client' | 'execution' | 'computer-worker' | 'web'
  readonly entries: readonly PackageEntrySelection[]
  readonly capabilities: readonly PackageCapabilitySelection[]
  readonly revoked: boolean
}
export interface PackageUsage {
  readonly id: string
  readonly snapshotId: string
  readonly holderId: string
  readonly generation: string
  readonly parentId: string | null
  readonly state: 'reserved' | 'claimed' | 'ready' | 'exit-unconfirmed' | 'exited'
  readonly createdAt: string
}
/** Returned once to the trusted role launcher. Never a browser DTO or persisted plaintext. */
export interface PackageUseCredential {
  readonly usageId: string
  readonly secret: string
  readonly snapshot: PackageCatalogSnapshot
}
export interface PackageActualCatalog {
  readonly usage: PackageUsage
  readonly snapshot: PackageCatalogSnapshot
}
export interface PackageRegistryView {
  readonly revision: number
  readonly ownerEpoch: number
  readonly applications: readonly ApplicationInstallationFacts[]
  readonly actual: readonly PackageActualCatalog[]
}
/** A durable, exact role plan. It contains lifecycle targets, never application business state. */
export interface PackageActivationRolePlan {
  readonly role: PackageCatalogSnapshot['role']
  readonly entries: readonly PackageEntrySelection[]
  readonly capabilities?: readonly PackageCapabilitySelection[]
}
export type PackageActivationKind = 'activate' | 'remove'
export type PackageActivationPhase = 'prepared' | 'handoff' | 'loading' | 'reclaiming' | 'completed' | 'recovery-required' | 'cancelled'
export interface PackageActivationTarget {
  readonly identity: PackageIdentity
  readonly previousSelected: PackageIdentity | null
  readonly operationId: string
}
export interface PackageActivationRole extends Omit<PackageActivationRolePlan, 'capabilities'> {
  readonly capabilities: readonly PackageCapabilitySelection[]
  readonly handoffUsageId: string | null
  /** Every attempt remains pinned until its actual resource exit is proved. */
  readonly usageIds: readonly string[]
  readonly readyUsageId: string | null
}
export interface PackageActivation {
  readonly kind: PackageActivationKind
  readonly id: string
  readonly requestId: string
  readonly revision: number
  readonly registryRevision: number
  readonly ownerEpoch: number
  readonly phase: PackageActivationPhase
  readonly targets: readonly PackageActivationTarget[]
  readonly roles: readonly PackageActivationRole[]
  readonly supersededUsageIds: readonly string[]
  /** Exact old managed roles that are closed even when the new catalog omits their role. */
  readonly ownedUsageIds: readonly string[]
  readonly receipt: PackageReceiptValue
  readonly errorCode: string | null
  readonly recovery: { readonly from: PackageActivationPhase; readonly reason: 'owner-restarted' | 'outcome-unconfirmed' } | null
  readonly createdAt: string
  readonly updatedAt: string
}
export interface PackageActivationLaunch {
  readonly activation: PackageActivation
  /** Private launcher result. Never persist or send these secrets through browser HTTP. */
  readonly credentials: readonly PackageUseCredential[]
}
/** Private physical root pinned by the registry owner, never a browser DTO or a caller-supplied path. */
export interface PackageReclamationRoot {
  readonly directory: string
  readonly device: number
  readonly inode: number
}
export interface PackageRegistryPort {
  inspect(): Promise<PackageRegistryView>
  getOperation(id: string): Promise<PackageOperation | undefined>
  findOperation(requestId: string): Promise<PackageOperation | undefined>
  listOperations(): Promise<readonly PackageOperation[]>
  acceptFileInstall(input: PackageFileInstallIntent): Promise<PackageFileInstall>
  getFileInstall(id: string): Promise<PackageFileInstall | undefined>
  findFileInstall(requestId: string): Promise<PackageFileInstall | undefined>
  listFileInstalls(): Promise<readonly PackageFileInstall[]>
  /** Binding follows static verification, before the independent registration preparation process. */
  bindFileInstall(input: { installId: string; expectedRevision: number; identity: PackageIdentity }): Promise<PackageFileInstall>
  /** prepared/committing also advance a newly bound install operation atomically; installed is otherwise written by recordInstalled. */
  advanceFileInstall(input: { installId: string; expectedRevision: number; phase: PackageFileInstallPhase; receipt?: PackageReceiptValue; errorCode?: string | null; workGuardId?: string }): Promise<PackageFileInstall>
  /** Trusted adapter supplies explicit disk observations; no automatic side-effect replay. */
  reconcileFileInstall(input: { installId: string; expectedRevision: number; phase: 'verifying' | 'prepared' | 'committing' | 'installed' | 'failed' | 'cancelled'; receipt: PackageReceiptValue; errorCode?: string | null }): Promise<PackageFileInstall>
  begin(input: { requestId: string; kind: PackageOperationKind; identity: PackageIdentity; expectedAppRevision: number }): Promise<PackageOperation>
  advance(input: { operationId: string; expectedRevision: number; phase: PackageOperationPhase; receipt?: PackageReceiptValue }): Promise<PackageOperation>
  /** Trusted installation adapter supplies verified facts; this port never reads or executes a package. */
  recordInstalled(input: { operationId: string; expectedRevision: number; expectedAppRevision: number; source: PackageInstallation['source'] }): Promise<PackageOperation>
  select(input: { operationId: string; expectedRevision: number; expectedAppRevision: number }): Promise<PackageOperation>
  /** Explicit recovery receipt; never resumes unknown file effects automatically. */
  reconcile(input: { operationId: string; expectedRevision: number; phase: 'prepared' | 'committing' | 'awaiting-activation' | 'activating' | 'failed' | 'cancelled'; receipt: PackageReceiptValue }): Promise<PackageOperation>
  prepareUse(input: { expectedRegistryRevision: number; role: PackageCatalogSnapshot['role']; holderId: string; generation: string; entries: readonly PackageEntrySelection[]; capabilities?: readonly PackageCapabilitySelection[] }): Promise<PackageUseCredential>
  /** Child reservation commits before the parent reservation can be released. */
  prepareHandoff(parent: { usageId: string; secret: string }, holder: { holderId: string; generation: string }): Promise<PackageUseCredential>
  /** Caller holds the OS-backed usage read lock before claiming, and before importing code. */
  claim(credential: { usageId: string; secret: string }): Promise<PackageCatalogSnapshot>
  ready(credential: { usageId: string; secret: string }): Promise<PackageActualCatalog>
  /** Private launcher authentication of an already claimed live role; never promotes it to ready. */
  validateUse(credential: { usageId: string; secret: string }): Promise<PackageCatalogSnapshot>
  revokeSnapshot(input: { snapshotId: string; expectedRevision: number }): Promise<PackageCatalogSnapshot>
  listUsages(): Promise<readonly PackageUsage[]>
  /** Fences new claims, proves OS lock exit, and durably revokes the anchor before release. */
  confirmExit(input: { usageId: string }): Promise<PackageUsage>
  /** A local controlled callback, not a deletion API. Unknown exit or a changed physical root prevents entry. */
  withReclamation<T>(input: { operationId: string; expectedRevision: number; expectedAppRevision: number }, work: (identity: PackageIdentity, signal: AbortSignal, root: PackageReclamationRoot) => Promise<T>): Promise<T>
  getActivation(id: string): Promise<PackageActivation | undefined>
  findActivation(requestId: string): Promise<PackageActivation | undefined>
  listActivations(): Promise<readonly PackageActivation[]>
  /** Records intent only; selected/pending and all running roles remain unchanged. */
  prepareActivation(input: { kind?: PackageActivationKind; requestId: string; expectedRegistryRevision: number; appIds?: readonly string[]; roles: readonly PackageActivationRolePlan[]; ownedUsageIds?: readonly string[] }): Promise<PackageActivation>
  /** Called only after the lifecycle coordinator has frozen admission and confirmed every role's guards. */
  commitActivation(input: { activationId: string; expectedRevision: number; holderId: string; generation: string; receipt: PackageReceiptValue }): Promise<PackageActivationLaunch>
  /** A new writer authenticates held parent anchors, then issues new current-owner reservations. */
  adoptActivation(input: { activationId: string; expectedRevision: number; parents: readonly { usageId: string; secret: string }[]; holderId: string; generation: string }): Promise<PackageActivationLaunch>
  /** Ready is accepted only from the actual current-owner usage with the exact recorded role contents. */
  recordActivationRoleReady(input: { activationId: string; expectedRevision: number; usageId: string }): Promise<PackageActivation>
  completeActivation(input: { activationId: string; expectedRevision: number }): Promise<PackageActivation>
  /** Completion of role switching is insufficient for uninstall: every target must be durably removed. */
  completeRemoval(input: { activationId: string; expectedRevision: number }): Promise<PackageActivation>
  interruptActivation(input: { activationId: string; expectedRevision: number; errorCode: string }): Promise<PackageActivation>
  /** Resume proves previous attempts exited, then re-arms fresh parent handoff reservations; it never starts application code. */
  recoverActivation(input: { activationId: string; expectedRevision: number; action: 'resume' | 'cancel'; holderId?: string; generation?: string }): Promise<PackageActivationLaunch>
  /** Quarantine preserves installation and pointer facts; it cannot fabricate an exit or remove files. */
  quarantineInstallation(input: { identity: PackageIdentity; expectedAppRevision: number; errorCode: string }): Promise<ApplicationInstallationFacts>
  closeAdmission(): void
  awaitIdle(): Promise<void>
}
export type PackageRegistryFailureCode = 'invalid-input' | 'revision-conflict' | 'request-conflict' | 'operation-conflict' | 'transition-invalid' | 'not-found' | 'identity-conflict' | 'snapshot-stale' | 'snapshot-revoked' | 'use-unavailable' | 'use-lock-required' | 'version-in-use' | 'service-closing' | 'registry-corrupt' | 'reclamation-root-changed' | 'reclamation-root-unavailable'
export function packageRegistryFailure(code: PackageRegistryFailureCode): Error & { readonly code: PackageRegistryFailureCode } {
  return Object.assign(new Error(`package registry ${code}`), { name: 'PackageRegistryFailure', code })
}

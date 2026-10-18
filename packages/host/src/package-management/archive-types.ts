import type { KeyObject } from 'node:crypto'
import type { PackageIdentity } from './port.js'

export type ApplicationArchiveRole = 'client' | 'execution' | 'computerWorker'
export type ApplicationArchiveEntryRole = ApplicationArchiveRole | 'web'
export interface ApplicationArchiveTarget { readonly os: string; readonly arch: string }
export interface ApplicationArchiveRuntimeRequirement {
  readonly profile: string
  readonly sharedRuntime?: string
  readonly node?: string
  readonly nodeApi?: number
  readonly modules?: string
  readonly sqlite?: boolean
  readonly libc?: 'glibc' | 'musl'
  readonly platforms?: readonly string[]
}
export interface ApplicationArchiveRuntimeProfile {
  readonly profile: string
  readonly sharedRuntime?: string
  readonly node?: string
  readonly nodeApi?: number
  readonly modules?: string
  readonly sqlite?: boolean
  readonly libc?: 'glibc' | 'musl'
  readonly platform?: string
}
export interface ApplicationArchiveCapabilityRequirements {
  readonly required?: Readonly<Record<string, string>>
  readonly optional?: Readonly<Record<string, string>>
}
export interface ApplicationArchiveManifest {
  readonly schemaVersion: 1
  /** Versioned generic package role launch contract; required to load packages with independent worker roles. */
  readonly lifecycleVersion?: 1
  readonly appId: string
  readonly version: string
  readonly publisher: string
  readonly displayName: string
  readonly applicationApi: string
  readonly target: ApplicationArchiveTarget
  readonly entries?: Readonly<Partial<Record<ApplicationArchiveRole, string>>>
  readonly web?: { readonly entry: string; readonly assets?: string; readonly styles?: readonly string[] }
  readonly runtimeRequirements?: Readonly<Partial<Record<ApplicationArchiveRole, ApplicationArchiveRuntimeRequirement>>>
  readonly capabilityRequirements?: Readonly<Partial<Record<ApplicationArchiveEntryRole, ApplicationArchiveCapabilityRequirements>>>
  readonly dataCompatibility?: string
}
export interface ApplicationArchiveFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly mode: 420 | 493
}
export interface ApplicationArchiveSignature { readonly schemaVersion: 1; readonly keyId: string; readonly signature: string }
export interface ApplicationArchivePublisher {
  readonly publisher: string
  readonly keyId: string
  readonly publicKey: string | KeyObject
  readonly appIds: readonly string[]
}
export interface ApplicationArchiveLimits {
  readonly archiveBytes: number
  readonly expandedBytes: number
  readonly fileBytes: number
  readonly metadataBytes: number
  readonly files: number
  readonly compressionRatio: number
}
export interface VerifyApplicationArchiveOptions {
  readonly trustedPublishers: readonly ApplicationArchivePublisher[]
  readonly target: ApplicationArchiveTarget
  readonly applicationApiVersion: string
  readonly runtimeProfiles?: Readonly<Partial<Record<ApplicationArchiveRole, ApplicationArchiveRuntimeProfile>>>
  readonly limits?: Partial<ApplicationArchiveLimits>
  readonly signal?: AbortSignal
}
export interface VerifyApplicationPackageOptions extends VerifyApplicationArchiveOptions {
  /** Explicit caller authorization for locally authored, unsigned application directories. */
  readonly allowUnsignedLocal?: boolean
}
export interface ApplicationArchiveRoleCompatibility { readonly compatible: boolean; readonly reasons: readonly string[] }
export interface VerifiedApplicationArchive {
  readonly manifest: ApplicationArchiveManifest
  readonly identity: PackageIdentity
  readonly signature: ApplicationArchiveSignature | null
  readonly metadataPaths: readonly string[]
  readonly files: readonly ApplicationArchiveFile[]
  readonly filePaths: readonly string[]
  readonly roleCompatibility: Readonly<Partial<Record<ApplicationArchiveEntryRole, ApplicationArchiveRoleCompatibility>>>
  readonly archiveDigest: string
  readonly archiveSize: number
  /** Returns a fresh copy; verified backing bytes never escape. */
  readFile(path: string): Uint8Array
}
export interface CreateApplicationArchiveInput {
  readonly manifest: ApplicationArchiveManifest
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array; readonly mode?: 420 | 493 }[]
  readonly keyId: string
  readonly privateKey: string | KeyObject
}
/** A regular file in an application directory; metadata always uses mode 0644. */
export interface ApplicationDirectoryEntry {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode?: 420 | 493
}
export interface ApplicationDirectoryOptions {
  readonly limits?: Partial<ApplicationArchiveLimits>
  readonly signal?: AbortSignal
}

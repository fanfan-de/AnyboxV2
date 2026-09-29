import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import type { StorageTransaction } from '../storage/port.js'

export const imageAssetsServiceKey = 'harness.image-assets'
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

/** Immutable server-verified image identity. Expiry is absent once durably retained. */
export interface ImageRef {
  readonly assetId: string
  readonly sha256: string
  readonly mediaType: ImageMediaType
  readonly byteLength: number
  readonly width: number
  readonly height: number
  readonly expiresAt?: string
}

export interface ImageAssetsPort {
  importImage(input: { readonly scopeId: string; readonly bytes: AsyncIterable<Uint8Array> }, signal?: AbortSignal): OwnedCall<ImageRef>
  describe(scopeId: string, assetIds: readonly string[]): Promise<readonly ImageRef[]>
  /** Synchronous participant in the caller's transaction on the same local-storage service. */
  retainIn(tx: StorageTransaction, scopeId: string, ownerKey: string, refs: readonly ImageRef[]): readonly ImageRef[]
  readImage(scopeId: string, assetId: string, signal?: AbortSignal): OwnedCall<Uint8Array>
  renew(scopeId: string, assetIds: readonly string[]): Promise<ImageRenewal>
}

export interface ImageRenewal { readonly valid: readonly ImageRef[]; readonly invalid: readonly string[] }

export interface ImageAssetsOptions extends Partial<RuntimeInputs> {
  readonly directory: string
  /** Tests and hosts may shorten the collection interval; draft lifetime remains 24 hours. */
  readonly collectionIntervalMs?: number
}

export type ImageAssetErrorCode = 'asset-invalid' | 'asset-too-large' | 'asset-unsupported' | 'asset-expired' |
  'asset-missing' | 'asset-corrupt' | 'asset-unavailable' | 'asset-occupied' | 'asset-cancelled' | 'asset-cleanup-failed'

export function imageAssetError(code: ImageAssetErrorCode): Error & { readonly code: ImageAssetErrorCode } {
  return Object.assign(new Error(code), { name: 'ImageAssetError', code })
}

export function isImageAssetError(value: unknown): value is Error & { readonly code: ImageAssetErrorCode } {
  return value instanceof Error && value.name === 'ImageAssetError' && 'code' in value
}

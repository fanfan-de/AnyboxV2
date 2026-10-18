import { imageAssetError } from './port.js'
import type { ImageRef } from './port.js'

/** Shared by the browser and server; this module has no platform imports. */
export const imageLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxBatchBytes: 20 * 1024 * 1024,
  maxImages: 8,
  maxWidth: 4096,
  maxHeight: 4096,
  draftTtlMs: 24 * 60 * 60 * 1000,
  renewIntervalMs: 5 * 60 * 1000,
  acceptedMediaTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const),
})

export function validateImageBatch(refs: readonly Pick<ImageRef, 'byteLength'>[]): void {
  if (!Array.isArray(refs) || refs.length > imageLimits.maxImages) throw imageAssetError('asset-too-large')
  let total = 0
  for (const ref of refs) {
    if (!ref || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1) throw imageAssetError('asset-invalid')
    if (ref.byteLength > imageLimits.maxBytes) throw imageAssetError('asset-too-large')
    total += ref.byteLength
  }
  if (total > imageLimits.maxBatchBytes) throw imageAssetError('asset-too-large')
}

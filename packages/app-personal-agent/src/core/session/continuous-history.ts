import { nativeImageResourceUri } from '@anybox/models'
import { imageLimits } from '../image/limits.js'
import type { ImageRef } from '../image/port.js'
import type { ProtocolRecord } from '../run/program.js'

export interface HistoryUsage {
  readonly bytes: number
  readonly images: number
  readonly imageBytes: number
}

export const approximateImageTokens = 768
const nativeRecordOverheadBytes = 32

export function nativeHistoryUsage(records: readonly ProtocolRecord[]): HistoryUsage {
  let bytes = records.length * nativeRecordOverheadBytes, images = 0, imageBytes = 0
  for (const record of records) {
    const payload = JSON.stringify(record.payload)
    bytes += Buffer.byteLength(payload, 'utf8')
    for (const image of record.resourceRefs ?? []) {
      // The same persisted resource can appear at several positions in a request.
      const uses = Math.max(1, payload.split(nativeImageResourceUri(image.id)).length - 1)
      images += uses
      imageBytes += uses * image.byteLength
    }
  }
  return { bytes, images, imageBytes }
}

export function addHistoryUsage(left: HistoryUsage, right: HistoryUsage): HistoryUsage {
  return { bytes: left.bytes + right.bytes, images: left.images + right.images, imageBytes: left.imageBytes + right.imageBytes }
}

export function historyImagesFit(usage: HistoryUsage,
  currentImages: readonly Pick<ImageRef, 'byteLength'>[] = []): boolean {
  const currentImageBytes = currentImages.reduce((total, image) => total + image.byteLength, 0)
  return usage.images + currentImages.length <= imageLimits.maxImages &&
    usage.imageBytes + currentImageBytes <= imageLimits.maxBatchBytes
}

export function projectedTokens(text: string): number {
  // Provider tokenizers differ. Estimate the size of the encoded input from its UTF-8 bytes.
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

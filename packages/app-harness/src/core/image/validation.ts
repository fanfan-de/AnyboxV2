import sharp from 'sharp'
import { imageLimits } from './limits.js'
import { imageAssetError, isImageAssetError } from './port.js'
import type { ImageMediaType } from './port.js'

function formatOf(bytes: Buffer): 'jpeg' | 'png' | 'webp' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let at = 8; at < bytes.length;) {
      if (at + 12 > bytes.length) throw imageAssetError('asset-invalid')
      const size = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8)
      if (kind === 'acTL') throw imageAssetError('asset-unsupported')
      if (at + 12 + size > bytes.length) throw imageAssetError('asset-invalid')
      at += 12 + size
    }
    return 'png'
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw imageAssetError('asset-invalid')
    for (let at = 12; at < bytes.length;) {
      if (at + 8 > bytes.length) throw imageAssetError('asset-invalid')
      const kind = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4)
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && ((bytes[at + 8] ?? 0) & 2))) throw imageAssetError('asset-unsupported')
      if (at + 8 + size > bytes.length) throw imageAssetError('asset-invalid')
      at += 8 + size + (size % 2)
    }
    return 'webp'
  }
  throw imageAssetError('asset-unsupported')
}

/** Decode the complete original image; never transcode or trust a filename/content-type. */
export async function validateImage(bytes: Buffer, signal: AbortSignal): Promise<{
  readonly mediaType: ImageMediaType; readonly width: number; readonly height: number
}> {
  if (!bytes.length) throw imageAssetError('asset-invalid')
  if (bytes.length > imageLimits.maxBytes) throw imageAssetError('asset-too-large')
  signal.throwIfAborted()
  const format = formatOf(bytes)
  const header = sharp(bytes, { animated: true, failOn: 'warning', limitInputPixels: false })
  let decoder: ReturnType<typeof sharp> | undefined
  try {
    const metadata = await header.metadata()
    signal.throwIfAborted()
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) throw imageAssetError('asset-unsupported')
    if (!metadata.width || !metadata.height) throw imageAssetError('asset-invalid')
    if (metadata.width > imageLimits.maxWidth || metadata.height > imageLimits.maxHeight) throw imageAssetError('asset-too-large')
    // metadata() alone accepts truncated images. stats() forces a complete pixel decode.
    decoder = sharp(bytes, { animated: true, failOn: 'warning', limitInputPixels: imageLimits.maxWidth * imageLimits.maxHeight })
    await decoder.stats()
    signal.throwIfAborted()
    return { mediaType: `image/${format}`, width: metadata.width, height: metadata.height }
  } catch (error) {
    if (signal.aborted) throw imageAssetError('asset-cancelled')
    if (isImageAssetError(error)) throw error
    throw imageAssetError('asset-invalid')
  } finally { header.destroy(); decoder?.destroy() }
}

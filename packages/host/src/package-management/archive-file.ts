import { open } from 'node:fs/promises'

/** Bound accepted bytes before allocation; cancellation joins the current read and close. */
export async function readApplicationPackageFile(path: string, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error('Application package file exceeds its size limit or is not a regular file')
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - length))
      const { bytesRead } = await handle.read(chunk)
      if (!bytesRead) break
      length += bytesRead
      if (length > maximum) throw new Error('Application package file exceeds its size limit')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    signal?.throwIfAborted()
    return Buffer.concat(chunks, length)
  } finally { await handle.close() }
}


import type { FileHandle } from 'node:fs/promises'

/** NTFS exposes read/write attributes, not signed POSIX executable bits. */
export function packageFileModeMatches(mode: number, expected: number): boolean {
  return process.platform === 'win32' ? (mode & 0o777) === 0o666 : (mode & 0o777) === expected
}

/** File data is always flushed separately. Windows has no Node directory fsync. */
export async function syncPackageDirectory(handle: FileHandle): Promise<void> {
  if (!(await handle.stat()).isDirectory()) throw new TypeError('Package directory handle required')
  if (process.platform !== 'win32') await handle.sync()
}

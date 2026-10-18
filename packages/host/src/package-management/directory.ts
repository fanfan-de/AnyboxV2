import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ApplicationDirectoryEntry, ApplicationDirectoryOptions } from './archive-types.js'
import { addApplicationArchivePath, applicationArchiveFailure, applicationArchiveLimits, applicationArchivePath, encodeApplicationDirectory } from './directory-format.js'

function reject(code: string): never { throw applicationArchiveFailure(code) }
const metadata = new Set(['manifest.json', 'files.json', 'signature.json'])
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

/**
 * Copy regular files into a bounded immutable transport snapshot, without importing code.
 * Each opened object is checked against its path before and after reading, and the full
 * source tree is checked again before returning. Cancellation joins reads and closes.
 */
export async function readApplicationDirectory(path: string, options: ApplicationDirectoryOptions = {}): Promise<Uint8Array> {
  const limits = applicationArchiveLimits(options.limits)
  options.signal?.throwIfAborted()
  const root = resolve(path)
  const snapshots: { readonly path: string; readonly info: BigIntStats }[] = []
  const entries: ApplicationDirectoryEntry[] = []
  const paths = new Set<string>()
  let directories = 0
  let expanded = 0, transport = new TextEncoder().encode('Anybox Application Directory v1\0').length + 4
  const check = (): void => options.signal?.throwIfAborted()
  const inspect = async (target: string): Promise<BigIntStats> => {
    check()
    const info = await lstat(target, { bigint: true })
    check()
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1n) reject('unsafe-file-kind')
    return info
  }
  const walk = async (target: string, relative: string, expected?: BigIntStats): Promise<void> => {
    // Directory entries carry no bytes in the transport, so cap traversal work independently.
    if (++directories > limits.files * 4 + 3) reject('directory-count-limit')
    const initial = expected ?? await inspect(target)
    if (!initial.isDirectory()) reject('unsafe-directory')
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    let names: string[]
    try {
      check()
      if (!same(initial, await handle.stat({ bigint: true }))) reject('directory-source-changed')
      snapshots.push({ path: target, info: initial })
      names = []
      const children = await opendir(target, { bufferSize: 128 })
      try {
        for (;;) {
          check()
          const child = await children.read()
          if (!child) break
          if (names.length >= limits.files * 5 + 6) reject('directory-count-limit')
          names.push(child.name)
        }
      } finally { await children.close() }
      names.sort()
      check()
      if (!same(initial, await handle.stat({ bigint: true })) || !same(initial, await inspect(target))) reject('directory-source-changed')
    } finally { await handle.close() }
    // Never retain a directory handle while descending; deeply nested input cannot exhaust FDs.
    let descendants = 0
    for (const name of names) {
      check()
      const child = relative ? `${relative}/${name}` : name
      applicationArchivePath(child)
      const childTarget = join(target, name)
      const info = await inspect(childTarget)
      if (info.isDirectory()) {
        if (child !== 'payload' && child !== 'licenses' && !child.startsWith('payload/') && !child.startsWith('licenses/')) reject('unindexed-path')
        const before = entries.length
        await walk(childTarget, child, info)
        descendants += entries.length - before
        continue
      }
      if (!metadata.has(child) && !child.startsWith('payload/') && !child.startsWith('licenses/')) reject('unindexed-path')
      addApplicationArchivePath(paths, child)
      if (info.mode & 0o7000n) reject('unsafe-file-kind')
      const maximum = metadata.has(child) ? limits.metadataBytes : limits.fileBytes
      if (info.size > BigInt(maximum)) reject('expanded-size-limit')
      expanded += Number(info.size); transport += 12 + Buffer.byteLength(child) + Number(info.size)
      if (expanded > limits.expandedBytes) reject('expanded-size-limit')
      if (transport > limits.archiveBytes || entries.length >= limits.files + 3) reject('archive-size-limit')
      const file = await open(childTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        check()
        if (!same(info, await file.stat({ bigint: true }))) reject('directory-source-changed')
        const bytes = Buffer.alloc(Number(info.size))
        let offset = 0
        while (offset < bytes.length) {
          check()
          const read = await file.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
          if (!read.bytesRead) reject('directory-source-changed')
          offset += read.bytesRead
        }
        check()
        if (!same(info, await file.stat({ bigint: true })) || !same(info, await inspect(childTarget))) reject('directory-source-changed')
        entries.push({ path: child, bytes, mode: info.mode & 0o111n ? 493 : 420 })
        snapshots.push({ path: childTarget, info }); descendants++
      } finally { await file.close() }
    }
    if (relative && descendants === 0) reject('unindexed-path')
    check()
    if (!same(initial, await inspect(target))) reject('directory-source-changed')
  }
  await walk(root, '')
  // A replacement of an ancestor changes its own identity/ctime even if a leaf is restored.
  for (const snapshot of snapshots) if (!same(snapshot.info, await inspect(snapshot.path))) reject('directory-source-changed')
  check()
  // Browser File objects have no POSIX permissions. An explicit index is required
  // for executable payloads; otherwise both local entrypoints use ordinary 0644 files.
  const normalized = entries.some(entry => entry.path === 'files.json') ? entries : entries.map(entry => metadata.has(entry.path) ? entry : { ...entry, mode: 420 as const })
  return encodeApplicationDirectory(normalized, options)
}

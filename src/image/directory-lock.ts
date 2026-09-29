import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { imageAssetError, isImageAssetError } from './port.js'

function code(error: unknown, value: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === value
}
async function unlinkExact(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if (!code(error, 'ENOENT')) throw error }
}
async function removeEmpty(path: string): Promise<void> {
  try { await rmdir(path) } catch (error) {
    if (!code(error, 'ENOENT') && !code(error, 'ENOTEMPTY') && !code(error, 'EEXIST')) throw error
  }
}

/** A published lock is always nonempty. Recovery can remove only a proven-dead owner's unique token. */
export async function acquireImageDirectoryLock(directory: string): Promise<() => Promise<void>> {
  const lock = `${directory}.lock`, token = randomUUID(), filename = `${token}.json`, candidate = `${lock}.candidate-${token}`
  const host = hostname(), owner = { pid: process.pid, hostname: host, token }
  let acquired = false, created = false
  try {
    await mkdir(candidate, { mode: 0o700 })
    created = true
    const handle = await open(join(candidate, filename), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync() } finally { await handle.close() }
    for (let attempt = 0; attempt < 16; attempt++) {
      try { await rename(candidate, lock); acquired = true; break }
      catch (error) {
        if (!code(error, 'ENOTEMPTY') && !code(error, 'EEXIST')) throw imageAssetError('asset-unavailable')
      }
      let names: string[]
      try { names = await readdir(lock) } catch (error) { if (code(error, 'ENOENT')) continue; throw imageAssetError('asset-occupied') }
      if (!names.length) { await removeEmpty(lock); continue }
      if (names.length !== 1 || !/^[0-9a-f-]{36}\.json$/.test(names[0]!)) throw imageAssetError('asset-occupied')
      const previousFile = names[0]!
      let previous: { pid?: unknown; hostname?: unknown; token?: unknown }
      try { previous = JSON.parse(await readFile(join(lock, previousFile), 'utf8')) }
      catch (error) { if (code(error, 'ENOENT')) continue; throw imageAssetError('asset-occupied') }
      if (!previous || previous.hostname !== host || typeof previous.pid !== 'number' || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
        previous.token !== previousFile.slice(0, -5)) throw imageAssetError('asset-occupied')
      try { process.kill(previous.pid, 0) }
      catch (error) {
        if (code(error, 'ESRCH')) {
          // A competing reclaimer may already have installed another token. Never remove that token.
          await unlinkExact(join(lock, previousFile)); await removeEmpty(lock); continue
        }
        throw imageAssetError('asset-occupied')
      }
      throw imageAssetError('asset-occupied')
    }
    if (!acquired) throw imageAssetError('asset-occupied')
    let released = false
    return async () => {
      if (released) return
      released = true
      try { await unlinkExact(join(lock, filename)); await removeEmpty(lock) }
      catch { throw imageAssetError('asset-cleanup-failed') }
    }
  } catch (error) {
    if (isImageAssetError(error)) throw error
    throw imageAssetError('asset-unavailable')
  } finally {
    if (created && !acquired) {
      try { await unlinkExact(join(candidate, filename)); await removeEmpty(candidate) }
      catch { throw imageAssetError('asset-cleanup-failed') }
    }
  }
}

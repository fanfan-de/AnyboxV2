import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, realpath, open, unlink, link } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Component } from '@nya/core'
import type { OwnedCall } from '../contracts.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../storage/port.js'
import { imageLimits, validateImageBatch } from './limits.js'
import { imageAssetsServiceKey, imageAssetError, isImageAssetError } from './port.js'
import type { ImageAssetsOptions, ImageAssetsPort, ImageRef } from './port.js'
import { validateImage } from './validation.js'
import { acquireImageDirectoryLock } from './directory-lock.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_image_assets (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staging', 'ready', 'deleting')),
    sha256 TEXT, media_type TEXT, byte_length INTEGER, width INTEGER, height INTEGER,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`)
  tx.execute(`CREATE TABLE harness_image_retentions (
    asset_id TEXT NOT NULL REFERENCES harness_image_assets(id), owner_key TEXT NOT NULL,
    PRIMARY KEY(asset_id, owner_key)
  )`)
  tx.execute('CREATE INDEX harness_image_assets_expiry ON harness_image_assets(status, expires_at)')
} }]

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw imageAssetError('asset-invalid')
  return value
}
function assetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw imageAssetError('asset-invalid')
  return value
}
function ids(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > imageLimits.maxImages) throw imageAssetError('asset-invalid')
  return values.map(assetId)
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}
function refFromRow(row: StorageRow, retained: boolean): ImageRef {
  return Object.freeze({ assetId: assetId(row.id), sha256: String(row.sha256), mediaType: row.media_type as ImageRef['mediaType'],
    byteLength: Number(row.byte_length), width: Number(row.width), height: Number(row.height),
    ...(retained ? {} : { expiresAt: String(row.expires_at) }) })
}
function lookup(reader: StorageReader, scopeId: string, id: string, now: string): ImageRef {
  const row = reader.get('SELECT * FROM harness_image_assets WHERE id = ? AND scope_id = ?', [id, scopeId])
  if (!row) throw imageAssetError('asset-missing')
  const retained = !!reader.get('SELECT asset_id FROM harness_image_retentions WHERE asset_id = ? LIMIT 1', [id])
  if (row.status !== 'ready' || (!retained && String(row.expires_at) <= now)) throw imageAssetError('asset-expired')
  return refFromRow(row, retained)
}
function sameImage(left: ImageRef, right: ImageRef): boolean {
  return ['assetId', 'sha256', 'mediaType', 'byteLength', 'width', 'height'].every(key => left[key as keyof ImageRef] === right[key as keyof ImageRef])
}
async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose a directory fsync handle. File contents are still synced.
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function removeFile(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
}

/** One owner for immutable image files, temporary uploads, durable retentions and collection. */
export function createImageAssetsComponent(options: ImageAssetsOptions): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  const configuredDirectory = resolve(text(options.directory)), now = options.now ?? (() => new Date().toISOString()), newId = options.newId ?? randomUUID
  const interval = options.collectionIntervalMs ?? 60 * 60 * 1000
  if (!Number.isSafeInteger(interval) || interval < 1) throw imageAssetError('asset-invalid')
  return { name: 'harness-image-assets', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]
    let directory: string
    try { await mkdir(configuredDirectory, { recursive: true, mode: 0o700 }); directory = await realpath(configuredDirectory) }
    catch { throw imageAssetError('asset-unavailable') }
    const releaseDirectory = await acquireImageDirectoryLock(directory)
    ctx.effect(() => releaseDirectory, 'exclusive image directory')
    const pathFor = (id: string) => join(directory, `${assetId(id)}.image`)
    const temporaryFor = (id: string) => join(directory, `${assetId(id)}.part`)
    const active = new Set<OwnedCall<unknown>>(), operations = new Set<Promise<unknown>>(), reading = new Map<string, number>(), uploading = new Set<string>()
    const cleanupFailures: unknown[] = []
    const queuedUploads: { grant(release: () => void): void; cancel(): void }[] = []
    let runningUploads = 0
    const acquireUpload = (signal: AbortSignal): Promise<() => void> => {
      const take = (): (() => void) => {
        runningUploads++
        let released = false
        return () => {
          if (released) return
          released = true; runningUploads--
          const next = queuedUploads.shift()
          if (next) next.grant(take())
        }
      }
      if (signal.aborted) return Promise.reject(imageAssetError('asset-cancelled'))
      if (runningUploads < 2) return Promise.resolve(take())
      return new Promise((resolve, reject) => {
        const waiting = {
          grant(release: () => void) { signal.removeEventListener('abort', waiting.cancel); resolve(release) },
          cancel() {
            const at = queuedUploads.indexOf(waiting)
            if (at >= 0) queuedUploads.splice(at, 1)
            signal.removeEventListener('abort', waiting.cancel); reject(imageAssetError('asset-cancelled'))
          },
        }
        queuedUploads.push(waiting); signal.addEventListener('abort', waiting.cancel, { once: true })
      })
    }
    let accepting = false, collection: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined
    const timestamp = () => {
      const value = now(), time = Date.parse(value)
      if (!Number.isFinite(time)) throw imageAssetError('asset-invalid')
      return new Date(time).toISOString()
    }
    const expiry = (at: string) => new Date(Date.parse(at) + imageLimits.draftTtlMs).toISOString()
    const ensureOpen = () => { if (!accepting) throw imageAssetError('asset-unavailable') }
    const track = <T>(task: Promise<T>): Promise<T> => {
      operations.add(task)
      void task.finally(() => operations.delete(task)).catch(() => {})
      return task
    }
    const owned = <T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): OwnedCall<T> => {
      ensureOpen()
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      let call!: OwnedCall<T>
      const result = Promise.resolve().then(() => work(controller.signal)).then(value => {
        if (controller.signal.aborted) throw imageAssetError('asset-cancelled')
        return value
      }).catch(error => {
        if (isImageAssetError(error)) throw error
        throw imageAssetError(controller.signal.aborted ? 'asset-cancelled' : 'asset-unavailable')
      }).finally(() => { signal?.removeEventListener('abort', abort); active.delete(call) })
      const done = result.then(() => {}, error => {
        if (isImageAssetError(error) && error.code === 'asset-cleanup-failed') { cleanupFailures.push(error); throw error }
      })
      call = Object.freeze({ result, done, cancel: (_reason: string) => abort() })
      active.add(call)
      void result.catch(() => {}); void done.catch(() => {})
      return call
    }
    const removeMarked = async (id: string): Promise<void> => {
      const marked = await db.read(reader => reader.get("SELECT id FROM harness_image_assets WHERE id = ? AND status = 'deleting' AND NOT EXISTS (SELECT 1 FROM harness_image_retentions WHERE asset_id = ?)", [id, id]))
      if (!marked) return
      await removeFile(temporaryFor(id)); await removeFile(pathFor(id)); await syncDirectory(directory)
      await db.transaction(tx => { tx.execute("DELETE FROM harness_image_assets WHERE id = ? AND status = 'deleting' AND NOT EXISTS (SELECT 1 FROM harness_image_retentions WHERE asset_id = ?)", [id, id]) })
    }
    const collect = (recover = false): Promise<void> => {
      if (collection) return collection
      collection = (async () => {
        const selected = await db.transaction(tx => {
          const at = timestamp(), selected: string[] = []
          for (const row of tx.all(`SELECT id, status, expires_at FROM harness_image_assets
            WHERE NOT EXISTS (SELECT 1 FROM harness_image_retentions WHERE asset_id = harness_image_assets.id)`)) {
            const id = assetId(row.id)
            if (uploading.has(id) || reading.has(id)) continue
            if (row.status === 'deleting' || (recover && row.status === 'staging') || String(row.expires_at) <= at) {
              tx.execute("UPDATE harness_image_assets SET status = 'deleting' WHERE id = ?", [id]); selected.push(id)
            }
          }
          return selected
        })
        for (const id of selected) {
          try { await removeMarked(id) }
          catch { ctx.logger.warn('Image collection will retry a pending deletion', { assetId: id }) }
        }
      })().finally(() => { collection = undefined })
      return collection
    }
    ctx.effect(() => async () => {
      accepting = false
      if (timer) clearInterval(timer)
      for (const call of active) call.cancel('owner-disposed')
      await Promise.allSettled([...active].map(call => call.done))
      await Promise.allSettled([...operations])
      await collection
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Image cleanup failed')
    }, 'stop image admission and join imports, reads and collection')
    await db.migrate('image-assets', migrations)
    await collect(true)
    accepting = true
    timer = setInterval(() => { if (accepting) void collect().catch(() => { ctx.logger.warn('Image collection will retry after a storage failure') }) }, interval)
    timer.unref()
    const service: ImageAssetsPort = {
      importImage(input, signal) {
        const scopeId = text(input.scopeId)
        if (!input.bytes || typeof input.bytes[Symbol.asyncIterator] !== 'function') throw imageAssetError('asset-invalid')
        return owned(async signal => {
          const id = assetId(newId()), iterator = input.bytes[Symbol.asyncIterator]()
          let handle: FileHandle | undefined, inserted = false, complete = false, returning: Promise<unknown> | undefined, releaseUpload: (() => void) | undefined
          const endIterator = () => { if (!returning && iterator.return) { try { returning = Promise.resolve(iterator.return()); void returning.catch(() => {}) } catch (error) { returning = Promise.reject(error); void returning.catch(() => {}) } } }
          signal.addEventListener('abort', endIterator, { once: true })
          uploading.add(id)
          try {
            releaseUpload = await acquireUpload(signal)
            signal.throwIfAborted()
            await db.transaction(tx => {
              const at = timestamp()
              tx.execute("INSERT INTO harness_image_assets (id, scope_id, status, created_at, expires_at) VALUES (?, ?, 'staging', ?, ?)", [id, scopeId, at, expiry(at)])
            }, signal)
            inserted = true
            handle = await open(temporaryFor(id), 'wx', 0o600)
            let byteLength = 0
            while (true) {
              signal.throwIfAborted()
              const step = await iterator.next()
              signal.throwIfAborted()
              if (step.done) { complete = true; break }
              if (!(step.value instanceof Uint8Array)) throw imageAssetError('asset-invalid')
              byteLength += step.value.byteLength
              if (byteLength > imageLimits.maxBytes) throw imageAssetError('asset-too-large')
              await handle.writeFile(step.value)
            }
            await handle.sync(); await handle.close(); handle = undefined
            const source = await open(temporaryFor(id), 'r')
            let bytes: Buffer
            try { bytes = await source.readFile() } finally { await source.close() }
            signal.throwIfAborted()
            const metadata = await validateImage(bytes, signal), sha256 = createHash('sha256').update(bytes).digest('hex')
            // link() refuses to overwrite an existing final file; all paths are on one volume.
            await link(temporaryFor(id), pathFor(id)); await unlink(temporaryFor(id)); await syncDirectory(directory)
            const ref = await db.transaction(tx => {
              const at = timestamp()
              tx.execute("UPDATE harness_image_assets SET status = 'ready', sha256 = ?, media_type = ?, byte_length = ?, width = ?, height = ?, expires_at = ? WHERE id = ? AND status = 'staging'",
                [sha256, metadata.mediaType, byteLength, metadata.width, metadata.height, expiry(at), id])
              return lookup(tx, scopeId, id, at)
            }, signal)
            signal.throwIfAborted()
            return ref
          } catch (error) {
            if (handle) { try { await handle.close() } catch { throw imageAssetError('asset-cleanup-failed') } finally { handle = undefined } }
            if (inserted) {
              try {
                await db.transaction(tx => { if (!reading.has(id)) tx.execute("UPDATE harness_image_assets SET status = 'deleting' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM harness_image_retentions WHERE asset_id = ?)", [id, id]) })
                await removeMarked(id)
              } catch { throw imageAssetError('asset-cleanup-failed') }
            }
            throw error
          } finally {
            signal.removeEventListener('abort', endIterator)
            if (!complete) endIterator()
            try { await returning }
            catch { throw imageAssetError('asset-cleanup-failed') }
            finally { uploading.delete(id); releaseUpload?.() }
          }
        }, signal)
      },
      describe(scopeId, assetIds) {
        ensureOpen(); text(scopeId); const requested = ids(assetIds)
        return track(db.read(reader => { const at = timestamp(); return Object.freeze(requested.map(id => lookup(reader, scopeId, id, at))) }))
      },
      retainIn(tx, scopeId, ownerKey, refs) {
        ensureOpen(); text(scopeId); text(ownerKey)
        if (!Array.isArray(refs)) throw imageAssetError('asset-invalid')
        const requested = ids(refs.map(ref => ref.assetId)), at = timestamp()
        const actual = requested.map(id => lookup(tx, scopeId, id, at))
        validateImageBatch(actual)
        if (actual.some((ref, index) => !sameImage(ref, refs[index]!))) throw imageAssetError('asset-invalid')
        for (const id of new Set(requested)) tx.execute('INSERT OR IGNORE INTO harness_image_retentions (asset_id, owner_key) VALUES (?, ?)', [id, ownerKey])
        return Object.freeze(actual.map(({ expiresAt: _expiresAt, ...ref }) => Object.freeze(ref)))
      },
      readImage(scopeId, rawId, signal) {
        text(scopeId); const id = assetId(rawId)
        return owned(async signal => {
          let pinned = false, handle: FileHandle | undefined
          try {
            const ref = await db.read(reader => {
              const ref = lookup(reader, scopeId, id, timestamp())
              reading.set(id, (reading.get(id) ?? 0) + 1); pinned = true
              return ref
            }, signal)
            signal.throwIfAborted()
            try { handle = await open(pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW) }
            catch (error) { throw imageAssetError(hasCode(error, 'ENOENT') ? 'asset-missing' : 'asset-corrupt') }
            const stat = await handle.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== ref.byteLength) throw imageAssetError('asset-corrupt')
            const bytes = Buffer.alloc(ref.byteLength)
            let offset = 0
            while (offset < bytes.byteLength) {
              signal.throwIfAborted()
              const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
              if (!bytesRead) throw imageAssetError('asset-corrupt')
              offset += bytesRead
            }
            signal.throwIfAborted()
            if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw imageAssetError('asset-corrupt')
            return bytes
          } finally {
            try { if (handle) await handle.close() }
            catch { throw imageAssetError('asset-cleanup-failed') }
            finally { if (pinned) { const remaining = reading.get(id)! - 1; if (remaining) reading.set(id, remaining); else reading.delete(id) } }
          }
        }, signal)
      },
      renew(scopeId, assetIds) {
        ensureOpen(); text(scopeId); const requested = ids(assetIds)
        return track(db.transaction(tx => {
          const at = timestamp(), valid: ImageRef[] = [], invalid: string[] = []
          for (const id of new Set(requested)) {
            let ref: ImageRef
            try { ref = lookup(tx, scopeId, id, at) }
            catch (error) { if (isImageAssetError(error)) { invalid.push(id); continue } throw error }
            if (ref.expiresAt) {
              tx.execute("UPDATE harness_image_assets SET expires_at = ? WHERE id = ? AND status = 'ready'", [expiry(at), id])
              ref = Object.freeze({ ...ref, expiresAt: expiry(at) })
            }
            valid.push(ref)
          }
          return Object.freeze({ valid: Object.freeze(valid), invalid: Object.freeze(invalid) })
        }))
      },
    }
    ctx.provide(imageAssetsServiceKey, service)
  } }
}

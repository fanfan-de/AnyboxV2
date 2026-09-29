import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import type { OwnedCall } from '../contracts.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../storage/port.js'
import { projectFilesServiceKey } from './port.js'
import type { ProjectFilesPort, ProjectFilesOptions } from './port.js'
import { fileError, fileLimits, validId, isFileRef, validateFileSelections, validateSnapshotIds, validateFileBatch, encodeFileContents } from './domain.js'
import type { FileContent, FileRef } from './domain.js'
import { readProjectFile, searchProjectFiles } from './filesystem.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_file_snapshots (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL, bytes BLOB NOT NULL, expires_at TEXT NOT NULL)`)
  tx.execute(`CREATE TABLE harness_file_retentions (snapshot_id TEXT NOT NULL REFERENCES harness_file_snapshots(id),
    owner_key TEXT NOT NULL, PRIMARY KEY(snapshot_id, owner_key))`)
  tx.execute(`CREATE TABLE harness_file_preparations (scope_id TEXT NOT NULL, preparation_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, ids_json TEXT NOT NULL, PRIMARY KEY(scope_id, preparation_key))`)
} }]
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function normalize(error: unknown): Error {
  if (error instanceof Error && (error.name === 'ProjectFileError' || ('code' in error && error.code === 'project-unavailable'))) return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return fileError(code === 'ENOENT' ? 'file-missing' : code === 'ELOOP' ? 'file-invalid' : 'file-unavailable')
}

export function createProjectFilesComponent(options: ProjectFilesOptions = {}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort; [projectServiceKey]: ProjectPort
}> {
  const now = options.now ?? (() => new Date().toISOString()), newId = options.newId ?? randomUUID
  return { name: 'harness-project-files', inject: [localStorageServiceKey, projectServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey], projects = deps[projectServiceKey]
    await db.migrate('project-files', migrations)
    let accepting = true, active = 0
    const calls = new Set<OwnedCall<unknown>>(), pending = new Set<Promise<unknown>>(), failures: unknown[] = []
    const wake = new Set<() => void>(), preparations = new Map<string, Promise<unknown>>()
    const slot = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
      while (active >= fileLimits.concurrency) {
        signal.throwIfAborted()
        await new Promise<void>(resolve => {
          const ready = () => { wake.delete(ready); signal.removeEventListener('abort', ready); resolve() }
          wake.add(ready); signal.addEventListener('abort', ready, { once: true })
          if (signal.aborted) ready()
        })
      }
      signal.throwIfAborted(); active++
      try { return await work() } finally { active--; for (const ready of [...wake]) ready() }
    }
    const owned = <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): OwnedCall<T> => {
      if (!accepting) throw fileError('file-unavailable')
      const abort = new AbortController(), combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
      let cleanupError: unknown
      const result = Promise.resolve().then(async () => {
        combined.throwIfAborted()
        const value = await work(combined)
        combined.throwIfAborted()
        return value
      }).catch(error => {
        if (error instanceof Error && 'code' in error && error.code === 'file-cleanup-failed') { cleanupError = error; failures.push(error); throw error }
        if (combined.aborted) throw fileError('file-cancelled')
        throw normalize(error)
      })
      const done = result.then(() => {}, () => { if (cleanupError) throw cleanupError }).finally(() => calls.delete(call))
      const call: OwnedCall<T> = { result, done, cancel: reason => abort.abort(reason) }
      calls.add(call); void result.catch(() => {}); void done.catch(() => {})
      return call
    }
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(fileError('file-unavailable'))
      const result = Promise.resolve().then(work); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const rowFor = (reader: StorageReader, scope: string, id: string): StorageRow => {
      const row = reader.get(`SELECT s.*, EXISTS(SELECT 1 FROM harness_file_retentions r WHERE r.snapshot_id=s.id) AS retained
        FROM harness_file_snapshots s WHERE s.id=? AND s.scope_id=?`, [id, scope])
      if (!row) throw fileError('file-missing')
      if (!row.retained && String(row.expires_at) <= now()) throw fileError('file-expired')
      return row
    }
    const content = (row: StorageRow): FileContent => {
      let file: FileRef
      try { file = JSON.parse(String(row.metadata_json)) as FileRef } catch { throw fileError('file-corrupt') }
      if (!isFileRef(file) || file.snapshotId !== row.id || !(row.bytes instanceof Uint8Array) ||
        row.bytes.byteLength !== file.byteLength || hash(row.bytes) !== file.sha256) throw fileError('file-corrupt')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.bytes) } catch { throw fileError('file-corrupt') }
      return { file: Object.freeze({ ...file, ...(!row.retained ? { expiresAt: String(row.expires_at) } : {}) }), text }
    }
    const readIn = (reader: StorageReader, scope: string, ids: readonly string[]) => {
      const values = ids.map(id => content(rowFor(reader, scope, id)))
      validateFileBatch(values.map(value => value.file)); encodeFileContents(values)
      return values
    }
    const collect = () => track(() => db.transaction(tx => {
      // Preparation rows remain as tombstones: an old key can never recapture different bytes.
      tx.execute(`DELETE FROM harness_file_snapshots WHERE expires_at <= ? AND NOT EXISTS
        (SELECT 1 FROM harness_file_retentions r WHERE r.snapshot_id=harness_file_snapshots.id)`, [now()])
    }))
    await collect()
    const timer = setInterval(() => { void collect().catch(() => ctx.logger.warn('Project file snapshot collection failed')) }, options.collectionIntervalMs ?? 60 * 60 * 1000)
    timer.unref()
    ctx.effect(() => async () => {
      accepting = false; clearInterval(timer)
      for (const call of calls) call.cancel('project-files-closed')
      await Promise.allSettled([...calls].map(call => call.done))
      await Promise.allSettled([...pending])
      if (failures.length) throw new AggregateError(failures, 'project file cleanup failed')
    }, 'cancel and join project file operations')
    const service: ProjectFilesPort = {
      search(projectId, query, signal) { return owned(signal, async signal => {
        if (typeof query !== 'string' || query.length > 4096 || query.includes('\0')) throw fileError('file-invalid')
        const project = await projects.requireAvailable(projectId)
        return slot(signal, () => searchProjectFiles(project.path, query, signal))
      }) },
      preview(projectId, raw, signal) { return owned(signal, async signal => {
        const [selection] = validateFileSelections([raw])
        if (selection.kind !== 'project-file') throw fileError('file-invalid')
        const project = await projects.requireAvailable(projectId)
        return slot(signal, () => readProjectFile(project.path, selection.path, selection.range, signal))
      }) },
      prepare(scope, projectId, key, raw, signal) {
        const queueKey = JSON.stringify([scope, key]), previous = preparations.get(queueKey)
        const call = owned(signal, async signal => {
          if (!validId(scope) || !validId(key)) throw fileError('file-invalid')
          const selections = validateFileSelections(raw), fingerprint = hash(JSON.stringify({ projectId, selections }))
          if (previous) await previous.catch(() => {})
          signal.throwIfAborted()
          const replay = (reader: StorageReader): readonly FileRef[] | undefined => {
            const batch = reader.get('SELECT fingerprint, ids_json FROM harness_file_preparations WHERE scope_id=? AND preparation_key=?', [scope, key])
            if (!batch) return undefined
            if (batch.fingerprint !== fingerprint) throw fileError('file-preparation-conflict')
            const ids = validateSnapshotIds(JSON.parse(String(batch.ids_json)))
            // A collected batch is expired, rather than a request to read the sources again.
            if (ids.some(id => !reader.get('SELECT id FROM harness_file_snapshots WHERE id=? AND scope_id=?', [id, scope]))) throw fileError('file-expired')
            return readIn(reader, scope, ids).map(value => value.file)
          }
          const prior = await db.read(replay, signal)
          if (prior) return prior
          const values: FileContent[] = [], created = new Set<string>()
          for (const [fileIndex, selection] of selections.entries()) {
            try {
              signal.throwIfAborted()
              if (selection.kind === 'snapshot') {
                const [value] = await db.read(reader => readIn(reader, scope, [selection.snapshotId]), signal)
                if (value.file.projectId !== projectId) throw fileError('file-invalid')
                values.push(value)
              } else {
                const project = await projects.requireAvailable(projectId)
                const preview = await slot(signal, () => readProjectFile(project.path, selection.path, selection.range, signal))
                if (!preview.canReference) throw fileError('file-too-large')
                const id = newId(), file: FileRef = { snapshotId: id, projectId, path: selection.path,
                  ...(selection.range ? { range: selection.range } : {}), actualRange: preview.actualRange,
                  byteLength: preview.byteLength, sha256: hash(Buffer.from(preview.text)), createdAt: now() }
                created.add(id); values.push({ file, text: preview.text })
              }
            } catch (error) { throw Object.assign(normalize(error), { fileIndex }) }
          }
          validateFileBatch(values.map(value => value.file)); encodeFileContents(values)
          signal.throwIfAborted()
          return db.transaction(tx => {
            const prior = replay(tx)
            if (prior) return prior
            const expires = new Date(Date.parse(now()) + fileLimits.draftLifetimeMs).toISOString()
            for (const value of values) {
              if (created.has(value.file.snapshotId)) tx.execute('INSERT INTO harness_file_snapshots (id,scope_id,metadata_json,bytes,expires_at) VALUES (?,?,?,?,?)',
                [value.file.snapshotId, scope, JSON.stringify(value.file), Buffer.from(value.text), expires])
              else rowFor(tx, scope, value.file.snapshotId)
            }
            tx.execute('INSERT INTO harness_file_preparations (scope_id,preparation_key,fingerprint,ids_json) VALUES (?,?,?,?)',
              [scope, key, fingerprint, JSON.stringify(values.map(value => value.file.snapshotId))])
            return readIn(tx, scope, values.map(value => value.file.snapshotId)).map(value => value.file)
          }, signal)
        })
        preparations.set(queueKey, call.done)
        void call.done.finally(() => { if (preparations.get(queueKey) === call.done) preparations.delete(queueKey) }).catch(() => {})
        return call
      },
      read: (scope, raw, signal) => owned(signal, signal => db.read(reader => readIn(reader, scope, validateSnapshotIds(raw)), signal)),
      renew(scope, raw) { return track(() => db.transaction(tx => {
        const ids = validateSnapshotIds(raw), valid: FileRef[] = [], invalid: string[] = []
        for (const id of ids) {
          let row: StorageRow
          try { row = rowFor(tx, scope, id); content(row) } catch { invalid.push(id); continue }
          if (!row.retained) tx.execute('UPDATE harness_file_snapshots SET expires_at=? WHERE id=?',
            [new Date(Date.parse(now()) + fileLimits.draftLifetimeMs).toISOString(), id])
          valid.push(content(rowFor(tx, scope, id)).file)
        }
        return { valid, invalid }
      })) },
      retainIn(tx, scope, owner, refs) {
        if (!accepting) throw fileError('file-unavailable')
        validateFileBatch(refs)
        for (const ref of refs) {
          const { expiresAt: _expiry, ...actual } = content(rowFor(tx, scope, ref.snapshotId)).file
          const { expiresAt: _requested, ...expected } = ref
          if (!isDeepStrictEqual(actual, expected)) throw fileError('file-corrupt')
          tx.execute('INSERT OR IGNORE INTO harness_file_retentions (snapshot_id,owner_key) VALUES (?,?)', [ref.snapshotId, owner])
        }
      },
    }
    ctx.provide(projectFilesServiceKey, service)
  } }
}

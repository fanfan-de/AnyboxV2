import { AsyncEntry } from '@napi-rs/keyring'
import type { Component } from '@nya/core'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import type { SystemKeyringOptions, SystemKeyringStore } from '@anybox/api-key-manager'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../../../../storage/port.js'
import { localWorkerAttachment, localWorkerAttachmentId, revokeWorkerAttachment, validateWorkerAttachment, validateComputerCeiling } from './worker-attachments-domain.js'
import type { WorkerAttachment } from './worker-attachments-domain.js'
import { workerError } from './worker-port.js'

export const workerAttachmentsServiceKey = 'computer.worker-attachments'
export type WorkerAttachmentChange = 'record' | 'permissions' | 'revoke'
export interface WorkerAttachmentsOptions {
  /** System credential namespace; the unit credential of each attachment is one entry in it. */
  readonly namespace?: string
  readonly openEntry?: SystemKeyringOptions['openEntry']
  readonly now?: () => string
}
/** The unit's own attachment ledger. Every acceptance of a remote request checks it; credentials are read only by the dial-out loops. */
export interface WorkerAttachmentsPort {
  list(): Promise<readonly WorkerAttachment[]>
  /** Stores an approved attachment and its credential: intent first, then the keyring entry, then the durable row. */
  record(attachment: WorkerAttachment, credential: string): Promise<WorkerAttachment>
  /** Stops acceptance immediately, lets listeners finish, then deletes the credential. Idempotent. */
  revoke(attachmentId: string): Promise<WorkerAttachment>
  updatePermissions(attachmentId: string, ceiling: unknown): Promise<WorkerAttachment>
  credential(attachmentId: string, signal?: AbortSignal): Promise<string>
  /** Synchronous participant of the executor's acceptance transaction; the loopback attachment is always approved. */
  requireApprovedIn(reader: StorageReader, attachmentId: string): WorkerAttachment
  onChanged(listener: (attachment: WorkerAttachment, change: WorkerAttachmentChange) => void | Promise<void>): () => void
}
const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE computer_worker_attachments (attachment_id TEXT PRIMARY KEY, state TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)')
  tx.execute('CREATE TABLE computer_worker_credential_intents (attachment_id TEXT PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL)')
} }]
const credentialId = (attachmentId: string) => `unit-attachment/${attachmentId}`
function fromRow(row: StorageRow): WorkerAttachment { return validateWorkerAttachment(JSON.parse(String(row.record_json))) }
function nativeEntry(service: string, id: string) {
  const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } })
  return { getPassword: () => entry.getPassword(), setPassword: (value: string) => entry.setPassword(value), deleteCredential: () => entry.deleteCredential() }
}

export function createWorkerAttachmentsComponent(options: WorkerAttachmentsOptions = {}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'computer-worker-attachments', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey], now = options.now ?? (() => new Date().toISOString())
    await db.migrate('computer-worker-attachments', migrations)
    let vault: SystemKeyringStore | undefined, accepting = true
    const pending = new Set<Promise<unknown>>(), listeners = new Set<(attachment: WorkerAttachment, change: WorkerAttachmentChange) => void | Promise<void>>()
    const queues = new Map<string, Promise<unknown>>()
    const changingPermissions = new Set<string>()
    const secrets = () => vault ??= createSystemKeyringStore({ namespace: options.namespace ?? 'anybox.computer-worker', openEntry: options.openEntry ?? nativeEntry })
    const keyring = async <T>(work: (store: SystemKeyringStore) => Promise<T>): Promise<T> => {
      try { return await work(secrets()) } catch { throw workerError('worker-credential-unavailable') }
    }
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      const result = Promise.resolve().then(() => { if (!accepting) throw workerError('worker-closing'); return work() })
      pending.add(result); void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const readOne = (reader: StorageReader, attachmentId: string) => { const row = reader.get('SELECT * FROM computer_worker_attachments WHERE attachment_id = ?', [attachmentId]); return row ? fromRow(row) : undefined }
    const change = <T>(id: string, work: () => Promise<T>) => track(async () => {
      const task = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(work)
      queues.set(id, task)
      try { return await task } finally { if (queues.get(id) === task) queues.delete(id) }
    })
    const notify = async (attachment: WorkerAttachment, reason: WorkerAttachmentChange) => {
      let failure: unknown
      for (const listener of [...listeners]) { try { await listener(attachment, reason) } catch (error) { failure ??= error } }
      if (failure) throw failure
    }
    // Orphaned credentials from an interrupted record() or revoke() are reconciled before anything is served.
    for (const row of await db.read(reader => reader.all('SELECT attachment_id, kind FROM computer_worker_credential_intents'))) {
      const attachmentId = String(row.attachment_id)
      try {
        const stored = await db.read(reader => readOne(reader, attachmentId))
        if (row.kind === 'store' && stored?.state === 'approved') { await db.transaction(tx => { tx.execute('DELETE FROM computer_worker_credential_intents WHERE attachment_id = ?', [attachmentId]) }); continue }
        await keyring(store => store.delete(credentialId(attachmentId)))
        await db.transaction(tx => { tx.execute('DELETE FROM computer_worker_credential_intents WHERE attachment_id = ?', [attachmentId]) })
      } catch { /* Retried on the next start or the next change of this attachment. */ }
    }
    ctx.effect(() => async () => { accepting = false; await Promise.allSettled([...pending]); try { await vault?.close() } catch { /* nothing to recover */ } }, 'stop worker attachment changes and join credential operations')
    const service: WorkerAttachmentsPort = {
      list: () => track(() => db.read(reader => Object.freeze(reader.all('SELECT * FROM computer_worker_attachments ORDER BY created_at, attachment_id').map(fromRow)))),
      record: (input, credential) => change(input?.attachmentId, async () => {
        const attachment = validateWorkerAttachment(input)
        if (attachment.state !== 'approved' || attachment.attachmentId === localWorkerAttachmentId || typeof credential !== 'string' || !credential) throw workerError('worker-attachment-invalid')
        await db.transaction(tx => {
          if (tx.get('SELECT 1 FROM computer_worker_attachments WHERE attachment_id = ?', [attachment.attachmentId])) throw workerError('worker-attachment-conflict')
          tx.execute('INSERT INTO computer_worker_credential_intents (attachment_id, kind, at) VALUES (?, ?, ?) ON CONFLICT(attachment_id) DO UPDATE SET kind = excluded.kind, at = excluded.at', [attachment.attachmentId, 'store', now()])
        })
        await keyring(store => store.write(credentialId(attachment.attachmentId), credential))
        await db.transaction(tx => {
          tx.execute('INSERT INTO computer_worker_attachments (attachment_id, state, record_json, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)', [attachment.attachmentId, attachment.state, JSON.stringify(attachment), attachment.createdAt])
          tx.execute('DELETE FROM computer_worker_credential_intents WHERE attachment_id = ?', [attachment.attachmentId])
        })
        await notify(attachment, 'record')
        return attachment
      }),
      updatePermissions: (attachmentId, input) => change(attachmentId, async () => {
        if (attachmentId === localWorkerAttachmentId) throw workerError('worker-attachment-local')
        const ceiling = validateComputerCeiling(input)
        changingPermissions.add(attachmentId)
        try {
          const updated = await db.transaction(tx => {
            const prior = readOne(tx, attachmentId)
            if (!prior) throw workerError('worker-attachment-missing')
            if (prior.state !== 'approved') throw workerError('worker-attachment-rejected')
            const next = Object.freeze({ ...prior, ceiling })
            tx.execute('UPDATE computer_worker_attachments SET record_json = ? WHERE attachment_id = ?', [JSON.stringify(next), attachmentId])
            return next
          })
          await notify(updated, 'permissions')
          return updated
        } finally { changingPermissions.delete(attachmentId) }
      }),
      revoke: attachmentId => change(attachmentId, async () => {
        if (attachmentId === localWorkerAttachmentId) throw workerError('worker-attachment-local')
        const revoked = await db.transaction(tx => {
          const prior = readOne(tx, attachmentId)
          if (!prior) throw workerError('worker-attachment-missing')
          if (prior.state === 'revoked') return prior
          const next = revokeWorkerAttachment(prior, now())
          tx.execute('UPDATE computer_worker_attachments SET state = ?, record_json = ?, revoked_at = ? WHERE attachment_id = ?', [next.state, JSON.stringify(next), next.revokedAt, attachmentId])
          tx.execute('INSERT INTO computer_worker_credential_intents (attachment_id, kind, at) VALUES (?, ?, ?) ON CONFLICT(attachment_id) DO UPDATE SET kind = excluded.kind, at = excluded.at', [attachmentId, 'delete', now()])
          return next
        })
        let cleanupFailure: unknown
        try { await notify(revoked, 'revoke') } catch (error) { cleanupFailure = error }
        try {
          await keyring(store => store.delete(credentialId(attachmentId)))
          await db.transaction(tx => { tx.execute('DELETE FROM computer_worker_credential_intents WHERE attachment_id = ?', [attachmentId]) })
        } catch { /* The delete intent stays durable and is retried at the next start. */ }
        if (cleanupFailure) throw cleanupFailure
        return revoked
      }),
      credential: (attachmentId, signal) => track(async () => {
        const stored = await db.read(reader => readOne(reader, attachmentId))
        if (!stored || stored.state !== 'approved') throw workerError('worker-attachment-rejected')
        const value = await keyring(store => store.read(credentialId(attachmentId), signal))
        if (!value) throw workerError('worker-credential-unavailable')
        return value
      }),
      requireApprovedIn(reader, attachmentId) {
        if (typeof attachmentId !== 'string' || !attachmentId) throw workerError('worker-invalid')
        if (attachmentId === localWorkerAttachmentId) return localWorkerAttachment(now())
        if (changingPermissions.has(attachmentId)) throw workerError('worker-attachment-updating')
        const stored = readOne(reader, attachmentId)
        if (!stored || stored.state !== 'approved') throw workerError('worker-attachment-rejected')
        return stored
      },
      onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    ctx.provide(workerAttachmentsServiceKey, service)
  } }
}

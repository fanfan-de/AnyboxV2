import { randomBytes } from 'node:crypto'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { RuntimeInputs } from '../contracts.js'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow, StorageTransaction } from '../../../../storage/port.js'
import { approveAttachment, attachCodeExpired, attachCodeExpiry, attachmentBinding, bindingMatches, localAttachment, revokeAttachment, secretDigest,
  unitError, validateRunUnitBinding, validateRunUnitBindings, validateUnitId, validateUnitKind, validateUnitScope } from './domain.js'
import type { UnitAttachment, UnitKind } from './domain.js'
import { unitAttachmentsServiceKey } from './port.js'
import type { LocalUnit, UnitAttachmentEvent, UnitAttachmentsPort } from './port.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_unit_attachments (
    attachment_id TEXT PRIMARY KEY, unit_kind TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL,
    unit_id TEXT, contract_version TEXT, capabilities_json TEXT,
    requested_scope_json TEXT NOT NULL, ceiling_json TEXT, scope_json TEXT,
    code_digest TEXT, code_expires_at TEXT, credential_digest TEXT,
    epoch INTEGER NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, revoked_at TEXT
  )`)
  tx.execute('CREATE INDEX harness_unit_attachments_by_unit ON harness_unit_attachments(unit_kind, unit_id, state)')
  tx.execute('CREATE UNIQUE INDEX harness_unit_attachments_by_code ON harness_unit_attachments(code_digest)')
  tx.execute(`CREATE TABLE harness_unit_attachment_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, attachment_id TEXT NOT NULL REFERENCES harness_unit_attachments(attachment_id),
    kind TEXT NOT NULL, epoch INTEGER NOT NULL, detail_json TEXT, at TEXT NOT NULL
  )`)
} }]

function text(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw unitError('unit-invalid')
  return value
}
function nullable(row: StorageRow, key: string): string | null {
  const value = row[key]
  if (value !== null && typeof value !== 'string') throw unitError('unit-invalid')
  return value
}
function integer(row: StorageRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw unitError('unit-invalid')
  return value
}
function attachmentFrom(row: StorageRow): UnitAttachment {
  const state = row.state, origin = row.origin
  if ((state !== 'pending' && state !== 'approved' && state !== 'revoked') || (origin !== 'local' && origin !== 'remote')) throw unitError('unit-invalid')
  const ceiling = nullable(row, 'ceiling_json'), scope = nullable(row, 'scope_json'), capabilities = nullable(row, 'capabilities_json')
  return Object.freeze({ attachmentId: text(row, 'attachment_id'), unitKind: validateUnitKind(row.unit_kind), origin, state, unitId: nullable(row, 'unit_id'),
    contractVersion: nullable(row, 'contract_version'), capabilities: capabilities === null ? null : JSON.parse(capabilities) as JsonValue,
    requestedScope: validateUnitScope(JSON.parse(text(row, 'requested_scope_json'))), ceiling: ceiling === null ? null : validateUnitScope(JSON.parse(ceiling)),
    scope: scope === null ? null : validateUnitScope(JSON.parse(scope)), epoch: integer(row, 'epoch'),
    credential: nullable(row, 'credential_digest') === null ? 'none' : 'issued', createdAt: text(row, 'created_at'),
    codeExpiresAt: nullable(row, 'code_expires_at'), approvedAt: nullable(row, 'approved_at'), revokedAt: nullable(row, 'revoked_at') })
}
function eventFrom(row: StorageRow): UnitAttachmentEvent {
  const kind = row.kind, detail = nullable(row, 'detail_json')
  if (kind !== 'created' && kind !== 'approved' && kind !== 'revoked') throw unitError('unit-invalid')
  return Object.freeze({ seq: integer(row, 'seq'), attachmentId: text(row, 'attachment_id'), kind, epoch: integer(row, 'epoch'),
    detail: detail === null ? null : JSON.parse(detail) as JsonValue, at: text(row, 'at') })
}
interface Secrets { readonly codeDigest: string | null; readonly credentialDigest: string | null }
function insertAttachment(tx: StorageTransaction, value: UnitAttachment, secrets: Secrets): void {
  tx.execute(`INSERT INTO harness_unit_attachments (attachment_id, unit_kind, origin, state, unit_id, contract_version, capabilities_json,
    requested_scope_json, ceiling_json, scope_json, code_digest, code_expires_at, credential_digest, epoch, created_at, approved_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [value.attachmentId, value.unitKind, value.origin, value.state, value.unitId,
    value.contractVersion, value.capabilities === null ? null : JSON.stringify(value.capabilities), JSON.stringify(value.requestedScope),
    value.ceiling === null ? null : JSON.stringify(value.ceiling), value.scope === null ? null : JSON.stringify(value.scope),
    secrets.codeDigest, value.codeExpiresAt, secrets.credentialDigest, value.epoch, value.createdAt, value.approvedAt, value.revokedAt])
}
function updateAttachment(tx: StorageTransaction, value: UnitAttachment, secrets: Secrets): void {
  tx.execute(`UPDATE harness_unit_attachments SET state = ?, unit_id = ?, contract_version = ?, capabilities_json = ?, ceiling_json = ?, scope_json = ?,
    code_digest = ?, code_expires_at = ?, credential_digest = ?, epoch = ?, approved_at = ?, revoked_at = ? WHERE attachment_id = ?`,
    [value.state, value.unitId, value.contractVersion, value.capabilities === null ? null : JSON.stringify(value.capabilities),
      value.ceiling === null ? null : JSON.stringify(value.ceiling), value.scope === null ? null : JSON.stringify(value.scope),
      secrets.codeDigest, value.codeExpiresAt, secrets.credentialDigest, value.epoch, value.approvedAt, value.revokedAt, value.attachmentId])
}
function recordEvent(tx: StorageTransaction, attachmentId: string, kind: UnitAttachmentEvent['kind'], epoch: number, detail: JsonValue | null, at: string): void {
  tx.execute('INSERT INTO harness_unit_attachment_events (attachment_id, kind, epoch, detail_json, at) VALUES (?, ?, ?, ?, ?)',
    [attachmentId, kind, epoch, detail === null ? null : JSON.stringify(detail), at])
}
function readAttachment(reader: StorageReader, attachmentId: string): UnitAttachment | undefined {
  const row = reader.get('SELECT * FROM harness_unit_attachments WHERE attachment_id = ?', [attachmentId])
  return row ? attachmentFrom(row) : undefined
}
const newSecret = () => randomBytes(32).toString('base64url')

export interface LocalUnitDefinition { readonly unitKind: UnitKind; readonly unitId: string }
export interface UnitAttachmentsOptions {
  /** Units served by this same composition; approved idempotently at startup and never revocable through the API. */
  readonly localUnits?: readonly LocalUnitDefinition[]
}

/** Owns the `unit-attachments` ledger and this boot's identity for local units; transports and proxies stay outside. */
export function createUnitAttachmentsComponent(inputs: RuntimeInputs, options: UnitAttachmentsOptions = {}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
}> {
  return { name: 'harness-unit-attachments', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]
    await db.migrate('unit-attachments', migrations)
    const bootId = inputs.newId()
    const locals = new Map<UnitKind, string>()
    for (const unit of options.localUnits ?? []) {
      const kind = validateUnitKind(unit.unitKind), unitId = validateUnitId(unit.unitId)
      if (locals.has(kind)) throw unitError('unit-invalid')
      locals.set(kind, unitId)
    }
    await db.transaction(tx => {
      // One timestamp for the whole startup transaction keeps the ledger order deterministic across local units.
      const at = inputs.now()
      for (const [kind, unitId] of locals) {
        if (tx.get('SELECT 1 FROM harness_unit_attachments WHERE unit_kind = ? AND unit_id = ? AND origin = ? AND state = ?', [kind, unitId, 'local', 'approved'])) continue
        const attachment = localAttachment(kind, unitId, at)
        if (readAttachment(tx, attachment.attachmentId)) throw unitError('unit-attachment-state')
        insertAttachment(tx, attachment, { codeDigest: null, credentialDigest: null })
        recordEvent(tx, attachment.attachmentId, 'created', 1, { origin: 'local', unitKind: kind, requestedScope: attachment.requestedScope }, at)
        recordEvent(tx, attachment.attachmentId, 'approved', 1, { unitId, scope: attachment.scope }, at)
      }
    })
    let accepting = true
    const pending = new Set<Promise<unknown>>()
    const assertOpen = () => { if (!accepting) throw unitError('unit-attachments-closed') }
    // Validation failures reject like storage failures; only the transaction participant throws synchronously.
    const track = <T>(work: () => Promise<T> | T): Promise<T> => {
      const result = Promise.resolve().then(() => { assertOpen(); return work() })
      pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    ctx.effect(() => async () => { accepting = false; await Promise.allSettled([...pending]) }, 'stop unit attachment admission and join ledger operations')
    const service: UnitAttachmentsPort = {
      list: () => track(() => db.read(reader => Object.freeze(reader.all('SELECT * FROM harness_unit_attachments ORDER BY created_at, attachment_id').map(attachmentFrom)))),
      get: attachmentId => track(() => { validateUnitId(attachmentId); return db.read(reader => readAttachment(reader, attachmentId)) }),
      listEvents: attachmentId => track(() => {
        validateUnitId(attachmentId)
        return db.read(reader => Object.freeze(reader.all('SELECT * FROM harness_unit_attachment_events WHERE attachment_id = ? ORDER BY seq', [attachmentId]).map(eventFrom)))
      }),
      createAttachCode: input => track(() => {
        const unitKind = validateUnitKind(input?.unitKind), scope = validateUnitScope(input?.scope)
        if (scope.kind !== unitKind) throw unitError('unit-invalid')
        const at = inputs.now(), codeExpiresAt = attachCodeExpiry(at, input.ttlMs), code = newSecret()
        const attachment: UnitAttachment = Object.freeze({ attachmentId: inputs.newId(), unitKind, origin: 'remote', state: 'pending', unitId: null,
          contractVersion: null, capabilities: null, requestedScope: scope, ceiling: null, scope: null, epoch: 1, credential: 'none',
          createdAt: at, codeExpiresAt, approvedAt: null, revokedAt: null })
        return db.transaction(tx => {
          insertAttachment(tx, attachment, { codeDigest: secretDigest(code), credentialDigest: null })
          recordEvent(tx, attachment.attachmentId, 'created', 1, { origin: 'remote', unitKind, requestedScope: scope, codeExpiresAt }, at)
          return { attachment, code }
        })
      }),
      attach: input => track(() => {
        const unitKind = validateUnitKind(input?.unitKind), unitId = validateUnitId(input?.unitId), ceiling = validateUnitScope(input?.ceiling)
        if (typeof input.code !== 'string' || !input.code) throw unitError('unit-code-invalid')
        const digest = secretDigest(input.code), credential = newSecret()
        return db.transaction(tx => {
          const row = tx.get('SELECT * FROM harness_unit_attachments WHERE code_digest = ?', [digest])
          if (!row) throw unitError('unit-code-invalid')
          const prior = attachmentFrom(row), at = inputs.now()
          if (prior.state !== 'pending') throw unitError('unit-attachment-state')
          if (attachCodeExpired(prior, at)) throw unitError('unit-code-expired')
          if (prior.unitKind !== unitKind) throw unitError('unit-kind-mismatch')
          if (tx.get('SELECT 1 FROM harness_unit_attachments WHERE unit_kind = ? AND unit_id = ? AND state = ?', [unitKind, unitId, 'approved'])) throw unitError('unit-already-attached')
          const approved = approveAttachment(prior, { unitId, contractVersion: input.contractVersion, capabilities: input.capabilities ?? null, ceiling, at })
          updateAttachment(tx, approved, { codeDigest: null, credentialDigest: secretDigest(credential) })
          recordEvent(tx, approved.attachmentId, 'approved', approved.epoch, { unitId, scope: approved.scope, ceiling }, at)
          return { attachment: approved, credential }
        })
      }),
      revoke: attachmentId => track(() => {
        validateUnitId(attachmentId)
        return db.transaction(tx => {
          const row = tx.get('SELECT * FROM harness_unit_attachments WHERE attachment_id = ?', [attachmentId])
          if (!row) throw unitError('unit-attachment-missing')
          const prior = attachmentFrom(row)
          if (prior.origin === 'local') throw unitError('unit-attachment-local')
          if (prior.state === 'revoked') return prior
          const at = inputs.now(), revoked = revokeAttachment(prior, at)
          updateAttachment(tx, revoked, { codeDigest: null, credentialDigest: nullable(row, 'credential_digest') })
          recordEvent(tx, revoked.attachmentId, 'revoked', revoked.epoch, null, at)
          return revoked
        })
      }),
      local: unitKind => track(() => {
        const kind = validateUnitKind(unitKind), unitId = locals.get(kind)
        if (unitId === undefined) throw unitError('unit-attachment-missing')
        return db.read((reader): LocalUnit => {
          const row = reader.get('SELECT * FROM harness_unit_attachments WHERE unit_kind = ? AND unit_id = ? AND origin = ? AND state = ?', [kind, unitId, 'local', 'approved'])
          if (!row) throw unitError('unit-attachment-missing')
          const attachment = attachmentFrom(row)
          return Object.freeze({ attachment, binding: attachmentBinding(attachment, kind === 'models' ? bootId : undefined) })
        })
      }),
      requireApprovedIn(tx, binding) {
        assertOpen()
        const fixed = validateRunUnitBinding(binding), attachment = readAttachment(tx, fixed.attachmentId)
        if (!bindingMatches(fixed, attachment)) throw unitError('unit-attachment-mismatch')
        return attachment!
      },
      verify: bindings => track(() => {
        const fixed = validateRunUnitBindings(bindings)
        return db.read(reader => {
          for (const binding of [fixed.models, fixed.computer]) {
            if (!bindingMatches(binding, readAttachment(reader, binding.attachmentId))) throw unitError('unit-attachment-mismatch')
          }
        })
      }),
    }
    ctx.provide(unitAttachmentsServiceKey, service)
  } }
}

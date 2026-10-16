import type { JsonValue } from '@anybox/models'
import type { StorageReader, StorageTransaction } from '../../../../storage/port.js'
import type { RunUnitBinding, RunUnitBindings, UnitAttachment, UnitKind, UnitScope } from './domain.js'
export type { RunUnitBinding, RunUnitBindings, UnitAttachment, UnitKind, UnitScope } from './domain.js'

export const unitAttachmentsServiceKey = 'harness.unit-attachments'

export interface AttachCodeInput { readonly unitKind: UnitKind; readonly scope: UnitScope; readonly ttlMs?: number }
export interface AttachRequest {
  readonly code: string
  readonly unitKind: UnitKind
  readonly unitId: string
  readonly contractVersion: string
  readonly capabilities?: JsonValue
  /** The unit owner's upper bound; the harness server's requested scope must fit inside it. */
  readonly ceiling: UnitScope
}
export interface UnitAttachmentEvent {
  readonly seq: number
  readonly attachmentId: string
  readonly kind: 'created' | 'approved' | 'revoked'
  readonly epoch: number
  readonly detail: JsonValue | null
  readonly at: string
}
export interface LocalUnit { readonly attachment: UnitAttachment; readonly binding: RunUnitBinding }

/** Attachment ledger of one harness server. Secrets are returned once and stored only as digests. */
export interface UnitAttachmentsPort {
  list(): Promise<readonly UnitAttachment[]>
  get(attachmentId: string): Promise<UnitAttachment | undefined>
  listEvents(attachmentId: string): Promise<readonly UnitAttachmentEvent[]>
  /** Records a pending attachment and returns its one-time code. */
  createAttachCode(input: AttachCodeInput): Promise<{ readonly attachment: UnitAttachment; readonly code: string }>
  /** Consumes a pending code on behalf of the unit; the unit credential is returned once. */
  attach(input: AttachRequest): Promise<{ readonly attachment: UnitAttachment; readonly credential: string }>
  /** Idempotent for remote attachments; local attachments cannot be revoked. */
  revoke(attachmentId: string): Promise<UnitAttachment>
  /** Presented unit credentials are compared in constant time against the stored digest; only approved attachments authenticate. */
  authenticate(attachmentId: string, credential: string): Promise<UnitAttachment>
  /** This harness server's own unit of a kind, approved automatically at startup. */
  local(unitKind: UnitKind): Promise<LocalUnit>
  /** Binding reference of any approved attachment, for compositions that fix a remote unit instead of the local one. */
  binding(attachmentId: string): Promise<RunUnitBinding>
  /** Synchronous read inside a caller's transaction, regardless of state; placement facts of revoked attachments stay readable. */
  getIn(reader: StorageReader, attachmentId: string): UnitAttachment | undefined
  /** Synchronous participant of a business transaction: the fixed reference must still be approved at the same epoch. */
  requireApprovedIn(tx: StorageTransaction, binding: RunUnitBinding): UnitAttachment
  verify(bindings: RunUnitBindings): Promise<void>
}

import { resolve, sep } from 'node:path'
import { fullScope, localAttachmentId, validateUnitScope } from '../unit/domain.js'
import type { UnitScope } from '../unit/domain.js'
import { workerError } from './worker-port.js'

/** A Computer unit's own record of one harness server it serves. Credentials live in the system keyring, never here. */
export interface WorkerAttachment {
  readonly attachmentId: string
  /** Normalized harness server base URL; the unit API lives under `/api/v1/apps/agent/units/unit`. */
  readonly harnessUrl: string
  readonly instanceId: string
  readonly state: 'approved' | 'revoked'
  /** The device owner's upper bound, checked again on every acceptance. */
  readonly ceiling: Extract<UnitScope, { kind: 'computer' }>
  /** The scope the harness server granted at approval; informational on this side. */
  readonly scope: UnitScope
  readonly epoch: number
  readonly createdAt: string
  readonly revokedAt: string | null
}
export const workerContractVersion = 'computer-worker-1'
export const localWorkerAttachmentId = localAttachmentId('computer')
const loopback = (hostname: string) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname)
/** Remote harness servers must be reached over HTTPS; plain HTTP is accepted only for loopback endpoints. */
export function validateHarnessUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw workerError('worker-attachment-invalid')
  let url: URL
  try { url = new URL(value) } catch { throw workerError('worker-attachment-invalid') }
  if (url.username || url.password || url.search || url.hash) throw workerError('worker-attachment-invalid')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw workerError('worker-attachment-invalid')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
export function unitApiUrl(harnessUrl: string, path: string): string { return `${harnessUrl}/api/v1/apps/agent/units/unit/${path}` }
export function validateComputerCeiling(value: unknown): Extract<UnitScope, { kind: 'computer' }> {
  let scope: UnitScope
  try { scope = validateUnitScope(value) } catch { throw workerError('worker-attachment-invalid') }
  if (scope.kind !== 'computer') throw workerError('worker-attachment-invalid')
  if (scope.projects !== 'all' && scope.projects.some(path => resolve(path) !== path)) throw workerError('worker-attachment-invalid')
  return scope
}
function within(path: string, directory: string): boolean {
  const target = resolve(path), base = resolve(directory)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}
/** The ceiling admits a tool declaration only when the fixed workspace path and the tool contract are both granted. */
export function ceilingPermits(ceiling: Extract<UnitScope, { kind: 'computer' }>, input: { readonly path: string; readonly toolId: string }): boolean {
  const projectAllowed = ceiling.projects === 'all' || ceiling.projects.some(directory => within(input.path, directory))
  const toolAllowed = ceiling.tools === 'all' || ceiling.tools.includes(input.toolId)
  return projectAllowed && toolAllowed
}
/** The harness server that owns this worker's directory attaches over loopback without a credential or a ceiling. */
export function localWorkerAttachment(at: string): WorkerAttachment {
  const scope = fullScope('computer') as Extract<UnitScope, { kind: 'computer' }>
  return Object.freeze({ attachmentId: localWorkerAttachmentId, harnessUrl: 'http://127.0.0.1', instanceId: 'local', state: 'approved', ceiling: scope, scope, epoch: 1, createdAt: at, revokedAt: null })
}
export function revokeWorkerAttachment(attachment: WorkerAttachment, at: string): WorkerAttachment {
  if (attachment.state === 'revoked') return attachment
  return Object.freeze({ ...attachment, state: 'revoked', revokedAt: at })
}
export function validateWorkerAttachment(value: unknown): WorkerAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workerError('worker-attachment-invalid')
  const record = value as Record<string, unknown>
  const text = (key: string, max = 256) => { const item = record[key]; if (typeof item !== 'string' || !item || item.length > max) throw workerError('worker-attachment-invalid'); return item }
  if ((record.state !== 'approved' && record.state !== 'revoked') || !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1 ||
    (record.revokedAt !== null && typeof record.revokedAt !== 'string')) throw workerError('worker-attachment-invalid')
  let scope: UnitScope
  try { scope = validateUnitScope(record.scope) } catch { throw workerError('worker-attachment-invalid') }
  return Object.freeze({ attachmentId: text('attachmentId'), harnessUrl: validateHarnessUrl(record.harnessUrl), instanceId: text('instanceId'), state: record.state,
    ceiling: validateComputerCeiling(record.ceiling), scope, epoch: record.epoch as number, createdAt: text('createdAt', 64), revokedAt: record.revokedAt as string | null })
}

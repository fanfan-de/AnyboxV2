import { createHash, timingSafeEqual } from 'node:crypto'
import type { JsonValue } from '@anybox/models'

/** Deployment units attach to one harness server. Identity, scope rules and state transitions stay pure here. */
export type UnitKind = 'models' | 'computer'
export const unitKinds: readonly UnitKind[] = Object.freeze(['models', 'computer'])
/** The in-process Models component and this Authority's own worker attach as local units with fixed identities. */
export const localModelsUnitId = 'models-local'
export const localComputerUnitId = 'computer-local'

export type UnitScope =
  | { readonly kind: 'computer'; readonly projects: 'all' | readonly string[]; readonly tools: 'all' | readonly string[] }
  | { readonly kind: 'models'; readonly access: 'manage' | 'execute'; readonly configurations: 'all' | readonly string[] }

export type UnitAttachmentState = 'pending' | 'approved' | 'revoked'
export type UnitAttachmentOrigin = 'local' | 'remote'

/** Durable attachment fact; code and credential digests never leave the ledger. */
export interface UnitAttachment {
  readonly attachmentId: string
  readonly unitKind: UnitKind
  readonly origin: UnitAttachmentOrigin
  readonly state: UnitAttachmentState
  readonly unitId: string | null
  readonly contractVersion: string | null
  readonly capabilities: JsonValue | null
  readonly requestedScope: UnitScope
  readonly ceiling: UnitScope | null
  readonly scope: UnitScope | null
  readonly epoch: number
  readonly credential: 'none' | 'issued'
  readonly createdAt: string
  readonly codeExpiresAt: string | null
  readonly approvedAt: string | null
  readonly revokedAt: string | null
}

/** Fixed by a Run's acceptance transaction; later mismatches reject continuation instead of rebinding. */
export interface RunUnitBinding {
  readonly attachmentId: string
  readonly unitKind: UnitKind
  readonly unitId: string
  readonly epoch: number
  /** Boot that accepted the Run. Informational for the in-process Models unit; workers fix their boot per operation. */
  readonly bootId?: string
}
export interface RunUnitBindings {
  readonly schemaVersion: 1
  readonly models: RunUnitBinding
  readonly computer: RunUnitBinding
}

export type UnitErrorCode = 'unit-invalid' | 'unit-attachment-missing' | 'unit-attachment-state' | 'unit-code-invalid' | 'unit-code-expired' |
  'unit-kind-mismatch' | 'unit-scope-exceeded' | 'unit-already-attached' | 'unit-attachment-local' | 'unit-attachment-mismatch' | 'unit-attachments-closed' |
  'unit-credential-invalid'

export function unitError(code: UnitErrorCode): Error & { readonly code: UnitErrorCode } {
  return Object.assign(new Error(code), { name: 'UnitAttachmentError', code })
}
export function isUnitError(error: unknown): error is Error & { readonly code: UnitErrorCode } {
  return error instanceof Error && error.name === 'UnitAttachmentError' && 'code' in error
}

function identifier(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x1f\x7f]/.test(value)) throw unitError('unit-invalid')
  return value
}
export function validateUnitKind(value: unknown): UnitKind {
  if (value !== 'models' && value !== 'computer') throw unitError('unit-invalid')
  return value
}
export function validateUnitId(value: unknown): string { return identifier(value) }

function grantList(value: unknown): 'all' | readonly string[] {
  if (value === 'all') return 'all'
  if (!Array.isArray(value) || value.length > 256) throw unitError('unit-invalid')
  const items = value.map(item => identifier(item, 1024))
  if (new Set(items).size !== items.length) throw unitError('unit-invalid')
  return Object.freeze(items)
}
export function validateUnitScope(value: unknown): UnitScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unitError('unit-invalid')
  const scope = value as Record<string, unknown>, keys = Object.keys(scope)
  if (scope.kind === 'computer') {
    if (keys.some(key => !['kind', 'projects', 'tools'].includes(key))) throw unitError('unit-invalid')
    return Object.freeze({ kind: 'computer', projects: grantList(scope.projects), tools: grantList(scope.tools) })
  }
  if (scope.kind === 'models') {
    if (keys.some(key => !['kind', 'access', 'configurations'].includes(key)) || (scope.access !== 'manage' && scope.access !== 'execute')) throw unitError('unit-invalid')
    return Object.freeze({ kind: 'models', access: scope.access, configurations: grantList(scope.configurations) })
  }
  throw unitError('unit-invalid')
}
export function fullScope(kind: UnitKind): UnitScope {
  return kind === 'computer' ? Object.freeze({ kind, projects: 'all', tools: 'all' } as const) : Object.freeze({ kind, access: 'manage', configurations: 'all' } as const)
}
const within = (part: 'all' | readonly string[], whole: 'all' | readonly string[]): boolean =>
  whole === 'all' || (part !== 'all' && part.every(item => whole.includes(item)))
/** A scope fits a ceiling when every grant is also granted by the ceiling; `manage` only fits under `manage`. */
export function scopeWithin(scope: UnitScope, ceiling: UnitScope): boolean {
  if (scope.kind === 'computer' && ceiling.kind === 'computer') return within(scope.projects, ceiling.projects) && within(scope.tools, ceiling.tools)
  if (scope.kind === 'models' && ceiling.kind === 'models') return (scope.access === 'execute' || ceiling.access === 'manage') && within(scope.configurations, ceiling.configurations)
  return false
}

export function secretDigest(secret: string): string { return createHash('sha256').update(secret, 'utf8').digest('hex') }
/** Constant-time comparison of a presented secret against the stored digest. */
export function secretMatches(secret: string, digest: string | null): boolean {
  if (digest === null || typeof secret !== 'string' || !secret || secret.length > 4096) return false
  const presented = Buffer.from(secretDigest(secret), 'hex'), stored = Buffer.from(digest, 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}
/** Unit requests present `Unit <attachmentId>:<credential>`; credentials are base64url and never contain the separator. */
export function parseUnitAuthorization(header: string | undefined): { readonly attachmentId: string; readonly credential: string } {
  if (typeof header !== 'string' || !header.startsWith('Unit ')) throw unitError('unit-credential-invalid')
  const value = header.slice(5).trim(), separator = value.lastIndexOf(':')
  if (separator < 1 || separator === value.length - 1) throw unitError('unit-credential-invalid')
  const attachmentId = value.slice(0, separator), credential = value.slice(separator + 1)
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(credential)) throw unitError('unit-credential-invalid')
  try { return Object.freeze({ attachmentId: validateUnitId(attachmentId), credential }) } catch { throw unitError('unit-credential-invalid') }
}
export function unitAuthorization(attachmentId: string, credential: string): string { return `Unit ${attachmentId}:${credential}` }

export const attachCodeLimits = Object.freeze({ defaultTtlMs: 10 * 60_000, minTtlMs: 60_000, maxTtlMs: 24 * 3_600_000 })
export function attachCodeExpiry(now: string, ttlMs: number | undefined): string {
  const ttl = ttlMs ?? attachCodeLimits.defaultTtlMs
  if (!Number.isSafeInteger(ttl) || ttl < attachCodeLimits.minTtlMs || ttl > attachCodeLimits.maxTtlMs) throw unitError('unit-invalid')
  const start = Date.parse(now)
  if (Number.isNaN(start)) throw unitError('unit-invalid')
  return new Date(start + ttl).toISOString()
}
export function attachCodeExpired(attachment: UnitAttachment, now: string): boolean {
  if (attachment.codeExpiresAt === null) return false
  const current = Date.parse(now), limit = Date.parse(attachment.codeExpiresAt)
  if (Number.isNaN(current) || Number.isNaN(limit)) throw unitError('unit-invalid')
  return current > limit
}

export interface AttachInput {
  readonly unitId: string
  readonly contractVersion: string
  readonly capabilities: JsonValue | null
  readonly ceiling: UnitScope
  readonly at: string
}
/** Approval fixes the unit identity and grants the requested scope only under the unit's own ceiling. */
export function approveAttachment(attachment: UnitAttachment, input: AttachInput): UnitAttachment {
  if (attachment.state !== 'pending') throw unitError('unit-attachment-state')
  if (!scopeWithin(attachment.requestedScope, input.ceiling)) throw unitError('unit-scope-exceeded')
  return Object.freeze({ ...attachment, state: 'approved', unitId: validateUnitId(input.unitId), contractVersion: identifier(input.contractVersion, 64),
    capabilities: input.capabilities, ceiling: input.ceiling, scope: attachment.requestedScope, credential: 'issued', approvedAt: input.at, codeExpiresAt: null })
}
/** Revocation is monotonic and bumps the epoch so fixed references stop matching. */
export function revokeAttachment(attachment: UnitAttachment, at: string): UnitAttachment {
  if (attachment.state === 'revoked') return attachment
  return Object.freeze({ ...attachment, state: 'revoked', epoch: attachment.epoch + 1, revokedAt: at, codeExpiresAt: null })
}
export function localAttachmentId(unitKind: UnitKind): string { return `local:${unitKind}` }
/** Local units are approved by the composition at startup with their full scope and no credential. */
export function localAttachment(unitKind: UnitKind, unitId: string, at: string): UnitAttachment {
  const scope = fullScope(unitKind)
  return Object.freeze({ attachmentId: localAttachmentId(unitKind), unitKind, origin: 'local', state: 'approved', unitId: validateUnitId(unitId), contractVersion: 'local',
    capabilities: null, requestedScope: scope, ceiling: scope, scope, epoch: 1, credential: 'none', createdAt: at, codeExpiresAt: null, approvedAt: at, revokedAt: null })
}
export function attachmentBinding(attachment: UnitAttachment, bootId?: string): RunUnitBinding {
  if (attachment.state !== 'approved' || attachment.unitId === null) throw unitError('unit-attachment-state')
  return Object.freeze({ attachmentId: attachment.attachmentId, unitKind: attachment.unitKind, unitId: attachment.unitId, epoch: attachment.epoch,
    ...(bootId === undefined ? {} : { bootId }) })
}
/** The fixed reference still names the same approved unit at the same epoch. Boot identity is not part of the fence. */
export function bindingMatches(binding: RunUnitBinding, attachment: UnitAttachment | undefined): boolean {
  return attachment !== undefined && attachment.state === 'approved' && attachment.unitKind === binding.unitKind &&
    attachment.unitId === binding.unitId && attachment.epoch === binding.epoch
}
export function validateRunUnitBinding(value: unknown): RunUnitBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unitError('unit-invalid')
  const binding = value as Record<string, unknown>
  if (Object.keys(binding).some(key => !['attachmentId', 'unitKind', 'unitId', 'epoch', 'bootId'].includes(key))) throw unitError('unit-invalid')
  if (!Number.isSafeInteger(binding.epoch) || (binding.epoch as number) < 1) throw unitError('unit-invalid')
  return Object.freeze({ attachmentId: identifier(binding.attachmentId), unitKind: validateUnitKind(binding.unitKind), unitId: validateUnitId(binding.unitId),
    epoch: binding.epoch as number, ...(binding.bootId === undefined ? {} : { bootId: identifier(binding.bootId) }) })
}
export function validateRunUnitBindings(value: unknown): RunUnitBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unitError('unit-invalid')
  const bindings = value as Record<string, unknown>
  if (bindings.schemaVersion !== 1 || Object.keys(bindings).some(key => !['schemaVersion', 'models', 'computer'].includes(key))) throw unitError('unit-invalid')
  const models = validateRunUnitBinding(bindings.models), computer = validateRunUnitBinding(bindings.computer)
  if (models.unitKind !== 'models' || computer.unitKind !== 'computer') throw unitError('unit-invalid')
  return Object.freeze({ schemaVersion: 1, models, computer })
}

import type { JsonValue } from '@anybox/models'
import { validateUnitId } from './domain.js'

/** Unit dial-out transport: the unit long-polls for requests and posts replies. Rules here are pure. */
export interface UnitRequest { readonly requestId: string; readonly kind: string; readonly payload: JsonValue }
export interface UnitReplyError { readonly code: string; readonly name?: string; readonly message?: string; readonly category?: string }
export type UnitReply = { readonly requestId: string; readonly value: JsonValue } | { readonly requestId: string; readonly error: UnitReplyError }
/** What a unit declares on every poll; the harness server answers `info` from it without a round trip. */
export interface UnitRegistration {
  readonly unitId: string
  readonly bootId: string
  readonly platform: string
  readonly architecture: string
  readonly waitMs: number
}
export interface UnitConnection extends Omit<UnitRegistration, 'waitMs'> {
  readonly attachmentId: string
  readonly lastSeenAt: string
  readonly polling: boolean
}
export type UnitTransportErrorCode = 'unit-transport-invalid' | 'unit-unavailable' | 'unit-reply-timeout' | 'unit-request-aborted' | 'unit-transport-closed'
export function transportError(code: UnitTransportErrorCode): Error & { readonly code: UnitTransportErrorCode } {
  return Object.assign(new Error(code), { name: 'UnitTransportError', code })
}
export function isTransportError(error: unknown): error is Error & { readonly code: UnitTransportErrorCode } {
  return error instanceof Error && error.name === 'UnitTransportError' && 'code' in error
}
export const transportLimits = Object.freeze({
  /** A poll returns an empty batch after this long without requests. */
  maxWaitMs: 30_000, defaultWaitMs: 20_000,
  /** A request nobody claimed within this window is reported unavailable; the caller's own retry policy applies. */
  claimTimeoutMs: 10_000,
  /** A claimed request whose reply never arrives; unit-side waits are shorter than this. */
  replyTimeoutMs: 60_000,
  /** A unit that neither polls nor has polled within this window counts as disconnected. */
  staleAfterMs: 45_000,
  maxRepliesPerPost: 256, maxRequestsPerPoll: 64,
})
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x1f\x7f]/.test(value)) throw transportError('unit-transport-invalid')
  return value
}
export function validateUnitRegistration(value: unknown): UnitRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw transportError('unit-transport-invalid')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['unitId', 'bootId', 'platform', 'architecture', 'waitMs'].includes(key))) throw transportError('unit-transport-invalid')
  let unitId: string
  try { unitId = validateUnitId(input.unitId) } catch { throw transportError('unit-transport-invalid') }
  const waitMs = input.waitMs === undefined ? transportLimits.defaultWaitMs : input.waitMs
  if (!Number.isSafeInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > transportLimits.maxWaitMs) throw transportError('unit-transport-invalid')
  return Object.freeze({ unitId, bootId: text(input.bootId), platform: text(input.platform, 64), architecture: text(input.architecture, 64), waitMs: waitMs as number })
}
export function validateUnitReply(value: unknown): UnitReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw transportError('unit-transport-invalid')
  const reply = value as Record<string, unknown>, requestId = text(reply.requestId)
  const keys = Object.keys(reply)
  if ('error' in reply) {
    if (keys.some(key => key !== 'requestId' && key !== 'error')) throw transportError('unit-transport-invalid')
    const error = reply.error
    if (!error || typeof error !== 'object' || Array.isArray(error)) throw transportError('unit-transport-invalid')
    const detail = error as Record<string, unknown>
    if (Object.keys(detail).some(key => !['code', 'name', 'message', 'category'].includes(key))) throw transportError('unit-transport-invalid')
    const optional = (key: 'name' | 'message' | 'category') => detail[key] === undefined ? {} : { [key]: text(detail[key], 4096) }
    return Object.freeze({ requestId, error: Object.freeze({ code: text(detail.code, 128), ...optional('name'), ...optional('message'), ...optional('category') }) })
  }
  if (keys.some(key => key !== 'requestId' && key !== 'value') || !('value' in reply)) throw transportError('unit-transport-invalid')
  return Object.freeze({ requestId, value: reply.value as JsonValue })
}
export function validateUnitReplies(value: unknown): readonly UnitReply[] {
  if (!Array.isArray(value) || value.length > transportLimits.maxRepliesPerPost) throw transportError('unit-transport-invalid')
  const replies = value.map(validateUnitReply)
  if (new Set(replies.map(reply => reply.requestId)).size !== replies.length) throw transportError('unit-transport-invalid')
  return Object.freeze(replies)
}
/** Connectivity is a derived view of the last poll, never a durable fact. */
export function unitConnected(connection: UnitConnection | undefined, now: string, staleAfterMs = transportLimits.staleAfterMs): boolean {
  if (!connection) return false
  if (connection.polling) return true
  const seen = Date.parse(connection.lastSeenAt), current = Date.parse(now)
  return !Number.isNaN(seen) && !Number.isNaN(current) && current - seen < staleAfterMs
}

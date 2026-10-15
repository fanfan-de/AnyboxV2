import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { RuntimeInputs } from '../contracts.js'
import { parseUnitAuthorization } from './domain.js'
import type { UnitAttachment } from './domain.js'
import { unitAttachmentsServiceKey } from './port.js'
import type { UnitAttachmentsPort } from './port.js'
import { transportError, transportLimits, unitConnected, validateUnitRegistration, validateUnitReplies } from './transport-domain.js'
import type { UnitConnection, UnitRegistration, UnitReply, UnitRequest } from './transport-domain.js'

export const unitTransportServiceKey = 'harness.unit-transport'
export interface UnitRequestOptions { readonly signal?: AbortSignal; readonly claimTimeoutMs?: number; readonly replyTimeoutMs?: number }
/** The harness server end of unit dial-out: requests wait in a per-attachment mailbox until the unit claims and answers them. */
export interface UnitTransportPort {
  /** Resolves the approved attachment behind a `Unit` authorization header. */
  authenticate(authorization: string | undefined): Promise<UnitAttachment>
  /** Long poll: returns queued requests, or an empty batch after the registration's wait. */
  poll(attachmentId: string, registration: UnitRegistration, signal?: AbortSignal): Promise<readonly UnitRequest[]>
  reply(attachmentId: string, replies: readonly UnitReply[]): void
  /** Proxy side: one request to the unit behind this attachment; transport failures carry UnitTransportError codes. */
  request(attachmentId: string, message: { readonly kind: string; readonly payload: JsonValue }, options?: UnitRequestOptions): Promise<JsonValue>
  connection(attachmentId: string): (UnitConnection & { readonly connected: boolean }) | undefined
}

interface Pending {
  readonly request: UnitRequest
  resolve(value: JsonValue): void
  reject(error: unknown): void
  readonly claimTimeoutMs: number
  readonly replyTimeoutMs: number
  timer?: ReturnType<typeof setTimeout>
  cleanup?: () => void
}
interface Poll { wake(): void }
interface Mailbox { connection?: UnitConnection; queued: Pending[]; inflight: Map<string, Pending>; polls: Set<Poll> }

/** Owns only in-memory mailboxes and waiting polls. Units keep their own ledgers; nothing here is a durable fact. */
export function createUnitTransportComponent(inputs: RuntimeInputs): Component.Object<void, { [unitAttachmentsServiceKey]: UnitAttachmentsPort }> {
  return { name: 'harness-unit-transport', inject: [unitAttachmentsServiceKey], apply(ctx, _config, deps) {
    const attachments = deps[unitAttachmentsServiceKey]
    const mailboxes = new Map<string, Mailbox>()
    let closing = false
    const mailbox = (attachmentId: string): Mailbox => {
      let box = mailboxes.get(attachmentId)
      if (!box) { box = { queued: [], inflight: new Map(), polls: new Set() }; mailboxes.set(attachmentId, box) }
      return box
    }
    const settle = (pending: Pending, outcome: { value: JsonValue } | { error: unknown }) => {
      clearTimeout(pending.timer); pending.cleanup?.()
      if ('error' in outcome) pending.reject(outcome.error); else pending.resolve(outcome.value)
    }
    const dropQueued = (box: Mailbox, pending: Pending) => { const index = box.queued.indexOf(pending); if (index >= 0) box.queued.splice(index, 1) }
    const failInflight = (box: Mailbox, error: unknown) => { for (const pending of [...box.inflight.values()]) { box.inflight.delete(pending.request.requestId); settle(pending, { error }) } }
    ctx.effect(() => () => {
      closing = true
      for (const box of mailboxes.values()) {
        for (const pending of box.queued.splice(0)) settle(pending, { error: transportError('unit-transport-closed') })
        failInflight(box, transportError('unit-transport-closed'))
        for (const poll of box.polls) poll.wake()
      }
    }, 'reject waiting unit requests and release polls')
    const service: UnitTransportPort = {
      async authenticate(authorization) {
        const { attachmentId, credential } = parseUnitAuthorization(authorization)
        return attachments.authenticate(attachmentId, credential)
      },
      async poll(attachmentId, registration, signal) {
        if (closing) throw transportError('unit-transport-closed')
        const input = validateUnitRegistration(registration), box = mailbox(attachmentId)
        // A new boot cannot answer requests the previous boot claimed; let callers retry against the live unit.
        if (box.connection && box.connection.bootId !== input.bootId) failInflight(box, transportError('unit-unavailable'))
        const { waitMs, ...identity } = input
        const take = (): readonly UnitRequest[] => {
          const batch = box.queued.splice(0, transportLimits.maxRequestsPerPoll)
          for (const pending of batch) {
            box.inflight.set(pending.request.requestId, pending)
            clearTimeout(pending.timer)
            pending.timer = setTimeout(() => { if (box.inflight.get(pending.request.requestId) === pending) { box.inflight.delete(pending.request.requestId); settle(pending, { error: transportError('unit-reply-timeout') }) } }, pending.replyTimeoutMs)
          }
          return Object.freeze(batch.map(pending => pending.request))
        }
        const connect = (polling: boolean) => { box.connection = Object.freeze({ attachmentId, ...identity, lastSeenAt: inputs.now(), polling }) }
        connect(true)
        try {
          if (signal?.aborted) return Object.freeze([])
          if (box.queued.length || waitMs === 0) return take()
          await new Promise<void>(resolve => {
            const poll: Poll = { wake: () => { clearTimeout(timer); signal?.removeEventListener('abort', poll.wake); box.polls.delete(poll); resolve() } }
            const timer = setTimeout(poll.wake, waitMs)
            signal?.addEventListener('abort', poll.wake, { once: true })
            box.polls.add(poll)
          })
          // A poll whose caller went away must not claim requests nobody will answer.
          return closing || signal?.aborted ? Object.freeze([]) : take()
        } finally { if (box.polls.size === 0) connect(false) }
      },
      reply(attachmentId, replies) {
        const box = mailbox(attachmentId)
        for (const reply of validateUnitReplies(replies)) {
          const pending = box.inflight.get(reply.requestId)
          if (!pending) continue
          box.inflight.delete(reply.requestId)
          settle(pending, 'error' in reply ? { error: Object.assign(new Error(reply.error.message ?? reply.error.code), { name: reply.error.name ?? 'UnitReplyError', code: reply.error.code,
            ...(reply.error.category === undefined ? {} : { category: reply.error.category }), remote: true }) } : { value: reply.value })
        }
      },
      request(attachmentId, message, options = {}) {
        if (closing) return Promise.reject(transportError('unit-transport-closed'))
        if (options.signal?.aborted) return Promise.reject(transportError('unit-request-aborted'))
        const box = mailbox(attachmentId)
        // A unit that has not polled within the stale window is not going to claim anything: fail now instead of after the claim window.
        if (!unitConnected(box.connection, inputs.now())) return Promise.reject(transportError('unit-unavailable'))
        return new Promise<JsonValue>((resolve, reject) => {
          const pending: Pending = { request: Object.freeze({ requestId: inputs.newId(), kind: message.kind, payload: message.payload }), resolve, reject,
            claimTimeoutMs: options.claimTimeoutMs ?? transportLimits.claimTimeoutMs, replyTimeoutMs: options.replyTimeoutMs ?? transportLimits.replyTimeoutMs }
          const abort = () => { dropQueued(box, pending); box.inflight.delete(pending.request.requestId); settle(pending, { error: transportError('unit-request-aborted') }) }
          options.signal?.addEventListener('abort', abort, { once: true })
          pending.cleanup = () => options.signal?.removeEventListener('abort', abort)
          pending.timer = setTimeout(() => { dropQueued(box, pending); settle(pending, { error: transportError('unit-unavailable') }) }, pending.claimTimeoutMs)
          box.queued.push(pending)
          const [poll] = box.polls
          poll?.wake()
        })
      },
      connection(attachmentId) {
        const connection = mailboxes.get(attachmentId)?.connection
        return connection && Object.freeze({ ...connection, connected: unitConnected(connection, inputs.now()) })
      },
    }
    ctx.provide(unitTransportServiceKey, service)
  } }
}

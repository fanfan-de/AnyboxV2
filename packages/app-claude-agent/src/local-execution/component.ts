import { randomUUID } from 'node:crypto'
import type { Component, Context } from '@nya/core'
import { productActivityServiceKey, productsServiceKey } from '@anybox/application-api'
import type { ActivityLease, ProductActivityPort, ProductsPort } from '@anybox/application-api'
import { failure, hostAccessServiceKey, json, requestObject } from '@anybox/application-api/node'
import type { ApplicationHttpPort, HostAccessPort } from '@anybox/application-api/node'
import { claudeAgentHttpServiceKey, claudeAgentId } from '../definition.js'
import { createLocalHttpStream } from './http-stream.js'
import { localExecutionCommand, localExecutionLimits } from './protocol.js'
import type { LocalExecutionChunk, LocalExecutionClosed, LocalExecutionDescription, LocalExecutionReserved, LocalExecutionResponse } from './protocol.js'

export const claudeAgentLocalExecutionServiceKey = 'claude-agent.local-execution'
export interface ClaudeAgentLocalExecutionPort { request(payload: unknown, signal: AbortSignal): Promise<LocalExecutionDescription | LocalExecutionResponse | LocalExecutionChunk | LocalExecutionClosed | LocalExecutionReserved> }
type Session = { readonly stream: ReturnType<typeof createLocalHttpStream>; readonly done: Promise<void>; readonly closed: Promise<void>; timer?: ReturnType<typeof setTimeout> }
interface Reservation {
  readonly attached: Promise<void>; attach(): void
  readonly closed: Promise<void>; exit(): void
  watching: boolean; revoked: boolean; session?: Session; timer?: ReturnType<typeof setTimeout>
}
function reservation(): Reservation {
  let attach!: () => void, exit!: () => void
  return { attached: new Promise<void>(resolve => { attach = resolve }), attach: () => attach(),
    closed: new Promise<void>(resolve => { exit = resolve }), exit: () => exit(), watching: false, revoked: false }
}

/** Owns private HTTP observations for the execution root, independently of the business application's open target. */
export function createClaudeAgentLocalExecutionComponent(root: Context): Component.Object<void, {
  [productsServiceKey]: ProductsPort; [productActivityServiceKey]: ProductActivityPort; [hostAccessServiceKey]: HostAccessPort
}> {
  return { name: 'claude-agent-local-execution', inject: [productsServiceKey, productActivityServiceKey, hostAccessServiceKey], apply(ctx, _config, deps) {
    const products = deps[productsServiceKey], activity = deps[productActivityServiceKey], access = deps[hostAccessServiceKey]
    const sessions = new Map<string, Session>(), reservations = new Map<string, Reservation>(), retained = new Set<Promise<void>>()
    let accepting = true
    const describe = (): LocalExecutionDescription => ({ instanceId: access.instance.instanceId, name: '本机', capabilities: ['claude-agent.v1'] })
    const releaseReservation = (id: string, intent: Reservation) => {
      if (reservations.get(id) === intent) reservations.delete(id)
      intent.revoked = true; clearTimeout(intent.timer); intent.attach(); intent.exit()
    }
    const close = async (id: string, session: Session) => {
      if (sessions.get(id) === session) sessions.delete(id)
      clearTimeout(session.timer); session.stream.close(); await Promise.all([session.done, session.closed])
    }
    const cancelReservation = async (id: string, intent: Reservation) => {
      releaseReservation(id, intent)
      if (intent.session) await close(id, intent.session)
    }
    const expire = (id: string, session: Session) => {
      clearTimeout(session.timer)
      session.timer = setTimeout(() => { void close(id, session) }, localExecutionLimits.idleMs)
      session.timer.unref()
    }
    const read = async (id: string, session: Session, signal: AbortSignal) => {
      clearTimeout(session.timer)
      const abort = () => { session.stream.close() }
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      try {
        const frame = await session.stream.read()
        if (signal.aborted) { await close(id, session); throw failure(503, 'cancelled') }
        if (frame.done) await close(id, session)
        else if (!session.stream.signal.aborted) expire(id, session)
        return { ...frame, instanceId: access.instance.instanceId }
      } finally { signal.removeEventListener('abort', abort) }
    }
    ctx.effect(() => async () => {
      accepting = false
      await Promise.all([...reservations].map(([id, intent]) => cancelReservation(id, intent)))
      await Promise.all([...sessions].map(([id, session]) => close(id, session)))
      await Promise.allSettled([...retained])
    }, 'close private Claude Agent observations and join retained operations')
    const service: ClaudeAgentLocalExecutionPort = { async request(payload, signal) {
      if (!accepting) throw failure(503, 'service-unavailable')
      signal.throwIfAborted()
      const input = localExecutionCommand(payload), instanceId = access.instance.instanceId
      if (input.type === 'describe') return describe()
      if (input.instanceId !== undefined && input.instanceId !== instanceId) throw failure(409, 'instance-mismatch')
      if (input.type === 'reserve') {
        if (sessions.has(input.requestId) || reservations.has(input.requestId)) throw failure(409, 'request-conflict')
        if (new Set([...sessions.keys(), ...reservations.keys()]).size >= localExecutionLimits.sessions) throw failure(503, 'too-many-streams')
        const intent = reservation()
        reservations.set(input.requestId, intent)
        intent.timer = setTimeout(() => releaseReservation(input.requestId, intent), localExecutionLimits.idleMs)
        intent.timer.unref()
        return { instanceId, requestId: input.requestId, reserved: true }
      }
      if (input.type === 'close') {
        const intent = reservations.get(input.requestId)
        if (intent) await cancelReservation(input.requestId, intent)
        const session = sessions.get(input.requestId)
        if (session) await close(input.requestId, session)
        return { instanceId, closed: true }
      }
      if (input.type === 'read') {
        const session = sessions.get(input.requestId)
        if (!session) throw failure(404, 'stream-not-found')
        return read(input.requestId, session, signal)
      }
      if (input.type === 'watch') {
        const intent = reservations.get(input.requestId)
        if (intent) {
          if (intent.watching) throw failure(409, 'stream-watch-busy')
          intent.watching = true; clearTimeout(intent.timer)
          const abort = () => { void cancelReservation(input.requestId, intent) }
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
          intent.attach()
          try {
            await intent.closed
            if (intent.session) await Promise.all([intent.session.done, intent.session.closed])
            if (signal.aborted) throw failure(503, 'cancelled')
            return { instanceId, closed: true }
          } finally { signal.removeEventListener('abort', abort) }
        }
        const session = sessions.get(input.requestId)
        if (!session) return { instanceId, closed: true }
        const abort = () => session.stream.close()
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        try {
          await session.closed; await session.done
          if (signal.aborted) throw failure(503, 'cancelled')
          return { instanceId, closed: true }
        } finally { signal.removeEventListener('abort', abort) }
      }
      const id = input.requestId ?? randomUUID()
      const intent = input.reserved ? reservations.get(id) : undefined
      if (input.reserved && !intent || !input.reserved && reservations.has(id)) throw failure(409, 'request-reservation-unavailable')
      if (intent) {
        const abort = () => { void cancelReservation(id, intent) }
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        try {
          await intent.attached
          if (!accepting || intent.revoked || signal.aborted || reservations.get(id) !== intent) throw failure(503, 'cancelled')
        } finally { signal.removeEventListener('abort', abort) }
      } else if (new Set([...sessions.keys(), ...reservations.keys()]).size >= localExecutionLimits.sessions) throw failure(503, 'too-many-streams')
      if (sessions.has(id)) throw failure(409, 'request-conflict')
      let stream: ReturnType<typeof createLocalHttpStream>
      try { stream = createLocalHttpStream(input.method, input.body) }
      catch (error) { if (intent) await cancelReservation(id, intent); throw error }
      const url = new URL(input.path, 'http://claude-agent.local')
      const held: Promise<void>[] = []
      let lease: ActivityLease | undefined
      const done = Promise.resolve().then(async () => {
        stream.signal.throwIfAborted()
        if (input.method === 'GET' && url.pathname === '/instance') {
          if (url.search) throw failure(400, 'invalid-input')
          json(stream.response, 200, { ...access.instance, capabilities: [...new Set([...access.instance.capabilities, 'products.v2', 'claude-agent.v1'])] }); return
        }
        const control = /^\/products\/claude-agent(?:\/(open|stop|retry))?$/.exec(url.pathname)
        if (control) {
          if (url.search) throw failure(400, 'invalid-input')
          if (input.method === 'GET' && !control[1]) { const product = products.get(claudeAgentId); if (!product) throw failure(404, 'product-not-found'); json(stream.response, 200, product); return }
          if (input.method !== 'POST' || !control[1]) throw failure(404, 'not-found')
          await requestObject(stream.request, [])
          const result = await (control[1] === 'open' ? products.open(claudeAgentId) : control[1] === 'stop' ? products.disable(claudeAgentId) : products.retry(claudeAgentId))
          json(stream.response, 200, result); return
        }
        products.authorize(claudeAgentId)
        lease = activity.enter(claudeAgentId, { blocking: input.method !== 'GET', cancel: () => stream.close() })
        const handler = root.get<ApplicationHttpPort>(claudeAgentHttpServiceKey)
        if (!handler) throw failure(503, 'product-unavailable')
        url.pathname = url.pathname.slice(`/apps/${claudeAgentId}`.length)
        await handler.handle(stream.request, stream.response, url, { signal: stream.signal, actorId: 'local-web-user', appId: claudeAgentId, principal: 'owner',
          retainUntil(promise) { held.push(promise.then(() => {}, () => {})) } })
      }).catch(error => {
        if (stream.response.destroyed) return
        const known = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && 'code' in error && typeof error.code === 'string'
          ? { status: error.status, code: error.code } : { status: 500, code: 'internal-error' }
        if (!stream.response.headersSent) json(stream.response, known.status, { error: { code: known.code } })
        else stream.close()
      })
      let exited!: () => void
      const session: Session = { stream, done, closed: new Promise<void>(resolve => { exited = resolve }) }
      sessions.set(id, session)
      if (intent) intent.session = session
      stream.response.once('close', () => {
        if (sessions.get(id) === session) sessions.delete(id)
        if (intent) releaseReservation(id, intent)
        clearTimeout(session.timer); exited()
      })
      const retention = done.finally(async () => { await Promise.allSettled(held); lease?.release(); retained.delete(retention) })
      retained.add(retention); void retention.catch(() => {})
      const abort = () => stream.close()
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      try {
        const head = await stream.head, frame = await read(id, session, signal)
        return { requestId: id, ...head, ...frame }
      } catch (error) { await close(id, session); throw error }
      finally { signal.removeEventListener('abort', abort) }
    } }
    ctx.provide(claudeAgentLocalExecutionServiceKey, service)
  } }
}

/** Pure registration declaration. The first runtime invocation installs only this transport's Nya component. */
export function createClaudeAgentLocalExecutionChannel() {
  const starting = new WeakMap<Context, Promise<void>>()
  return { async handle(root: Context, payload: unknown, context: { readonly signal: AbortSignal; readonly sourceRole: 'client' }) {
    if (context.sourceRole !== 'client') throw failure(403, 'forbidden')
    let service = root.get<ClaudeAgentLocalExecutionPort>(claudeAgentLocalExecutionServiceKey)
    if (!service) {
      let startup = starting.get(root)
      if (!startup) {
        startup = Promise.resolve(root.installComponent(createClaudeAgentLocalExecutionComponent(root))).then(() => {})
        starting.set(root, startup)
        void startup.catch(() => { starting.delete(root) })
      }
      await startup
      service = root.get<ClaudeAgentLocalExecutionPort>(claudeAgentLocalExecutionServiceKey)
      if (!service) throw failure(503, 'service-unavailable')
    }
    return service.request(payload, context.signal)
  } }
}

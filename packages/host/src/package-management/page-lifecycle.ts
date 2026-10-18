import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { failure, json, requestObject } from '@anybox/application-api/node'
import { identifier } from './domain.js'

export interface PackagePageLifecycle {
  handle(request: IncomingMessage, response: ServerResponse, url: URL, options?: { signal?: AbortSignal }): Promise<boolean>
  freeze(activationId: string): Promise<void>
  dispose(activationId: string): Promise<void>
  release(activationId: string): void
  close(): Promise<void>
}
type Action = 'freeze' | 'dispose'
interface Transport { readonly response: ServerResponse; readonly heartbeat: ReturnType<typeof setInterval>; readonly removeAbort: () => void }
interface Page { readonly id: string; readonly registrationId: string; transport?: Transport; exited: boolean }
interface Round { readonly action: Action; readonly pending: Set<Page>; readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void; timer?: ReturnType<typeof setTimeout> }
interface Gate { readonly id: string; readonly pages: readonly Page[]; readonly disposed: Set<Page>; round?: Round; frozen: boolean; failed: boolean }
const base = '/api/client/v1/app-packages/pages'
const lifecycleFailure = (code: string) => Object.assign(new Error(code), { code })
/** Same-origin pages prove interface lifetime; disconnect and timeouts never prove disposal. */
export function createPackagePageLifecycle(options: { timeoutMs?: number } = {}): PackagePageLifecycle {
  const pages = new Map<string, Page>(), exitedRegistrations = new Set<string>(), timeoutMs = options.timeoutMs ?? 30_000
  const registrationKey = (id: string, registrationId: string) => JSON.stringify([id, registrationId])
  let gate: Gate | undefined, closed = false
  function send(page: Page, value: unknown) {
    const response = page.transport?.response
    if (response && !response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  function fail(current: Gate, code: string) {
    current.failed = true
    const round = current.round
    if (round?.timer) clearTimeout(round.timer)
    round?.reject(lifecycleFailure(code))
  }
  function disconnected(page: Page, transport: Transport) {
    clearInterval(transport.heartbeat); transport.removeAbort()
    if (page.transport !== transport) return
    page.transport = undefined
    // Keep the document registered: losing its observer proves no cleanup.
    if (!page.exited && gate?.pages.includes(page) && !gate.disposed.has(page)) fail(gate, gate.round?.action === 'dispose' ? 'activation-browser-exit-unconfirmed' : 'activation-browser-unavailable')
  }
  function complete(current: Gate, pending: Round) {
    if (pending.pending.size || current.failed) return
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.action === 'freeze') current.frozen = true
    pending.resolve()
  }
  function round(current: Gate, action: Action): Promise<void> {
    if (current.failed) return Promise.reject(lifecycleFailure('activation-browser-unavailable'))
    if (current.round?.action === action) return current.round.promise
    const active = current.pages.filter(page => !page.exited)
    if (active.some(page => pages.get(page.id) !== page || !page.transport || page.transport.response.destroyed || page.transport.response.writableEnded)) { fail(current, 'activation-browser-unavailable'); return Promise.reject(lifecycleFailure('activation-browser-unavailable')) }
    let resolve!: () => void, reject!: (error: unknown) => void
    const promise = new Promise<void>((done, error) => { resolve = done; reject = error }); void promise.catch(() => {})
    const next: Round = { action, pending: new Set(active), promise, resolve, reject }; current.round = next
    if (!next.pending.size) { complete(current, next); return promise }
    next.timer = setTimeout(() => fail(current, action === 'dispose' ? 'activation-browser-exit-unconfirmed' : 'activation-browser-busy'), timeoutMs)
    for (const page of active) send(page, { activationId: current.id, action })
    return promise
  }
  return {
    async handle(request, response, url, lifetime = {}) {
      const match = new RegExp(`^${base}/([^/]+)/(events|ack|exit)$`).exec(url.pathname)
      if (!match) return false
      if (url.search) throw failure(400, 'invalid-input')
      const id = identifier(decodeURIComponent(match[1])), action = match[2]
      if (closed || lifetime.signal?.aborted) throw failure(503, 'service-closing')
      if (request.method === 'GET' && action === 'events') {
        if (gate) throw failure(503, 'package-pages-frozen')
        const suppliedRegistration = request.headers['x-anybox-page-registration']
        const registrationId = suppliedRegistration === undefined ? undefined : identifier(suppliedRegistration)
        if (registrationId && exitedRegistrations.has(registrationKey(id, registrationId))) throw failure(409, 'request-conflict')
        let page = pages.get(id)
        if (page && (page.transport || registrationId !== page.registrationId)) throw failure(409, 'request-conflict')
        page ??= { id, registrationId: registrationId ?? randomUUID(), exited: false }
        response.statusCode = 200; response.setHeader('Content-Type', 'text/event-stream'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Connection', 'keep-alive'); response.flushHeaders()
        const abort = () => response.end()
        const transport: Transport = { response, removeAbort: () => lifetime.signal?.removeEventListener('abort', abort), heartbeat: setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n') }, 10_000) }
        lifetime.signal?.addEventListener('abort', abort, { once: true })
        page.transport = transport; pages.set(id, page)
        const current = page
        response.once('close', () => disconnected(current, transport)); if (lifetime.signal?.aborted) abort(); else send(page, { action: 'connected', registrationId: page.registrationId }); return true
      }
      if (request.method === 'POST' && action === 'exit') {
        const body = await requestObject(request, ['registrationId', 'interfacesExited'])
        const registrationId = identifier(body.registrationId)
        if (body.interfacesExited !== true) throw failure(400, 'invalid-input')
        const page = pages.get(id)
        if (page) {
          if (page.registrationId !== registrationId) throw failure(409, 'activation-browser-stale')
          page.exited = true; pages.delete(id)
          if (gate?.pages.includes(page) && gate.round) { gate.disposed.add(page); gate.round.pending.delete(page); complete(gate, gate.round) }
          page.transport?.response.end()
        }
        // A previously sent GET may arrive after this POST. Retain its terminal
        // identity for this coordinator's lifetime so it cannot register again.
        exitedRegistrations.add(registrationKey(id, registrationId))
        json(response, 200, { ok: true }); return true
      }
      if (request.method === 'POST' && action === 'ack') {
        const body = await requestObject(request, ['registrationId', 'activationId', 'action', 'ok'])
        const activationId = identifier(body.activationId), registrationId = identifier(body.registrationId)
        if (!['freeze', 'dispose'].includes(body.action as string) || typeof body.ok !== 'boolean') throw failure(400, 'invalid-input')
        const current = gate, page = pages.get(id), pending = current?.round
        if (!current || current.id !== activationId || !page || page.registrationId !== registrationId || !current.pages.includes(page) || !pending || pending.action !== body.action || current.failed) throw failure(409, 'activation-browser-stale')
        if (body.ok === false) fail(current, body.action === 'dispose' ? 'activation-browser-exit-unconfirmed' : 'activation-browser-busy')
        else {
          if (body.action === 'dispose') current.disposed.add(page)
          pending.pending.delete(page); complete(current, pending)
        }
        json(response, 200, { ok: true }); return true
      }
      throw failure(404, 'not-found')
    },
    freeze(id) {
      identifier(id)
      if (closed) return Promise.reject(lifecycleFailure('service-closing'))
      if (gate && gate.id !== id) return Promise.reject(lifecycleFailure('activation-browser-busy'))
      const current = gate ?? (gate = { id, pages: [...pages.values()], disposed: new Set<Page>(), frozen: false, failed: false })
      return round(current, 'freeze')
    },
    dispose(id) {
      if (!gate || gate.id !== id || !gate.frozen || gate.failed) return Promise.reject(lifecycleFailure('activation-browser-stale'))
      return round(gate, 'dispose')
    },
    release(id) {
      const current = gate; if (!current || current.id !== id) return
      if (current.round?.timer) clearTimeout(current.round.timer)
      current.round?.reject(lifecycleFailure('activation-browser-cancelled'))
      for (const page of current.pages) send(page, { activationId: id, action: 'release' })
      gate = undefined
    },
    async close() {
      if (closed) return
      closed = true
      if (gate) { fail(gate, 'service-closing'); gate = undefined }
      const disconnected = [...pages.values()].flatMap(page => {
        const transport = page.transport
        if (!transport) return []
        clearInterval(transport.heartbeat); transport.removeAbort()
        if (transport.response.destroyed || transport.response.closed) return []
        const done = new Promise<void>(resolve => transport.response.once('close', () => resolve())); transport.response.end(); return [done]
      })
      await Promise.all(disconnected); pages.clear(); exitedRegistrations.clear()
    },
  }
}

import type { Component, Context } from '@nya/core'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { failure, json, requestObject } from '@anybox/application-api/node'
import { harnessServerAccessServiceKey } from '../server-access.js'
import type { HarnessServerAccessPort } from '../server-access.js'
import { harnessServerHttpServiceKey } from './harness-http.js'
import type { HarnessServerHttpHandler } from './handler.js'

export interface HarnessServerListener { readonly url: string; close(): Promise<void> }
const base = '/api/v1'
const applicationBase = `${base}/apps/agent`
const legacyRoutes = ['models', 'prompts', 'tools', 'agents', 'projects', 'sessions', 'runs', 'changes']
function applicationPath(path: string): string | undefined {
  if (path === applicationBase || path.startsWith(`${applicationBase}/`)) return path.slice(applicationBase.length) || '/'
  return legacyRoutes.some(route => path === `${base}/${route}` || path.startsWith(`${base}/${route}/`)) ? path.slice(base.length) : undefined
}

/** The standalone application owns its listener, authentication and request lifetime. */
export async function startHarnessServerHttpServer(options: {
  readonly access: HarnessServerAccessPort
  readonly handler: () => HarnessServerHttpHandler | undefined
  readonly port?: number
  readonly host?: string
}): Promise<HarnessServerListener> {
  let origin = '', closing = false
  const lifetime = new AbortController(), bodies = new Set<IncomingMessage>()
  const tasks = new Set<Promise<void>>(), responses = new Map<ServerResponse, string | undefined>()
  const unsubscribe = options.access.onRevoked(id => { for (const [response, actor] of responses) if (actor === id) response.destroy() })
  const server = createServer((request, response) => {
    bodies.add(request); request.once('end', () => bodies.delete(request)); request.once('close', () => bodies.delete(request))
    responses.set(response, undefined); response.once('close', () => responses.delete(response))
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff')
    const retained: Promise<unknown>[] = []
    const task = (async () => {
      if (closing) throw failure(503, 'service-unavailable')
      const method = request.method ?? 'GET', url = new URL(request.url ?? '/', origin)
      if (url.origin !== origin) throw failure(403, 'forbidden-host')
      const path = applicationPath(url.pathname)
      // Unit credentials are only accepted on the canonical application prefix.
      const unit = url.pathname.startsWith(`${applicationBase}/units/unit/`) || url.pathname === `${applicationBase}/units/unit`
      const actorId = unit ? 'unit' : options.access.authenticate(request.headers.authorization)
      response.setHeader('X-Anybox-Instance-Id', options.access.instance.instanceId)
      if (!unit) {
        responses.set(response, actorId)
        if (method === 'GET' && url.pathname === `${base}/instance`) {
          const instance = options.access.instance
          json(response, 200, { ...instance, capabilities: [...new Set([...instance.capabilities,
            'projects.path', 'images', 'project-files', 'sse', 'units', ...(options.handler()?.capabilities?.() ?? [])])] }); return
        }
        if (request.headers['x-anybox-instance-id'] !== options.access.instance.instanceId) throw failure(409, 'instance-mismatch')
        if (url.pathname === `${base}/access/tokens`) {
          if (method === 'GET') { json(response, 200, await options.access.list()); return }
          if (method === 'POST') { const body = await requestObject(request, ['name']); json(response, 200, await options.access.issue(body.name as string)); return }
        }
        const revoke = /^\/api\/v1\/access\/tokens\/([^/]+)\/revoke$/.exec(url.pathname)
        if (method === 'POST' && revoke) {
          await requestObject(request, []); await options.access.revoke(decodeURIComponent(revoke[1]!)); json(response, 200, { ok: true }); return
        }
      }
      if (path === undefined) throw failure(404, 'not-found')
      const product = request.headers['x-anybox-product-id']
      if (product !== undefined && product !== 'agent') throw failure(403, 'product-mismatch')
      const handler = options.handler()
      if (!handler) throw failure(503, 'service-unavailable')
      const relative = new URL(url); relative.pathname = path
      await handler.handle(request, response, relative, { signal: lifetime.signal, actorId, appId: 'agent', principal: unit ? 'unit' : 'owner',
        retainUntil(done) { retained.push(done.then(() => {}, () => {})) } })
    })().catch(error => {
      if (response.destroyed) return
      const status = error instanceof URIError ? 400 : error && typeof error.status === 'number' ? error.status : 500
      const code = error instanceof URIError ? 'invalid-input' : error && typeof error.status === 'number' && typeof error.code === 'string' ? error.code : 'internal-error'
      if (!response.headersSent) json(response, status, { error: { code } }); else response.destroy()
    }).finally(async () => {
      if (retained.length) await Promise.allSettled(retained)
      tasks.delete(task)
    })
    tasks.add(task)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('harness server listener has no TCP address')
    const host = address.family === 'IPv6' ? `[${address.address === '::' ? '::1' : address.address}]` : address.address === '0.0.0.0' ? '127.0.0.1' : address.address
    origin = `http://${host}:${address.port}`
  } catch (error) { unsubscribe(); server.close(); throw error }
  let shutdown: Promise<void> | undefined
  return { url: origin, close() {
    if (shutdown) return shutdown
    closing = true; unsubscribe(); lifetime.abort()
    for (const request of bodies) if (!request.complete) request.destroy()
    server.closeIdleConnections()
    shutdown = Promise.all([new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), ...tasks]).then(() => {})
    return shutdown
  } }
}

export const harnessServerListenerServiceKey = 'harness.listener'
/** The root owns listener restart and cleanup together with its current access and HTTP services. */
export function createHarnessServerListenerComponent(root: Context, options: { readonly port?: number; readonly host?: string } = {}): Component.Object<void, {
  [harnessServerAccessServiceKey]: HarnessServerAccessPort
}> {
  let listenPort = options.port
  return { name: 'harness-listener', inject: [harnessServerAccessServiceKey], async apply(ctx, _config, deps) {
    let listener: HarnessServerListener | undefined
    ctx.effect(() => async () => { await listener?.close() }, 'stop and join standalone harness listener')
    listener = await startHarnessServerHttpServer({ access: deps[harnessServerAccessServiceKey],
      handler: () => root.get<HarnessServerHttpHandler>(harnessServerHttpServiceKey), port: listenPort, host: options.host })
    listenPort = Number(new URL(listener.url).port)
    ctx.provide(harnessServerListenerServiceKey, listener)
  } }
}

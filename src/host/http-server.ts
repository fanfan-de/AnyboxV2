import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { ApplicationCatalog, ApplicationHttpPort } from './applications/registration.js'
import type { ActivityLease, ProductActivityPort, ProductsPort } from './applications/contracts.js'
import type { HostAccessPort } from './access.js'
import { handleProductsApi } from './products-api.js'
import { failure, json, requestObject } from './http-utils.js'

export interface ApplicationHttpServer { readonly url: string; close(): Promise<void> }
export async function startApplicationHttpServer(options: {
  catalog: ApplicationCatalog
  service(key: string): ApplicationHttpPort | undefined
  products?: ProductsPort
  activity?: ProductActivityPort
  access?: HostAccessPort
  port?: number
  host?: string
  base?: '/api/v1' | '/api/client/v1'
}): Promise<ApplicationHttpServer> {
  const base = options.base ?? '/api/v1'
  let origin = '', closing = false
  const lifetime = new AbortController(), bodies = new Set<import('node:http').IncomingMessage>()
  const tasks = new Set<Promise<void>>(), responses = new Map<ServerResponse, string | undefined>()
  const unsubscribe = options.access?.onRevoked(id => { for (const [response, actor] of responses) if (actor === id) response.destroy() })
  const server = createServer((request, response) => {
    bodies.add(request); request.once('end', () => bodies.delete(request)); request.once('close', () => bodies.delete(request))
    responses.set(response, undefined); response.once('close', () => responses.delete(response))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    let lease: ActivityLease | undefined
    const retained: Promise<unknown>[] = []
    const task = (async () => {
      if (closing) throw failure(503, 'service-unavailable')
      const method = request.method ?? 'GET'
      if (!options.access) {
        if (request.headers.host !== new URL(origin).host) throw failure(403, 'forbidden-host')
        if (request.headers.origin !== undefined && request.headers.origin !== origin || request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw failure(403, 'forbidden-origin')
        if (method !== 'GET' && method !== 'HEAD' && request.headers.origin !== origin) throw failure(403, 'forbidden-origin')
      }
      const url = new URL(request.url ?? '/', origin)
      if (url.origin !== origin) throw failure(403, 'forbidden-host')
      let actorId = 'local-web-user'
      if (options.access) {
        actorId = options.access.authenticate(request.headers.authorization)
        responses.set(response, actorId)
        response.setHeader('X-Anybox-Instance-Id', options.access.instance.instanceId)
        if (method === 'GET' && url.pathname === base + '/instance') {
          const instance = options.access.instance
          json(response, 200, { ...instance, capabilities: [...new Set([...instance.capabilities, 'products.v2',
            ...options.catalog.applications.flatMap(app => app.http ? [...(app.http.capabilities ?? []), ...(options.service(app.http.service)?.capabilities?.() ?? [])] : [])])] }); return
        }
        if (request.headers['x-anybox-instance-id'] !== options.access.instance.instanceId) throw failure(409, 'instance-mismatch')
        if (url.pathname === base + '/access/tokens') {
          if (method === 'GET') { json(response, 200, await options.access.list()); return }
          if (method === 'POST') { const body = await requestObject(request, ['name']); json(response, 200, await options.access.issue(body.name as string)); return }
        }
        const revoke = new RegExp(`^${base}/access/tokens/([^/]+)/revoke$`).exec(url.pathname)
        if (method === 'POST' && revoke) { await requestObject(request, []); await options.access.revoke(decodeURIComponent(revoke[1])); json(response, 200, { ok: true }); return }
      }
      if (method === 'GET' && options.catalog.assets.has(url.pathname)) {
        const asset = options.catalog.assets.get(url.pathname)!
        response.setHeader('Content-Type', asset.type); response.end(await readFile(asset.file)); return
      }
      if (url.pathname === base + '/products' || url.pathname.startsWith(base + '/products/')) {
        if (!options.products) throw failure(404, 'not-found')
        const management = new URL(url); management.pathname = '/api/v1' + url.pathname.slice(base.length)
        await handleProductsApi(options.products, request, response, management); return
      }
      const route = options.catalog.route(url.pathname, base)
      if (!route) throw failure(404, 'not-found')
      const id = route.application.definition.id
      const source = request.headers['x-anybox-product-id']
      if (source !== undefined && (typeof source !== 'string' || source !== id)) throw failure(403, 'product-mismatch')
      options.products?.authorize(id)
      lease = options.activity?.enter(id, { blocking: method !== 'GET', cancel() { response.destroy(); if (!request.complete) request.destroy() } })
      const handler = options.service(route.application.http!.service)
      if (!handler) throw failure(503, 'product-unavailable')
      const relative = new URL(url); relative.pathname = route.path
      await handler.handle(request, response, relative, { signal: lifetime.signal, actorId, appId: id, retainUntil(done) {
        // Observe now; it may reject before the request finishes.
        const settled = done.then(() => {}, () => {}); retained.push(settled)
      } })
    })().catch(error => {
      if (response.destroyed) return
      const status = error instanceof URIError ? 400 : error && typeof error.status === 'number' ? error.status : 500
      const code = error instanceof URIError ? 'invalid-input' : error && typeof error.status === 'number' && typeof error.code === 'string' ? error.code : 'internal-error'
      if (!response.headersSent) json(response, status, { error: { code } }); else response.destroy()
    }).finally(() => {
      if (retained.length) void Promise.allSettled(retained).then(() => lease?.release())
      else lease?.release()
      tasks.delete(task)
    })
    tasks.add(task)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) { unsubscribe?.(); server.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('application listener has no TCP address')
  const host = address.family === 'IPv6' ? `[${address.address === '::' ? '::1' : address.address}]` : address.address === '0.0.0.0' ? '127.0.0.1' : address.address
  origin = `http://${host}:${address.port}`
  let shutdown: Promise<void> | undefined
  return { url: origin, close() {
    if (shutdown) return shutdown
    closing = true; unsubscribe?.()
    lifetime.abort()
    for (const request of bodies) if (!request.complete) request.destroy()
    server.closeIdleConnections()
    shutdown = Promise.all([new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), ...tasks]).then(() => {})
    return shutdown
  } }
}

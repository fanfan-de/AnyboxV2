import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { Component } from '@nya/core'
import { connectionsServiceKey } from './connections.js'
import type { ConnectionsPort, ConnectionInput } from './connections.js'
import { assets } from '../assets.js'
import { json, requestObject, failure } from '../http-utils.js'
import { directoryPickerServiceKey } from '../directory-picker.js'
import type { DirectoryPickerPort } from '../directory-picker.js'

export const clientGatewayServiceKey = 'client.gateway'
export interface ClientGateway { readonly url: string; close(): Promise<void> }
const id = '[^/]+'
const paths: Record<string, readonly RegExp[]> = {
  GET: [ /^\/(instance|agents|projects|models|prompts|access\/tokens|changes)$/, new RegExp(`^/projects/${id}/sessions$`),
    new RegExp(`^/agents/${id}/prompts$`), new RegExp(`^/prompts/${id}(/versions)?$`),
    new RegExp(`^/sessions/${id}(/runs(/by-key/${id})?|/nodes(/${id}(/path)?)?|/images/${id}/content|/project-files/(search|preview|snapshots/${id}))?$`),
    new RegExp(`^/runs/${id}(/(view|events|wait))?$`),
    new RegExp(`^/models/(templates|protocols|catalog|providers|definitions|connections|configurations)(/${id}(/(history|models))?)?$`) ],
  POST: [ /^\/(projects|sessions|prompts|access\/tokens)$/, new RegExp(`^/access/tokens/${id}/revoke$`),
    new RegExp(`^/agents/${id}/prompts$`), new RegExp(`^/prompts/${id}(/publish)?$`),
    new RegExp(`^/sessions/${id}/(model|archive|restore|runs|images(/renew)?|project-files/(preview|prepare|renew))$`), new RegExp(`^/runs/${id}/cancel$`),
    /^\/models\/catalog\/refresh$/, new RegExp(`^/models/(providers|definitions|connections|configurations)(/${id}(/(retry|key|key/delete|delete|discover|check))?)?$`) ],
}
export function allowedProxyPath(method: string, path: string): boolean {
  return !!paths[method]?.some(pattern => pattern.test(path)) && !path.split('/').some(segment => {
    try { const s = decodeURIComponent(segment); return s === '.' || s === '..' || /[\\/\0]/.test(s) } catch { return true }
  })
}
async function forward(connections: ConnectionsPort, connectionId: string, path: string, query: string, request: IncomingMessage, response: ServerResponse, signal: AbortSignal) {
  const lease = await connections.acquire(connectionId)
  signal.throwIfAborted()
  const url = new URL(`${lease.connection.endpoint}/api/v1${path}${query}`)
  const headers: Record<string, string> = { Authorization: `Bearer ${lease.token}`, 'X-Anybox-Instance-Id': lease.connection.instanceId }
  if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type']
  if (request.headers['content-length']) headers['Content-Length'] = request.headers['content-length']
  await new Promise<void>((resolve, reject) => {
    const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers, signal })
    let upload: Promise<unknown> = Promise.resolve(), download: Promise<unknown> = Promise.resolve(), error: unknown
    const handshake = setTimeout(() => upstream.destroy(new Error('connection timeout')), 15000)
    upstream.setTimeout(35000, () => upstream.destroy(new Error('upstream timeout')))
    upstream.on('error', failure => { error = failure })
    upstream.on('response', incoming => {
      clearTimeout(handshake)
      if ((incoming.statusCode !== 401 && incoming.headers['x-anybox-instance-id'] !== lease.connection.instanceId) || (incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) {
        error = failure(409, 'instance-mismatch'); incoming.destroy(); upstream.destroy(); return
      }
      response.statusCode = incoming.statusCode ?? 502
      for (const key of ['content-type', 'content-length', 'cache-control', 'cross-origin-resource-policy']) {
        const value = incoming.headers[key]; if (value !== undefined) response.setHeader(key, value)
      }
      response.flushHeaders()
      download = pipeline(incoming, response, { signal }).catch(failure => { error = failure })
    })
    upstream.on('close', () => { clearTimeout(handshake); void Promise.allSettled([upload, download]).then(() => error ? reject(error) : resolve()) })
    if (request.method === 'POST') upload = pipeline(request, upstream, { signal }).catch(failure => { error = failure; upstream.destroy() })
    else upstream.end()
  })
}
export async function startClientGateway(connections: ConnectionsPort, options: { port?: number; localInstanceId?: string; picker?: DirectoryPickerPort } = {}): Promise<ClientGateway> {
  let origin = '', closing = false
  const tasks = new Map<AbortController, Promise<void>>()
  const server = createServer((request, response) => {
    const controller = new AbortController()
    const disconnected = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', disconnected)
    controller.signal.addEventListener('abort', () => { if (!request.complete) request.destroy() }, { once: true })
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    const task = Promise.resolve().then(async () => {
      if (closing) throw failure(503, 'service-unavailable')
      if (request.headers.host !== new URL(origin).host) throw failure(403, 'forbidden-host')
      if (request.headers.origin !== undefined && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'forbidden-origin')
      const method = request.method ?? 'GET'
      if (method === 'POST' && request.headers.origin !== origin) throw failure(403, 'forbidden-origin')
      const url = new URL(request.url ?? '/', origin)
      if (url.origin !== origin) throw failure(403, 'forbidden-host')
      if (method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname)!; response.setHeader('Content-Type', asset.type); response.end(await readFile(asset.file)); return
      }
      if (url.pathname === '/api/client/v1/connections') {
        if (method === 'GET') { json(response, 200, await connections.list()); return }
        if (method === 'POST') { const body = await requestObject(request, ['id', 'name', 'endpoint', 'token', 'expectedRevision']); json(response, 200, await connections.save(body as unknown as ConnectionInput, controller.signal)); return }
      }
      if (method === 'GET' && url.pathname === '/api/client/v1/local') { json(response, 200, { instanceId: options.localInstanceId ?? null, picker: !!options.localInstanceId && !!options.picker?.supported }); return }
      const action = /^\/api\/client\/v1\/connections\/([^/]+)\/(check|delete|pick)$/.exec(url.pathname)
      if (action && method === 'POST') {
        const connectionId = decodeURIComponent(action[1])
        const body = await requestObject(request, action[2] === 'delete' ? ['expectedRevision'] : [])
        if (action[2] === 'check') { json(response, 200, await connections.check(connectionId, controller.signal)); return }
        if (action[2] === 'pick') {
          const connection = (await connections.list()).find(item => item.id === connectionId)
          if (!connection || !options.localInstanceId || connection.instanceId !== options.localInstanceId || !options.picker?.supported) throw failure(403, 'picker-unavailable')
          json(response, 200, { path: await options.picker.pick(controller.signal) ?? null }); return
        }
        await connections.remove(connectionId, body.expectedRevision as number); json(response, 200, { ok: true }); return
      }
      const proxy = /^\/api\/connections\/([^/]+)\/v1(\/.*)$/.exec(url.pathname)
      if (proxy && allowedProxyPath(method, proxy[2])) {
        await forward(connections, decodeURIComponent(proxy[1]), proxy[2], url.search, request, response, controller.signal); return
      }
      throw failure(404, 'not-found')
    }).catch(error => {
      if (response.destroyed) return
      const status = error && typeof error.status === 'number' ? error.status : 502
      const code = error && typeof error.status === 'number' && typeof error.code === 'string' ? error.code : 'connection-unavailable'
      if (!response.headersSent) json(response, status, { error: { code } }); else response.destroy()
    }).finally(() => { tasks.delete(controller); response.off('close', disconnected) })
    tasks.set(controller, task)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('client has no address')
  origin = `http://127.0.0.1:${address.port}`
  let shutdown: Promise<void> | undefined
  return { url: origin, close() {
    if (shutdown) return shutdown
    closing = true; for (const controller of tasks.keys()) controller.abort()
    shutdown = Promise.all([new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), ...tasks.values()]).then(() => {})
    return shutdown
  } }
}
export function createClientGatewayComponent(options: { port?: number; localInstanceId?: string } = {}): Component.Object<void, { [connectionsServiceKey]: ConnectionsPort; [directoryPickerServiceKey]: DirectoryPickerPort }> {
  return { name: 'client-gateway', inject: [connectionsServiceKey, directoryPickerServiceKey], async apply(ctx, _config, deps) {
    let server: ClientGateway | undefined
    ctx.effect(() => async () => { await server?.close() }, 'stop and join client gateway')
    server = await startClientGateway(deps[connectionsServiceKey], { ...options, picker: deps[directoryPickerServiceKey] })
    ctx.provide(clientGatewayServiceKey, server)
  } }
}

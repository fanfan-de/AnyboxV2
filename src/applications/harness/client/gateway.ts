import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { Component } from '@nya/core'
import { connectionsServiceKey } from './connections.js'
import type { ConnectionsPort, ConnectionInput, Connection } from './connections.js'
import { json, requestObject, failure } from '../../../host/http-utils.js'
import { directoryPickerServiceKey } from './directory-picker.js'
import type { DirectoryPickerPort } from './directory-picker.js'

export const clientGatewayServiceKey = 'client.gateway'
export interface HarnessGateway { handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>; close(): Promise<void> }
const id = '[^/]+'
const paths: Record<string, readonly RegExp[]> = {
  GET: [ /^\/(instance|agents|projects|models|prompts|access\/tokens|changes)$/, /^\/products(?:\/[^/]+)?$/, new RegExp(`^/projects/${id}/sessions$`),
    new RegExp(`^/agents/${id}/prompts$`), new RegExp(`^/prompts/${id}(/versions)?$`),
    new RegExp(`^/sessions/${id}(/runs(/by-key/${id})?|/nodes(/${id}(/path)?)?|/images/${id}/content|/project-files/(search|preview|snapshots/${id}))?$`),
    new RegExp(`^/runs/${id}(/(view|events|wait))?$`),
    new RegExp(`^/models/(templates|protocols|catalog|providers|definitions|connections|configurations)(/${id}(/(history|models))?)?$`) ],
  POST: [ /^\/(projects|sessions|prompts|access\/tokens)$/, /^\/products\/[^/]+\/(open|stop|retry)$/, new RegExp(`^/access/tokens/${id}/revoke$`),
    /^\/projects\/directories\/(browse|close|create)$/,
    new RegExp(`^/agents/${id}/prompts$`), new RegExp(`^/prompts/${id}(/publish)?$`),
    new RegExp(`^/sessions/${id}/(model|archive|restore|runs|images(/renew)?|project-files/(preview|prepare|renew|tree/(open|page|close)))$`), new RegExp(`^/runs/${id}/cancel$`),
    /^\/models\/catalog\/refresh$/, new RegExp(`^/models/(providers|definitions|connections|configurations)(/${id}(/(retry|key|key/delete|delete|discover|check))?)?$`) ],
}
export function allowedProxyPath(method: string, path: string): boolean {
  return !!paths[method]?.some(pattern => pattern.test(path)) && !path.split('/').some(segment => {
    try { const s = decodeURIComponent(segment); return s === '.' || s === '..' || /[\\/\0]/.test(s) } catch { return true }
  })
}
interface RequestBinding { readonly instance?: string; readonly revision?: number; readonly productId?: string }
const bindingQuery = ['__anyboxProductId', '__anyboxInstanceId', '__anyboxConnectionRevision'] as const
/** Capture browser identity before acquiring the connection; only image URLs may encode it in a query. */
function requestBinding(request: IncomingMessage, path?: string, search?: URLSearchParams): RequestBinding {
  const headers = [request.headers['x-anybox-product-id'], request.headers['x-anybox-expected-instance-id'], request.headers['x-anybox-connection-revision']]
  const values = headers.map((header, index) => {
    const query = search?.getAll(bindingQuery[index]) ?? []
    if (query.length && (!path || !/^\/sessions\/[^/]+\/images\/[^/]+\/content$/.test(path) || request.method !== 'GET')) throw failure(400, 'invalid-input')
    if (query.length > 1 || header !== undefined && typeof header !== 'string' || header !== undefined && query.length && header !== query[0]) throw failure(400, 'invalid-input')
    return header ?? query[0]
  })
  const [productId, instance, revision] = values
  if (productId !== undefined && (typeof productId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(productId))) throw failure(400, 'invalid-input')
  if (instance !== undefined || revision !== undefined) {
    if (typeof instance !== 'string' || !/^[0-9a-f-]{36}$/.test(instance) || typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw failure(400, 'invalid-input')
  }
  if (bindingQuery.some(key => search?.has(key)) && values.some(value => value === undefined)) throw failure(400, 'invalid-input')
  for (const key of bindingQuery) search?.delete(key)
  return Object.freeze({ ...(instance === undefined ? {} : { instance }), ...(revision === undefined ? {} : { revision: Number(revision) }), ...(productId === undefined ? {} : { productId }) })
}
function expectedConnection(binding: RequestBinding, connection: Connection): void {
  if (binding.instance === undefined) return
  if (binding.instance !== connection.instanceId) throw failure(409, 'instance-mismatch')
  if (binding.revision !== connection.revision) throw failure(409, 'connection-changed')
}
async function forward(connections: ConnectionsPort, connectionId: string, path: string, query: string, request: IncomingMessage, response: ServerResponse, signal: AbortSignal) {
  const search = new URLSearchParams(query), binding = requestBinding(request, path, search)
  const lease = await connections.acquire(connectionId)
  signal.throwIfAborted()
  expectedConnection(binding, lease.connection)
  const suffix = search.toString()
  const url = new URL(`${lease.connection.endpoint}/api/v1${path}${suffix ? `?${suffix}` : ''}`)
  const headers: Record<string, string> = { Authorization: `Bearer ${lease.token}`, 'X-Anybox-Instance-Id': lease.connection.instanceId }
  if (binding.productId) headers['X-Anybox-Product-Id'] = binding.productId
  if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type']
  if (request.headers['content-length']) headers['Content-Length'] = request.headers['content-length']
  await new Promise<void>((resolve, reject) => {
    const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers, signal })
    let upload: Promise<unknown> = Promise.resolve(), download: Promise<unknown> = Promise.resolve(), error: unknown
    // Application control joins component startup/cleanup before replying; it can exceed an ordinary proxy request.
    const control = /^\/products\/[^/]+\/(?:open|stop|retry)$/.test(path)
    const handshake = setTimeout(() => upstream.destroy(new Error('connection timeout')), control ? 120000 : 15000)
    upstream.setTimeout(control ? 120000 : 35000, () => upstream.destroy(new Error('upstream timeout')))
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
import type { ApplicationHttpContext } from '../../../host/applications/registration.js'
import { productActivityServiceKey } from '../../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../../host/applications/contracts.js'

/** Harness owns its connection requests and proxy operations; the listener belongs to the shell. */
export function createHarnessGateway(connections: ConnectionsPort, options: { localInstanceId?: string; picker?: DirectoryPickerPort; activity?: ProductActivityPort } = {}): HarnessGateway {
  let closing = false
  const tasks = new Map<AbortController, Promise<void>>()
  return {
    handle(request, response, input, context) {
      const url = new URL(input)
      // Canonical application-relative routes and explicit legacy aliases use one adapter.
      if (/^\/connections\/[^/]+\/v1(?:\/|$)/.test(url.pathname)) url.pathname = '/api' + url.pathname
      else url.pathname = '/api/client/v1' + url.pathname
      if (closing) return Promise.reject(failure(503, 'product-unavailable'))
      const controller = new AbortController()
      const disconnected = () => { if (!response.writableEnded) controller.abort() }
      const stop = () => controller.abort()
      context.signal.addEventListener('abort', stop, { once: true }); if (context.signal.aborted) stop()
      response.once('close', disconnected)
      controller.signal.addEventListener('abort', () => { if (!request.complete) request.destroy() }, { once: true })
      const lease = options.activity?.enter('agent', { blocking: request.method === 'POST', cancel: () => { controller.abort(); response.destroy() } })
      const task = Promise.resolve().then(async () => {
        const method = request.method ?? 'GET'
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
        expectedConnection(requestBinding(request), connection)
        const path = await options.picker.pick(controller.signal) ?? null
        const current = (await connections.list()).find(item => item.id === connectionId)
        if (!current || current.instanceId !== connection.instanceId || current.revision !== connection.revision) throw failure(409, 'connection-changed')
        expectedConnection(requestBinding(request), current)
        json(response, 200, { path }); return
      }
      await connections.remove(connectionId, body.expectedRevision as number); json(response, 200, { ok: true }); return
    }
    const proxy = /^\/api\/connections\/([^/]+)\/v1(\/.*)$/.exec(url.pathname)
    if (proxy && allowedProxyPath(method, proxy[2])) {
      try { await forward(connections, decodeURIComponent(proxy[1]), proxy[2], url.search, request, response, controller.signal) }
      catch (error) { if (error && typeof error === 'object' && 'status' in error) throw error; throw failure(502, 'connection-unavailable') }
      return
    }
        throw failure(404, 'not-found')
      }).finally(() => { tasks.delete(controller); context.signal.removeEventListener('abort', stop); lease?.release(); response.off('close', disconnected) })
      tasks.set(controller, task)
      return task
    },
    async close() {
      closing = true
      for (const controller of tasks.keys()) controller.abort()
      await Promise.allSettled([...tasks.values()])
    },
  }
}
export function createClientGatewayComponent(options: { localInstanceId?: string } = {}): Component.Object<void, {
  [connectionsServiceKey]: ConnectionsPort; [directoryPickerServiceKey]: DirectoryPickerPort; [productActivityServiceKey]: ProductActivityPort
}> {
  return { name: 'client-gateway', inject: [connectionsServiceKey, directoryPickerServiceKey, productActivityServiceKey], apply(ctx, _config, deps) {
    const gateway = createHarnessGateway(deps[connectionsServiceKey], { ...options, picker: deps[directoryPickerServiceKey], activity: deps[productActivityServiceKey] })
    ctx.effect(() => () => gateway.close(), 'cancel and join Harness connection and proxy requests')
    ctx.provide(clientGatewayServiceKey, gateway)
  } }
}

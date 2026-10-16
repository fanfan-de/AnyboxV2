import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { Connection, ConnectionsPort } from './connections.js'
import { failure } from './http-utils.js'

/** Browser-declared identity of the connection a request expects; captured before any connection is acquired. */
export interface RequestBinding { readonly instance?: string; readonly revision?: number; readonly productId?: string }
const bindingQuery = ['__anyboxProductId', '__anyboxInstanceId', '__anyboxConnectionRevision'] as const
/** Reads the binding headers, or the reserved query parameters when the caller allows them for this route; query values must match the headers. */
export function requestBinding(request: IncomingMessage, search?: URLSearchParams, allowQuery = false): RequestBinding {
  const headers = [request.headers['x-anybox-product-id'], request.headers['x-anybox-expected-instance-id'], request.headers['x-anybox-connection-revision']]
  const values = headers.map((header, index) => {
    const query = search?.getAll(bindingQuery[index]) ?? []
    if (query.length && !allowQuery) throw failure(400, 'invalid-input')
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
export function expectedConnection(binding: RequestBinding, connection: Connection): void {
  if (binding.instance === undefined) return
  if (binding.instance !== connection.instanceId) throw failure(409, 'instance-mismatch')
  if (binding.revision !== connection.revision) throw failure(409, 'connection-changed')
}
export interface ConnectionForwardOptions {
  /** Only routes that cannot send headers (image URLs) may carry the binding in reserved query parameters. */
  readonly allowQueryBinding?: boolean
}
// Application control joins component startup/cleanup before replying; it can exceed an ordinary proxy request.
const controlPath = /^\/products\/[^/]+\/(?:open|stop|retry)$/
/**
 * Forwards one request to `<endpoint>/api/v1<path>` under the connection's own credentials and expected instance.
 * Browser authentication and proxy identity headers never reach the execution host; redirects and write retries are refused.
 * Resolves only after the upload and download pipelines have actually exited.
 */
export async function forwardConnectionRequest(connections: ConnectionsPort, connectionId: string, path: string, query: string,
  request: IncomingMessage, response: ServerResponse, signal: AbortSignal, options: ConnectionForwardOptions = {}): Promise<void> {
  const search = new URLSearchParams(query), binding = requestBinding(request, search, options.allowQueryBinding === true)
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
    const control = controlPath.test(path)
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

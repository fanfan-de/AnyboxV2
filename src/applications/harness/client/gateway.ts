import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from '@nya/core'
import { connectionsServiceKey } from '../../../host/connections.js'
import type { ConnectionsPort, ConnectionInput } from '../../../host/connections.js'
import { expectedConnection, forwardConnectionRequest, requestBinding } from '../../../host/connection-proxy.js'
import { json, requestObject, failure } from '../../../host/http-utils.js'
import { directoryPickerServiceKey } from '../../../host/directory-picker.js'
import type { DirectoryPickerPort } from '../../../host/directory-picker.js'
import type { ApplicationHttpContext } from '../../../host/applications/registration.js'
import { productActivityServiceKey } from '../../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../../host/applications/contracts.js'

export const clientGatewayServiceKey = 'client.gateway'
export interface HarnessGateway { handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>; close(): Promise<void> }
const id = '[^/]+'
const paths: Record<string, readonly RegExp[]> = {
  GET: [ /^\/(instance|agents|projects|models|prompts|tools|access\/tokens|changes)$/, /^\/products(?:\/[^/]+)?$/, new RegExp(`^/projects/${id}/sessions$`),
    new RegExp(`^/agents/${id}/(prompts|session-defaults|tools)$`), new RegExp(`^/prompts/${id}(/versions)?$`),
    new RegExp(`^/sessions/${id}(/runs(/by-key/${id})?|/nodes(/${id}(/path)?)?|/images/${id}/content|/project-files/(search|preview|snapshots/${id}))?$`),
    new RegExp(`^/runs/${id}(/(view|events|wait))?$`),
    new RegExp(`^/models/(templates|protocols|catalog|providers|definitions|connections|configurations)(/${id}(/(history|models))?)?$`) ],
  POST: [ /^\/(projects|sessions|prompts|access\/tokens)$/, /^\/products\/[^/]+\/(open|stop|retry)$/, new RegExp(`^/access/tokens/${id}/revoke$`),
    /^\/projects\/directories\/(browse|close|create)$/,
    new RegExp(`^/agents/${id}/(prompts|session-defaults|tools)$`), new RegExp(`^/prompts/${id}(/publish)?$`),
    new RegExp(`^/sessions/${id}/(model|archive|restore|runs|images(/renew)?|project-files/(preview|prepare|renew|tree/(open|page|close)))$`), new RegExp(`^/runs/${id}/cancel$`),
    /^\/models\/catalog\/refresh$/, new RegExp(`^/models/(providers|definitions|connections|configurations)(/${id}(/(retry|key|key/delete|delete|discover|check))?)?$`) ],
}
export function allowedProxyPath(method: string, path: string): boolean {
  return !!paths[method]?.some(pattern => pattern.test(path)) && !path.split('/').some(segment => {
    try { const s = decodeURIComponent(segment); return s === '.' || s === '..' || /[\\/\0]/.test(s) } catch { return true }
  })
}
/** <img> cannot send headers, so only image content URLs may carry the connection binding in reserved query parameters. */
const imageContentPath = /^\/sessions\/[^/]+\/images\/[^/]+\/content$/

/** The Anybox Harness client owns connection requests and proxy operations; Anybox owns the listener and the connection library. */
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
    if (method === 'GET' && url.pathname === '/api/client/v1/local') {
      const status = connections.localStatus?.()
      const instanceId = status?.instanceId ?? options.localInstanceId ?? null
      json(response, 200, { instanceId, picker: !!instanceId && !!options.picker?.supported, ...(status?.enabled ? { status } : {}) }); return
    }
    if (method === 'POST' && url.pathname === '/api/client/v1/local/retry') {
      if (!connections.localStatus?.().enabled) throw failure(403, 'local-pairing-unavailable')
      await requestObject(request, [])
      json(response, 200, await connections.retryLocal(controller.signal)); return
    }
    const action = /^\/api\/client\/v1\/connections\/([^/]+)\/(check|delete|pick)$/.exec(url.pathname)
    if (action && method === 'POST') {
      const connectionId = decodeURIComponent(action[1])
      const body = await requestObject(request, action[2] === 'delete' ? ['expectedRevision'] : [])
      if (action[2] === 'check') { json(response, 200, await connections.check(connectionId, controller.signal)); return }
      if (action[2] === 'pick') {
        const connection = (await connections.list()).find(item => item.id === connectionId)
        const localInstanceId = connections.localStatus?.().instanceId ?? options.localInstanceId
        if (!connection || !localInstanceId || connection.instanceId !== localInstanceId || !options.picker?.supported) throw failure(403, 'picker-unavailable')
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
      try {
        await forwardConnectionRequest(connections, decodeURIComponent(proxy[1]), proxy[2], url.search, request, response, controller.signal,
          { allowQueryBinding: method === 'GET' && imageContentPath.test(proxy[2]) })
      } catch (error) { if (error && typeof error === 'object' && 'status' in error) throw error; throw failure(502, 'connection-unavailable') }
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
    ctx.effect(() => () => gateway.close(), 'cancel and join Anybox Harness client connection and proxy requests')
    ctx.provide(clientGatewayServiceKey, gateway)
  } }
}

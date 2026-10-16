import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from '@nya/core'
import { connectionsServiceKey } from '../../../host/connections.js'
import type { ConnectionsPort } from '../../../host/connections.js'
import { forwardConnectionRequest } from '../../../host/connection-proxy.js'
import { failure, json } from '../../../host/http-utils.js'
import type { ApplicationHttpContext } from '../../../host/applications/registration.js'
import { productActivityServiceKey } from '../../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../../host/applications/contracts.js'
import { claudeAgentGatewayServiceKey, claudeAgentId } from '../definition.js'

export interface ClaudeAgentGateway {
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>
  close(): Promise<void>
}
const id = '[^/]+', app = `/apps/${claudeAgentId}`
/** Only the execution device's product control and this application's own routes may be reached through the proxy. */
const paths: Record<string, readonly RegExp[]> = {
  GET: [/^\/instance$/, new RegExp(`^/products/${claudeAgentId}$`), new RegExp(`^${app}/(environment|threads|events)$`),
    new RegExp(`^${app}/threads/${id}(/(runs|messages|approvals))?$`), new RegExp(`^${app}/runs/${id}(/(view|wait))?$`)],
  POST: [new RegExp(`^/products/${claudeAgentId}/(open|stop|retry)$`), new RegExp(`^${app}/threads(/${id}/runs)?$`), new RegExp(`^${app}/runs/${id}/cancel$`), new RegExp(`^${app}/approvals/${id}$`)],
}
export function allowedClaudeAgentProxyPath(method: string, path: string): boolean {
  return !!paths[method]?.some(pattern => pattern.test(path)) && !path.split('/').some(segment => {
    try { const value = decodeURIComponent(segment); return value === '.' || value === '..' || /[\\/\0]/.test(value) } catch { return true }
  })
}
/** Reads the host connection library and forwards whitelisted requests to the chosen execution device; Anybox owns the listener. */
export function createClaudeAgentGateway(connections: ConnectionsPort, options: { localInstanceId?: string; activity?: ProductActivityPort } = {}): ClaudeAgentGateway {
  let closing = false
  const tasks = new Map<AbortController, Promise<void>>()
  const localInstanceId = () => connections.localStatus?.().instanceId ?? options.localInstanceId ?? null
  return {
    handle(request, response, url, context) {
      if (closing) return Promise.reject(failure(503, 'product-unavailable'))
      const controller = new AbortController()
      const disconnected = () => { if (!response.writableEnded) controller.abort() }
      const stop = () => controller.abort()
      context.signal.addEventListener('abort', stop, { once: true }); if (context.signal.aborted) stop()
      response.once('close', disconnected)
      controller.signal.addEventListener('abort', () => { if (!request.complete) request.destroy() }, { once: true })
      const lease = options.activity?.enter(claudeAgentId, { blocking: request.method === 'POST', cancel: () => { controller.abort(); response.destroy() } })
      const task = Promise.resolve().then(async () => {
        const method = request.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/connections') {
          if (url.search) throw failure(400, 'invalid-input')
          json(response, 200, { connections: await connections.list(), localInstanceId: localInstanceId() }); return
        }
        if (method === 'GET' && url.pathname === '/local') {
          if (url.search) throw failure(400, 'invalid-input')
          const status = connections.localStatus?.()
          json(response, 200, { instanceId: localInstanceId(), ...(status?.enabled ? { status } : {}) }); return
        }
        const proxy = /^\/connections\/([^/]+)\/v1(\/.*)$/.exec(url.pathname)
        if (proxy && allowedClaudeAgentProxyPath(method, proxy[2])) {
          try { await forwardConnectionRequest(connections, decodeURIComponent(proxy[1]), proxy[2], url.search, request, response, controller.signal) }
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
export function createClaudeAgentGatewayComponent(options: { localInstanceId?: string } = {}): Component.Object<void, {
  [connectionsServiceKey]: ConnectionsPort; [productActivityServiceKey]: ProductActivityPort
}> {
  return { name: 'claude-agent-client-gateway', inject: [connectionsServiceKey, productActivityServiceKey], apply(ctx, _config, deps) {
    const gateway = createClaudeAgentGateway(deps[connectionsServiceKey], { ...options, activity: deps[productActivityServiceKey] })
    ctx.effect(() => () => gateway.close(), 'cancel and join Claude Agent client proxy requests')
    ctx.provide(claudeAgentGatewayServiceKey, gateway)
  } }
}

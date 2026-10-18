import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from '@nya/core'
import { connectionsServiceKey } from './connections.js'
import type { ConnectionsPort, ConnectionInput } from './connections.js'
import { expectedConnection, forwardConnectionRequest, requestBinding } from './connection-proxy.js'
import { DirectoryPickerFailure, directoryPickerServiceKey } from '@anybox/directory-picker'
import type { DirectoryPickerPort } from '@anybox/directory-picker'
import { failure, json, requestObject } from '@anybox/application-api/node'
import type { ApplicationHttpContext } from '@anybox/application-api/node'
import { productActivityServiceKey } from '@anybox/application-api/contracts'
import type { ProductActivityPort } from '@anybox/application-api/contracts'
import { claudeAgentGatewayServiceKey, claudeAgentId } from '../definition.js'
import { describeLocalExecution, forwardLocalExecutionRequest } from './local-execution.js'
import type { LocalChannel } from './local-execution.js'

export interface ClaudeAgentGateway {
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>
  close(): Promise<void>
}
const id = '[^/]+', app = `/apps/${claudeAgentId}`
/** Only the execution device's product control and this application's own routes may be reached through the proxy. */
const paths: Record<string, readonly RegExp[]> = {
  GET: [new RegExp(`^${app}/runs/${id}/messages$`),new RegExp(`^${app}/threads/${id}/native-sessions$`),new RegExp(`^${app}/threads/${id}/(context|agents|agents/${id}/messages|file|checkpoints|interactions|mcp/jobs|mcp/jobs/${id})$`), /^\/instance$/, new RegExp(`^/products/${claudeAgentId}$`), new RegExp(`^${app}/(account|environment|threads|events|directories|projects/recent|models|models/recent|capabilities)$`),
    new RegExp(`^${app}/threads/${id}(/(runs|messages|approvals|capabilities|permissions))?$`), new RegExp(`^${app}/runs/${id}(/(view|wait))?$`)],
  POST: [new RegExp(`^${app}/attachments(/${id}/(chunks|discard))?$`),new RegExp(`^${app}/runs/${id}/messages(/${id}/cancel)?$`),new RegExp(`^${app}/threads/${id}/native-sessions$`),new RegExp(`^${app}/threads/${id}/(options|manage|rewind|mcp/connect|mcp/jobs/${id}/cancel|interactions/${id})$`), new RegExp(`^/products/${claudeAgentId}/(open|stop|retry)$`), new RegExp(`^${app}/threads(/${id}/runs)?$`), new RegExp(`^${app}/threads/${id}/permissions/${id}/revoke$`), new RegExp(`^${app}/runs/${id}/(cancel|control)$`), new RegExp(`^${app}/approvals/${id}$`)],
}
export function allowedClaudeAgentProxyPath(method: string, path: string): boolean {
  return !!paths[method]?.some(pattern => pattern.test(path)) && !path.split('/').some(segment => {
    try { const value = decodeURIComponent(segment); return value === '.' || value === '..' || /[\\/\0]/.test(value) } catch { return true }
  })
}
const pickerFailure = (error: unknown) => {
  if (error instanceof DirectoryPickerFailure && error.code === 'busy') return failure(409, 'picker-busy')
  if (error instanceof DirectoryPickerFailure && error.code === 'unsupported') return failure(503, 'picker-unsupported')
  return failure(503, 'picker-unavailable')
}
/** Reads Claude Agent connections and forwards whitelisted requests to the chosen execution device; Anybox owns the listener. */
export function createClaudeAgentGateway(connections: ConnectionsPort, options: { localInstanceId?: string; localChannel?: LocalChannel; picker?: DirectoryPickerPort; activity?: ProductActivityPort } = {}): ClaudeAgentGateway {
  let closing = false
  const tasks = new Map<AbortController, Promise<void>>()
  const localInstanceId = () => connections.localStatus?.().instanceId ?? options.localInstanceId ?? null
  const pickerAvailable = (connection: { readonly instanceId: string } | undefined) => { const local = localInstanceId(); return !!connection && !!local && connection.instanceId === local && !!options.picker?.supported }
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
        if (method === 'POST' && url.pathname === '/connections') {
          if (url.search) throw failure(400, 'invalid-input')
          const body = await requestObject(request, ['id', 'name', 'endpoint', 'token', 'expectedRevision'])
          json(response, 200, await connections.save(body as unknown as ConnectionInput, controller.signal)); return
        }
        if (method === 'GET' && url.pathname === '/local') {
          if (url.search) throw failure(400, 'invalid-input')
          if (options.localChannel) {
            try {
              const local = await describeLocalExecution(options.localChannel, controller.signal)
              json(response, 200, { managed: true, instanceId: local.instanceId, picker: !!options.picker?.supported,
                device: { id: 'local', kind: 'local', name: local.name, instanceId: local.instanceId, revision: 1 } })
            } catch {
              if (controller.signal.aborted) throw failure(503, 'cancelled')
              json(response, 200, { managed: true, instanceId: null, picker: false, error: { code: 'local-execution-unavailable' } })
            }
            return
          }
          const status = connections.localStatus?.()
          json(response, 200, { instanceId: localInstanceId(), picker: !!localInstanceId() && !!options.picker?.supported, ...(status?.enabled ? { status } : {}) }); return
        }
        if (method === 'POST' && url.pathname === '/local/pick' && options.localChannel) {
          if (url.search) throw failure(400, 'invalid-input')
          await requestObject(request, [])
          const local = await describeLocalExecution(options.localChannel, controller.signal)
          const binding = requestBinding(request)
          if (binding.productId !== undefined && binding.productId !== claudeAgentId) throw failure(403, 'product-mismatch')
          if (binding.instance !== undefined && binding.instance !== local.instanceId) throw failure(409, 'instance-mismatch')
          if (binding.revision !== undefined && binding.revision !== 1) throw failure(409, 'connection-changed')
          if (!options.picker?.supported) throw failure(403, 'picker-unavailable')
          try { json(response, 200, { path: await options.picker.pick(controller.signal) ?? null }) }
          catch (error) { throw pickerFailure(error) }
          return
        }
        const localProxy = /^\/local\/v1(\/.*)$/.exec(url.pathname)
        if (localProxy && options.localChannel && allowedClaudeAgentProxyPath(method, localProxy[1])) {
          await forwardLocalExecutionRequest(options.localChannel, localProxy[1], url.search, request, response, controller.signal)
          return
        }
        if (method === 'POST' && url.pathname === '/local/retry') {
          if (url.search) throw failure(400, 'invalid-input')
          await requestObject(request, [])
          if (!connections.localStatus().enabled) throw failure(403, 'local-pairing-unavailable')
          json(response, 200, await connections.retryLocal(controller.signal)); return
        }
        const connectionAction = /^\/connections\/([^/]+)\/(check|delete)$/.exec(url.pathname)
        if (connectionAction && method === 'POST') {
          if (url.search) throw failure(400, 'invalid-input')
          const body = await requestObject(request, connectionAction[2] === 'delete' ? ['expectedRevision'] : [])
          const id = decodeURIComponent(connectionAction[1]!)
          if (connectionAction[2] === 'check') { json(response, 200, await connections.check(id, controller.signal)); return }
          await connections.remove(id, body.expectedRevision as number)
          json(response, 200, { ok: true }); return
        }
        // The native directory window only ever runs on this machine, for the connection confirmed to be this machine.
        const pick = /^\/connections\/([^/]+)\/pick$/.exec(url.pathname)
        if (pick && method === 'POST') {
          if (url.search) throw failure(400, 'invalid-input')
          await requestObject(request, [])
          const connectionId = decodeURIComponent(pick[1])
          const connection = (await connections.list()).find(item => item.id === connectionId)
          if (!connection || !pickerAvailable(connection)) throw failure(403, 'picker-unavailable')
          expectedConnection(requestBinding(request), connection)
          let path: string | null
          try { path = await options.picker!.pick(controller.signal) ?? null } catch (error) { throw pickerFailure(error) }
          const current = (await connections.list()).find(item => item.id === connectionId)
          if (!current || current.instanceId !== connection.instanceId || current.revision !== connection.revision) throw failure(409, 'connection-changed')
          json(response, 200, { path }); return
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
export function createClaudeAgentGatewayComponent(options: { localInstanceId?: string; localChannel?: LocalChannel } = {}, directoryPicker = false): Component.Object<void, {
  [connectionsServiceKey]: ConnectionsPort; [directoryPickerServiceKey]: DirectoryPickerPort; [productActivityServiceKey]: ProductActivityPort
}> {
  return { name: 'claude-agent-client-gateway', inject: [connectionsServiceKey, ...(directoryPicker ? [directoryPickerServiceKey] : []), productActivityServiceKey], apply(ctx, _config, deps) {
    const gateway = createClaudeAgentGateway(deps[connectionsServiceKey], { ...options, picker: directoryPicker ? deps[directoryPickerServiceKey] : undefined, activity: deps[productActivityServiceKey] })
    ctx.effect(() => () => gateway.close(), 'cancel and join Claude Agent client proxy requests')
    ctx.provide(claudeAgentGatewayServiceKey, gateway)
  } }
}

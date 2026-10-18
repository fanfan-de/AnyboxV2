import type { Component, Context } from '@nya/core'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { failure, json, requestObject } from '@anybox/application-api/node'
import type { ApplicationHttpPort, HostAccessPort } from '@anybox/application-api/node'
import { claudeAgentHttpServiceKey, claudeAgentId, claudeAgentServerHttp } from './definition.js'
import { hostAccessServiceKey } from './server-access.js'

export interface ClaudeAgentHttpServer { readonly url: string; close(): Promise<void> }
/** Claude Agent owns its listener, authentication and retained operations, independently of Anybox. */
export async function startClaudeAgentHttpServer(options: {
  readonly handler: () => ApplicationHttpPort | undefined
  readonly access: HostAccessPort
  readonly port?: number
  readonly host?: string
}): Promise<ClaudeAgentHttpServer> {
  const base = '/api/v1', prefix = `${base}/apps/${claudeAgentId}`
  const lifetime = new AbortController(), bodies = new Set<IncomingMessage>()
  const tasks = new Set<Promise<void>>(), responses = new Map<ServerResponse, string | undefined>()
  let origin = '', closing = false
  const unsubscribe = options.access.onRevoked(id => { for (const [response, actor] of responses) if (actor === id) response.destroy() })
  const server = createServer((request, response) => {
    bodies.add(request); request.once('end', () => bodies.delete(request)); request.once('close', () => bodies.delete(request))
    responses.set(response, undefined); response.once('close', () => responses.delete(response))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const retained: Promise<unknown>[] = []
    const task = (async () => {
      if (closing) throw failure(503, 'service-unavailable')
      const method = request.method ?? 'GET', url = new URL(request.url ?? '/', origin)
      if (url.origin !== origin) throw failure(403, 'forbidden-host')
      const actorId = options.access.authenticate(request.headers.authorization), instance = options.access.instance
      responses.set(response, actorId)
      response.setHeader('X-Anybox-Instance-Id', instance.instanceId)
      if (method === 'GET' && url.pathname === `${base}/instance`) {
        json(response, 200, { ...instance, capabilities: [...new Set([...instance.capabilities, ...claudeAgentServerHttp.capabilities])] }); return
      }
      if (request.headers['x-anybox-instance-id'] !== instance.instanceId) throw failure(409, 'instance-mismatch')
      if (url.pathname === `${base}/access/tokens`) {
        if (method === 'GET') { json(response, 200, await options.access.list()); return }
        if (method === 'POST') { const input = await requestObject(request, ['name']); json(response, 200, await options.access.issue(input.name as string)); return }
      }
      const revoke = /^\/api\/v1\/access\/tokens\/([^/]+)\/revoke$/.exec(url.pathname)
      if (method === 'POST' && revoke) {
        await requestObject(request, []); await options.access.revoke(decodeURIComponent(revoke[1])); json(response, 200, { ok: true }); return
      }
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) throw failure(404, 'not-found')
      const source = request.headers['x-anybox-product-id']
      if (source !== undefined && source !== claudeAgentId) throw failure(403, 'product-mismatch')
      const handler = options.handler()
      if (!handler) throw failure(503, 'service-unavailable')
      const relative = new URL(url); relative.pathname = url.pathname.slice(prefix.length) || '/'
      await handler.handle(request, response, relative, { signal: lifetime.signal, actorId, appId: claudeAgentId, principal: 'owner',
        retainUntil(done) { retained.push(done.then(() => {}, () => {})) },
      })
    })().catch((error: unknown) => {
      if (response.destroyed) return
      const known = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && 'code' in error && typeof error.code === 'string' ? { status: error.status, code: error.code } : undefined
      if (!response.headersSent) json(response, error instanceof URIError ? 400 : known?.status ?? 500, { error: { code: error instanceof URIError ? 'invalid-input' : known?.code ?? 'internal-error' } })
      else response.destroy()
    }).finally(async () => { await Promise.allSettled(retained); tasks.delete(task) })
    tasks.add(task)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) { unsubscribe(); server.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Claude Agent listener has no TCP address')
  const host = address.family === 'IPv6' ? `[${address.address === '::' ? '::1' : address.address}]` : address.address === '0.0.0.0' ? '127.0.0.1' : address.address
  origin = `http://${host}:${address.port}`
  let shutdown: Promise<void> | undefined
  return { url: origin, close() {
    if (shutdown) return shutdown
    closing = true; unsubscribe(); lifetime.abort()
    for (const body of bodies) if (!body.complete) body.destroy()
    server.closeIdleConnections()
    shutdown = Promise.all([new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), ...tasks]).then(() => {})
    return shutdown
  } }
}


export const claudeAgentListenerServiceKey = 'claude-agent.listener'
/** Owns the current access generation's listener and preserves an ephemeral port across component restarts. */
export function createClaudeAgentListenerComponent(root: Context, options: { readonly port?: number; readonly host?: string } = {}): Component.Object<void, {
  [hostAccessServiceKey]: HostAccessPort
}> {
  if (root.root !== root) throw new TypeError('application root Context required')
  let listenPort = options.port
  return { name: 'claude-agent-listener', inject: [hostAccessServiceKey], async apply(ctx, _config, deps) {
    let listener: ClaudeAgentHttpServer | undefined
    ctx.effect(() => async () => { await listener?.close() }, 'stop and join standalone Claude Agent listener')
    listener = await startClaudeAgentHttpServer({ access: deps[hostAccessServiceKey],
      handler: () => root.get<ApplicationHttpPort>(claudeAgentHttpServiceKey), port: listenPort, host: options.host })
    listenPort = Number(new URL(listener.url).port)
    ctx.provide(claudeAgentListenerServiceKey, listener)
  } }
}

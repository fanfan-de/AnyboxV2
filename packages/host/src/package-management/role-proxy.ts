import { createServer, request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

export interface ManagedRoleProxy {
  readonly url: string
  closeAdmission(): void
  /** Waits for every accepted proxy transport and the listening socket to exit. */
  close(): Promise<void>
}
const transportHeader = 'x-anybox-desktop-transport'
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function headers(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = String(input.connection ?? '').toLowerCase().split(',').map(value => value.trim())
  return Object.fromEntries(Object.entries(input).filter(([name]) => !hopHeaders.has(name) && !connection.includes(name) && name !== transportHeader))
}
function reply(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed) return
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify({ error: { code } }))
}
function targetUrl(input: string | undefined): URL | undefined {
  if (!input) return undefined
  try {
    const target = new URL(input)
    if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash || !target.port) return undefined
    return target
  } catch { return undefined }
}

/** A fixed loopback origin forwards only to the lifecycle owner's private role URL. */
export async function startManagedRoleProxy(options: { readonly port?: number; readonly target: () => string | undefined; readonly transportSecret: string; readonly incomingTransportSecret?: string }): Promise<ManagedRoleProxy> {
  if (typeof options.target !== 'function' || typeof options.transportSecret !== 'string' || !options.transportSecret || options.transportSecret.length > 4096 || /[\r\n\0]/.test(options.transportSecret)) throw new TypeError('invalid managed role proxy configuration')
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new TypeError('invalid managed role proxy port')
  if (options.incomingTransportSecret !== undefined && (typeof options.incomingTransportSecret !== 'string' || !options.incomingTransportSecret || options.incomingTransportSecret.length > 4096 || /[\r\n\0]/.test(options.incomingTransportSecret))) throw new TypeError('invalid incoming managed role transport')
  const incomingDigest = options.incomingTransportSecret === undefined ? undefined : createHash('sha256').update(options.incomingTransportSecret).digest()
  const secret = options.transportSecret, target = options.target
  let origin = '', closing = false, shutdown: Promise<void> | undefined
  const sockets = new Set<Socket>(), uploads = new Set<IncomingMessage>(), upstreams = new Set<ClientRequest>(), streams = new Set<IncomingMessage>(), responses = new Set<ServerResponse>(), tasks = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    uploads.add(request); responses.add(response)
    request.once('close', () => uploads.delete(request)); response.once('close', () => responses.delete(response))
    const method = request.method ?? 'GET'
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    const acceptedMutation = () => mutation && request.complete
    let incoming: URL
    try {
      if (closing) { reply(response, 503, 'service-unavailable'); request.resume(); return }
      if (incomingDigest) {
        const presented = request.headers[transportHeader]
        if (typeof presented !== 'string' || !timingSafeEqual(incomingDigest, createHash('sha256').update(presented).digest())) { reply(response, 403, 'forbidden-transport'); request.resume(); return }
      }
      if (request.headers.host !== new URL(origin).host) { reply(response, 403, 'forbidden-host'); request.resume(); return }
      if (request.headers.origin !== undefined && request.headers.origin !== origin || request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])) || method !== 'GET' && method !== 'HEAD' && request.headers.origin !== origin) { reply(response, 403, 'forbidden-origin'); request.resume(); return }
      incoming = new URL(request.url ?? '/', origin)
      if (incoming.origin !== origin) { reply(response, 403, 'forbidden-host'); request.resume(); return }
    } catch { reply(response, 400, 'invalid-input'); request.resume(); return }
    let destination: URL | undefined
    try { destination = targetUrl(target()) } catch { /* Target unavailability is a lifecycle fact. */ }
    if (!destination) { reply(response, 503, 'role-unavailable'); request.resume(); return }
    const selectedTarget = destination, forwarded = headers(request.headers)
    forwarded.host = destination.host; forwarded[transportHeader] = secret
    if (request.headers.origin !== undefined) forwarded.origin = destination.origin
    // Each request fixes its role generation. A restart never retries a mutation.
    const upstream = httpRequest({ protocol: 'http:', hostname: destination.hostname === '[::1]' ? '::1' : destination.hostname, port: destination.port, method, path: incoming.pathname + incoming.search, headers: forwarded, agent: false })
    upstreams.add(upstream)
    let settled = false, received: IncomingMessage | undefined
    let finish!: () => void
    const task = new Promise<void>(resolve => { finish = () => { if (settled) return; settled = true; upstreams.delete(upstream); if (received) streams.delete(received); tasks.delete(task); resolve() } })
    tasks.add(task)
    const fail = () => { reply(response, 503, 'role-unavailable'); upstream.destroy() }
    upstream.once('error', fail)
    upstream.once('close', () => { if (!received) finish() })
    request.once('error', () => { if (!request.complete) upstream.destroy() })
    request.once('aborted', () => { if (!request.complete) upstream.destroy() })
    response.once('close', () => {
      if (!acceptedMutation()) {
        // GET/HEAD completion only means their request headers were received.
        // Their response is an observation, including SSE page registrations.
        // Releasing it must reach the child so a reloaded page cannot stay live.
        received?.destroy(); upstream.destroy()
      } else if (received) {
        // A complete mutation remains accepted after its browser observer leaves.
        // Drain its result without aborting or retrying application work.
        received.unpipe(response); received.resume()
      }
    })
    upstream.once('response', source => {
      received = source; streams.add(source)
      source.once('end', finish); source.once('close', finish); source.once('error', () => { response.destroy(); upstream.destroy(); finish() })
      if (response.destroyed) {
        if (acceptedMutation()) source.resume()
        else { source.destroy(); upstream.destroy() }
        return
      }
      const outgoing = headers(source.headers)
      if (typeof outgoing.location === 'string') {
        try { const location = new URL(outgoing.location, selectedTarget); if (location.origin === selectedTarget.origin) outgoing.location = origin + location.pathname + location.search + location.hash } catch { delete outgoing.location }
      }
      try { response.writeHead(source.statusCode ?? 502, outgoing); source.pipe(response) } catch { response.destroy(); source.destroy(); upstream.destroy(); finish() }
    })
    request.pipe(upstream)
    // No payload buffering or interpretation occurs in this process.
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('managed role proxy has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
  const closeAdmission = () => { closing = true }
  return Object.freeze({ url: origin, closeAdmission, close() {
    if (shutdown) return shutdown
    closeAdmission()
    const exited = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    for (const upload of uploads) if (!upload.complete) upload.destroy()
    for (const response of responses) response.destroy()
    for (const stream of streams) stream.destroy()
    for (const upstream of upstreams) upstream.destroy()
    for (const socket of sockets) socket.destroy()
    shutdown = Promise.all([exited, ...tasks]).then(() => {})
    return shutdown
  } })
}

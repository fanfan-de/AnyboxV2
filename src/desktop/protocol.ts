import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

export const desktopOrigin = 'anybox-app://app'
export function isDesktopUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'anybox-app:' && url.hostname === 'app' && !url.port && !url.username && !url.password
  } catch { return false }
}
const requestHeaders = ['content-type', 'content-length', 'accept', 'last-event-id',
  'x-anybox-product-id', 'x-anybox-expected-instance-id', 'x-anybox-connection-revision']
const responseHeaders = ['content-type', 'content-length', 'cache-control', 'content-security-policy',
  'cross-origin-resource-policy', 'x-content-type-options']
export interface DesktopProtocolRequest extends Request { readonly initiatorOrigin?: string }

/** Streams the existing listener; it has no asset table, domain routing, or model credentials. */
export function createDesktopProtocolBridge(origin: string, secret: string) {
  const upstream = new URL(origin)
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port || upstream.username || upstream.password) {
    throw new TypeError('Invalid desktop client listener')
  }
  let accepting = true
  const operations = new Set<{ abort(): void; done: Promise<void> }>()
  const handle = async (request: DesktopProtocolRequest): Promise<Response> => {
    if (!accepting) return new Response('Desktop services are closing', { status: 503 })
    if (!isDesktopUrl(request.url) || request.initiatorOrigin && request.initiatorOrigin !== desktopOrigin) {
      return new Response('Forbidden', { status: 403 })
    }
    const input = new URL(request.url), target = new URL(upstream)
    target.pathname = input.pathname; target.search = input.search
    const headers: Record<string, string> = { Host: upstream.host, Origin: upstream.origin,
      'X-Anybox-Desktop-Transport': secret }
    for (const name of requestHeaders) { const value = request.headers.get(name); if (value !== null) headers[name] = value }
    const controller = new AbortController(), abort = () => controller.abort()
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    const operation = { abort, done }; operations.add(operation)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    return new Promise<Response>((resolve, reject) => {
      let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined, upload: Readable | undefined
      let started = false, outgoingExited = false, incomingExited = true, uploadExited = false
      const finish = () => {
        if (!started || !outgoingExited || !incomingExited || !uploadExited) return
        request.signal.removeEventListener('abort', abort); operations.delete(operation); complete()
      }
      const fail = (error: unknown) => {
        reject(error)
        controller.abort()
        const cause = error instanceof Error ? error : new Error('Desktop transport failed')
        outgoing?.destroy(cause); incoming?.destroy(cause)
      }
      const uploadFinished = () => { uploadExited = true; finish() }
      try {
        if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
          upload = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>)
        }
        outgoing = httpRequest(target, { method: request.method, headers, signal: controller.signal }, response => {
          incoming = response; incomingExited = false
          response.once('close', () => {
            incomingExited = true
            // Renderer cancellation also stops an upload that the listener has not consumed yet.
            if (!uploadExited) abort()
            finish()
          })
          response.once('error', fail)
          try {
            const resultHeaders = new Headers()
            for (const name of responseHeaders) {
              const value = response.headers[name]
              if (typeof value === 'string') resultHeaders.set(name, value)
            }
            const status = response.statusCode ?? 502
            if (request.method === 'HEAD' || [204, 205, 304].includes(status)) {
              const result = new Response(null, { status, headers: resultHeaders })
              response.resume(); resolve(result); return
            }
            const body = Readable.toWeb(response) as ReadableStream<Uint8Array>
            resolve(new Response(body, { status, headers: resultHeaders }))
          } catch (error) { fail(error) }
        })
        outgoing.once('close', () => { outgoingExited = true; finish() })
        outgoing.once('error', fail)
        if (upload) {
          void pipeline(upload, outgoing, { signal: controller.signal }).catch(fail).finally(uploadFinished)
        } else {
          outgoing.end(); uploadExited = true
        }
      } catch (error) {
        fail(error)
        if (!outgoing) outgoingExited = true
        if (upload) {
          // Constructor/setup failures still own the reader acquired by fromWeb.
          const exited = finished(upload, { cleanup: true }).catch(() => {})
          upload.destroy()
          void exited.finally(uploadFinished)
        } else uploadExited = true
      } finally { started = true; finish() }
    })
  }
  return { handle, closeAdmission() { accepting = false }, async close() {
    accepting = false
    for (const operation of operations) operation.abort()
    await Promise.allSettled([...operations].map(operation => operation.done))
  } }
}

import type { Session } from 'electron'
import { isDesktopUrl } from './protocol.js'
import type { DesktopProtocolRequest } from './protocol.js'

const correlationHeader = 'X-Anybox-Desktop-Request-Id'
/** Electron's protocol Request.signal does not observe renderer aborts. Bind exact browser request IDs instead. */
export function installDesktopSessionProtocol(desktopSession: Session, ownerId: () => number | undefined,
  forward: (request: DesktopProtocolRequest) => Promise<Response>) {
  type Operation = { readonly controller: AbortController; readonly owner: number; readonly url: string; readonly method: string }
  const requests = new Map<number, Operation>()
  const filter = { urls: ['anybox-app://app/*'] }
  desktopSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const owner = ownerId()
    if (owner === undefined || !isDesktopUrl(details.url) || details.webContentsId !== owner) { callback({ cancel: true }); return }
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) if (key.toLowerCase() === correlationHeader.toLowerCase()) delete headers[key]
    headers[correlationHeader] = String(details.id)
    requests.set(details.id, { controller: new AbortController(), owner, url: details.url, method: details.method })
    callback({ requestHeaders: headers })
  })
  desktopSession.webRequest.onErrorOccurred(filter, details => {
    requests.get(details.id)?.controller.abort(); requests.delete(details.id)
  })
  desktopSession.webRequest.onCompleted(filter, details => { requests.delete(details.id) })
  desktopSession.protocol.handle('anybox-app', async input => {
    const request = input as DesktopProtocolRequest
    const rawId = request.headers.get(correlationHeader)
    const id = Number(rawId), operation = rawId && /^\d+$/.test(rawId) ? requests.get(id) : undefined
    if (!operation || operation.owner !== ownerId() || operation.url !== request.url || operation.method !== request.method) return new Response('Forbidden', { status: 403 })
    const bound = new Request(request, { signal: AbortSignal.any([request.signal, operation.controller.signal]) }) as DesktopProtocolRequest
    Object.defineProperty(bound, 'initiatorOrigin', { value: request.initiatorOrigin })
    try { return await forward(bound) }
    catch (error) {
      if (operation.controller.signal.aborted) return new Response(null, { status: 499 })
      throw error
    }
  })
  return { dispose() {
    for (const operation of requests.values()) operation.controller.abort()
    requests.clear()
    desktopSession.webRequest.onBeforeSendHeaders(filter, null)
    desktopSession.webRequest.onErrorOccurred(filter, null)
    desktopSession.webRequest.onCompleted(filter, null)
    desktopSession.protocol.unhandle('anybox-app')
  } }
}

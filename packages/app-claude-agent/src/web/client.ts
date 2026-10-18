import type { RunChangedView, RunEventFrameView } from '../core/view.js'

export interface DeviceConnection { readonly id: string; readonly name: string; readonly endpoint: string; readonly instanceId: string; readonly revision: number; readonly credentialConfigured: boolean }
/** A local execution role is an application target, never a saved device connection. */
export interface LocalDevice { readonly id: 'local'; readonly kind: 'local'; readonly name: string; readonly instanceId: string; readonly revision: 1 }
export type DeviceTarget = DeviceConnection | LocalDevice
export interface DeviceDirectory { readonly connections: readonly DeviceConnection[]; readonly localInstanceId: string | null }
/** This machine as the launcher confirmed it, and whether the host offers a native directory window for it. */
export interface LocalIdentity { readonly instanceId: string | null; readonly picker?: boolean; readonly device?: LocalDevice; readonly managed?: boolean; readonly error?: { readonly code: string } }
export interface EventHandlers { ready(): void; change(change: RunChangedView): void; event(frame: RunEventFrameView): void; error(): void }
export interface EventSubscription { close(): void }
export interface DeviceClient {
  readonly connection: DeviceTarget
  request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T>
  events(threadId: string, handlers: EventHandlers): EventSubscription
  /** Opens the host's native directory window for this connection; null when the user cancelled. Only offered for this machine. */
  pickDirectory(signal?: AbortSignal): Promise<string | null>
}
const apiFailure = (status: number, code: string, message?: string) => Object.assign(new Error(message || code), { status, code })
/** JSON request keeping the product's own error message; the gateway strips every browser credential. */
export async function requestJSON<T>(url: string, body?: object, signal?: AbortSignal, headers: Readonly<Record<string, string>> = {}): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' })
  const data = await response.json().catch(() => undefined)
  if (!response.ok) throw apiFailure(response.status, data?.error?.code ?? 'request-failed', data?.error?.message)
  return data as T
}
export function readDevices(apiBase: string, signal: AbortSignal): Promise<DeviceDirectory> {
  return requestJSON<DeviceDirectory>(`${apiBase}/connections`, undefined, signal)
}
export function readLocal(apiBase: string, signal: AbortSignal): Promise<LocalIdentity> {
  return requestJSON<LocalIdentity>(`${apiBase}/local`, undefined, signal)
}
/** Every request pins the connection revision and expected instance; a changed device never receives an old request. */
export function createDeviceClient(apiBase: string, connection: DeviceTarget, lifetime: AbortSignal): DeviceClient {
  const headers = { 'X-Anybox-Product-Id': 'claude-agent', 'X-Anybox-Expected-Instance-Id': connection.instanceId, 'X-Anybox-Connection-Revision': String(connection.revision) }
  const local = 'kind' in connection && connection.kind === 'local'
  const targetBase = local ? `${apiBase}/local` : `${apiBase}/connections/${encodeURIComponent(connection.id)}`
  const url = (path: string) => `${targetBase}/v1${path}`
  const bound = <T>(target: string, body: object | undefined, signal: AbortSignal | undefined): Promise<T> => {
    const controller = new AbortController(), abort = () => controller.abort()
    lifetime.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
    if (lifetime.aborted || signal?.aborted) abort()
    return requestJSON<T>(target, body, controller.signal, headers).finally(() => { lifetime.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort) })
  }
  return {
    connection,
    request: <T>(path: string, body?: object, signal?: AbortSignal) => bound<T>(url(path), body, signal),
    pickDirectory: async signal => (await bound<{ path: string | null }>(`${targetBase}/pick`, {}, signal)).path,
    events(threadId, handlers) {
      const controller = new AbortController()
      const stop = () => controller.abort()
      lifetime.addEventListener('abort', stop, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      const run = async () => {
        try {
          const response = await fetch(url(`/apps/claude-agent/events?threadId=${encodeURIComponent(threadId)}`), { headers, signal: controller.signal, cache: 'no-store' })
          if (!response.ok || !response.body) throw new Error('stream unavailable')
          const reader = response.body.getReader(), decoder = new TextDecoder()
          let buffer = ''
          try {
            while (!controller.signal.aborted) {
              const next = await reader.read()
              if (next.done) break
              buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n')
              if (buffer.length > 2 * 1024 * 1024) throw new Error('stream frame too large')
              let boundary: number
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
                let event = 'message'; const data: string[] = []
                for (const line of frame.split('\n')) {
                  if (line.startsWith('event:')) event = line.slice(6).trim()
                  else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
                }
                if (controller.signal.aborted) break
                if (event === 'ready') handlers.ready()
                else if (event === 'run-changed') handlers.change(JSON.parse(data.join('\n')) as RunChangedView)
                else if (event === 'run-event') handlers.event(JSON.parse(data.join('\n')) as RunEventFrameView)
              }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        } catch { /* Reconnect below with the same device identity. */ }
        if (!controller.signal.aborted) { handlers.error(); timer = setTimeout(() => { void run() }, 1500) }
      }
      void run()
      return { close() { controller.abort(); lifetime.removeEventListener('abort', stop); if (timer !== undefined) clearTimeout(timer) } }
    },
  }
}

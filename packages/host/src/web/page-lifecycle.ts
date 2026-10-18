import type { ApplicationInterfaceLease } from './application-lifecycle.js'
import { removedApplicationIds } from './application-workspace.js'
const base = '/api/client/v1/app-packages'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Options {
  prepare(): Promise<ApplicationInterfaceLease>
  connection(enabled: boolean, registered: boolean): void
  reload(removedAppIds?: readonly string[]): void
  readonly fetch?: typeof fetch
  readonly pageId?: string
  readonly pollMs?: number
}
/** Every shell page participates, including hidden pages whose manager is closed. */
export function setupPackagePageLifecycle(options: Options) {
  const fetcher = options.fetch ?? fetch, pageId = options.pageId ?? crypto.randomUUID(), registrationId = crypto.randomUUID(), lifetime = new AbortController(), pollMs = options.pollMs ?? 2000
  let registeredOnce!: () => void
  const registration = new Promise<void>(resolve => { registeredOnce = resolve })
  let enabled = false, closed = false, registrationAttempted = false, lease: ApplicationInterfaceLease | undefined, activationId: string | undefined, disposal: Promise<void> | undefined
  let connection: Promise<void> | undefined, observation: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, announced = false
  async function json(path: string, body?: unknown) {
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const value: unknown = await response.json(); if (!response.ok) throw Error('lifecycle observation unavailable'); return value
  }
  async function acknowledge(id: string, action: 'freeze' | 'dispose', ok: boolean) { await json(`${base}/pages/${encodeURIComponent(pageId)}/ack`, { registrationId, activationId: id, action, ok }) }
  async function event(value: unknown) {
    if (closed || !object(value)) return
    if (value.action === 'connected') {
      if (value.registrationId !== registrationId) throw Error('invalid page registration')
      announced = true; options.connection(true, true); registeredOnce(); return
    }
    if (typeof value.activationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.activationId)) return
    const id = value.activationId
    if (value.action === 'release') {
      if (activationId === id) { lease?.release(); lease = undefined; activationId = undefined }
      return
    }
    if (value.action !== 'freeze' && value.action !== 'dispose') return
    if (activationId && activationId !== id) { await acknowledge(id, value.action, false); return }
    activationId = id
    let ok = false
    try {
      if (value.action === 'freeze') { lease ??= await options.prepare(); lease.check(); ok = true }
      else { if (lease) { await lease.disposeForRestart(); ok = true } }
    } catch { /* A guard or unconfirmed cleanup is a negative lifetime acknowledgement. */ }
    await acknowledge(id, value.action, ok)
  }
  async function connect() {
    if (closed || connection) return connection
    let task!: Promise<void>
    task = (async () => {
      try {
        const status = await json(base)
        enabled = object(status) && status.browserLifecycleAvailable === true
        if (!enabled) { options.connection(false, false); registeredOnce(); return }
        options.connection(true, false); announced = false
        registrationAttempted = true
        const response = await fetcher(`${base}/pages/${encodeURIComponent(pageId)}/events`, { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal,
          headers: { 'X-Anybox-Page-Registration': registrationId } })
        if (!response.ok || !response.body) throw Error('page registration unavailable')
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''
        try {
          while (!closed) {
            const chunk = await reader.read(); if (chunk.done) break
            pending += decoder.decode(chunk.value, { stream: true })
            if (pending.length > 64 * 1024) throw Error('invalid page lifecycle stream')
            let boundary: number
            while ((boundary = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
              const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
              if (data) await event(JSON.parse(data))
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch { if (!closed) options.connection(enabled, false) }
      finally {
        if (connection === task) connection = undefined
        if (!closed && enabled) { announced = false; options.connection(true, false); schedule() }
      }
    })()
    connection = task; return task
  }
  function refresh(): Promise<void> {
    if (closed || observation) return observation ?? Promise.resolve()
    const id = activationId
    const task = (async () => {
      if (!id) return
      try {
        const value = await json(`${base}/activations/${encodeURIComponent(id)}`)
        if (closed || activationId !== id || !object(value)) return
        if (value.phase === 'cancelled') { lease?.release(); lease = undefined; activationId = undefined }
        else if (value.phase === 'completed' && Array.isArray(value.roles) && value.roles.every(role => object(role) && role.ready === true)) options.reload(removedApplicationIds(value))
      } catch { /* Keep the interface fence while the stable origin reconnects. */ }
    })().finally(() => { if (observation === task) observation = undefined })
    observation = task; return task
  }
  function schedule() {
    if (closed || timer !== undefined || pollMs <= 0) return
    timer = setTimeout(() => { timer = undefined; void refresh(); if (!connection) void connect(); schedule() }, pollMs)
  }
  const ready = (async () => {
    // A newly opened page remains fenced until it joins the lifetime protocol.
    try {
      const value = await json(base)
      enabled = object(value) && value.browserLifecycleAvailable === true
      options.connection(enabled, false)
      if (enabled) { void connect(); schedule(); await registration } else registeredOnce()
    } catch { options.connection(true, false); enabled = true; schedule(); await registration }
  })()
  return { ready, refresh, get registered() { return announced }, dispose(proof: { interfacesExited?: boolean } = {}): Promise<void> {
    if (disposal) return disposal
    closed = true; announced = false; registeredOnce(); if (timer !== undefined) clearTimeout(timer)
    lifetime.abort()
    disposal = (async () => {
      // Join every registration attempt before unregistering: a late GET must
      // never recreate this document after its successful exit proof.
      await Promise.allSettled([ready, ...(connection ? [connection] : []), ...(observation ? [observation] : [])])
      // Callers grant this proof only after every accepted interface cleanup
      // has actually exited. A disconnected stream alone keeps registration.
      if (proof.interfacesExited && registrationAttempted) {
        const response = await fetcher(`${base}/pages/${encodeURIComponent(pageId)}/exit`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId, interfacesExited: true }) })
        if (!response.ok) throw Error('page exit unconfirmed')
      }
    })()
    return disposal
  } }
}

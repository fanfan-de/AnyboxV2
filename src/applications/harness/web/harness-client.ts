import { requestJSON } from '../../../host/web/http-client.js'
export { requestJSON } from '../../../host/web/http-client.js'
import type { Api, ImageRef, ProjectView } from './client-types.js'
import type { ProtocolViewSnapshot } from '../core/view/types.js'
import { createRunChangeClient } from './run-change-client.js'
import { openChangeStream } from './event-stream.js'
export interface HarnessConnection { readonly id: string; readonly name: string; readonly endpoint: string; readonly instanceId: string; readonly revision: number; readonly credentialConfigured: boolean }
const identityKeys = new Set(['id', 'agentId', 'viewNodeId', 'focusedRunId', 'activePaneId', 'sidebarProjectId', 'projectId', 'sessionId', 'runId', 'parentId', 'parentNodeId', 'nodeId', 'sourceRunId', 'resultNodeId', 'modelId', 'requestedModelId', 'assetId', 'snapshotId', 'connectionId', 'providerId', 'modelDefinitionId', 'assetIds', 'snapshotIds', 'invalid'])
export function scopedId(instanceId: string, id: string): string { return `h:${instanceId}:${id}` }
export function splitScopedId(value: string): { instanceId: string; id: string } | undefined {
  const match = /^h:([0-9a-f-]{36}):([\s\S]+)$/.exec(value)
  return match ? { instanceId: match[1], id: match[2] } : undefined
}
export function mapResourceIds(value: unknown, map: (id: string) => string, key = ''): unknown {
  if (typeof value === 'string') return identityKeys.has(key) ? map(value) : value
  if (Array.isArray(value)) return value.map(item => mapResourceIds(item, map, key))
  if (!value || typeof value !== 'object') return value
  if (['parameters', 'modelSnapshot', 'capabilities', 'controls', 'source'].includes(key)) return value
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, mapResourceIds(item, map, field)]))
}
const configured = new Map<string, HarnessConnection>()
const resourceProducts = new Map<string, string>()
export function connectionHeaders(connection: HarnessConnection, productId?: string): Record<string, string> {
  return { 'X-Anybox-Expected-Instance-Id': connection.instanceId, 'X-Anybox-Connection-Revision': String(connection.revision),
    ...(productId ? { 'X-Anybox-Product-Id': productId } : {}) }
}
function resourceURL(connection: HarnessConnection, path: string, productId: string): string {
  const url = new URL(`/api/connections/${encodeURIComponent(connection.id)}/v1${path}`, 'http://client.invalid')
  if (/^\/sessions\/[^/]+\/images\/[^/]+\/content$/.test(path.split('?')[0])) {
    url.searchParams.set('__anyboxProductId', productId)
    url.searchParams.set('__anyboxInstanceId', connection.instanceId)
    url.searchParams.set('__anyboxConnectionRevision', String(connection.revision))
  }
  return url.pathname + url.search
}
export function connectionResourceURL(sessionId: string, path: string): string {
  const ref = splitScopedId(sessionId)
  if (!ref) return `/api/v1${path}` // Browser fixtures and retained legacy previews only; no remote fallback.
  const connection = configured.get(ref.instanceId)
  if (!connection) return '/unavailable-resource'
  let mismatch = false
  const clean = path.split('/').map(part => { const id = splitScopedId(decodeURIComponent(part)); if (id && id.instanceId !== ref.instanceId) mismatch = true; return id ? encodeURIComponent(id.id) : part }).join('/')
  if (mismatch) return '/unavailable-resource'
  return resourceURL(connection, clean, resourceProducts.get(ref.instanceId) ?? 'agent')
}
export interface HarnessClient extends Api {
  readonly connections: readonly HarnessConnection[]
  readonly errors: ReadonlyMap<string, string>
  subscribeList(path: string, listener: (values: readonly unknown[]) => void): () => void
  forConnection(id: string): Api
  directoryTarget(id?: string): ProjectDirectoryTarget | undefined
  resource(path: string): string
  upload(sessionId: string, file: File, signal: AbortSignal): Promise<ImageRef>
  changes(handlers: { refresh(id: string): void; view(snapshot: ProtocolViewSnapshot): void; connected(ids: readonly string[], value: boolean): void }): { update(ids: readonly string[]): void; dispose(): void }
  dispose(): Promise<void>
}
/** A selector holds this immutable binding until it closes, including its final write. */
export interface ProjectDirectoryTarget {
  readonly connection: HarnessConnection
  readonly api: Api
  nativeAvailable(signal: AbortSignal): Promise<boolean>
  pickNative(signal: AbortSignal): Promise<string | null>
  register(path: string, signal: AbortSignal): Promise<ProjectView>
}
export function createHarnessClient(inputConnections: readonly HarnessConnection[], selectedId?: string, productId = 'agent'): HarnessClient {
  const connections = inputConnections.map(connection => Object.freeze({ ...connection }))
  for (const connection of connections) { configured.set(connection.instanceId, connection); resourceProducts.set(connection.instanceId, productId) }
  const errors = new Map<string, string>(), cache = new Map<string, unknown[]>(), requests = new Set<AbortController>(), streams = new Set<() => void>()
  const writes = new Set<AbortController>(), exits = new Map<AbortController, Promise<void>>()
  const listListeners = new Map<string, Set<(values: readonly unknown[]) => void>>(), revisions = new Map<string, number>()
  let disposed = false
  const selected = () => selectedId === undefined ? connections[0] : connections.find(item => item.id === selectedId)
  const call = async <T>(connection: HarnessConnection, path: string, body?: object, signal?: AbortSignal, pinned = false, local = false): Promise<T> => {
    if (disposed) throw new Error('client-disposed')
    const controller = new AbortController(); requests.add(controller)
    let finish!: () => void
    exits.set(controller, new Promise<void>(resolve => { finish = resolve }))
    if (body !== undefined) writes.add(controller)
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    try {
      const headers = connectionHeaders(connection, local ? undefined : productId)
      const result = await requestJSON<T>(local ? `/api/client/v1${path}` : `/api/connections/${encodeURIComponent(connection.id)}/v1${path}`, body, controller.signal, headers)
      errors.delete(connection.id); return result
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'connection-unavailable'
      if (!controller.signal.aborted && ['connection-unavailable', 'connection-changed', 'authentication-failed', 'credential-unavailable', 'instance-mismatch', 'version-incompatible', 'service-unavailable'].includes(code)) errors.set(connection.id, code)
      throw error
    }
    finally { requests.delete(controller); writes.delete(controller); exits.delete(controller); finish(); signal?.removeEventListener('abort', abort) }
  }
  const route = (path: string, body?: object) => {
    const instances = new Set<string>()
    const unwrap = (value: string) => { const ref = splitScopedId(value); if (!ref) return value; instances.add(ref.instanceId); return ref.id }
    const url = new URL(path, 'http://client.invalid')
    const pathname = url.pathname.split('/').map(part => encodeURIComponent(unwrap(decodeURIComponent(part)))).join('/')
    const params = new URLSearchParams(); for (const [key, value] of url.searchParams) params.append(key, identityKeys.has(key) ? unwrap(value) : value)
    const payload = mapResourceIds(body, unwrap) as object | undefined
    if (instances.size > 1) throw Object.assign(new Error('cross-instance-input'), { status: 409, code: 'cross-instance-input' })
    const instanceId = [...instances][0]
    const connection = instanceId ? connections.find(item => item.instanceId === instanceId) : selected()
    if (!connection || (!instanceId && /^\/(sessions\/|runs\/|projects\/[^/]+\/sessions)/.test(path))) throw Object.assign(new Error('instance-unavailable'), { status: 409, code: 'instance-unavailable' })
    return { connection, path: pathname + (params.size ? `?${params}` : ''), body: payload }
  }
  const listSnapshot = (path: string) => connections.flatMap(connection => (cache.get(`${connection.id}:${path}`) ?? []).map(value => {
    const mapped = mapResourceIds(value, id => scopedId(connection.instanceId, id)) as Record<string, unknown>
    if (path === '/projects') return { ...mapped, harnessName: connection.name, instanceId: connection.instanceId, available: !errors.has(connection.id) && mapped.available }
    return path === '/agents' ? { ...mapped, harnessName: connection.name } : mapped
  }))
  const aggregate = async (path: string, signal?: AbortSignal) => {
    await Promise.all(connections.map(async connection => {
      const key = `${connection.id}:${path}`, revision = (revisions.get(key) ?? 0) + 1; revisions.set(key, revision)
      try { const values = await call<unknown[]>(connection, path, undefined, signal); if (revisions.get(key) === revision) cache.set(key, values) }
      catch { if (signal?.aborted) signal.throwIfAborted() }
      if (!disposed && revisions.get(key) === revision) for (const listener of listListeners.get(path) ?? []) listener(listSnapshot(path))
    }))
    return listSnapshot(path)
  }
  const api = (async <T>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
    if (disposed) throw new Error('client-disposed')
    if (!body && ['/projects', '/agents', '/models', '/models/connections', '/sessions/archived'].includes(path)) return await aggregate(path, signal) as T
    const target = route(path, body)
    return mapResourceIds(await call(target.connection, target.path, target.body, signal), id => scopedId(target.connection.instanceId, id)) as T
  }) as HarnessClient
  Object.assign(api, {
    connections, errors,
    subscribeList(path: string, listener: (values: readonly unknown[]) => void) {
      const set = listListeners.get(path) ?? new Set(); listListeners.set(path, set); set.add(listener)
      return () => { set.delete(listener) }
    },
    forConnection(id: string): Api {
      const connection = connections.find(item => item.id === id)
      return <T>(path: string, body?: object, signal?: AbortSignal) => connection ? call<T>(connection, path, body, signal) : Promise.reject(new Error('instance-unavailable'))
    },
    directoryTarget(id?: string): ProjectDirectoryTarget | undefined {
      const value = id ? connections.find(item => item.id === id) : selected()
      if (!value || disposed) return undefined
      const connection = Object.freeze({ ...value })
      const fixed: Api = (path, body, signal) => call(connection, path, body, signal, true)
      return {
        connection, api: fixed,
        async nativeAvailable(signal) {
          const local = await call<{ instanceId: string | null; picker: boolean }>(connection, '/local', undefined, signal, false, true)
          return local.picker && local.instanceId === connection.instanceId
        },
        async pickNative(signal) {
          return (await call<{ path: string | null }>(connection, `/connections/${encodeURIComponent(connection.id)}/pick`, {}, signal, true, true)).path
        },
        async register(path, signal) {
          const raw = await fixed<ProjectView>('/projects', { path }, signal)
          const key = `${connection.id}:/projects`
          cache.set(key, [...(cache.get(key) ?? []).filter(value => (value as ProjectView).id !== raw.id), raw])
          const project = mapResourceIds(raw, id => scopedId(connection.instanceId, id)) as ProjectView
          return { ...project, instanceId: connection.instanceId, harnessName: connection.name }
        },
      }
    },
    resource(path: string) { const target = route(path); return resourceURL(target.connection, target.path, productId) },
    async upload(sessionId: string, file: File, signal: AbortSignal): Promise<ImageRef> {
      const target = route(`/sessions/${encodeURIComponent(sessionId)}/images`)
      if (disposed) throw new Error('client-disposed')
      const controller = new AbortController(); requests.add(controller)
      writes.add(controller)
      let finish!: () => void
      exits.set(controller, new Promise<void>(resolve => { finish = resolve }))
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      try {
      const response = await fetch(`/api/connections/${target.connection.id}/v1${target.path}`, { method: 'POST', headers: { ...connectionHeaders(target.connection, productId), 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal })
      const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data?.error?.code ?? 'upload-failed'), { status: response.status, code: data?.error?.code })
      return mapResourceIds(data, id => scopedId(target.connection.instanceId, id)) as ImageRef
      } finally { requests.delete(controller); writes.delete(controller); exits.delete(controller); finish(); signal.removeEventListener('abort', abort) }
    },
    changes(handlers: Parameters<HarnessClient['changes']>[0]) {
      const groups = connections.map(connection => {
        let ids: readonly string[] = []
        const qualify = (value: string) => scopedId(connection.instanceId, value)
        const change = createRunChangeClient({
          open(url, callbacks) {
            return openChangeStream(`/api/connections/${connection.id}/v1${url.slice('/api/v1'.length)}`, connectionHeaders(connection, productId), callbacks)
          },
          refresh: id => handlers.refresh(qualify(id)),
          view: snapshot => handlers.view(mapResourceIds(snapshot, qualify) as ProtocolViewSnapshot),
          connected: value => handlers.connected(ids.map(qualify), value),
        })
        return { update(all: readonly string[]) { ids = all.flatMap(id => { const ref = splitScopedId(id); return ref?.instanceId === connection.instanceId ? [ref.id] : [] }); change.update(ids) }, dispose: () => change.dispose() }
      })
      const dispose = () => { groups.forEach(group => group.dispose()); streams.delete(dispose) }; streams.add(dispose)
      return { update: (ids: readonly string[]) => groups.forEach(group => group.update(ids)), dispose }
    },
    async dispose() { disposed = true; listListeners.clear(); for (const controller of requests) if (!writes.has(controller)) controller.abort(); for (const close of [...streams]) close(); await Promise.allSettled([...exits.values()]) },
  })
  return api
}

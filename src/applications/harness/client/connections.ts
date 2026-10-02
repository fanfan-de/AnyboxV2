import { randomUUID } from 'node:crypto'
import { AsyncEntry } from '@napi-rs/keyring'
import type { Component } from '@nya/core'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import type { SystemKeyringStore, SystemKeyringOptions } from '@anybox/api-key-manager'
import { localStorageServiceKey } from '../../../storage/port.js'
import type { LocalStoragePort, StorageMigration } from '../../../storage/port.js'
import { hostFailure } from '../../../host/access.js'
import type { InstanceInfo } from '../../../host/access.js'

export const connectionsServiceKey = 'client.connections'
export interface Connection { readonly id: string; readonly name: string; readonly endpoint: string; readonly instanceId: string; readonly revision: number; readonly credentialConfigured: boolean }
interface Stored extends Omit<Connection, 'credentialConfigured'> { readonly credentialRef: string }
export interface ConnectionInput { readonly id?: string; readonly name: string; readonly endpoint: string; readonly token?: string; readonly expectedRevision?: number }
export interface ConnectionLease { readonly connection: Connection; readonly token: string }
export interface ConnectionsPort {
  list(): Promise<readonly Connection[]>
  save(input: ConnectionInput, signal?: AbortSignal): Promise<Connection>
  remove(id: string, revision: number): Promise<void>
  acquire(id: string): Promise<ConnectionLease>
  check(id: string, signal?: AbortSignal): Promise<InstanceInfo>
}
const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE client_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  tx.execute('CREATE TABLE client_credential_intents (id TEXT PRIMARY KEY)')
} }]
export function connectionEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/$/, '')
  } catch { throw hostFailure('invalid-endpoint') }
}
const view = ({ credentialRef: _, ...record }: Stored): Connection => Object.freeze({ ...record, credentialConfigured: true })
export async function inspectInstance(endpoint: string, token: string, signal: AbortSignal, fetcher = globalThis.fetch): Promise<InstanceInfo> {
  let response: Response
  try { response = await fetcher(`${endpoint}/api/v1/instance`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal }) }
  catch { throw hostFailure(signal.aborted ? 'cancelled' : 'connection-unavailable', 503) }
  try {
    if (!response.ok) throw hostFailure(response.status === 401 ? 'authentication-failed' : 'connection-unavailable', response.status === 401 ? 401 : 503)
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
    if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw hostFailure('invalid-instance', 502); chunks.push(part.value) } } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as InstanceInfo
    if (value.apiVersion !== 1) throw hostFailure('version-incompatible', 409)
    if (typeof value.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.instanceId) || typeof value.name !== 'string' || !Array.isArray(value.capabilities) || value.capabilities.some(x => typeof x !== 'string')) throw hostFailure('invalid-instance', 502)
    return value
  } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}
export function createConnectionsComponent(options: { namespace?: string; openEntry?: SystemKeyringOptions['openEntry']; fetch?: typeof fetch } = {}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'client-connections', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]; await db.migrate('client-connections', migrations)
    let vault: SystemKeyringStore | undefined, accepting = true, tail: Promise<unknown> = Promise.resolve()
    const controllers = new Set<AbortController>(), pending = new Set<Promise<unknown>>()
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      const result = work(); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const secrets = () => vault ??= createSystemKeyringStore({ namespace: options.namespace ?? 'anybox.client', openEntry: options.openEntry ?? ((service, id) => {
      const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } })
      // Wait for native completion even when the managed operation is cancelled.
      return { getPassword: () => entry.getPassword(), setPassword: value => entry.setPassword(value), deleteCredential: () => entry.deleteCredential() }
    }) })
    const credential = async <T>(work: (store: SystemKeyringStore) => Promise<T>): Promise<T> => {
      try { return await work(secrets()) } catch { throw hostFailure('credential-unavailable', 503) }
    }
    const queue = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      const result = tail.then(() => { if (!accepting) throw hostFailure('service-unavailable', 503); return work() })
      tail = result.catch(() => {}); return result
    }
    const get = async (id: string): Promise<Stored> => {
      const row = await db.read(r => r.get('SELECT record FROM client_connections WHERE id=?', [id]))
      if (!row) throw hostFailure('not-found', 404)
      return JSON.parse(String(row.record)) as Stored
    }
    const tokenFor = async (record: Stored) => {
      const token = await credential(store => store.read(record.credentialRef))
      if (!token) throw hostFailure('credential-unavailable', 503)
      return token
    }
    const cleanup = async () => {
      const rows = await db.read(r => r.all('SELECT id FROM client_credential_intents'))
      for (const row of rows) try {
        await credential(store => store.delete(String(row.id)))
        await db.transaction(tx => { tx.execute('DELETE FROM client_credential_intents WHERE id=?', [row.id]) })
      } catch { /* Durable intent is retried on the next edit/start. */ }
    }
    const inspect = async (endpoint: string, token: string, signal?: AbortSignal) => {
      const controller = new AbortController(); controllers.add(controller)
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(), 15000)
      try { return await inspectInstance(endpoint, token, controller.signal, options.fetch) }
      finally { clearTimeout(timer); controllers.delete(controller); signal?.removeEventListener('abort', abort) }
    }
    const service: ConnectionsPort = {
      list: () => queue(async () => (await db.read(r => r.all('SELECT record FROM client_connections ORDER BY id'))).map(row => view(JSON.parse(String(row.record))))),
      acquire: id => queue(async () => { const record = await get(id); return { connection: view(record), token: await tokenFor(record) } }),
      check: (id, signal) => track(async () => {
        const lease = await service.acquire(id)
        if (!accepting) throw hostFailure('service-unavailable', 503)
        const info = await inspect(lease.connection.endpoint, lease.token, signal)
        if (info.instanceId !== lease.connection.instanceId) throw hostFailure('instance-mismatch', 409)
        return info
      }),
      save: (input, signal) => track(async () => {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || typeof input.endpoint !== 'string') throw hostFailure('invalid-input')
        const endpoint = connectionEndpoint(input.endpoint)
        const { previous, token } = await queue(async () => {
          const previous = input.id ? await get(input.id) : undefined
          return { previous, token: input.token ?? (previous ? await tokenFor(previous) : '') }
        })
        if (previous && previous.revision !== input.expectedRevision) throw hostFailure('conflict', 409)
        if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw hostFailure('invalid-token')
        const info = await inspect(endpoint, token, signal)
        if (previous && previous.instanceId !== info.instanceId) throw hostFailure('instance-mismatch', 409)
        return queue(async () => {
        signal?.throwIfAborted()
        if (previous && (await get(previous.id)).revision !== previous.revision) throw hostFailure('conflict', 409)
        const duplicates = await db.read(r => r.all('SELECT record FROM client_connections'))
        if (duplicates.some(row => { const other = JSON.parse(String(row.record)); return other.id !== previous?.id && other.instanceId === info.instanceId })) throw hostFailure('instance-already-connected', 409)
        const ref = input.token !== undefined || !previous ? randomUUID() : previous.credentialRef
        const record: Stored = { id: previous?.id ?? randomUUID(), name: input.name.trim(), endpoint, instanceId: info.instanceId, revision: (previous?.revision ?? 0) + 1, credentialRef: ref }
        if (ref !== previous?.credentialRef) {
          await db.transaction(tx => { tx.execute('INSERT INTO client_credential_intents VALUES(?)', [ref]) })
          try { await credential(store => store.write(ref, token)) } catch (error) { await cleanup(); throw error }
        }
        try {
          await db.transaction(tx => {
            tx.execute('INSERT INTO client_connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', [record.id, JSON.stringify(record)])
            tx.execute('DELETE FROM client_credential_intents WHERE id=?', [ref])
            if (previous && previous.credentialRef !== ref) tx.execute('INSERT INTO client_credential_intents VALUES(?)', [previous.credentialRef])
          })
        } catch (error) { await cleanup(); throw error }
        await cleanup(); return view(record)
        })
      }),
      remove: (id, revision) => queue(async () => {
        const record = await get(id); if (record.revision !== revision) throw hostFailure('conflict', 409)
        await db.transaction(tx => { tx.execute('DELETE FROM client_connections WHERE id=?', [id]); tx.execute('INSERT INTO client_credential_intents VALUES(?)', [record.credentialRef]) })
        await cleanup()
      }),
    }
    await cleanup()
    ctx.effect(() => async () => { accepting = false; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); await tail; await vault?.close() }, 'cancel and join client connection operations')
    ctx.provide(connectionsServiceKey, service)
  } }
}

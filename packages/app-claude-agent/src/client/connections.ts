import { randomUUID } from 'node:crypto'
import { AsyncEntry } from '@napi-rs/keyring'
import type { Component } from '@nya/core'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import type { SystemKeyringStore, SystemKeyringOptions } from '@anybox/api-key-manager'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration } from '@anybox/storage-sqlite/port'
import { hostFailure } from './connection-failure.js'
import type { InstanceInfo } from './connection-failure.js'

export const connectionsServiceKey = 'claude-agent.connections'
export interface Connection { readonly id: string; readonly name: string; readonly endpoint: string; readonly instanceId: string; readonly revision: number; readonly credentialConfigured: boolean }
interface Stored extends Omit<Connection, 'credentialConfigured'> { readonly credentialRef: string; readonly legacyCredentialRef?: string }
export interface ConnectionInput { readonly id?: string; readonly name: string; readonly endpoint: string; readonly token?: string; readonly expectedRevision?: number }
export interface ConnectionLease { readonly connection: Connection; readonly token: string }
/** Trusted desktop callbacks. Tokens never appear in the public pairing projection. */
export interface DesktopLocalPairingOptions {
  /** Read-only: undefined means the desktop has not started a local server. */
  getLocal(signal: AbortSignal): Promise<{ readonly endpoint: string; readonly instanceId: string } | undefined>
  /** Called only by an explicit retry/start action, never by bootstrap or status reads. */
  start?(signal: AbortSignal): Promise<void>
  issue(signal: AbortSignal): Promise<string>
  reconcile(retainedToken: string | undefined, signal: AbortSignal): Promise<void>
}
export interface LocalPairingStatus {
  readonly enabled: boolean
  readonly state: 'disabled' | 'pending' | 'ready' | 'failed'
  readonly instanceId: string | null
  readonly connectionId: string | null
  readonly connectionRevision?: number
  readonly error?: { readonly code: string }
}
export interface ConnectionsPort {
  list(): Promise<readonly Connection[]>
  save(input: ConnectionInput, signal?: AbortSignal): Promise<Connection>
  remove(id: string, revision: number): Promise<void>
  acquire(id: string): Promise<ConnectionLease>
  check(id: string, signal?: AbortSignal): Promise<InstanceInfo>
  localStatus(): LocalPairingStatus
  retryLocal(signal?: AbortSignal): Promise<LocalPairingStatus>
}
// The former shared tables are a read-only import source. Each application keeps its own copy.
const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE claude_agent_client_connections (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  tx.execute('CREATE TABLE claude_agent_client_credential_intents (id TEXT PRIMARY KEY)')
  if (tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='client_connections'")) {
    for (const row of tx.all('SELECT record FROM client_connections')) {
      const previous = JSON.parse(String(row.record)) as Stored
      const record: Stored = { ...previous, credentialRef: randomUUID(), legacyCredentialRef: previous.credentialRef }
      tx.execute('INSERT INTO claude_agent_client_connections VALUES(?,?)', [record.id, JSON.stringify(record)])
    }
  }
} }, { version: 2, up(tx) {
  tx.execute('CREATE TABLE claude_agent_client_local_connection (slot INTEGER PRIMARY KEY CHECK(slot=1), connection_id TEXT NOT NULL, instance_id TEXT NOT NULL)')
  if (tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='client_local_connection'")) {
    tx.execute('INSERT INTO claude_agent_client_local_connection SELECT * FROM client_local_connection')
  }
} }]
export function connectionEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/$/, '')
  } catch { throw hostFailure('invalid-endpoint') }
}
const view = ({ credentialRef: _, legacyCredentialRef: _legacy, ...record }: Stored): Connection => Object.freeze({ ...record, credentialConfigured: true })
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
/** Private claude-agent connection configuration; its runtime owns storage, credentials and network operations. */
export interface ClientConnectionsOptions {
  readonly namespace?: string
  readonly openEntry?: SystemKeyringOptions['openEntry']
  readonly fetch?: typeof fetch
  readonly localPairing?: DesktopLocalPairingOptions
}
export function createConnectionsComponent(options: ClientConnectionsOptions = {}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'claude-agent-client-connections', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]; await db.migrate('claude-agent-client-connections', migrations)
    let vault: SystemKeyringStore | undefined, legacyVault: SystemKeyringStore | undefined, accepting = true, tail: Promise<unknown> = Promise.resolve()
    let local: LocalPairingStatus = Object.freeze({ enabled: !!options.localPairing, state: options.localPairing ? 'pending' : 'disabled', instanceId: null, connectionId: null })
    let pairing: Promise<LocalPairingStatus> | undefined
    let pairingStartsService = false
    let requestedStart: Promise<LocalPairingStatus> | undefined
    const controllers = new Set<AbortController>(), pending = new Set<Promise<unknown>>()
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      const result = work(); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const openVault = (namespace: string) => createSystemKeyringStore({ namespace, openEntry: options.openEntry ?? ((service, id) => {
      const entry = new AsyncEntry(service, id, { linux: { store: 'secret-service' } })
      return { getPassword: () => entry.getPassword(), setPassword: value => entry.setPassword(value), deleteCredential: () => entry.deleteCredential() }
    }) })
    const secrets = () => vault ??= openVault(`${options.namespace ?? 'anybox.client'}.claude-agent`)
    const legacySecrets = () => legacyVault ??= openVault(options.namespace ?? 'anybox.client')
    const credential = async <T>(work: (store: SystemKeyringStore) => Promise<T>): Promise<T> => {
      try { return await work(secrets()) } catch { throw hostFailure('credential-unavailable', 503) }
    }
    const queue = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      const result = tail.then(() => { if (!accepting) throw hostFailure('service-unavailable', 503); return work() })
      tail = result.catch(() => {}); return result
    }
    const get = async (id: string): Promise<Stored> => {
      const row = await db.read(r => r.get('SELECT record FROM claude_agent_client_connections WHERE id=?', [id]))
      if (!row) throw hostFailure('not-found', 404)
      return JSON.parse(String(row.record)) as Stored
    }
    // Import only this application's credential on first use. Never edit or delete a legacy shared entry.
    const tokenFor = async (record: Stored) => {
      if (record.legacyCredentialRef) {
        let token: string | undefined
        try { token = await legacySecrets().read(record.legacyCredentialRef) } catch { throw hostFailure('credential-unavailable', 503) }
        if (!token) throw hostFailure('credential-unavailable', 503)
        await db.transaction(tx => { tx.execute('INSERT OR IGNORE INTO claude_agent_client_credential_intents VALUES(?)', [record.credentialRef]) })
        try {
          await credential(store => store.write(record.credentialRef, token!))
          const { legacyCredentialRef: _, ...owned } = record
          await db.transaction(tx => {
            tx.execute('UPDATE claude_agent_client_connections SET record=? WHERE id=?', [JSON.stringify(owned), record.id])
            tx.execute('DELETE FROM claude_agent_client_credential_intents WHERE id=?', [record.credentialRef])
          })
        } catch (error) { await cleanup(); throw error }
        return token
      }
      const token = await credential(store => store.read(record.credentialRef))
      if (!token) throw hostFailure('credential-unavailable', 503)
      return token
    }
    const cleanup = async () => {
      const rows = await db.read(r => r.all('SELECT id FROM claude_agent_client_credential_intents'))
      for (const row of rows) try {
        await credential(store => store.delete(String(row.id)))
        await db.transaction(tx => { tx.execute('DELETE FROM claude_agent_client_credential_intents WHERE id=?', [row.id]) })
      } catch { /* Durable intent is retried on the next edit/start. */ }
    }
    const inspect = async (endpoint: string, token: string, signal?: AbortSignal) => {
      const controller = new AbortController(); controllers.add(controller)
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(), 15000)
      try { return await inspectInstance(endpoint, token, controller.signal, options.fetch) }
      finally { clearTimeout(timer); controllers.delete(controller); signal?.removeEventListener('abort', abort) }
    }
    const save = (input: ConnectionInput, signal?: AbortSignal, ownedInstanceId?: string): Promise<Connection> => track(async () => {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || typeof input.endpoint !== 'string') throw hostFailure('invalid-input')
        const endpoint = connectionEndpoint(input.endpoint)
        const { previous, token } = await queue(async () => {
          const previous = input.id ? await get(input.id) : undefined
          return { previous, token: input.token ?? (previous ? await tokenFor(previous) : '') }
        })
        if (previous && previous.revision !== input.expectedRevision) throw hostFailure('conflict', 409)
        if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw hostFailure('invalid-token')
        const info = await inspect(endpoint, token, signal)
        if (ownedInstanceId !== undefined && info.instanceId !== ownedInstanceId) throw hostFailure('instance-mismatch', 409)
        if (previous && previous.instanceId !== info.instanceId) throw hostFailure('instance-mismatch', 409)
        return queue(async () => {
        signal?.throwIfAborted()
        if (previous && (await get(previous.id)).revision !== previous.revision) throw hostFailure('conflict', 409)
        const duplicates = await db.read(r => r.all('SELECT record FROM claude_agent_client_connections'))
        if (duplicates.some(row => { const other = JSON.parse(String(row.record)); return other.id !== previous?.id && other.instanceId === info.instanceId })) throw hostFailure('instance-already-connected', 409)
        const ref = input.token !== undefined || !previous ? randomUUID() : previous.credentialRef
        const record: Stored = { id: previous?.id ?? randomUUID(), name: input.name.trim(), endpoint, instanceId: info.instanceId, revision: (previous?.revision ?? 0) + 1, credentialRef: ref }
        if (ref !== previous?.credentialRef) {
          await db.transaction(tx => { tx.execute('INSERT INTO claude_agent_client_credential_intents VALUES(?)', [ref]) })
          try { await credential(store => store.write(ref, token)) } catch (error) { await cleanup(); throw error }
        }
        try {
          await db.transaction(tx => {
            tx.execute('INSERT INTO claude_agent_client_connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', [record.id, JSON.stringify(record)])
            if (ownedInstanceId !== undefined) tx.execute('INSERT INTO claude_agent_client_local_connection VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET connection_id=excluded.connection_id, instance_id=excluded.instance_id', [record.id, record.instanceId])
            tx.execute('DELETE FROM claude_agent_client_credential_intents WHERE id=?', [ref])
            if (previous && previous.credentialRef !== ref) tx.execute('INSERT INTO claude_agent_client_credential_intents VALUES(?)', [previous.credentialRef])
          })
        } catch (error) { await cleanup(); throw error }
        await cleanup()
        if (local.state === 'ready' && local.connectionId === record.id) local = Object.freeze({ ...local, connectionRevision: record.revision })
        return view(record)
        })
      })
    const retainLocal = (connection: Connection, signal: AbortSignal) => queue(async () => {
      if ((await get(connection.id)).revision !== connection.revision) throw hostFailure('conflict', 409)
      const token = await tokenFor(await get(connection.id))
      signal.throwIfAborted()
      await db.transaction(tx => {
        tx.execute('INSERT INTO claude_agent_client_local_connection VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET connection_id=excluded.connection_id, instance_id=excluded.instance_id', [connection.id, connection.instanceId])
      })
      await options.localPairing!.reconcile(token, signal)
    })
    const ensureLocal = async (signal: AbortSignal, start: boolean): Promise<LocalPairingStatus> => {
      const pair = options.localPairing!
      let issued: string | undefined, committed = false, previouslyRetained: string | undefined
      try {
        signal.throwIfAborted()
        if (start) { await pair.start?.(signal); signal.throwIfAborted() }
        const target = await pair.getLocal(signal); signal.throwIfAborted()
        if (!target) {
          local = Object.freeze({ enabled: true, state: 'disabled', instanceId: null, connectionId: null })
          return local
        }
        const endpoint = connectionEndpoint(target.endpoint)
        if (!/^[0-9a-f-]{36}$/.test(target.instanceId)) throw hostFailure('invalid-instance', 502)
        const owner = await queue(() => db.read(r => r.get('SELECT connection_id,instance_id FROM claude_agent_client_local_connection WHERE slot=1')))
        if (owner && owner.instance_id !== target.instanceId) throw hostFailure('instance-mismatch', 409)
        const records = await service.list()
        const previous = (owner ? records.find(item => item.id === owner.connection_id) : undefined) ?? records.find(item => item.instanceId === target.instanceId)
        if (previous && previous.instanceId !== target.instanceId) throw hostFailure('instance-mismatch', 409)
        local = Object.freeze({ enabled: true, state: 'pending', instanceId: target.instanceId, connectionId: previous?.id ?? null })
        let saved: Connection
        if (previous) {
          // Read before reconciling: a locked Vault must not revoke a valid retained token.
          const lease = await service.acquire(previous.id)
          previouslyRetained = lease.token
          try {
            const info = await inspect(endpoint, lease.token, signal)
            if (info.instanceId !== target.instanceId) throw hostFailure('instance-mismatch', 409)
            saved = previous.endpoint === endpoint ? previous : await save({ ...previous, endpoint, expectedRevision: previous.revision }, signal, target.instanceId)
            await retainLocal(saved, signal)
          } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || !['authentication-failed', 'invalid-managed-token'].includes(String(error.code))) throw error
            // A revoked or unmanaged retained token cannot be retained by the host's managed ledger.
            // Reconciliation only removes desktop-owned tokens, leaving unrelated credentials alone.
            previouslyRetained = undefined
            issued = await pair.issue(signal); signal.throwIfAborted()
            saved = await save({ ...previous, endpoint, token: issued, expectedRevision: previous.revision }, signal, target.instanceId)
            committed = true
            await retainLocal(saved, signal)
          }
        } else {
          await pair.reconcile(undefined, signal); signal.throwIfAborted()
          issued = await pair.issue(signal); signal.throwIfAborted()
          saved = await save({ name: '本机', endpoint, token: issued }, signal, target.instanceId)
          committed = true
          await retainLocal(saved, signal)
        }
        local = Object.freeze({ enabled: true, state: 'ready', instanceId: target.instanceId, connectionId: saved.id, connectionRevision: saved.revision })
      } catch (error) {
        // A failed save has no retained credential. If cancellation interrupts this cleanup,
        // the host's durable managed ownership is reconciled on the next attempt.
        if (issued && !committed) await pair.reconcile(previouslyRetained, signal).catch(() => {})
        const code = signal.aborted ? 'cancelled' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : 'connection-unavailable'
        local = Object.freeze({ ...local, state: 'failed', error: Object.freeze({ code }) })
      }
      return local
    }
    const pairLocal = (signal: AbortSignal | undefined, start: boolean): Promise<LocalPairingStatus> => {
      if (!options.localPairing) return Promise.reject(hostFailure('local-pairing-unavailable', 403))
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      if (pairing) {
        if (start && !pairingStartsService && options.localPairing.start) {
          return requestedStart ??= pairing.then(() => pairLocal(signal, true)).finally(() => { requestedStart = undefined })
        }
        return pairing
      }
      const controller = new AbortController(); controllers.add(controller)
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      local = Object.freeze({ enabled: true, state: 'pending', instanceId: local.instanceId, connectionId: local.connectionId })
      pairingStartsService = start
      const result = track(() => ensureLocal(controller.signal, start)).finally(() => {
        controllers.delete(controller); signal?.removeEventListener('abort', abort); pairing = undefined
      })
      pairing = result
      return result
    }
    const service: ConnectionsPort = {
      list: () => queue(async () => (await db.read(r => r.all('SELECT record FROM claude_agent_client_connections ORDER BY id'))).map(row => view(JSON.parse(String(row.record))))),
      acquire: id => queue(async () => { const record = await get(id); return { connection: view(record), token: await tokenFor(record) } }),
      check: (id, signal) => track(async () => {
        const lease = await service.acquire(id)
        if (!accepting) throw hostFailure('service-unavailable', 503)
        const info = await inspect(lease.connection.endpoint, lease.token, signal)
        if (info.instanceId !== lease.connection.instanceId) throw hostFailure('instance-mismatch', 409)
        return info
      }),
      save,
      localStatus: () => local,
      retryLocal: signal => pairLocal(signal, true),
      remove: (id, revision) => queue(async () => {
        const record = await get(id); if (record.revision !== revision) throw hostFailure('conflict', 409)
        await db.transaction(tx => { tx.execute('DELETE FROM claude_agent_client_connections WHERE id=?', [id]); tx.execute('INSERT INTO claude_agent_client_credential_intents VALUES(?)', [record.credentialRef]) })
        if (local.enabled && local.connectionId === id) local = Object.freeze({ ...local, state: 'failed', error: Object.freeze({ code: 'local-connection-removed' }) })
        await cleanup()
      }),
    }
    await cleanup()
    ctx.effect(() => async () => { accepting = false; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); await tail; await Promise.all([vault?.close(), legacyVault?.close()]) }, 'cancel and join client connection operations')
    ctx.provide(connectionsServiceKey, service)
    // Bootstrap is owned by this component generation and never holds up application readiness.
    if (options.localPairing) void Promise.resolve().then(() => pairLocal(undefined, false)).catch(() => {})
  } }
}

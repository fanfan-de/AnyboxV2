import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Component } from '@nya/core'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration } from '../storage/port.js'

export const hostAccessServiceKey = 'host.access'
export interface InstanceInfo { readonly instanceId: string; readonly name: string; readonly apiVersion: 1; readonly capabilities: readonly string[] }
export interface AccessToken { readonly id: string; readonly name: string; readonly createdAt: string; readonly revokedAt: string | null }
export interface HostAccessPort {
  readonly instance: InstanceInfo
  authenticate(authorization: string | undefined): string
  list(): Promise<readonly AccessToken[]>
  issue(name: string): Promise<{ readonly token: string; readonly record: AccessToken }>
  revoke(id: string): Promise<void>
  resetIdentity(): Promise<InstanceInfo>
  onRevoked(listener: (id: string) => void): () => void
}
export function hostFailure(code: string, status = 400): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status })
}
const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE host_identity (id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL)')
  tx.execute('CREATE TABLE host_access_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)')
} }]
const hash = (value: string) => createHash('sha256').update(value).digest()
export function createHostAccessComponent(name = 'Anybox'): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'host-access', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]
    await db.migrate('host-access', migrations)
    let instanceId = await db.transaction(tx => {
      const existing = tx.get('SELECT instance_id FROM host_identity WHERE id=1')
      if (existing) return String(existing.instance_id)
      const id = randomUUID(); tx.execute('INSERT INTO host_identity VALUES(1,?)', [id]); return id
    })
    const tokens = new Map((await db.read(r => r.all('SELECT id,digest FROM host_access_tokens WHERE revoked_at IS NULL'))).map(row => [String(row.id), String(row.digest)]))
    const listeners = new Set<(id: string) => void>()
    const pending = new Set<Promise<unknown>>()
    let accepting = true
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(hostFailure('service-unavailable', 503))
      const result = work(); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const revoked = (id: string) => { for (const listener of listeners) { try { listener(id) } catch { /* Observers cannot undo a committed revocation. */ } } }
    const info = (): InstanceInfo => Object.freeze({ instanceId, name, apiVersion: 1, capabilities: Object.freeze(['tokens']) })
    const service: HostAccessPort = {
      get instance() { return info() },
      authenticate(authorization) {
        if (!accepting) throw hostFailure('service-unavailable', 503)
        const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')
        const digest = match && tokens.get(match[1])
        if (!match || !digest || !timingSafeEqual(hash(match[2]), Buffer.from(digest, 'hex'))) throw hostFailure('authentication-failed', 401)
        return match[1]
      },
      list: () => track(async () => (await db.read(r => r.all('SELECT id,name,created_at,revoked_at FROM host_access_tokens ORDER BY created_at,id'))).map(row => ({ id: String(row.id), name: String(row.name), createdAt: String(row.created_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at) }))),
      issue(name) {
        return track(async () => {
          if (typeof name !== 'string' || !name.trim() || name.length > 200) throw hostFailure('invalid-input')
          const secret = randomBytes(32).toString('base64url'), id = randomUUID(), digest = hash(secret).toString('hex')
          const record: AccessToken = { id, name: name.trim(), createdAt: new Date().toISOString(), revokedAt: null }
          await db.transaction(tx => { tx.execute('INSERT INTO host_access_tokens VALUES(?,?,?,?,NULL)', [id, record.name, digest, record.createdAt]) })
          tokens.set(id, digest)
          return { token: `${id}.${secret}`, record }
        })
      },
      revoke(id) { return track(async () => {
        await db.transaction(tx => { tx.execute('UPDATE host_access_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL', [new Date().toISOString(), id]) })
        tokens.delete(id); revoked(id)
      }) },
      resetIdentity() { return track(async () => {
        const next = randomUUID()
        await db.transaction(tx => { tx.execute('UPDATE host_identity SET instance_id=? WHERE id=1', [next]); tx.execute('UPDATE host_access_tokens SET revoked_at=? WHERE revoked_at IS NULL', [new Date().toISOString()]) })
        instanceId = next; const old = [...tokens.keys()]; tokens.clear(); old.forEach(revoked); return info()
      }) },
      onRevoked(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    ctx.effect(() => async () => { accepting = false; await Promise.allSettled([...pending]); tokens.clear(); listeners.clear() }, 'join host access changes')
    ctx.provide(hostAccessServiceKey, service)
  } }
}

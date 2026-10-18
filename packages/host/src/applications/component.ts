import type { Component } from '@nya/core'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration } from '@anybox/storage-sqlite/port'
import { productActivityServiceKey, productsServiceKey } from '@anybox/application-api'
import type { ActivityFreeze, ApplicationCapabilityStatus, ApplicationRuntime, ProductDefinition, ProductActivityPort, ProductError, ProductsPort, ProductView } from '@anybox/application-api'
import { productFailure } from './domain.js'

function runtimeError(error: unknown): ProductError {
  const phase = error && typeof error === 'object' && 'phase' in error && error.phase === 'cleanup' ? 'cleanup' : 'startup'
  return Object.freeze({ phase, code: phase === 'cleanup' ? 'product-cleanup-failed' : 'product-startup-failed' })
}
interface RecordState {
  definition: ProductDefinition
  desiredEnabled: boolean
  state: ProductView['state']
  error?: ProductError
  runtime?: ApplicationRuntime
  tail: Promise<void>
}
/** Owns per-application durable targets and control queues. */
export function createProductsComponent(options: {
  directory: readonly ProductDefinition[]
  runtime(id: string): ApplicationRuntime | undefined
  capabilities?(id: string): readonly ApplicationCapabilityStatus[]
  restoreLegacyAgent?: boolean
}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [productActivityServiceKey]: ProductActivityPort
}> {
  const migrations: readonly StorageMigration[] = [
    { version: 1, up(tx) {
      const legacy = options.restoreLegacyAgent !== false && tx.get('SELECT version FROM schema_migrations WHERE domain = ?', ['run-state']) !== undefined
      tx.execute('CREATE TABLE app_product_targets (id TEXT PRIMARY KEY, desired_enabled INTEGER NOT NULL)')
      tx.execute('INSERT INTO app_product_targets VALUES(?,?)', ['agent', legacy ? 1 : 0])
    } },
    { version: 2, up(tx) {
      // Combination v1 databases are read only at this migration boundary.
      // Custom combinations are not restored; business data remains in its domains.
      tx.execute('CREATE TABLE IF NOT EXISTS app_product_targets (id TEXT PRIMARY KEY, desired_enabled INTEGER NOT NULL)')
      const legacy = tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='app_products'")
      const row = legacy ? tx.get('SELECT desired_enabled FROM app_products WHERE id=?', ['agent']) : undefined
      tx.execute('INSERT OR IGNORE INTO app_product_targets VALUES(?,?)', ['agent', row?.desired_enabled === 1 ? 1 : 0])
    } },
  ]
  return { name: 'app-products', inject: [localStorageServiceKey, productActivityServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey], activity = deps[productActivityServiceKey]
    const records = new Map<string, RecordState>()
    if (new Set(options.directory.map(item => item.id)).size !== options.directory.length) throw new TypeError('duplicate application ID')
    await db.migrate('app-products', migrations)
    await db.transaction(tx => {
      for (const definition of options.directory) {
        // Interface-only applications have no durable background target or runtime factory.
        if (definition.runtime === false) {
          records.set(definition.id, { definition, desiredEnabled: false, state: 'running', tail: Promise.resolve() })
          continue
        }
        tx.execute('INSERT OR IGNORE INTO app_product_targets VALUES(?,0)', [definition.id])
        const row = tx.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', [definition.id])
        if (!row || row.desired_enabled !== 0 && row.desired_enabled !== 1) throw productFailure('invalid-product-storage', 500)
        const desiredEnabled = row.desired_enabled === 1
        records.set(definition.id, { definition, desiredEnabled, state: desiredEnabled ? 'applying' : 'disabled', tail: Promise.resolve() })
      }
    })
    let accepting = true, restoring: Promise<void> | undefined, controlFreezes = 0
    const targetChanges = new Set<Promise<void>>()
    const requireProduct = (id: string) => {
      const record = records.get(id)
      if (!record) throw productFailure('product-not-found', 404)
      return record
    }
    const queue = <T>(record: RecordState, work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(productFailure('service-unavailable', 503))
      if (controlFreezes) return Promise.reject(productFailure('product-busy'))
      const result = record.tail.then(() => { if (!accepting) throw productFailure('service-unavailable', 503); return work() })
      record.tail = result.then(() => {}, () => {})
      return result
    }
    const view = (record: RecordState): ProductView => {
      const capabilities = record.runtime?.capabilities?.() ?? options.capabilities?.(record.definition.id)
      if (record.definition.runtime === false) record.state = capabilities?.some(capability => capability.required && capability.status !== 'ready') ? 'blocked' : 'running'
      if (record.definition.runtime !== false && (record.state === 'running' || record.state === 'blocked')) {
        const snapshot = record.runtime?.inspect()
        record.state = snapshot === 'failed' ? 'failed' : snapshot === 'active' ? 'running' : 'blocked'
        if (record.state === 'failed') record.error = { phase: 'startup', code: 'product-startup-failed' }
      }
      return Object.freeze({ definition: record.definition, desiredEnabled: record.desiredEnabled, state: record.state,
        ...(record.error ? { error: Object.freeze({ ...record.error }) } : {}),
        ...(capabilities?.length ? { capabilities: Object.freeze(capabilities.map(capability => Object.freeze({ ...capability }))) } : {}) })
    }
    const apply = async (record: RecordState, enabled: boolean, retry = false) => {
      const runtime = record.runtime ??= options.runtime(record.definition.id)
      if (!runtime) throw productFailure('product-runtime-missing', 503)
      if (!enabled) await runtime.stop()
      else if (retry) await runtime.retry()
      else await runtime.open()
    }
    const change = async (record: RecordState, enabled: boolean, retry = false): Promise<ProductView> => {
      if (record.definition.runtime === false) return view(record)
      if (record.error?.phase === 'cleanup') throw productFailure('product-restart-required')
      if (!retry && enabled === record.desiredEnabled && (record.state === 'disabled' || view(record).state === 'running')) return view(record)
      let freeze: ActivityFreeze
      try { freeze = activity.freeze(!enabled || retry ? [record.definition.id] : []) }
      catch (cause) {
        const failure = runtimeError(cause)
        if (failure.phase !== 'cleanup') throw cause
        record.error = failure; record.state = 'failed'
        throw productFailure(failure.code, 503)
      }
      try {
        try { await db.transaction(tx => { tx.execute('UPDATE app_product_targets SET desired_enabled=? WHERE id=?', [enabled ? 1 : 0, record.definition.id]) }) }
        catch { throw productFailure('product-storage-failed', 503) }
        record.desiredEnabled = enabled; record.state = 'applying'; record.error = undefined
        try {
          await freeze.drain()
          await apply(record, enabled, retry)
          record.state = enabled ? 'blocked' : 'disabled'
        } catch (cause) { record.error = runtimeError(cause); record.state = 'failed' }
        return view(record)
      } finally {
        try { freeze.release() } catch {
          record.error = { phase: 'cleanup', code: 'product-cleanup-failed' }; record.state = 'failed'
          throw productFailure(record.error.code, 503)
        }
      }
    }
    const control = (id: string, enabled?: boolean, retry = false) => {
      try { const record = requireProduct(id); return queue(record, () => change(record, enabled ?? record.desiredEnabled, retry)) }
      catch (error) { return Promise.reject(error) }
    }
    const service: ProductsPort = {
      list: () => Object.freeze([...records.values()].map(view)),
      get: id => { const record = records.get(id); return record && view(record) },
      open: id => control(id, true), disable: id => control(id, false), retry: id => control(id, undefined, true),
      authorize(id) {
        if (!accepting) throw productFailure('service-unavailable', 503)
        if (view(requireProduct(id)).state !== 'running') throw productFailure('product-unavailable', 503)
      },
      restore() { return restoring ??= Promise.all([...records.values()].map(record => queue(record, async () => {
        if (!record.desiredEnabled) return
        try { await apply(record, true); record.state = 'blocked' }
        catch (cause) { record.error = runtimeError(cause); record.state = 'failed' }
      }))).then(() => {}) },
      async stop() { accepting = false; await Promise.all([...records.values()].map(record => record.tail)); while (targetChanges.size) await Promise.allSettled([...targetChanges]) },
      freezeControls() {
        if (!accepting) throw productFailure('service-unavailable', 503)
        controlFreezes++
        const pending = [...records.values()].map(record => record.tail)
        let released = false
        return { drain: () => Promise.all(pending).then(() => {}), release() { if (!released) { released = true; controlFreezes-- } } }
      },
      setClosedTargets(ids) {
        if (!accepting) return Promise.reject(productFailure('service-unavailable', 503))
        if (!controlFreezes) return Promise.reject(productFailure('product-busy'))
        if (!Array.isArray(ids) || !ids.length || ids.length > 10_000 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) || new Set(ids).size !== ids.length) return Promise.reject(productFailure('invalid-product-storage', 400))
        const captured = [...ids]
        const work = (async () => {
          await Promise.all([...records.values()].map(record => record.tail))
          // Only the host-owned lifecycle table is changed. Unknown/removed and
          // interface-only entries do not create a background target row.
          try { await db.transaction(tx => { for (const id of captured) tx.execute('UPDATE app_product_targets SET desired_enabled=0 WHERE id=?', [id]) }) }
          catch { throw productFailure('product-storage-failed', 503) }
          for (const id of captured) { const record = records.get(id); if (record) record.desiredEnabled = false }
        })()
        targetChanges.add(work); void work.finally(() => targetChanges.delete(work)).catch(() => {})
        return work
      },
    }
    ctx.effect(() => () => service.stop(), 'stop and join application control operations')
    ctx.provide(productsServiceKey, service)
  } }
}

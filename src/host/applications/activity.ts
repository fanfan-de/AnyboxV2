import type { Component } from '@nya/core'
import { productActivityServiceKey } from './contracts.js'
import type { ProductActivityPort, ActivityLease, ActivityFreeze } from './contracts.js'
import { productFailure } from './domain.js'

/** Synchronous admission decisions share one boundary with lease registration. */
export function createProductActivity(): ProductActivityPort {
  type Entry = { productId: string; blocking: boolean; cancel?: () => void; cancelled?: boolean; cancellationError?: { value: unknown } }
  const entries = new Set<Entry>(), freezes = new Set<{ products: Set<string> }>()
  const waiters = new Set<() => void>()
  const guards = new Map<string, Set<() => (() => void) | undefined>>()
  let accepting = true
  const cleanupErrors = new Set<unknown>()
  const cleanupFailure = (errors: readonly unknown[]) => Object.assign(new AggregateError(errors, 'Product observers failed to exit cleanly'), { phase: 'cleanup' as const })
  const cancelEntries = (selected: readonly Entry[]): unknown[] => {
    const errors: unknown[] = []
    for (const entry of selected) {
      if (!entry.cancelled) {
        entry.cancelled = true
        try { entry.cancel?.() } catch (error) { entry.cancellationError = { value: error } }
      }
      if (entry.cancellationError) errors.push(entry.cancellationError.value)
    }
    return errors
  }
  const releaseGuards = (releases: readonly (() => void)[]): unknown[] => {
    const errors: unknown[] = []
    for (const release of [...releases].reverse()) { try { release() } catch (error) { errors.push(error) } }
    return errors
  }
  const notify = () => { for (const waiter of [...waiters]) waiter() }
  const matches = (entry: Entry, products: ReadonlySet<string>) => products.has(entry.productId)
  const wait = (test: () => boolean): Promise<void> => test() ? Promise.resolve() : new Promise(resolve => {
    const check = () => { if (test()) { waiters.delete(check); resolve() } }
    waiters.add(check)
  })
  return {
    enter(productId, options = {}): ActivityLease {
      const entry: Entry = { productId, blocking: options.blocking ?? true, cancel: options.cancel }
      if (!accepting || [...freezes].some(freeze => matches(entry, freeze.products))) throw productFailure('product-unavailable', 503)
      entries.add(entry)
      return { release() { entries.delete(entry); notify() } }
    },
    freeze(productIds): ActivityFreeze {
      if (!accepting) throw productFailure('service-unavailable', 503)
      const freeze = { products: new Set(productIds) }
      if ([...entries].some(entry => entry.blocking && matches(entry, freeze.products))) throw productFailure('product-busy')
      const releases: (() => void)[] = []
      try {
        for (const id of freeze.products) for (const guard of guards.get(id) ?? []) {
          const release = guard()
          if (!release) throw productFailure('product-busy')
          releases.push(release)
        }
      } catch (error) {
        const failures = releaseGuards(releases)
        if (failures.length) throw cleanupFailure([error, ...failures])
        throw error
      }
      freezes.add(freeze)
      let released = false
      return {
        async drain() {
          const errors = cancelEntries([...entries].filter(entry => matches(entry, freeze.products)))
          await wait(() => ![...entries].some(entry => matches(entry, freeze.products)))
          if (errors.length) throw cleanupFailure(errors)
        },
        release() {
          if (released) return
          released = true
          const errors = releaseGuards(releases)
          freezes.delete(freeze); notify()
          if (errors.length) throw cleanupFailure(errors)
        },
      }
    },
    registerGuard(productId, acquire) {
      if (!accepting) throw productFailure('service-unavailable', 503)
      const set = guards.get(productId) ?? new Set()
      guards.set(productId, set); set.add(acquire)
      return () => { set.delete(acquire); if (!set.size) guards.delete(productId) }
    },
    stop() {
      accepting = false
      for (const error of cancelEntries([...entries].filter(entry => !entry.blocking))) cleanupErrors.add(error)
      notify()
    },
    async wait() { await wait(() => entries.size === 0); if (cleanupErrors.size) throw cleanupFailure([...cleanupErrors]) },
  }
}
export function createProductActivityComponent(): Component.Object<void> {
  return { name: 'app-activity', apply(ctx) {
    const service = createProductActivity()
    ctx.effect(() => async () => { service.stop(); await service.wait() }, 'close product admission and join operations')
    ctx.provide(productActivityServiceKey, service)
  } }
}

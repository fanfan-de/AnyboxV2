import { Context, FiberState } from '@nya/core'
import type { Component, Fiber } from '@nya/core'
import type { ApplicationRuntime } from './index.js'
import type { ApplicationRegistration as NodeApplicationRegistration } from './node.js'
export type ApplicationRegistration = NodeApplicationRegistration<Context>
export type { ApplicationCapabilityProvider, ApplicationCapabilityProviderContext } from './providers.js'
import { productFailure } from './failure.js'

export interface ApplicationInstallation {
  readonly signal: AbortSignal
  isClosing(): boolean
  install(component: Component<any, any>): Fiber
  track(fiber: Fiber): void
  effect(setup: () => (() => void | Promise<void>), label: string): void
}
interface Installation { fibers: Fiber[]; disposers: (() => unknown | Promise<unknown>)[]; abort: AbortController; failedExits: Map<number, unknown> }
/** Records ownership only. Nya owns dependency coordination and component cleanup. */
export function createApplicationRuntime(root: Context, setup: (installation: ApplicationInstallation) => void | Promise<void>, closeAdmission?: () => void): ApplicationRuntime {
  if (!Context.is(root) || root.root !== root) throw new TypeError('application root Context required')
  let current: Installation | undefined, failure: unknown, accepting = true, tail: Promise<void> = Promise.resolve()
  const guard = () => { if (!accepting) throw productFailure('product-unavailable') }
  const cleanupFailure = (errors: readonly unknown[]) => Object.assign(new AggregateError(errors, 'application cleanup failed or exit unconfirmed'), { phase: 'cleanup' })
  // A failed initialization can already have attempted rollback before dispose().
  // Its public Fiber state cannot prove that rollback released every resource.
  // Retain that uncertainty through root shutdown instead of silently clearing it.
  let reportCleanup: (() => void | Promise<void>) | undefined
  const unconfirmedExits = (installation: Installation) => {
    for (const fiber of installation.fibers) if (fiber.state === FiberState.FAILED) {
      installation.failedExits.set(fiber.id, fiber.error ?? new Error('application component exit unconfirmed'))
    }
    return [...installation.failedExits.values()]
  }
  const registerCleanupReport = () => {
    reportCleanup ??= root.effect(() => {
      // A dependency withdrawal can finish after admission closes but before root disposal.
      // Record the failure when it happens; later dispose/restart may erase Fiber FAILED.
      const unsubscribe = root.registry.subscribe(event => {
        if (event.type === 'state' && event.fiber.state === FiberState.FAILED && current?.fibers.some(fiber => fiber.id === event.fiber.id)) {
          current.failedExits.set(event.fiber.id, event.fiber.error ?? new Error('application component exit unconfirmed'))
        }
      })
      return () => {
        unsubscribe()
        const errors = current ? unconfirmedExits(current) : []
        if (errors.length && !(failure && typeof failure === 'object' && 'phase' in failure && failure.phase === 'cleanup')) failure = cleanupFailure(errors)
        if (failure && typeof failure === 'object' && 'phase' in failure && failure.phase === 'cleanup') throw failure
      }
    }, 'report unconfirmed application cleanup')
  }
  const cleanup = async () => {
    const installation = current
    if (!installation) return
    installation.abort.abort()
    unconfirmedExits(installation)
    const results = await Promise.allSettled([...installation.fibers].reverse().map(fiber => fiber.dispose()))
    for (const dispose of [...installation.disposers].reverse()) {
      try { await dispose() } catch (reason) { results.push({ status: 'rejected', reason }) }
    }
    const errors = [...unconfirmedExits(installation), ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
    if (errors.length) {
      failure = cleanupFailure(errors)
      throw failure
    }
    current = undefined
    const report = reportCleanup
    reportCleanup = undefined
    await report?.()
  }
  const inspect: ApplicationRuntime['inspect'] = () => failure || current?.failedExits.size || current?.fibers.some(fiber => fiber.state === FiberState.FAILED) ? 'failed'
    : !current ? 'disabled' : current.fibers.every(fiber => fiber.state === FiberState.ACTIVE) ? 'active' : 'blocked'
  const open = async () => {
    guard()
    if (failure) throw failure
    if (current) {
      if (inspect() === 'failed') throw current.fibers.find(fiber => fiber.state === FiberState.FAILED)?.error ?? current.failedExits.values().next().value
      return
    }
    registerCleanupReport()
    const installation: Installation = { fibers: [], disposers: [], abort: new AbortController(), failedExits: new Map() }
    current = installation
    const guardInstallation = () => {
      guard()
      if (current !== installation || installation.abort.signal.aborted) throw productFailure('product-unavailable')
    }
    const track = (fiber: Fiber) => {
      // Callers transferring a newly created Fiber must register it synchronously,
      // including when host admission closed during its creation.
      if (current !== installation) throw productFailure('product-unavailable')
      installation.fibers.push(fiber)
      guardInstallation()
    }
    const scope: ApplicationInstallation = {
      signal: installation.abort.signal, isClosing: () => !accepting || current !== installation || installation.abort.signal.aborted,
      track,
      install(component) { guardInstallation(); const fiber = root.installComponent(component); track(fiber); return fiber },
      effect(setup, label) { guardInstallation(); installation.disposers.push(root.effect(setup, label)); guardInstallation() },
    }
    try {
      await setup(scope)
      for (let pass = 0; pass <= installation.fibers.length; pass++) {
        await Promise.all(installation.fibers.map(fiber => fiber.awaitStable()))
        if (installation.fibers.every(fiber => fiber.state === FiberState.ACTIVE)) break
      }
      guard()
      const failed = installation.fibers.find(fiber => fiber.state === FiberState.FAILED)
      if (failed) throw failed.error
    } catch (error) {
      try { await cleanup() } catch (cleanupError) { throw cleanupError }
      failure = error; throw error
    }
  }
  const queue = (work: () => Promise<void>) => {
    if (!accepting) return Promise.reject(productFailure('product-unavailable'))
    const task = tail.then(() => { guard(); return work() }); tail = task.catch(() => {}); return task
  }
  const assertCleanup = () => { if (failure && typeof failure === 'object' && 'phase' in failure && failure.phase === 'cleanup') throw failure }
  return {
    open: () => queue(open),
    stop: () => queue(async () => { assertCleanup(); await cleanup(); failure = undefined }),
    retry: () => queue(async () => { assertCleanup(); await cleanup(); failure = undefined; await open() }),
    inspect,
    closeAdmission() {
      if (!accepting) return
      accepting = false
      const unconfirmed = current ? unconfirmedExits(current) : []
      if (unconfirmed.length && !(failure && typeof failure === 'object' && 'phase' in failure && failure.phase === 'cleanup')) failure = cleanupFailure(unconfirmed)
      try { closeAdmission?.() } finally { current?.abort.abort() }
    },
    awaitIdle: () => tail,
  }
}

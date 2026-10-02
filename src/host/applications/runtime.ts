import { Context, FiberState } from '@nya/core'
import type { Component, Fiber } from '@nya/core'
import type { ApplicationRuntime } from './contracts.js'
import { productFailure } from './domain.js'

export interface ApplicationInstallation {
  readonly signal: AbortSignal
  isClosing(): boolean
  install(component: Component<any, any>): Fiber
  track(fiber: Fiber): void
  effect(setup: () => (() => void | Promise<void>), label: string): void
}
interface Installation { fibers: Fiber[]; disposers: (() => unknown | Promise<unknown>)[]; abort: AbortController }
/** Records ownership only. Nya owns dependency coordination and component cleanup. */
export function createApplicationRuntime(root: Context, setup: (installation: ApplicationInstallation) => void | Promise<void>, closeAdmission?: () => void): ApplicationRuntime {
  if (!Context.is(root) || root.root !== root) throw new TypeError('application root Context required')
  let current: Installation | undefined, failure: unknown, accepting = true, tail: Promise<void> = Promise.resolve()
  const guard = () => { if (!accepting) throw productFailure('product-unavailable') }
  const cleanup = async () => {
    const installation = current
    if (!installation) return
    installation.abort.abort()
    const results = await Promise.allSettled([...installation.fibers].reverse().map(fiber => fiber.dispose()))
    for (const dispose of [...installation.disposers].reverse()) {
      try { await dispose() } catch (reason) { results.push({ status: 'rejected', reason }) }
    }
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) {
      failure = Object.assign(new AggregateError(errors, 'application cleanup failed'), { phase: 'cleanup' })
      throw failure
    }
    current = undefined
  }
  const inspect: ApplicationRuntime['inspect'] = () => failure || current?.fibers.some(fiber => fiber.state === FiberState.FAILED) ? 'failed'
    : !current ? 'disabled' : current.fibers.every(fiber => fiber.state === FiberState.ACTIVE) ? 'active' : 'blocked'
  const open = async () => {
    guard()
    if (failure) throw failure
    if (current) {
      if (inspect() === 'failed') throw current.fibers.find(fiber => fiber.state === FiberState.FAILED)?.error
      return
    }
    const installation: Installation = { fibers: [], disposers: [], abort: new AbortController() }
    current = installation
    const track = (fiber: Fiber) => { installation.fibers.push(fiber); guard() }
    const scope: ApplicationInstallation = {
      signal: installation.abort.signal, isClosing: () => !accepting || installation.abort.signal.aborted,
      track,
      install(component) { guard(); const fiber = root.installComponent(component); track(fiber); return fiber },
      effect(setup, label) { guard(); installation.disposers.push(root.effect(setup, label)); guard() },
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
    closeAdmission() { accepting = false; try { closeAdmission?.() } finally { current?.abort.abort() } },
    awaitIdle: () => tail,
  }
}

import { randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import { productsServiceKey, productActivityServiceKey } from '@anybox/application-api'
import type { ActivityFreeze, ProductsPort, ProductActivityPort } from '@anybox/application-api'
import { freezeApplicationRole } from '../applications/lifecycle.js'
import { captureCommand, identifier } from './domain.js'
import { packageRegistryServiceKey } from './port.js'
import type { PackageActivation, PackageActivationLaunch, PackageActivationRolePlan, PackageRegistryPort, PackageRegistryView } from './port.js'
import type { PackagePageLifecycle } from './page-lifecycle.js'

export const packageActivationServiceKey = 'host.package-activation'
export interface PackageActivationIntent { readonly requestId: string; readonly expectedRegistryRevision: number; readonly appIds?: readonly string[]; readonly kind?: 'activate' | 'remove' }
/** The trusted process owner freezes peer roles and holds launch reservations before restarting anything. */
export interface PackageLifecycleManager {
  readonly roles: readonly PackageActivationRolePlan['role'][]
  ownedUsageIds(): Promise<readonly string[]>
  desiredTargets?(): Promise<Readonly<Record<string, Readonly<Record<string, boolean>>>>>
  /** Saves closed targets in frozen peer roles without interpreting application state. */
  closeTargets?(appIds: readonly string[]): Promise<void>
  freeze(): Promise<void>
  release(): Promise<void>
  handoff(launch: PackageActivationLaunch): Promise<void>
}
export interface PackageActivationPort {
  readonly available: boolean
  /** Ephemeral proof for this owner only, after all role and page guards acknowledge. */
  isPrepared?(id: string): boolean
  prepare(input: PackageActivationIntent): Promise<PackageActivation>
  resume(id: string): Promise<PackageActivation>
  commit(id: string): Promise<PackageActivation>
  cancel(id: string): Promise<PackageActivation>
  get(id: string): Promise<PackageActivation | undefined>
  list(): Promise<readonly PackageActivation[]>
  closeAdmission(): void
  awaitIdle(): Promise<void>
}
function fail(code: string): never { throw Object.assign(new Error(`Package activation: ${code}`), { code }) }
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'activation-failed'

/** Owns only reversible role admission, page protection and durable activation handoff. */
export function createPackageActivationComponent(config: {
  readonly manager?: PackageLifecycleManager
  readonly pages?: PackagePageLifecycle
  readonly plan: (view: PackageRegistryView, intent: PackageActivationIntent) => Promise<readonly PackageActivationRolePlan[]>
  readonly preparedTimeoutMs?: number
  /** Proves external role exits without fencing an active role owned by another manager. */
  readonly inspectExternalUses?: (ownedUsageIds: readonly string[]) => Promise<void>
}): Component.Object<void, { [packageRegistryServiceKey]: PackageRegistryPort; [productsServiceKey]: ProductsPort; [productActivityServiceKey]: ProductActivityPort }> {
  const manager = config.manager, pages = config.pages, plan = config.plan, timeoutMs = config.preparedTimeoutMs ?? 120_000
  return { name: 'host-package-activation', inject: [packageRegistryServiceKey, productsServiceKey, productActivityServiceKey], apply(ctx, _options, deps) {
    const registry = deps[packageRegistryServiceKey], pending = new Set<Promise<unknown>>()
    type Protection = { id: string; local: ActivityFreeze; timer?: ReturnType<typeof setTimeout>; committed: boolean; recovery?: boolean; ready?: boolean }
    let accepting = true, held: Protection | undefined
    let tail: Promise<unknown> = Promise.resolve()
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(Object.assign(new Error('Activation admission closed'), { code: 'service-closing' }))
      const result = tail.then(work); tail = result.catch(() => {}); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const get = async (id: string) => { const value = await registry.getActivation(identifier(id)); if (!value) fail('not-found'); return value }
    const release = async () => {
      const previous = held; held = undefined
      if (previous?.timer) clearTimeout(previous.timer)
      const errors: unknown[] = []
      if (previous) {
        try { pages?.release(previous.id) } catch (error) { errors.push(error) }
        try { previous.local.release() } catch (error) { errors.push(error) }
      }
      try { await manager?.release() } catch (error) { errors.push(error) }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Activation protection cleanup failed'), { phase: 'cleanup' })
    }
    const cancel = async (id: string): Promise<PackageActivation> => {
      const activation = await get(id)
      if (held?.id === id && held.recovery && !held.committed) { await release(); return activation }
      if (activation.phase === 'cancelled') { if (held?.id === id) await release(); return activation }
      if (activation.phase !== 'prepared' || held?.committed) fail('activation-recovery-required')
      const result = await registry.recoverActivation({ activationId: id, expectedRevision: activation.revision, action: 'cancel' })
      if (held?.id === id) await release()
      return result.activation
    }
    const expire = (protection: Protection): void => {
      protection.timer = setTimeout(() => {
        void track(async () => {
          // A cleared timer may already be queued behind cancel/resume. Compare
          // the protection inside this queue before touching the same durable id.
          if (held !== protection || protection.committed) return
          await cancel(protection.id)
        }).catch(() => {})
      }, timeoutMs)
    }
    const service: PackageActivationPort = {
      available: !!manager,
      isPrepared: id => accepting && held?.id === id && held.ready === true && !held.committed,
      prepare(input) {
        let intent: PackageActivationIntent
        try { intent = captureCommand(input) } catch { return Promise.reject(Object.assign(new Error('Invalid activation input'), { code: 'invalid-input' })) }
        return track(async () => {
          if (!manager) fail('activation-manager-unavailable')
          identifier(intent.requestId)
          if (intent.kind !== undefined && intent.kind !== 'activate' && intent.kind !== 'remove' || intent.kind === 'remove' && (!Array.isArray(intent.appIds) || !intent.appIds.length)) fail('invalid-input')
          const prior = await registry.findActivation(intent.requestId)
          if (prior) {
            if ((prior.kind ?? 'activate') !== (intent.kind ?? 'activate') || prior.registryRevision !== intent.expectedRegistryRevision || intent.appIds && JSON.stringify([...intent.appIds].sort()) !== JSON.stringify([...new Set(prior.targets.map(target => target.identity.appId))].sort())) fail('request-conflict')
            if (held?.id === prior.id || prior.phase !== 'prepared') return prior
            fail('activation-recovery-required')
          }
          if (held) fail('activation-busy')
          const view = await registry.inspect()
          if (view.revision !== intent.expectedRegistryRevision) fail('revision-conflict')
          const local = await freezeApplicationRole(deps[productsServiceKey], deps[productActivityServiceKey])
          const provisional = randomUUID()
          held = { id: provisional, local, committed: false }
          try {
            await manager.freeze()
            const ownedUsageIds = await manager.ownedUsageIds()
            await config.inspectExternalUses?.(ownedUsageIds)
            const current = await registry.inspect()
            if (current.revision !== intent.expectedRegistryRevision) fail('revision-conflict')
            const roles = await plan(current, intent)
            const activation = await registry.prepareActivation({ ...intent, expectedRegistryRevision: current.revision, roles, ownedUsageIds })
            held.id = activation.id
            await pages?.freeze(activation.id)
            held.ready = true
            expire(held)
            return activation
          } catch (error) {
            const current = held
            if (current && current.id !== provisional) {
              const activation = await registry.getActivation(current.id)
              if (activation?.phase === 'prepared') await registry.recoverActivation({ activationId: activation.id, expectedRevision: activation.revision, action: 'cancel' }).catch(() => {})
            }
            try { await release() } catch (cleanup) { accepting = false; throw new AggregateError([error, cleanup], 'Activation preparation cleanup failed') }
            throw error
          }
        })
      },
      resume: id => track(async () => {
        if (!manager) fail('activation-manager-unavailable')
        const activation = await get(id)
        if (activation.phase !== 'recovery-required') fail('activation-recovery-not-required')
        if (held) fail('activation-busy')
        const local = await freezeApplicationRole(deps[productsServiceKey], deps[productActivityServiceKey])
        held = { id, local, committed: false, recovery: true }
        try {
          await manager.freeze(); await pages?.freeze(id); held.ready = true
          // A disconnected recovery caller owns only this temporary protection.
          // cancel() releases it without changing the durable recovery intent.
          expire(held)
          return activation
        }
        catch (error) { await release(); throw error }
      }),
      commit: id => track(async () => {
        if (!manager) fail('activation-manager-unavailable')
        const activation = await get(id)
        if (activation.phase !== 'prepared' && !(activation.phase === 'recovery-required' && held?.recovery)) return activation
        if (!held || held.id !== id || held.committed) fail('activation-recovery-required')
        if (held.timer) clearTimeout(held.timer)
        try {
          await pages?.dispose(id)
          if (activation.kind === 'remove') {
            const ids = [...new Set(activation.targets.map(target => target.identity.appId))]
            if (!deps[productsServiceKey].setClosedTargets || !manager.closeTargets) fail('activation-coordination-unavailable')
            await manager.closeTargets(ids)
            await deps[productsServiceKey].setClosedTargets!(ids)
          }
          let launch: PackageActivationLaunch
          if (held.recovery) {
            await config.inspectExternalUses?.(await manager.ownedUsageIds())
            const fresh = await get(id)
            launch = await registry.recoverActivation({ activationId: id, expectedRevision: fresh.revision, action: 'resume', holderId: 'lifecycle-parent', generation: randomUUID() })
            if (launch.activation.phase === 'prepared') launch = await registry.commitActivation({ activationId: id, expectedRevision: launch.activation.revision, holderId: 'lifecycle-parent', generation: randomUUID(), receipt: { guards: 'frozen', pages: 'disposed', recovery: true } })
          } else launch = await registry.commitActivation({ activationId: id, expectedRevision: activation.revision, holderId: 'lifecycle-parent', generation: randomUUID(), receipt: { guards: 'frozen', pages: 'disposed' } })
          held.committed = true
          await manager.handoff(launch)
          // The parent returns after holding all anchors. Restart runs outside this component's work.
          return launch.activation
        } catch (error) {
          const current = await get(id)
          if (current.phase !== 'completed' && current.phase !== 'cancelled') await registry.interruptActivation({ activationId: id, expectedRevision: current.revision, errorCode: errorCode(error) }).catch(() => {})
          // Before selection/parent reservations commit, a fresh explicit
          // recovery can reacquire every guard. Failed browser disposal keeps
          // its own resource fence even when this server protection is released.
          if (!current.roles.some(role => role.handoffUsageId !== null)) {
            try { await release() } catch (cleanup) { accepting = false; throw new AggregateError([error, cleanup], 'Activation recovery protection cleanup failed') }
          }
          throw error
        }
      }),
      cancel: id => track(() => cancel(id)),
      get: id => registry.getActivation(identifier(id)), list: () => registry.listActivations(),
      closeAdmission() { accepting = false; if (held?.timer) clearTimeout(held.timer) },
      async awaitIdle() { while (pending.size) await Promise.allSettled([...pending]) },
    }
    ctx.effect(() => async () => { service.closeAdmission(); await service.awaitIdle(); await release(); await pages?.close() })
    ctx.provide(packageActivationServiceKey, service)
  } }
}

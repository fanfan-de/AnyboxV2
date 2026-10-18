import { Context, FiberState, type Fiber } from '@nya/core'
import { rcompare, satisfies, valid, validRange } from 'semver'
import type { ApplicationCapabilityRequirements, ApplicationCapabilityStatus } from '@anybox/application-api'
import type { ApplicationCapabilityProvider } from '@anybox/application-api/nya'

interface Requirement { id: string; range: string; required: boolean }
interface Entry {
  provider: ApplicationCapabilityProvider
  fiber?: Fiber
  abort?: AbortController
  cancel?: () => void | Promise<void>
  consumers: number
  fenced: boolean
  initializationFailed?: { error: unknown }
  cleanupError?: unknown
}
interface Selection { requirement: Requirement; provider?: ApplicationCapabilityProvider; status: ApplicationCapabilityStatus }
export interface ApplicationCapabilityLease {
  readonly capabilities: Readonly<Record<string, string>>
  readonly statuses: readonly ApplicationCapabilityStatus[]
  inspect(): readonly ApplicationCapabilityStatus[]
  release(): Promise<void>
}
export interface ApplicationCapabilityManager {
  inspect(requirements?: ApplicationCapabilityRequirements): readonly ApplicationCapabilityStatus[]
  acquire(requirements?: ApplicationCapabilityRequirements): Promise<ApplicationCapabilityLease>
  closeAdmission(): void
  awaitIdle(): Promise<void>
}
const managers = new WeakMap<Context, { providers: readonly ApplicationCapabilityProvider[]; manager: ApplicationCapabilityManager }>()
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
export const validCapabilityRange = (range: string) => validRange(range) !== null
const cleanupFailure = (errors: readonly unknown[]) => Object.assign(new AggregateError(errors, 'application capability cleanup failed'), { phase: 'cleanup' })
const requirementsOf = (requirements?: ApplicationCapabilityRequirements): Requirement[] => [
  ...Object.entries(requirements?.required ?? {}).map(([id, range]) => ({ id, range, required: true })),
  ...Object.entries(requirements?.optional ?? {}).map(([id, range]) => ({ id, range, required: false })),
]
const diagnostic = ({ id, range, required }: Requirement, status: ApplicationCapabilityStatus['status'], version?: string): ApplicationCapabilityStatus =>
  Object.freeze({ id, range, required, status, ...(version ? { version } : {}) })

/** Selects resource owners; Nya alone coordinates their service dependencies and cleanup. */
export function createApplicationCapabilityManager(root: Context, input: readonly ApplicationCapabilityProvider[] = []): ApplicationCapabilityManager {
  if (!Context.is(root) || root.root !== root) throw new TypeError('application root Context required')
  const existing = managers.get(root)
  if (existing) {
    if (existing.providers.length !== input.length || existing.providers.some((provider, index) => provider !== input[index])) throw new TypeError('application capability manager already belongs to this root')
    return existing.manager
  }
  const offered = new Map<string, ApplicationCapabilityProvider[]>(), entries = new Map<string, Entry>()
  const serviceOwners = new Map<string, Entry>(), initializing = new Set<Entry>()
  for (const value of input) {
    if (!idPattern.test(value.id) || !valid(value.version) || typeof value.create !== 'function' || !Array.isArray(value.services) ||
        value.services.some(service => typeof service !== 'string' || !service.trim() || service.includes('\0')) ||
        new Set(value.services).size !== value.services.length || value.supported !== undefined && typeof value.supported !== 'boolean' ||
        value.resident !== undefined && typeof value.resident !== 'boolean') throw new TypeError('invalid application capability provider')
    const versions = offered.get(value.id) ?? []
    if (versions.some(provider => valid(provider.version) === valid(value.version))) throw new TypeError('duplicate application capability provider version')
    const provider = Object.freeze({ ...value, services: Object.freeze([...value.services]) })
    versions.push(provider); offered.set(provider.id, versions)
    if (provider.resident) {
      if (entries.has(provider.id) || provider.services.some(service => serviceOwners.has(service))) throw new TypeError('conflicting resident application capability providers')
      const entry: Entry = { provider, consumers: 0, fenced: false }
      entries.set(provider.id, entry)
      for (const service of provider.services) serviceOwners.set(service, entry)
    }
  }
  for (const versions of offered.values()) versions.sort((a, b) => rcompare(a.version, b.version))
  const retainFailedExit = (entry: Entry) => {
    if (entry.fiber?.state !== FiberState.FAILED || entry.initializationFailed) return
    // A later failed restart/dependency withdrawal may have already consumed the failing
    // Effect stack. Remember its public failure before permanent disposal erases that state.
    entry.fenced = true
    entry.cleanupError ??= entry.fiber.error ?? new Error('application capability exit is unconfirmed')
  }
  // A failed Nya startup can include a failed rollback without exposing a structured cleanup
  // phase. Retain that ownership conservatively; shutdown must not report confirmed cleanup.
  root.effect(() => {
    const unsubscribe = root.registry.subscribe(event => {
      if (event.type !== 'state' || event.fiber.state !== FiberState.FAILED) return
      const entry = [...entries.values()].find(entry => entry.fiber?.id === event.fiber.id)
      if (!entry || initializing.has(entry)) return
      // Preserve the lifecycle fact at publication time: cleanup may still be UNLOADING
      // during a shutdown snapshot, then fail before permanent disposal consumes the error.
      entry.fenced = true
      entry.cleanupError ??= event.fiber.error ?? new Error('application capability exit is unconfirmed')
    })
    return async () => {
      await unsubscribe()
      const failed = [...entries.values()].filter(entry => entry.fenced)
      if (failed.length) throw cleanupFailure(failed.map(entry => entry.cleanupError ?? entry.initializationFailed?.error))
    }
  }, 'report unconfirmed application capability cleanup')
  let accepting = true
  const tails = new Map<string, Promise<void>>(), pending = new Set<Promise<void>>()
  const guard = () => { if (!accepting) throw new Error('application host is closing') }
  const providerKeys = (provider: ApplicationCapabilityProvider) => [`capability:${provider.id}`, ...provider.services.map(service => `service:${service}`)]
  const requirementKeys = (requirements?: ApplicationCapabilityRequirements) => requirementsOf(requirements).flatMap(({ id }) => [
    `capability:${id}`, ...(offered.get(id) ?? []).flatMap(provider => providerKeys(provider)),
  ])
  const queue = <T>(keys: readonly string[], work: () => Promise<T>): Promise<T> => {
    const unique = [...new Set(keys)]
    const result = Promise.all(unique.flatMap(key => tails.get(key) ?? [])).then(work)
    const settled = result.then(() => {}, () => {})
    for (const key of unique) tails.set(key, settled)
    pending.add(settled)
    void settled.then(() => {
      pending.delete(settled)
      for (const key of unique) if (tails.get(key) === settled) tails.delete(key)
    })
    return result
  }
  const available = (entry: Entry) => !entry.fenced && entry.provider.supported !== false &&
    (!entry.fiber || entry.fiber.state === FiberState.ACTIVE) && entry.provider.services.every(service => root.get(service) !== undefined)
  const select = (requirements?: ApplicationCapabilityRequirements): Selection[] => {
    const reserved = new Map(serviceOwners)
    return requirementsOf(requirements).map(requirement => {
      const versions = offered.get(requirement.id)
      const compatible = versions?.filter(provider => satisfies(provider.version, requirement.range)) ?? []
      const pinned = entries.get(requirement.id)
      let provider: ApplicationCapabilityProvider | undefined, status: ApplicationCapabilityStatus['status']
      if (!versions) status = 'missing'
      else if (!compatible.length) status = 'incompatible'
      else if (pinned) {
        provider = pinned.provider
        status = !satisfies(provider.version, requirement.range) ? 'conflict' : provider.supported === false ? 'unsupported' : available(pinned) ? 'ready' : 'failed'
      } else {
        provider = compatible.find(candidate => candidate.supported !== false)
        if (!provider) status = 'unsupported'
        else if (provider.services.some(service => reserved.has(service) || root.get(service) !== undefined)) status = 'conflict'
        else {
          status = 'ready'
          const reservation: Entry = { provider, consumers: 0, fenced: false }
          for (const service of provider.services) reserved.set(service, reservation)
        }
      }
      return { requirement, provider, status: diagnostic(requirement, status, provider?.version) }
    })
  }
  const remove = async (entry: Entry) => {
    if (entry.provider.resident || entry.consumers > 0) return
    retainFailedExit(entry)
    try { entry.abort?.abort(); await entry.cancel?.(); await entry.fiber?.dispose() }
    catch (error) { entry.fenced = true; entry.cleanupError = error; throw cleanupFailure([error]) }
    if (entry.fenced) throw cleanupFailure([entry.cleanupError ?? entry.initializationFailed?.error])
    if (entry.initializationFailed) { entry.fenced = true; return }
    entries.delete(entry.provider.id)
    for (const service of entry.provider.services) if (serviceOwners.get(service) === entry) serviceOwners.delete(service)
  }
  const release = async (owned: readonly Entry[]) => {
    const errors: unknown[] = []
    // Decrement all before disposal; Nya drains dependents without us recreating its dependency graph.
    for (const entry of owned) entry.consumers--
    const results = await Promise.allSettled(owned.map(entry => remove(entry)))
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw cleanupFailure(errors)
  }
  const manager: ApplicationCapabilityManager = {
    inspect(requirements?: ApplicationCapabilityRequirements): readonly ApplicationCapabilityStatus[] {
      return Object.freeze(select(requirements).map(item => item.status))
    },
    acquire(requirements?: ApplicationCapabilityRequirements): Promise<ApplicationCapabilityLease> {
      if (!accepting) return Promise.reject(new Error('application host is closing'))
      return queue(requirementKeys(requirements), async () => {
        guard()
        const selections = select(requirements), owned: Entry[] = []
        const statuses = new Map(selections.map(item => [item.requirement.id, item.status]))
        const lease = (): ApplicationCapabilityLease => {
          let released: Promise<void> | undefined
          const snapshot = () => Object.freeze(selections.map(item => {
            const entry = owned.find(entry => entry.provider.id === item.requirement.id)
            return entry ? diagnostic(item.requirement, available(entry) ? 'ready' : 'failed', entry.provider.version) : statuses.get(item.requirement.id)!
          }))
          return {
            capabilities: Object.freeze(Object.fromEntries(owned.map(entry => [entry.provider.id, entry.provider.version]))),
            statuses: snapshot(), inspect: snapshot,
            release: () => released ??= queue(owned.flatMap(entry => providerKeys(entry.provider)), () => release(owned)),
          }
        }
        // A required contract gate has no resource side effects, including optional providers.
        if (selections.some(item => item.requirement.required && item.status.status !== 'ready')) return lease()
        const created: Entry[] = []
        for (const item of selections) {
          if (item.status.status !== 'ready' || !item.provider) continue
          let entry = entries.get(item.requirement.id)
          if (!entry) {
            entry = { provider: item.provider, consumers: 0, fenced: false, abort: new AbortController() }
            entries.set(item.requirement.id, entry)
            for (const service of entry.provider.services) serviceOwners.set(service, entry)
            created.push(entry)
            initializing.add(entry)
            try {
              const component = entry.provider.create(Object.freeze({ signal: entry.abort!.signal }))
              guard()
              entry.fiber = root.installComponent(component)
              const abort = entry.abort!
              // Root cleanup aborts before this provider's fiber is disposed; preparation only
              // aborts providers whose initial acquisition has not yet committed.
              const owned = entry
              entry.cancel = root.effect(() => () => { retainFailedExit(owned); abort.abort() }, 'cancel application capability provider')
            }
            catch { statuses.set(item.requirement.id, diagnostic(item.requirement, 'failed', entry.provider.version)) }
          }
          entry.consumers++; owned.push(entry)
        }
        try {
          // Install the complete selection before stabilization so Nya can resolve provider dependencies.
          const stabilized = await Promise.allSettled(created.map(entry => entry.fiber?.awaitStable()))
          for (const [index, result] of stabilized.entries()) if (result.status === 'rejected') created[index]!.initializationFailed = { error: result.reason }
          const failed = owned.filter(entry => !available(entry) || !entry.provider.resident && !entry.fiber)
          for (const entry of failed) {
            const item = selections.find(item => item.requirement.id === entry.provider.id)!
            statuses.set(item.requirement.id, diagnostic(item.requirement, 'failed', entry.provider.version))
          }
          const requiredFailed = failed.some(entry => selections.some(item => item.requirement.id === entry.provider.id && item.requirement.required))
          const relinquished = requiredFailed ? owned.splice(0) : failed.map(entry => { owned.splice(owned.indexOf(entry), 1); return entry })
          try { await release(relinquished) }
          catch (error) {
            const remaining = await Promise.allSettled([release(owned.splice(0))])
            throw cleanupFailure([error, ...remaining.flatMap(result => result.status === 'rejected' ? [result.reason] : [])])
          }
          if (!accepting) { await release(owned.splice(0)); guard() }
          return lease()
        } finally {
          for (const entry of created) initializing.delete(entry)
        }
      })
    },
    closeAdmission() {
      accepting = false
      for (const entry of entries.values()) if (!initializing.has(entry)) retainFailedExit(entry)
      for (const entry of initializing) {
        entry.abort?.abort()
        // Request disposal immediately so a just-finished initializer cannot become ready.
        // The owning acquisition still joins that exact fiber's actual exit.
        void entry.fiber?.dispose().catch(error => { entry.fenced = true; entry.cleanupError = error })
      }
    },
    async awaitIdle() { while (pending.size) await Promise.all([...pending]) },
  }
  managers.set(root, { providers: [...input], manager })
  return manager
}

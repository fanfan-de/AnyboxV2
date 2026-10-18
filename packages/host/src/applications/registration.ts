import type { Context } from '@nya/core'
import type { ApplicationCapabilityRequirements, ApplicationCapabilityStatus, ApplicationRuntime, ProductDefinition } from '@anybox/application-api'
import type { ApplicationAsset } from '@anybox/application-api/node'
import type { ApplicationCapabilityProvider, ApplicationRegistration } from '@anybox/application-api/nya'
import { createApplicationCapabilityManager, validCapabilityRange, type ApplicationCapabilityLease } from './providers.js'

export interface ApplicationCatalog {
  readonly applications: readonly ApplicationRegistration[]
  readonly assets: ReadonlyMap<string, ApplicationAsset>
  route(path: string, base: string): { application: ApplicationRegistration; path: string; selfAuthenticated: boolean } | undefined
}
/** Exact URL spellings are part of the static resource identity used by HTTP. */
export function isCanonicalApplicationPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\0]/.test(path)) return false
  try {
    const url = new URL(path, 'https://application.invalid')
    if (url.origin !== 'https://application.invalid' || url.pathname !== path || url.search || url.hash) return false
    return !path.split('/').some(part => {
      const decoded = decodeURIComponent(part)
      return decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)
    })
  } catch { return false }
}
const validPath = isCanonicalApplicationPath
const contains = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + '/')
/** Validate static declarations without resolving or opening any live provider. */
function capabilityRequirements(value: ApplicationCapabilityRequirements | undefined): ApplicationCapabilityRequirements | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'required' && key !== 'optional')) throw new TypeError('invalid application capability requirements')
  const copy = (group: Readonly<Record<string, string>> | undefined) => {
    if (group === undefined) return undefined
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new TypeError('invalid application capability requirements')
    for (const [id, version] of Object.entries(group)) if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) || typeof version !== 'string' || !version.trim() || version.length > 200 || version.includes('\0') || !validCapabilityRange(version)) throw new TypeError('invalid application capability requirement')
    return Object.freeze({ ...group })
  }
  const required = copy(value.required), optional = copy(value.optional)
  if (Object.keys(required ?? {}).some(id => Object.hasOwn(optional ?? {}, id))) throw new TypeError('application capability cannot be both required and optional')
  return Object.freeze({ ...(required ? { required } : {}), ...(optional ? { optional } : {}) })
}
/** Trusted, immutable directory. It contains no mutable runtime state. */
export function createApplicationCatalog(input: readonly ApplicationRegistration[], commonAssets: readonly ApplicationAsset[] = []): ApplicationCatalog {
  const ids = new Set<string>(), aliases: { prefix: string; stripPrefix: string; application: ApplicationRegistration }[] = []
  const assets = new Map<string, ApplicationAsset>()
  const addAsset = (asset: ApplicationAsset) => {
    if (!validPath(asset.path) || contains('/api', asset.path) || assets.has(asset.path)) throw new TypeError(`invalid or duplicate application asset: ${asset.path}`)
    const expected = asset.path.endsWith('.js') ? 'text/javascript' : asset.path.endsWith('.css') ? 'text/css' : asset.path === '/' || asset.path.endsWith('.html') ? 'text/html' : asset.path.endsWith('.svg') ? 'image/svg+xml' : undefined
    if (expected && !asset.type.startsWith(expected)) throw new TypeError(`invalid asset MIME type: ${asset.path}`)
    assets.set(asset.path, Object.freeze({ ...asset }))
  }
  commonAssets.forEach(addAsset)
  const applications = input.map(value => {
    const { id, name, icon, description, web } = value.definition
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || ids.has(id) || !name.trim() || !icon.trim()) throw new TypeError(`invalid or duplicate application: ${id}`)
    ids.add(id)
    if (value.createRuntime !== undefined && typeof value.createRuntime !== 'function') throw new TypeError(`invalid application runtime: ${id}`)
    if (value.channel !== undefined && (!value.channel || typeof value.channel.handle !== 'function' || Object.keys(value.channel).some(key => key !== 'handle'))) throw new TypeError(`invalid application channel: ${id}`)
    if (value.http && !value.createRuntime) throw new TypeError(`application HTTP entry requires a runtime: ${id}`)
    if (!value.createRuntime && !web) throw new TypeError(`application entry required: ${id}`)
    const definition: ProductDefinition = Object.freeze({ id, name, icon, runtime: !!value.createRuntime, http: !!value.http, ...(description ? { description } : {}), ...(web ? { web: Object.freeze({ entry: web.entry,
      ...(web.styles ? { styles: Object.freeze([...web.styles]) } : {}), ...(web.legacyRoutes ? { legacyRoutes: Object.freeze([...web.legacyRoutes]) } : {}) }) } : {}) })
    const requirements = capabilityRequirements(value.capabilityRequirements)
    const application = Object.freeze({ ...value, definition, ...(requirements ? { capabilityRequirements: requirements } : {}), assets: Object.freeze([...(value.assets ?? [])]),
      ...(value.channel ? { channel: Object.freeze({ ...value.channel }) } : {}),
      ...(value.http ? { http: Object.freeze({ ...value.http,
        ...(value.http.capabilities ? { capabilities: Object.freeze([...value.http.capabilities]) } : {}),
        legacyRoutes: Object.freeze([...(value.http.legacyRoutes ?? [])].map(route => Object.freeze({ ...route }))),
        selfAuthenticated: Object.freeze([...(value.http.selfAuthenticated ?? [])]) }) } : {}) })
    application.assets.forEach(addAsset)
    for (const prefix of application.http?.selfAuthenticated ?? []) {
      if (!validPath(prefix) || prefix === '/' || (application.http?.legacyRoutes ?? []).some(route => contains(route.prefix, route.stripPrefix + prefix) || contains(route.stripPrefix + prefix, route.prefix))) throw new TypeError(`invalid self-authenticated prefix: ${prefix}`)
    }
    for (const route of application.http?.legacyRoutes ?? []) {
      if (!validPath(route.prefix) || route.prefix === '/' || !validPath(route.stripPrefix) || !contains(route.stripPrefix, route.prefix) ||
          aliases.some(other => contains(other.prefix, route.prefix) || contains(route.prefix, other.prefix)) || /\/products(?:\/|$)|\/apps(?:\/|$)|\/access(?:\/|$)|\/instance$/.test(route.prefix)) throw new TypeError(`invalid or duplicate application route: ${route.prefix}`)
      aliases.push({ ...route, application })
    }
    return application
  })
  for (const route of aliases) if ([...assets.keys()].some(path => contains(route.prefix, path))) throw new TypeError(`asset overlaps application route: ${route.prefix}`)
  for (const app of applications) for (const path of app.definition.web ? [app.definition.web.entry, ...(app.definition.web.styles ?? [])] : []) {
    if (!validPath(path) || !assets.has(path)) throw new TypeError(`unregistered application web asset: ${path}`)
  }
  for (const app of applications) if (app.definition.web && !assets.get(app.definition.web.entry)!.type.startsWith('text/javascript')) throw new TypeError(`invalid web entry MIME type: ${app.definition.web.entry}`)
  return Object.freeze({ applications: Object.freeze(applications), assets,
    route(path: string, base: string) {
      if (!path.startsWith('/') || /[?#\\\0]/.test(path)) return undefined
      if (path.startsWith(base + '/apps/')) {
        const rest = path.slice((base + '/apps/').length), slash = rest.indexOf('/')
        const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
        const application = applications.find(app => app.definition.id === id)
        if (!application?.http) return undefined
        const relative = slash < 0 ? '/' : rest.slice(slash)
        return { application, path: relative, selfAuthenticated: (application.http.selfAuthenticated ?? []).some(prefix => contains(prefix, relative)) }
      }
      // Legacy aliases never reach self-authenticated prefixes: those are only served under the application's own path.
      const route = aliases.find(route => contains(route.prefix, path))
      return route ? { application: route.application, path: path.slice(route.stripPrefix.length) || '/', selfAuthenticated: false } : undefined
    },
  })
}

/** One host owns these lazy factories across Products component restarts. */
export function createApplicationRuntimes(root: Context, catalog: ApplicationCatalog, providers: readonly ApplicationCapabilityProvider[] = []) {
  const instances = new Map<string, ApplicationRuntime>()
  const capabilities = createApplicationCapabilityManager(root, providers)
  let accepting = true
  const requireApplication = (id: string) => {
    const application = catalog.applications.find(app => app.definition.id === id)
    if (!application) throw new Error('unknown application')
    return application
  }
  const createRuntime = (application: ApplicationRegistration): ApplicationRuntime => {
    let current: ApplicationRuntime | undefined, lease: ApplicationCapabilityLease | undefined
    let failure: unknown, blocked = false, acceptingRuntime = true, statuses: readonly ApplicationCapabilityStatus[] | undefined
    let cleanupReportRegistered = false
    let tail: Promise<void> = Promise.resolve()
    const guard = () => { if (!accepting || !acceptingRuntime) throw new Error('application host is closing') }
    const assertCleanup = () => { if (failure && typeof failure === 'object' && 'phase' in failure && failure.phase === 'cleanup') throw failure }
    const retainCleanupFailure = (error: unknown) => {
      failure = error
      if (!cleanupReportRegistered) {
        cleanupReportRegistered = true
        // Custom adapters need not use createApplicationRuntime. Retain their failed stop
        // too, so a later root disposal cannot turn unconfirmed exit into success.
        root.effect(() => () => { throw failure }, 'report unconfirmed application runtime cleanup')
      }
      return error
    }
    const cleanup = async () => {
      assertCleanup()
      try {
        await current?.stop()
        current = undefined
        await lease?.release()
        lease = undefined
      } catch (error) {
        // Even adapters that do not annotate their error cannot authorize a second owner after failed stop.
        throw retainCleanupFailure(Object.assign(new AggregateError([error], 'application cleanup failed'), { phase: 'cleanup' }))
      }
    }
    const open = async () => {
      guard(); assertCleanup()
      if (current) { await current.open(); return }
      failure = undefined; blocked = false
      try {
        lease = await capabilities.acquire(application.capabilityRequirements)
        statuses = lease.statuses
        guard()
        if (statuses.some(status => status.required && status.status !== 'ready')) {
          blocked = true; await lease.release(); lease = undefined; return
        }
        // Capability selection finishes before an application can initialize any business resources.
        current = application.createRuntime!(root, Object.freeze({ capabilities: lease.capabilities }))
        guard()
        await current.open()
        guard()
      } catch (error) {
        if (error && typeof error === 'object' && 'phase' in error && error.phase === 'cleanup') throw retainCleanupFailure(error)
        // During whole-host shutdown Nya owns disposal. Do not wait here for live business work
        // whose cancellation is driven by that root disposal.
        if (!accepting || !acceptingRuntime) { failure = error; throw error }
        await cleanup()
        failure = error; throw error
      }
    }
    const queue = (work: () => Promise<void>) => {
      if (!accepting || !acceptingRuntime) return Promise.reject(new Error('application host is closing'))
      const task = tail.then(() => { guard(); return work() }); tail = task.catch(() => {}); return task
    }
    const inspectCapabilities = () => lease?.inspect() ?? statuses ?? capabilities.inspect(application.capabilityRequirements)
    return {
      open: () => queue(open),
      stop: () => queue(async () => { await cleanup(); failure = undefined; blocked = false; statuses = undefined }),
      retry: () => queue(async () => { await cleanup(); failure = undefined; blocked = false; statuses = undefined; await open() }),
      inspect() {
        if (failure) return 'failed'
        if (blocked) return 'blocked'
        if (!current) return 'disabled'
        const state = current.inspect()
        if (state === 'failed') return state
        return lease?.inspect().some(capability => capability.required && capability.status !== 'ready') ? 'blocked' : state
      },
      capabilities: inspectCapabilities,
      closeAdmission() { acceptingRuntime = false; current?.closeAdmission() },
      async awaitIdle() { await tail; await current?.awaitIdle() },
    }
  }
  return {
    get(id: string): ApplicationRuntime | undefined {
      if (!accepting) throw new Error('application host is closing')
      const application = requireApplication(id)
      if (!application.createRuntime) return undefined
      let runtime = instances.get(id)
      if (!runtime) { runtime = createRuntime(application); instances.set(id, runtime) }
      return runtime
    },
    capabilities(id: string): readonly ApplicationCapabilityStatus[] {
      const application = requireApplication(id)
      return instances.get(id)?.capabilities?.() ?? capabilities.inspect(application.capabilityRequirements)
    },
    closeAdmission() {
      accepting = false
      capabilities.closeAdmission()
      const errors: unknown[] = []
      for (const runtime of instances.values()) { try { runtime.closeAdmission() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'application admission shutdown failed')
    },
    async awaitIdle() { await Promise.all([...instances.values()].map(runtime => runtime.awaitIdle())); await capabilities.awaitIdle() },
  }
}

import type { Context } from '@nya/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApplicationRuntime, ProductDefinition } from './contracts.js'

export interface ApplicationAsset { readonly path: string; readonly file: string; readonly type: string }
export interface ApplicationHttpContext { readonly signal: AbortSignal; readonly actorId: string; readonly appId: string; retainUntil(done: Promise<unknown>): void }
/** handle resolves after owned requests/streams exit, not merely after writing response headers. */
export interface ApplicationHttpPort {
  capabilities?(): readonly string[]
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>
}
export interface ApplicationRegistration {
  readonly definition: ProductDefinition
  readonly createRuntime: (root: Context) => ApplicationRuntime
  readonly http?: {
    readonly service: string
    readonly capabilities?: readonly string[]
    readonly legacyRoutes?: readonly { readonly prefix: string; readonly stripPrefix: string }[]
  }
  readonly assets?: readonly ApplicationAsset[]
}
export interface ApplicationCatalog {
  readonly applications: readonly ApplicationRegistration[]
  readonly assets: ReadonlyMap<string, ApplicationAsset>
  route(path: string, base: string): { application: ApplicationRegistration; path: string } | undefined
}
const validPath = (path: string) => path.startsWith('/') && !path.startsWith('//') && !/[?#\\\0]/.test(path) && !path.split('/').some(part => {
  try { const decoded = decodeURIComponent(part); return decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded) } catch { return true }
})
const contains = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + '/')
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
    const definition: ProductDefinition = Object.freeze({ id, name, icon, ...(description ? { description } : {}), ...(web ? { web: Object.freeze({ entry: web.entry,
      ...(web.styles ? { styles: Object.freeze([...web.styles]) } : {}), ...(web.legacyRoutes ? { legacyRoutes: Object.freeze([...web.legacyRoutes]) } : {}) }) } : {}) })
    const application = Object.freeze({ ...value, definition, assets: Object.freeze([...(value.assets ?? [])]),
      ...(value.http ? { http: Object.freeze({ ...value.http,
        ...(value.http.capabilities ? { capabilities: Object.freeze([...value.http.capabilities]) } : {}),
        legacyRoutes: Object.freeze([...(value.http.legacyRoutes ?? [])].map(route => Object.freeze({ ...route }))) }) } : {}) })
    application.assets.forEach(addAsset)
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
        return application?.http ? { application, path: slash < 0 ? '/' : rest.slice(slash) } : undefined
      }
      const route = aliases.find(route => contains(route.prefix, path))
      return route ? { application: route.application, path: path.slice(route.stripPrefix.length) || '/' } : undefined
    },
  })
}

/** One host owns these lazy factories across Products component restarts. */
export function createApplicationRuntimes(root: Context, catalog: ApplicationCatalog) {
  const instances = new Map<string, ApplicationRuntime>()
  let accepting = true
  return {
    get(id: string): ApplicationRuntime {
      if (!accepting) throw new Error('application host is closing')
      const application = catalog.applications.find(app => app.definition.id === id)
      if (!application) throw new Error('unknown application')
      let runtime = instances.get(id)
      if (!runtime) { runtime = application.createRuntime(root); instances.set(id, runtime) }
      return runtime
    },
    closeAdmission() {
      accepting = false
      const errors: unknown[] = []
      for (const runtime of instances.values()) { try { runtime.closeAdmission() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'application admission shutdown failed')
    },
    async awaitIdle() { await Promise.all([...instances.values()].map(runtime => runtime.awaitIdle())) },
  }
}

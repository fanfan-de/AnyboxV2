import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createApplicationApiComponent, hostHttpServiceKey } from './component.js'
import type { ApplicationHttpServer } from './http-server.js'
import { createHostAccessComponent, hostAccessServiceKey } from './access.js'
import type { HostAccessPort } from './access.js'
import { createProductActivityComponent } from './applications/activity.js'
import { createProductsComponent } from './applications/component.js'
import { productActivityServiceKey, productsServiceKey } from './applications/contracts.js'
import type { ProductActivityPort, ProductsPort } from './applications/contracts.js'
import { createApplicationCatalog, createApplicationRuntimes } from './applications/registration.js'
import type { ApplicationRegistration } from './applications/registration.js'

export interface ExecutionHostOptions {
  readonly applications: readonly ApplicationRegistration[]
  readonly databasePath: string
  readonly port?: number
  readonly name?: string
  readonly host?: string
}

/** Owns one execution root; the trusted composition entry supplies its application catalog. */
export async function createExecutionHost(options: ExecutionHostOptions) {
  const root = new Context()
  const catalog = createApplicationCatalog(options.applications)
  const runtime = createApplicationRuntimes(root, catalog)
  let products: ProductsPort | undefined, activity: ProductActivityPort | undefined
  let closing: Promise<void> | undefined, restoring: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    const admissionErrors: unknown[] = []
    const attempt = <T>(work: () => T): T | undefined => { try { return work() } catch (error) { admissionErrors.push(error) } }
    const stopping = attempt(() => products?.stop())
    attempt(() => activity?.stop())
    attempt(() => runtime.closeAdmission())
    const requests = attempt(() => root.get<ApplicationHttpServer>(hostHttpServiceKey)?.close())
    closing = (async () => {
      const results = await Promise.allSettled([stopping, runtime.awaitIdle(), restoring, requests])
      try { await root.fiber.dispose() } catch (error) { results.push({ status: 'rejected', reason: error }) }
      const errors = [...admissionErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Application shutdown failed')
    })()
    return closing
  }
  try {
    await root.installComponent(createLocalSqliteComponent(options.databasePath))
    await root.installComponent(createHostAccessComponent(options.name))
    await root.installComponent(createProductActivityComponent())
    activity = root.get<ProductActivityPort>(productActivityServiceKey)!
    await root.installComponent(createProductsComponent({ directory: catalog.applications.map(app => app.definition), runtime: id => runtime.get(id) }))
    products = root.get<ProductsPort>(productsServiceKey)!
    await root.installComponent(createApplicationApiComponent(root, catalog, options.port, { authenticated: true, host: options.host }))
    restoring = products.restore()
    void restoring.catch(() => root.logger.warn('Application product restoration failed'))
    const web = root.get<ApplicationHttpServer>(hostHttpServiceKey)!
    const access = root.get<HostAccessPort>(hostAccessServiceKey)!
    return { root, products, ready: restoring, url: web.url, instance: access.instance, get closing() { return !!closing }, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Application startup and cleanup failed') }
    throw error
  }
}

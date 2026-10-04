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
  let products: ProductsPort | undefined
  let preparingClose: Promise<void> | undefined, closing: Promise<void> | undefined, restoring: Promise<void> | undefined, drainingRequests: Promise<void> | undefined
  let admissionClosed = false
  const prepareClose = () => {
    if (preparingClose) return preparingClose
    admissionClosed = true
    const admissionErrors: unknown[] = []
    const attempt = <T>(work: () => T): T | undefined => { try { return work() } catch (error) { admissionErrors.push(error) } }
    const stopping = attempt(() => root.get<ProductsPort>(productsServiceKey)?.stop())
    attempt(() => root.get<ProductActivityPort>(productActivityServiceKey)?.stop())
    attempt(() => runtime.closeAdmission())
    drainingRequests = attempt(() => root.get<ApplicationHttpServer>(hostHttpServiceKey)?.close())
    // Retained Run leases exit during root cleanup, so preparation must not join their HTTP drain.
    void drainingRequests?.catch(() => {})
    preparingClose = Promise.allSettled([stopping, runtime.awaitIdle(), restoring]).then(results => {
      const errors = [...admissionErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Application admission shutdown failed')
    })
    return preparingClose
  }
  const close = () => closing ??= (async () => {
    const errors: unknown[] = []
    try { await prepareClose() } catch (error) { errors.push(error) }
    const results = await Promise.allSettled([root.fiber.dispose(), drainingRequests])
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Application shutdown failed')
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(options.databasePath))
    await root.installComponent(createHostAccessComponent(options.name))
    await root.installComponent(createProductActivityComponent())
    await root.installComponent(createProductsComponent({ directory: catalog.applications.map(app => app.definition), runtime: id => runtime.get(id) }))
    products = root.get<ProductsPort>(productsServiceKey)!
    await root.installComponent(createApplicationApiComponent(root, catalog, options.port, { authenticated: true, host: options.host }))
    restoring = products.restore()
    void restoring.catch(() => root.logger.warn('Application product restoration failed'))
    const web = root.get<ApplicationHttpServer>(hostHttpServiceKey)!
    const access = root.get<HostAccessPort>(hostAccessServiceKey)!
    return { root, products, ready: restoring, url: web.url, instance: access.instance, get closing() { return admissionClosed }, prepareClose, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Application startup and cleanup failed') }
    throw error
  }
}

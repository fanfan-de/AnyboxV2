import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createClientShellComponent, clientShellServiceKey } from './client-http.js'
import type { ClientShell } from './client-http.js'
import { createApplicationCatalog, createApplicationRuntimes } from './applications/registration.js'
import type { ApplicationRegistration } from './applications/registration.js'
import { shellAssets } from './assets.js'
import { createProductsComponent } from './applications/component.js'
import { createProductActivityComponent } from './applications/activity.js'
import { productsServiceKey, productActivityServiceKey } from './applications/contracts.js'
import type { ProductsPort, ProductActivityPort } from './applications/contracts.js'

export interface ClientHostOptions {
  readonly applications: readonly ApplicationRegistration[]
  readonly path: string
  readonly port?: number
  readonly transportSecret?: string
}

/** Owns the client root and shell without choosing an application. */
export async function createClientHost(options: ClientHostOptions) {
  const root = new Context()
  const catalog = createApplicationCatalog(options.applications, shellAssets)
  const runtime = createApplicationRuntimes(root, catalog)
  let products: ProductsPort | undefined
  let preparingClose: Promise<void> | undefined, closing: Promise<void> | undefined, drainingRequests: Promise<void> | undefined
  const prepareClose = () => {
    if (preparingClose) return preparingClose
    const admissionErrors: unknown[] = []
    const attempt = <T>(work: () => T): T | undefined => { try { return work() } catch (error) { admissionErrors.push(error) } }
    const stopping = attempt(() => root.get<ProductsPort>(productsServiceKey)?.stop())
    attempt(() => root.get<ProductActivityPort>(productActivityServiceKey)?.stop())
    attempt(() => runtime.closeAdmission())
    drainingRequests = attempt(() => root.get<ClientShell>(clientShellServiceKey)?.close())
    // HTTP can retain a Run until root cleanup cancels it; observe errors now, join after preparation.
    void drainingRequests?.catch(() => {})
    preparingClose = Promise.allSettled([stopping, runtime.awaitIdle()]).then(results => {
      const errors = [...admissionErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Client admission shutdown failed')
    })
    return preparingClose
  }
  const close = () => closing ??= (async () => {
    const errors: unknown[] = []
    try { await prepareClose() } catch (error) { errors.push(error) }
    const results = await Promise.allSettled([root.fiber.dispose(), drainingRequests])
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Client shutdown failed')
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(options.path))
    await root.installComponent(createProductActivityComponent())
    await root.installComponent(createProductsComponent({ directory: catalog.applications.map(app => app.definition), runtime: id => runtime.get(id), restoreLegacyAgent: false }))
    products = root.get<ProductsPort>(productsServiceKey)!
    await root.installComponent(createClientShellComponent(root, catalog, options.port, { transportSecret: options.transportSecret }))
    await products.restore()
    const server = root.get<ClientShell>(clientShellServiceKey)!
    return { root, products, url: server.url, prepareClose, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Client startup and cleanup failed') }
    throw error
  }
}

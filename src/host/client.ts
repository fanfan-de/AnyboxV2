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
}

/** Owns the client root and shell without choosing an application. */
export async function createClientHost(options: ClientHostOptions) {
  const root = new Context()
  const catalog = createApplicationCatalog(options.applications, shellAssets)
  const runtime = createApplicationRuntimes(root, catalog)
  let products: ProductsPort | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    const admissionErrors: unknown[] = []
    const attempt = <T>(work: () => T): T | undefined => { try { return work() } catch (error) { admissionErrors.push(error) } }
    const stopping = attempt(() => products?.stop())
    attempt(() => root.get<ProductActivityPort>(productActivityServiceKey)?.stop())
    attempt(() => runtime.closeAdmission())
    const requests = attempt(() => root.get<ClientShell>(clientShellServiceKey)?.close())
    const results = await Promise.allSettled([stopping, runtime.awaitIdle(), requests])
    try { await root.fiber.dispose() } catch (error) { results.push({ status: 'rejected', reason: error }) }
    const errors = [...admissionErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
    if (errors.length) throw new AggregateError(errors, 'Client shutdown failed')
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(options.path))
    await root.installComponent(createProductActivityComponent())
    await root.installComponent(createProductsComponent({ directory: catalog.applications.map(app => app.definition), runtime: id => runtime.get(id), restoreLegacyAgent: false }))
    products = root.get<ProductsPort>(productsServiceKey)!
    await root.installComponent(createClientShellComponent(root, catalog, options.port))
    await products.restore()
    const server = root.get<ClientShell>(clientShellServiceKey)!
    return { root, products, url: server.url, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Client startup and cleanup failed') }
    throw error
  }
}

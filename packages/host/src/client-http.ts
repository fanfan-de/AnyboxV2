import type { Context, Component } from '@nya/core'
import type { ApplicationCatalog } from './applications/registration.js'
import type { ApplicationHttpPort } from '@anybox/application-api/node'
import { productsServiceKey, productActivityServiceKey } from '@anybox/application-api'
import type { ProductsPort, ProductActivityPort } from '@anybox/application-api'
import { startApplicationHttpServer } from './http-server.js'
import type { ApplicationHttpServer } from './http-server.js'
import type { PackageManagementAccess } from './package-management/api.js'
export const clientShellServiceKey = 'app.client-http'
export type ClientShell = ApplicationHttpServer
export function createClientShellComponent(root: Context, catalog: ApplicationCatalog, port?: number, options: { transportSecret?: string; packageManagement?: () => PackageManagementAccess } = {}): Component.Object<void, {
  [productsServiceKey]: ProductsPort; [productActivityServiceKey]: ProductActivityPort
}> {
  let listenPort = port
  return { name: 'app-client-http', inject: [productsServiceKey, productActivityServiceKey], async apply(ctx, _config, deps) {
    let server: ClientShell | undefined
    ctx.effect(() => async () => { await server?.close() }, 'stop and join application shell HTTP')
    server = await startApplicationHttpServer({ catalog, port: listenPort, base: '/api/client/v1', products: deps[productsServiceKey],
      activity: deps[productActivityServiceKey], service: key => root.get<ApplicationHttpPort>(key), transportSecret: options.transportSecret, packageManagement: options.packageManagement })
    listenPort = Number(new URL(server.url).port)
    ctx.provide(clientShellServiceKey, server)
  } }
}

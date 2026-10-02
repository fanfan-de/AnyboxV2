import type { Context, Component } from '@nya/core'
import type { ApplicationCatalog, ApplicationHttpPort } from './applications/registration.js'
import { productsServiceKey, productActivityServiceKey } from './applications/contracts.js'
import type { ProductsPort, ProductActivityPort } from './applications/contracts.js'
import { startApplicationHttpServer } from './http-server.js'
import type { ApplicationHttpServer } from './http-server.js'
export const clientShellServiceKey = 'app.client-http'
export type ClientShell = ApplicationHttpServer
export function createClientShellComponent(root: Context, catalog: ApplicationCatalog, port?: number): Component.Object<void, {
  [productsServiceKey]: ProductsPort; [productActivityServiceKey]: ProductActivityPort
}> {
  let listenPort = port
  return { name: 'app-client-http', inject: [productsServiceKey, productActivityServiceKey], async apply(ctx, _config, deps) {
    let server: ClientShell | undefined
    ctx.effect(() => async () => { await server?.close() }, 'stop and join application shell HTTP')
    server = await startApplicationHttpServer({ catalog, port: listenPort, base: '/api/client/v1', products: deps[productsServiceKey],
      activity: deps[productActivityServiceKey], service: key => root.get<ApplicationHttpPort>(key) })
    listenPort = Number(new URL(server.url).port)
    ctx.provide(clientShellServiceKey, server)
  } }
}

import type { Component, Context } from '@nya/core'
import { productsServiceKey, productActivityServiceKey } from './applications/contracts.js'
import type { ProductsPort, ProductActivityPort } from './applications/contracts.js'
import type { ApplicationCatalog, ApplicationHttpPort } from './applications/registration.js'
import { hostAccessServiceKey } from './access.js'
import type { HostAccessPort } from './access.js'
import { startApplicationHttpServer } from './http-server.js'
import type { ApplicationHttpServer } from './http-server.js'
export const hostHttpServiceKey = 'host.http'
export function createApplicationApiComponent(root: Context, catalog: ApplicationCatalog, port = 0,
  options: { authenticated?: boolean; host?: string } = {}): Component.Object<void, {
    [productsServiceKey]: ProductsPort; [productActivityServiceKey]: ProductActivityPort; [hostAccessServiceKey]: HostAccessPort
  }> {
  let listenPort = port
  return { name: 'host-application-api', inject: [productsServiceKey, productActivityServiceKey, ...(options.authenticated ? [hostAccessServiceKey] : [])],
    async apply(ctx, _config, deps) {
      let server: ApplicationHttpServer | undefined
      ctx.effect(() => async () => { await server?.close() }, 'stop and join application HTTP requests')
      server = await startApplicationHttpServer({ catalog, service: key => root.get<ApplicationHttpPort>(key), port: listenPort, host: options.host,
        products: deps[productsServiceKey], activity: deps[productActivityServiceKey], access: options.authenticated ? deps[hostAccessServiceKey] : undefined })
      listenPort = Number(new URL(server.url).port)
      ctx.provide(hostHttpServiceKey, server)
    },
  }
}

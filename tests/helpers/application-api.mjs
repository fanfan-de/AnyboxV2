import { createApplicationApiComponent } from '../../packages/host/dist/component.js'
import { createHarnessServerHttpComponent } from '../../packages/app-harness/dist/http/harness-http.js'
import { createProductActivity } from '../../packages/host/dist/applications/activity.js'
import { createApplicationCatalog } from '../../packages/host/dist/applications/registration.js'
import { harnessDefinition, harnessServerHttp } from '../../packages/app-harness/dist/registration.js'
import { productsServiceKey, productActivityServiceKey } from '../../packages/application-api/dist/index.js'
import { hostAccessServiceKey } from '../../packages/application-api/dist/node.js'

/** Fixtures install one enabled Harness; production uses the persistent controller. */
export function createFixtureApplicationApiComponent(root, agents, port = 0, options = {}) {
  if (!root.get(productsServiceKey)) {
    const product = Object.freeze({ definition: harnessDefinition, desiredEnabled: true, state: 'running' })
    root.provide(productsServiceKey, {
      list: () => [product], get: id => id === 'agent' ? product : undefined,
      authorize(id) { if (id !== 'agent') throw Object.assign(new Error('product-not-found'), { status: 404, code: 'product-not-found' }) },
    })
    root.provide(productActivityServiceKey, createProductActivity())
  }
  const catalog = createApplicationCatalog([{ definition: harnessDefinition, http: harnessServerHttp,
    createRuntime() { throw new Error('fixture already installed') } }])
  return { name: 'test-http-installation', async apply(ctx) {
    let handler, listener
    ctx.effect(() => async () => { await listener?.dispose(); await handler?.dispose() })
    handler = root.installComponent(createHarnessServerHttpComponent(root, agents, {
      inject: [productActivityServiceKey, ...(options.authenticated ? [hostAccessServiceKey] : [])],
      resolve: deps => ({
        activity: deps[productActivityServiceKey],
        instanceId: () => deps[hostAccessServiceKey]?.instance.instanceId ?? null,
        ...(options.authenticated ? { onRevoked: callback => deps[hostAccessServiceKey].onRevoked(callback) } : {}),
      }),
    })); await handler
    listener = root.installComponent(createApplicationApiComponent(root, catalog, port, options)); await listener
  } }
}

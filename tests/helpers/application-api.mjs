import { createApplicationApiComponent } from '../../dist/host/component.js'
import { createHarnessHttpComponent } from '../../dist/applications/harness/http/harness-http.js'
import { createProductActivity } from '../../dist/host/applications/activity.js'
import { createApplicationCatalog } from '../../dist/host/applications/registration.js'
import { harnessDefinition, harnessExecutionHttp } from '../../dist/applications/harness/registration.js'
import { productsServiceKey, productActivityServiceKey } from '../../dist/host/applications/contracts.js'

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
  const catalog = createApplicationCatalog([{ definition: harnessDefinition, http: harnessExecutionHttp,
    createRuntime() { throw new Error('fixture already installed') } }])
  return { name: 'test-http-installation', async apply(ctx) {
    let handler, listener
    ctx.effect(() => async () => { await listener?.dispose(); await handler?.dispose() })
    handler = root.installComponent(createHarnessHttpComponent(root, agents, options)); await handler
    listener = root.installComponent(createApplicationApiComponent(root, catalog, port, options)); await listener
  } }
}

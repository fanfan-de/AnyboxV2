import { createHarnessGateway } from '../../packages/app-harness/dist/client/gateway.js'
import { startApplicationHttpServer } from '../../packages/host/dist/http-server.js'
import { createApplicationCatalog } from '../../packages/host/dist/applications/registration.js'
import { harnessClientApplication } from '../../packages/app-harness/dist/client/registration.js'
import { shellAssets } from '../../packages/host/dist/assets.js'

export async function startClientGateway(connections, options = {}) {
  const gateway = createHarnessGateway(connections, options)
  const catalog = createApplicationCatalog([harnessClientApplication()], shellAssets)
  const server = await startApplicationHttpServer({ ...options, base: '/api/client/v1', catalog, service: () => gateway })
  return { ...server, async close() { await server.close(); await gateway.close() } }
}

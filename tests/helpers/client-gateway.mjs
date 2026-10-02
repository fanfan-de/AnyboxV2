import { createHarnessGateway } from '../../dist/applications/harness/client/gateway.js'
import { startApplicationHttpServer } from '../../dist/host/http-server.js'
import { createApplicationCatalog } from '../../dist/host/applications/registration.js'
import { harnessClientApplication } from '../../dist/applications/harness/registration.js'
import { shellAssets } from '../../dist/host/assets.js'

export async function startClientGateway(connections, options = {}) {
  const gateway = createHarnessGateway(connections, options)
  const catalog = createApplicationCatalog([harnessClientApplication()], shellAssets)
  const server = await startApplicationHttpServer({ ...options, base: '/api/client/v1', catalog, service: () => gateway })
  return { ...server, async close() { await server.close(); await gateway.close() } }
}

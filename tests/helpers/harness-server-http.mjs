import { createHarnessServerHttpHandler } from '../../packages/app-harness/dist/http/handler.js'
import { startApplicationHttpServer } from '../../packages/host/dist/http-server.js'
import { createApplicationCatalog } from '../../packages/host/dist/applications/registration.js'
import { harnessDefinition, harnessServerHttp } from '../../packages/app-harness/dist/registration.js'

// Exercise the registered adapter and the same generic listener as production.
export async function startHarnessServerHttp(commands, port = 0, options = {}) {
  const handler = createHarnessServerHttpHandler(commands, { ...options, onRevoked: options.access?.onRevoked })
  const catalog = createApplicationCatalog([{ definition: harnessDefinition, http: harnessServerHttp,
    createRuntime() { throw new Error('fixture already installed') } }])
  const server = await startApplicationHttpServer({ ...options, port, catalog, service: () => handler })
  return { ...server, notifyRunChange: handler.notifyRunChange, notifyProtocolView: handler.notifyProtocolView,
    async close() { await server.close(); await handler.close() } }
}

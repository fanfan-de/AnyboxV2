import { createHarnessHttpHandler } from '../../dist/applications/harness/http/server.js'
import { startApplicationHttpServer } from '../../dist/host/http-server.js'
import { createApplicationCatalog } from '../../dist/host/applications/registration.js'
import { harnessDefinition, harnessExecutionHttp } from '../../dist/applications/harness/registration.js'

// Exercise the registered adapter and the same generic listener as production.
export async function startHarnessApiServer(commands, port = 0, options = {}) {
  const handler = createHarnessHttpHandler(commands, { ...options, onRevoked: options.access?.onRevoked })
  const catalog = createApplicationCatalog([{ definition: harnessDefinition, http: harnessExecutionHttp,
    createRuntime() { throw new Error('fixture already installed') } }])
  const server = await startApplicationHttpServer({ ...options, port, catalog, service: () => handler })
  return { ...server, notifyRunChange: handler.notifyRunChange, notifyProtocolView: handler.notifyProtocolView,
    async close() { await server.close(); await handler.close() } }
}

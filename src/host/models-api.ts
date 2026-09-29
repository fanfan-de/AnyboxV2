import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveCatalogConnections } from '@anybox/models'
import type { ProviderInput, ModelInput, ProviderConnectionInput, ModelConfigurationInput } from '@anybox/models'
import type { HarnessApiCommands } from './server.js'
import { json, requestObject, promptRevision, failure } from './http-utils.js'
export async function handleModelsApi(commands: HarnessApiCommands, request: IncomingMessage, response: ServerResponse, url: URL,
  modelRequest: <T>(response: ServerResponse, work: (signal: AbortSignal) => Promise<T>) => Promise<T>): Promise<boolean> {
  const method = request.method, path = url.pathname
      if (method === 'GET' && path === '/api/v1/models') { json(response, 200, commands.listModels()); return true }
      if (method === 'GET' && path === '/api/v1/models/templates') { json(response, 200, commands.modelTemplates()); return true }
      if (method === 'GET' && path === '/api/v1/models/protocols') { json(response, 200, commands.modelsSettings.protocols()); return true }
      if (method === 'GET' && path === '/api/v1/models/catalog') { json(response, 200, commands.modelsCatalog.status()); return true }
      if (method === 'POST' && path === '/api/v1/models/catalog/refresh') {
        await requestObject(request, [])
        json(response, 200, await modelRequest(response, signal => commands.modelsCatalog.refresh(signal))); return true
      }
      const definitionQuery = () => {
        const boolean = (name: string) => {
          const value = url.searchParams.get(name)
          if (value !== null && !['true', 'false'].includes(value)) throw failure(400, 'invalid-input')
          return value === null ? undefined : value === 'true'
        }
        return { sourceId: url.searchParams.get('sourceId') ?? undefined, providerId: url.searchParams.get('providerId') ?? undefined,
          search: url.searchParams.get('search') ?? undefined, includeDeprecated: boolean('includeDeprecated'), includeMissing: boolean('includeMissing'), textOnly: boolean('textOnly') }
      }
      if (path === '/api/v1/models/providers') {
        if (method === 'GET') {
          const protocols = commands.modelsSettings.protocols(), templates = commands.modelTemplates()
          json(response, 200, commands.modelsSettings.providers(definitionQuery()).map(provider => ({
            ...provider, connections: resolveCatalogConnections(provider, protocols, templates),
          }))); return true
        }
        if (method === 'POST') {
          const body = await requestObject(request, ['id', 'name', 'documentationUrl', 'connectionHints'])
          json(response, 200, await commands.modelsSettings.createProvider(body as unknown as ProviderInput)); return true
        }
      }
      const definitionProviderMatch = /^\/api\/v1\/models\/providers\/([^/]+)(?:\/(history))?$/.exec(path)
      if (definitionProviderMatch) {
        const id = decodeURIComponent(definitionProviderMatch[1])
        if (method === 'GET' && definitionProviderMatch[2] === 'history') { json(response, 200, commands.modelsSettings.providerHistory(id)); return true }
        if (method === 'POST' && !definitionProviderMatch[2]) {
          const body = await requestObject(request, ['patch', 'expectedRevision'])
          json(response, 200, await commands.modelsSettings.updateProvider(id, body.patch as Partial<ProviderInput>, promptRevision(body.expectedRevision))); return true
        }
      }
      if (path === '/api/v1/models/definitions') {
        if (method === 'GET') {
          const providers = commands.modelsSettings.providers({ includeMissing: true }), protocols = commands.modelsSettings.protocols(), templates = commands.modelTemplates()
          json(response, 200, commands.modelsSettings.models(definitionQuery()).map(model => {
            const provider = providers.find(provider => provider.id === model.providerId)
            return { ...model, connections: provider ? resolveCatalogConnections(provider, protocols, templates, model) : [] }
          })); return true
        }
        if (method === 'POST') {
          const body = await requestObject(request, ['id', 'providerId', 'remoteModelId', 'name', 'description', 'family', 'releaseDate', 'lastUpdated', 'status', 'openWeights', 'modelType', 'capabilities', 'controls', 'modalities', 'limits', 'cost', 'connectionHints'])
          json(response, 200, await commands.modelsSettings.createModel(body as unknown as ModelInput)); return true
        }
      }
      const definitionModelMatch = /^\/api\/v1\/models\/definitions\/([^/]+)(?:\/(history))?$/.exec(path)
      if (definitionModelMatch) {
        const id = decodeURIComponent(definitionModelMatch[1])
        if (method === 'GET' && definitionModelMatch[2] === 'history') { json(response, 200, commands.modelsSettings.modelHistory(id)); return true }
        if (method === 'POST' && !definitionModelMatch[2]) {
          const body = await requestObject(request, ['patch', 'expectedRevision'])
          json(response, 200, await commands.modelsSettings.updateModel(id, body.patch as Partial<ModelInput>, promptRevision(body.expectedRevision))); return true
        }
      }
      if (path === '/api/v1/models/connections') {
        if (method === 'GET') { json(response, 200, commands.modelsSettings.connections()); return true }
        if (method === 'POST') {
          const body = await requestObject(request, ['id', 'providerDefinitionId', 'name', 'enabled', 'protocolId', 'baseUrl', 'auth', 'timeoutMs', 'apiKey'])
          json(response, 200, await commands.modelsSettings.createConnection(body as unknown as ProviderConnectionInput)); return true
        }
      }
      const connectionMatch = /^\/api\/v1\/models\/connections\/([^/]+)(?:\/(history|models|retry|key|key\/delete|delete|discover|check))?$/.exec(path)
      if (connectionMatch) {
        const id = decodeURIComponent(connectionMatch[1]), action = connectionMatch[2]
        if (method === 'GET' && action === 'history') { json(response, 200, commands.modelsSettings.connectionHistory(id)); return true }
        if (method === 'GET' && action === 'models') { json(response, 200, commands.modelsSettings.connectionModels(id)); return true }
        if (method === 'POST') {
          if (!action) {
            const body = await requestObject(request, ['patch', 'expectedRevision'])
            json(response, 200, await commands.modelsSettings.updateConnection(id, body.patch as Partial<ProviderConnectionInput>, promptRevision(body.expectedRevision))); return true
          }
          if (action === 'key') {
            const body = await requestObject(request, ['apiKey', 'expectedRevision'])
            json(response, 200, await commands.modelsSettings.setApiKey(id, body.apiKey as string, promptRevision(body.expectedRevision))); return true
          }
          if (action === 'key/delete') {
            const body = await requestObject(request, ['expectedRevision'])
            json(response, 200, await commands.modelsSettings.deleteApiKey(id, promptRevision(body.expectedRevision))); return true
          }
          if (action === 'delete') {
            const body = await requestObject(request, ['expectedRevision'])
            await commands.modelsSettings.deleteConnection(id, promptRevision(body.expectedRevision))
            json(response, 200, { ok: true }); return true
          }
          if (action === 'retry') {
            await requestObject(request, [])
            json(response, 200, await commands.modelsSettings.retryConnection(id)); return true
          }
          if (action === 'discover' || action === 'check') {
            await requestObject(request, [])
            json(response, 200, await modelRequest<unknown>(response, signal => action === 'discover'
              ? commands.modelsSettings.discoverModels(id, signal)
              : commands.modelsSettings.checkConnection(id, signal).then(() => ({ ok: true })))); return true
          }
        }
      }
      if (path === '/api/v1/models/configurations') {
        if (method === 'GET') { json(response, 200, commands.modelsSettings.configurations(url.searchParams.get('connectionId') ?? undefined)); return true }
        if (method === 'POST') {
          const body = await requestObject(request, ['id', 'modelDefinitionId', 'connectionId', 'name', 'enabled', 'capabilities', 'parameters', 'baseline'])
          json(response, 200, await commands.modelsSettings.createConfiguration(body as unknown as ModelConfigurationInput)); return true
        }
      }
      const configurationMatch = /^\/api\/v1\/models\/configurations\/([^/]+)(?:\/(history))?$/.exec(path)
      if (configurationMatch) {
        const id = decodeURIComponent(configurationMatch[1])
        if (method === 'GET' && configurationMatch[2] === 'history') { json(response, 200, commands.modelsSettings.configurationHistory(id)); return true }
        if (method === 'POST' && !configurationMatch[2]) {
          const body = await requestObject(request, ['patch', 'expectedRevision'])
          json(response, 200, await commands.modelsSettings.updateConfiguration(id, body.patch as Partial<ModelConfigurationInput>, promptRevision(body.expectedRevision))); return true
        }
      }
  return false
}

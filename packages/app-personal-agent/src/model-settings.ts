import { failure } from '@anybox/application-api/node'
import { unknownCapabilities } from '@anybox/models'
import type { ModelsService, ModelsSettingsService } from '@anybox/models'
import type { ModelState } from './contracts.js'

export function personalAgentModelState(models: ModelsService, settings: ModelsSettingsService): ModelState {
  return {
    models: models.list().map(model => ({
      id: model.id, name: model.name, protocolId: model.parameters.protocolId,
      available: model.available, ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
    })),
    connections: settings.connections().map(connection => ({
      id: connection.id, name: connection.name, protocolId: connection.protocolId,
      baseUrl: connection.baseUrl, revision: connection.revision, credentialConfigured: connection.credentialConfigured,
    })),
  }
}
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure(400, 'invalid-input')
  return value.trim()
}

/** Manual, application-owned setup. Models validates/persists definitions, configuration and Vault intents. */
export async function addPersonalAgentModel(settings: ModelsSettingsService, body: Record<string, unknown>): Promise<void> {
  const name = text(body.name, 120), remoteModelId = text(body.remoteModelId, 512)
  const protocolId = text(body.protocolId, 60), baseUrl = text(body.baseUrl, 2048)
  if (!['responses', 'chat-completions', 'anthropic-messages', 'gemini-interactions'].includes(protocolId) ||
      !settings.protocols().some(protocol => protocol.id === protocolId)) throw failure(400, 'invalid-config')
  let address: URL
  try { address = new URL(baseUrl) } catch { throw failure(400, 'invalid-config') }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.hash || address.search ||
      /\/(?:responses|chat\/completions|messages|interactions)\/?$/.test(address.pathname)) throw failure(400, 'invalid-config')
  const auth = body.auth
  if (auth !== 'api-key' && auth !== 'none') throw failure(400, 'invalid-input')
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 16_384)) throw failure(400, 'invalid-input')
  if (auth === 'none' && body.apiKey !== undefined) throw failure(400, 'invalid-input')
  const connectionHints = { baseUrl, protocolIds: [protocolId] }
  const provider = await settings.createProvider({ name, connectionHints })
  await settings.createModel({
    providerId: provider.id, remoteModelId, name, connectionHints,
    capabilities: unknownCapabilities(), controls: { temperature: 'unknown' },
    modalities: { input: ['text'], output: ['text'] }, limits: {},
  })
  // Keep editable non-secret metadata if the OS Vault is unavailable; never fall back to a file.
  const connection = await settings.createConnection({
    providerDefinitionId: provider.id, name, protocolId, baseUrl, auth, enabled: true, timeoutMs: 120_000,
  })
  if (body.apiKey !== undefined) await settings.setApiKey(connection.id, body.apiKey as string, connection.revision)
  await settings.retryConnection(connection.id)
}

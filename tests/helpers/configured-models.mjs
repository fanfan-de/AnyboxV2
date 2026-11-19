/** Explicit disposable Models configuration for tests that exercise model calls. */
export async function seedHarnessModel(settings, options = {}) {
  const id = options.id ?? 'default'
  const protocolId = options.protocolId ?? 'chat-completions'
  const baseUrl = options.baseUrl ?? 'https://model.invalid/v1'
  const capabilities = options.capabilities ?? { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } }
  const provider = await settings.createProvider({ id: `${id}-provider`, name: 'Test provider', connectionHints: { baseUrl, protocolIds: [protocolId] } })
  const model = await settings.createModel({ id: `${id}-definition`, providerId: provider.id, remoteModelId: options.remoteModelId ?? 'test-model',
    name: options.name ?? 'Test model', capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: options.limits ?? {},
    connectionHints: { baseUrl, protocolIds: [protocolId] } })
  // Seed the chosen stable configuration identity before Key synchronization creates missing baselines.
  const connection = await settings.createConnection({ id: `${id}-connection`, providerDefinitionId: provider.id, name: 'Test connection', enabled: true,
    protocolId, baseUrl, auth: 'api-key', timeoutMs: 30_000 })
  const configuration = await settings.createConfiguration({ id, modelDefinitionId: model.id, connectionId: connection.id,
    name: model.name, enabled: true, baseline: true, capabilities, parameters: { protocolId, formatVersion: 1, value: options.parameters ?? {} } })
  if (options.apiKey !== false) await settings.setApiKey(connection.id, options.apiKey ?? 'test-model-secret', connection.revision)
  return configuration
}

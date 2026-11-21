const defaultCapabilities = { tools: { support: 'supported' }, streaming: { support: 'supported' },
  imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } }

/** Create a distinct test model under an existing provider, with explicit settings. */
export async function seedTestModel(settings, provider, options) {
  const { id, remoteModelId = id, name = 'Test model', capabilities = defaultCapabilities, limits = {}, parameters = {} } = options
  const { protocolId, baseUrl } = provider
  const model = await settings.createModel({ id, providerId: provider.id, remoteModelId, name, capabilities,
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits,
    connectionHints: { baseUrl, protocolIds: [protocolId] } })
  return settings.createModelSettings({ modelId: model.id, name: model.name, enabled: true, capabilities,
    parameters: { protocolId, formatVersion: 1, value: parameters } })
}

/** Explicit disposable Models settings for tests that exercise model calls. */
export async function seedHarnessModel(settings, options = {}) {
  const { id = 'default', protocolId = 'chat-completions', baseUrl = 'https://model.invalid/v1' } = options
  const provider = await settings.createProvider({ id: `${id}-provider`, name: 'Test provider', connectionHints: { baseUrl, protocolIds: [protocolId] } })
  const configured = await settings.createProviderSettings({ providerId: provider.id, name: 'Test connection', enabled: true,
    protocolId, baseUrl, auth: 'api-key', timeoutMs: 30_000 })
  const model = await seedTestModel(settings, configured, { ...options, id, remoteModelId: options.remoteModelId ?? 'test-model' })
  if (options.apiKey !== false) await settings.setApiKey(configured.id, options.apiKey ?? 'test-model-secret', configured.revision)
  return model
}

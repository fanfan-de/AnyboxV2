import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeminiInteractionsProtocol } from '../dist/protocols/gemini-interactions.js'
import { capabilities, exchange, fixture, params } from './helpers.mjs'
import { jsonResponse } from './native-protocol-helpers.mjs'

const intent = { input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hello' }] }] }

async function setup() {
  const requests = [], protocol = createGeminiInteractionsProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return jsonResponse({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }] })
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  const provider = await f.settings.createProvider({ name: 'Gemini', connectionHints: { protocolIds: ['gemini-interactions'] } })
  for (const support of ['supported', 'unknown', 'unsupported']) await f.settings.createModel({
    providerId: provider.id, remoteModelId: support, name: support,
    capabilities: capabilities({ streaming: { support: 'unsupported' }, reasoning: { support } }),
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {},
    connectionHints: { protocolIds: ['gemini-interactions'] },
  })
  const connection = await f.settings.createConnection({ providerDefinitionId: provider.id, name: 'Account',
    enabled: true, protocolId: 'gemini-interactions', baseUrl: 'https://gemini.invalid/v1beta', auth: 'none', timeoutMs: 1000 })
  return { ...f, requests, protocol, connection, configurations: f.settings.configurations(connection.id) }
}

test('new Gemini baselines persist and send enabled summaries only for declared reasoning support', async () => {
  const f = await setup()
  try {
    assert.equal(f.connection.sync.state, 'ready')
    assert.equal(f.configurations.length, 3, 'unknown or unsupported reasoning must not prevent a text baseline')
    assert.equal(f.protocol.descriptor.modelFields.find(field => field.key === 'generation_config.thinking_summaries').defaultValue, 'auto')
    for (const configuration of f.configurations) {
      const expected = configuration.capabilities.reasoning.support === 'supported' ? { generation_config: { thinking_summaries: 'auto' } } : {}
      assert.deepEqual(configuration.parameters, params('gemini-interactions', expected))
      const execution = await f.open({ modelId: configuration.id })
      try {
        assert.deepEqual(execution.snapshot.parameters, configuration.parameters)
        await exchange(execution, intent).result
        assert.deepEqual(f.requests.at(-1).generation_config, expected.generation_config)
      } finally { await execution.close() }
    }
  } finally { await f.close() }
})

test('Gemini reconciliation preserves saved none and omitted summaries without runtime defaults', async () => {
  const f = await setup()
  try {
    let configuration = f.configurations.find(value => value.capabilities.reasoning.support === 'supported')
    for (const value of [{ generation_config: { thinking_summaries: 'none' } }, {}]) {
      configuration = await f.settings.updateConfiguration(configuration.id, { parameters: params('gemini-interactions', value) }, configuration.revision)
      const before = configuration
      await f.settings.retryConnection(f.connection.id)
      assert.deepEqual(f.settings.configurations(f.connection.id).find(item => item.id === configuration.id), before)
      assert.deepEqual(f.settings.configurationHistory(configuration.id).at(-1), before)
      const execution = await f.open({ modelId: configuration.id })
      try {
        assert.deepEqual(execution.snapshot.parameters.value, value)
        await exchange(execution, intent).result
        assert.deepEqual(f.requests.at(-1).generation_config, value.generation_config)
      } finally { await execution.close() }
    }
  } finally { await f.close() }
})

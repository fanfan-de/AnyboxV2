import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js'
import { exchange, fakeProtocol, fixture } from './helpers.mjs'

const catalog = (context, time) => normalizeModelsDevCatalog({ provider: {
  id: 'provider', name: 'Provider', api: 'https://example.invalid/v1', npm: '@ai-sdk/openai-compatible',
  models: { model: { id: 'model', name: 'Model', tool_call: true, streaming: true,
    modalities: { input: ['text'], output: ['text'] }, limit: { context, input: context - 1000, output: 1000 } } },
} }, 'context-limit-test', time)

async function setup() {
  const f = await fixture({ protocols: [fakeProtocol('chat-completions')] })
  await f.sourceData.accept(catalog(32_000, 1))
  const provider = f.settings.providers()[0]
  const connection = await f.settings.createConnection({ id: 'account', providerDefinitionId: provider.id,
    name: 'Account', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 1000 })
  return { ...f, connection, configuration: f.settings.configurations()[0] }
}

test('runnable summaries and new executions retain the configuration-pinned definition limits after refresh', async () => {
  const f = await setup()
  try {
    const expected = { context: 32_000, input: 31_000, output: 1000 }
    const original = f.models.get(f.configuration.id)
    assert.deepEqual(original.limits, expected)
    await f.sourceData.accept(catalog(128_000, 2))
    assert.equal(f.settings.models()[0].limits.context, 128_000)
    assert.deepEqual(f.models.get(f.configuration.id).limits, expected)
    assert.equal(f.models.list()[0].modelDefinitionVersionId, original.modelDefinitionVersionId)
    const execution = await f.open({ modelId: f.configuration.id })
    assert.deepEqual(execution.snapshot.limits, expected)
    assert.equal(execution.snapshot.modelDefinitionVersionId, original.modelDefinitionVersionId)
    assert.equal(Object.isFrozen(execution.snapshot.limits), true)
    await execution.close()

    const input = Object.fromEntries(['name', 'enabled', 'modelDefinitionId', 'connectionId', 'capabilities', 'parameters'].map(key => [key, f.configuration[key]]))
    const variant = await f.settings.createConfiguration({ ...input, id: 'new-configuration', baseline: false })
    const next = await f.open({ modelId: variant.id })
    assert.equal(next.snapshot.limits.context, 128_000)
    assert.notEqual(next.snapshot.modelDefinitionVersionId, original.modelDefinitionVersionId)
    await next.close()
  } finally { await f.close() }
})

test('missing pinned definition history never substitutes the refreshed context limit', async () => {
  const f = await setup()
  try {
    await f.sourceData.accept(catalog(128_000, 2))
    f.store.modelHistory = () => []
    assert.equal(f.models.get(f.configuration.id).limits, undefined)
    const execution = await f.open({ modelId: f.configuration.id })
    assert.equal(execution.snapshot.limits, undefined)
    assert.equal(Object.hasOwn(execution.snapshot, 'limits'), false)
    await execution.close()
  } finally { await f.close() }
})

test('legacy schema 3 native history restores without limits and display metadata does not change compatibility', async () => {
  const f = await setup()
  try {
    const original = await f.open({ modelId: f.configuration.id })
    await exchange(original, { messages: [{ role: 'user', content: 'Hello' }] }).result
    const report = await original.close()
    assert.ok(report.restoreState)
    const { limits, ...legacySnapshot } = report.restoreState.modelSnapshot
    for (const modelSnapshot of [legacySnapshot, { ...legacySnapshot, limits: { context: 999 } }]) {
      const restored = await f.open({ modelId: f.configuration.id, restore: {
        ...report.restoreState, modelSnapshot, records: report.records,
      } })
      assert.equal(restored.snapshot.limits.context, 32_000)
      assert.equal(restored.snapshot.registrationGenerationId, original.snapshot.registrationGenerationId)
      await restored.close()
    }
  } finally { await f.close() }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createModelsComponent, createModelsJsonStoreComponent } from '../dist/index.js'
import { exchange, fakeProtocol, fixture, memoryVault } from './helpers.mjs'

for (const schemaVersion of [1, 2]) {
  test(`JSON v${schemaVersion} upgrade preserves a saved model and its native continuation scope`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-model-settings-upgrade-'))
    const path = join(directory, 'models.json')
    const vault = memoryVault()
    const previous = await fixture({ vault })
    const root = new Context()
    t.after(async () => {
      try { await root.fiber.dispose() }
      finally {
        try { await previous.close() }
        finally { await rm(directory, { recursive: true, force: true }) }
      }
    })

    const { provider, model } = await previous.add({ providerId: 'catalog-provider', key: 'original-key' })
    const first = await previous.open({ modelId: model.runtimeModelId })
    await exchange(first, { messages: [{ role: 'user', content: 'before upgrade' }] }).result
    const { records, restoreState } = await first.close()

    const formerAccount = 'former-connection', formerModel = 'former-model', retiredPreset = 'retired-preset'
    const providerSettings = previous.store.providerSettings(provider.id)
    const { restoreScopeId: _scope, ...legacySettings } = providerSettings
    const legacyConnection = { ...legacySettings, id: formerAccount, providerDefinitionId: provider.id }
    const { id: modelDefinitionId, runtimeModelId: _runtimeId, providerId, ...localFields } = model
    const legacyModel = {
      ...localFields, id: formerModel, modelDefinitionId, baseline: true,
      ...(schemaVersion === 1 ? { connectionId: formerAccount } : { providerId }),
    }
    const configs = schemaVersion === 1 ? [legacyModel] :
      [legacyModel, { ...legacyModel, id: retiredPreset, versionId: 'preset-version', name: 'Former preset', enabled: false, baseline: false }]
    const providers = previous.store.providers(), models = previous.store.models()
    const providerRows = schemaVersion === 1 ? { connections: [legacyConnection] } : { providerSettings: [providerSettings] }
    await writeFile(path, JSON.stringify({
      schemaVersion, providers, models, ...providerRows, configurations: configs,
      sources: [], syncStates: [], credentialIntents: [],
      tombstones: schemaVersion === 1 ? { connections: [], configurations: [] } : { providerSettings: [], configurations: [] },
      history: { providers, models, ...providerRows, configurations: configs, ...(schemaVersion === 2 ? { retiredConnections: [] } : {}) },
    }))
    const restore = { ...restoreState, records, modelSnapshot: {
      ...restoreState.modelSnapshot, modelId: formerModel,
      providerId: schemaVersion === 1 ? formerAccount : providerSettings.restoreScopeId,
    } }

    const store = root.installComponent(createModelsJsonStoreComponent({ path }))
    await store
    assert.equal(store.state, FiberState.ACTIVE, store.error?.message)
    await root.installComponent({ name: 'test-model-vault', apply(ctx) { ctx.provide('models.vault', vault) } })
    const component = root.installComponent(createModelsComponent())
    await component
    assert.equal(component.state, FiberState.ACTIVE)
    const protocol = fakeProtocol()
    const registration = root.get('models.protocols').register(protocol)
    const lease = registration.acquire()
    const execution = await root.get('models').openNative({ modelId: formerModel, lease, restore })
    try {
      assert.equal(root.get('models.settings').configuredProviders()[0].id, provider.id)
      const [configured] = root.get('models.settings').modelSettings()
      assert.equal(configured.id, modelDefinitionId)
      assert.equal(configured.runtimeModelId, formerModel)
      assert.equal(root.get('models').get(formerModel).id, formerModel)
      assert.equal(root.get('models').get(retiredPreset), undefined)
      await exchange(execution, { messages: [{ role: 'user', content: 'after upgrade' }] }).result
      assert.equal(protocol.calls[0].input.credential, 'original-key')
      assert.deepEqual(protocol.calls[0].input.request.messages.map(message => message.content), [
        'before upgrade', 'answer', 'after upgrade',
      ])
    } finally {
      await execution.close()
      lease.release()
    }
  })
}

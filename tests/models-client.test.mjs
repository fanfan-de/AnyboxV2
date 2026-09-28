import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canUseModel, createModelsCatalog, generationOptions, initialModelDefaults } from '../dist/web/models-client.js'
import { catalogSupportsText, catalogMatchesConnection, createModelsDirectory } from '../dist/web/models-directory-client.js'

const fields = [
  { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 },
  { key: 'maxOutputTokens', label: 'Tokens', type: 'number', min: 1, integer: true },
  { key: 'protocol.reasoningEffort', label: 'Effort', type: 'enum', values: ['none', 'low', 'high'] },
  { key: 'protocol.flag', label: 'Flag', type: 'boolean' },
]

test('descriptor forms omit blank options and preserve explicitly selected zero, false and reasoning mode', () => {
  assert.deepEqual(generationOptions(fields, {}), {})
  assert.deepEqual(generationOptions(fields, { temperature: '0', 'protocol.flag': 'false', 'protocol.reasoningEffort': '"none"' }), {
    temperature: 0, protocol: { flag: false, reasoningEffort: 'none' },
  })
  assert.throws(() => generationOptions(fields, { maxOutputTokens: '1.5' }), /范围/)
  assert.throws(() => generationOptions(fields, { temperature: 'NaN' }), /范围/)
  assert.throws(() => generationOptions(fields, { 'protocol.reasoningEffort': '"invented"' }), /无效/)
})

test('new forms initialize required defaults and cap output tokens using the selected directory model', () => {
  const fields = [{ key: 'maxOutputTokens', label: 'Tokens', type: 'number', min: 1, integer: true, required: true, defaultValue: 4096 },
    { key: 'protocol.flag', label: 'Flag', type: 'boolean', defaultValue: false }, { key: 'temperature', label: 'Temperature', type: 'number' }]
  assert.deepEqual(initialModelDefaults(fields), { maxOutputTokens: 4096, protocol: { flag: false } })
  assert.deepEqual(initialModelDefaults(fields, { limits: { output: 2048 } }), { maxOutputTokens: 2048, protocol: { flag: false } })
  assert.throws(() => generationOptions(fields, {}), /必须填写/)
  assert.deepEqual(generationOptions(fields, { maxOutputTokens: '4096' }), { maxOutputTokens: 4096 })
})

test('directory models require a compatible explicitly associated connection for prefill', () => {
  const model = { sourceId: 'models.dev', providerId: 'anthropic', modalities: { input: ['text', 'image'], output: ['text'] },
    connectionHints: { protocolIds: ['anthropic-messages'] }, connections: [] }
  assert.equal(catalogSupportsText(model), true)
  assert.equal(catalogSupportsText({ ...model, modalities: { input: ['text'], output: ['image'] } }), false)
  assert.equal(catalogSupportsText({ ...model, modalities: { input: ['audio'], output: ['text'] } }), false)
  assert.equal(catalogSupportsText({ ...model, modelType: 'embedding', modalities: { input: [], output: [] } }), false)
  const provider = { protocolId: 'anthropic-messages', catalogRef: { sourceId: 'models.dev', providerId: 'anthropic' } }
  assert.equal(catalogMatchesConnection(model, provider), true)
  assert.equal(catalogMatchesConnection(model, { ...provider, catalogRef: null }), false)
  assert.equal(catalogMatchesConnection(model, { ...provider, protocolId: 'chat-completions' }), false)
  assert.equal(catalogMatchesConnection({ ...model, connections: [{ values: { protocolId: 'host-special' } }] }, { ...provider, protocolId: 'host-special' }), true)
})

test('public directory reads preserve the last valid candidates and ignore obsolete searches', async () => {
  const requests = []
  const directory = createModelsDirectory(path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })), () => 'directory offline')
  const older = directory.readProviders('old'), current = directory.readProviders('current')
  requests[1].resolve([{ id: 'current' }]); await current
  requests[0].resolve([{ id: 'old' }]); await older
  assert.deepEqual(directory.snapshot().providers, [{ id: 'current' }])
  const models = directory.readModels('current', 'text')
  requests[2].resolve([{ providerId: 'current', remoteModelId: 'saved-candidate' }]); await models
  const failed = directory.readModels('current', 'another')
  requests[3].reject(new Error()); await failed
  assert.equal(directory.snapshot().models[0].remoteModelId, 'saved-candidate')
  assert.equal(directory.snapshot().error, 'directory offline')
  const nextProvider = directory.readModels('other')
  assert.deepEqual(directory.snapshot().models, [])
  requests[4].resolve([]); await nextProvider
  assert.match(requests[4].path, /includeDeprecated=false/)
})

test('directory refresh completion survives status polling and closing aborts obsolete publication', async () => {
  const requests = []
  const directory = createModelsDirectory((path, body, signal) => new Promise(resolve => requests.push({ path, body, signal, resolve })), () => 'directory failed')
  const refresh = directory.refresh(), poll = directory.readStatus()
  assert.equal(directory.snapshot().checking, true)
  requests[1].resolve({ snapshotVersion: 'before', refreshing: true }); await poll
  requests[0].resolve({ snapshotVersion: 'after', refreshing: false }); await refresh
  assert.equal(directory.snapshot().status.snapshotVersion, 'after')
  assert.equal(directory.snapshot().checking, false)
  const controller = new AbortController(), old = directory.refresh(controller.signal)
  controller.abort(); directory.invalidate()
  const current = directory.refresh()
  requests[2].resolve({ snapshotVersion: 'cancelled' }); await old
  assert.equal(directory.snapshot().checking, true)
  requests[3].resolve({ snapshotVersion: 'current' }); await current
  assert.equal(directory.snapshot().status.snapshotVersion, 'current')
})

test('a delayed pre-completion status read cannot overwrite a completed refresh', async () => {
  const requests = []
  const directory = createModelsDirectory(path => new Promise(resolve => requests.push({ path, resolve })), () => 'failed')
  const refresh = directory.refresh(), poll = directory.readStatus()
  requests[0].resolve({ snapshotVersion: 'new', refreshing: false }); await refresh
  requests[1].resolve({ snapshotVersion: 'old', refreshing: true }); await poll
  assert.equal(directory.snapshot().status.snapshotVersion, 'new')
  assert.equal(directory.snapshot().status.refreshing, false)
  assert.equal(directory.snapshot().checking, false)
})

test('available text-only models remain selectable without claiming tool support', () => {
  assert.equal(canUseModel(undefined), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: false } }), true)
  assert.equal(canUseModel({ available: false, effectiveCapabilities: { tools: true } }), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: true } }), true)
})

test('shared catalog ignores older refreshes and preserves current model records on a failed read', async () => {
  const requests = [], emitted = []
  const catalog = createModelsCatalog(path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })), () => 'read failed')
  const unsubscribe = catalog.subscribe(() => emitted.push(catalog.snapshot()))
  const old = catalog.refresh(), current = catalog.refresh()
  requests[2].resolve([{ id: 'fresh' }]); requests[3].resolve([{ id: 'provider' }]); await current
  requests[0].resolve([{ id: 'stale' }]); requests[1].resolve([]); await old
  assert.equal(catalog.snapshot().models[0].id, 'fresh')
  const failed = catalog.refresh(); requests[4].reject(new Error('offline')); requests[5].resolve([]); await failed
  assert.equal(catalog.snapshot().models[0].id, 'fresh')
  assert.equal(catalog.snapshot().error, 'read failed')
  assert.equal(catalog.snapshot().loading, false)
  unsubscribe(); const count = emitted.length
  const after = catalog.refresh(); requests[6].resolve([]); requests[7].resolve([]); await after
  assert.equal(emitted.length, count)
})

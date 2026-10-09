import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canUseModel, createModelsCatalog, nativeParameterValues, initialNativeParameters, settingsConnectionSelection, settingsModelEditorSelection } from '../dist/applications/harness/web/models-client.js'
import { catalogSupportsText, catalogMatchesConnection, createModelsDirectory } from '../dist/applications/harness/web/models-directory-client.js'

const fields = [
  { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 },
  { key: 'max_tokens', label: 'Tokens', type: 'number', min: 1, integer: true },
  { key: 'reasoning.effort', label: 'Effort', type: 'enum', values: ['none', 'low', 'high'] },
  { key: 'thinking.enabled', label: 'Flag', type: 'boolean' },
]

test('descriptor forms omit blank options and preserve explicitly selected zero, false and reasoning mode', () => {
  assert.deepEqual(nativeParameterValues(fields, {}), {})
  assert.deepEqual(nativeParameterValues(fields, { temperature: '0', 'thinking.enabled': 'false', 'reasoning.effort': '"none"' }), {
    temperature: 0, thinking: { enabled: false }, reasoning: { effort: 'none' },
  })
  assert.throws(() => nativeParameterValues(fields, { max_tokens: '1.5' }), /范围/)
  assert.throws(() => nativeParameterValues(fields, { temperature: 'NaN' }), /范围/)
  assert.throws(() => nativeParameterValues(fields, { 'reasoning.effort': '"invented"' }), /无效/)
})

test('new forms initialize required defaults and cap output tokens using the selected directory model', () => {
  const fields = [{ key: 'max_tokens', label: 'Tokens', type: 'number', min: 1, integer: true, required: true, defaultValue: 4096 },
    { key: 'thinking.enabled', label: 'Flag', type: 'boolean', defaultValue: false }, { key: 'temperature', label: 'Temperature', type: 'number' }]
  assert.deepEqual(initialNativeParameters(fields), { max_tokens: 4096, thinking: { enabled: false } })
  assert.deepEqual(initialNativeParameters(fields, { limits: { output: 2048 } }), { max_tokens: 2048, thinking: { enabled: false } })
  assert.throws(() => nativeParameterValues(fields, {}), /必须填写/)
  assert.deepEqual(nativeParameterValues(fields, { max_tokens: '4096' }), { max_tokens: 4096 })
})

test('native parameter paths retain nesting and reject conflicting or prototype paths', () => {
  assert.deepEqual(nativeParameterValues([
    { key: 'thinking.type', label: 'Thinking', type: 'enum', values: ['enabled'] },
    { key: 'thinking.budget_tokens', label: 'Budget', type: 'number', integer: true, min: 1 },
  ], { 'thinking.type': '"enabled"', 'thinking.budget_tokens': '1024' }), { thinking: { type: 'enabled', budget_tokens: 1024 } })
  assert.throws(() => nativeParameterValues([{ key: '__proto__.value', label: 'Bad', type: 'string' }], { '__proto__.value': 'bad' }), /参数路径/)
  assert.throws(() => nativeParameterValues([
    { key: 'thinking', label: 'Scalar', type: 'string' }, { key: 'thinking.type', label: 'Nested', type: 'string' },
  ], { thinking: 'scalar', 'thinking.type': 'enabled' }), /参数路径冲突/)
})

test('directory models require a compatible explicitly associated connection for automatic setup', () => {
  const model = { source: { kind: 'external', sourceId: 'models.dev', providerId: 'anthropic' }, providerId: 'anthropic-definition', modalities: { input: ['text', 'image'], output: ['text'] },
    connectionHints: { protocolIds: ['anthropic-messages'] }, connections: [] }
  assert.equal(catalogSupportsText(model), true)
  assert.equal(catalogSupportsText({ ...model, modalities: { input: ['text'], output: ['image'] } }), false)
  assert.equal(catalogSupportsText({ ...model, modalities: { input: ['audio'], output: ['text'] } }), false)
  assert.equal(catalogSupportsText({ ...model, modelType: 'embedding', modalities: { input: [], output: [] } }), false)
  const provider = { protocolId: 'anthropic-messages', providerDefinitionId: 'anthropic-definition' }
  assert.equal(catalogMatchesConnection(model, provider), true)
  assert.equal(catalogMatchesConnection(model, { ...provider, providerDefinitionId: 'other' }), false)
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

function deferredDirectory() {
  const requests = []
  const directory = createModelsDirectory((path, body, signal) => new Promise((resolve, reject) => requests.push({ path, body, signal, resolve, reject })), error => error.message)
  return { directory, requests }
}

async function seedDirectory(directory, requests) {
  const reads = [directory.readStatus(), directory.readProviders(), directory.readModels('saved')]
  requests[0].resolve({ snapshotVersion: 'saved', refreshing: false })
  requests[1].resolve([{ id: 'saved' }])
  requests[2].resolve([{ providerId: 'saved', remoteModelId: 'saved-model' }])
  await Promise.all(reads)
}

test('directory read failures remain visible until the matching read succeeds', async () => {
  const { directory, requests } = deferredDirectory()
  const status = directory.readStatus(), providers = directory.readProviders(), models = directory.readModels('saved')
  requests[0].reject(new Error('status offline')); await status
  assert.equal(directory.snapshot().errors.status, 'status offline')
  assert.equal(directory.snapshot().error, 'status offline')
  requests[2].reject(new Error('models offline')); await models
  requests[1].reject(new Error('providers offline')); await providers
  assert.equal(directory.snapshot().errors.status, 'status offline')
  assert.equal(directory.snapshot().errors.providers, 'providers offline')
  assert.equal(directory.snapshot().errors.models, 'models offline')

  const providersRetry = directory.readProviders()
  requests[3].resolve([{ id: 'saved' }]); await providersRetry
  assert.equal(directory.snapshot().errors.providers, undefined)
  assert.equal(directory.snapshot().errors.status, 'status offline')
  assert.equal(directory.snapshot().errors.models, 'models offline')
  assert.ok(directory.snapshot().error)
  const statusRetry = directory.readStatus()
  requests[4].resolve({ snapshotVersion: 'saved' }); await statusRetry
  assert.equal(directory.snapshot().errors.status, undefined)
  assert.equal(directory.snapshot().error, 'models offline')
  const modelsRetry = directory.readModels('saved')
  requests[5].resolve([{ providerId: 'saved', remoteModelId: 'saved-model' }]); await modelsRetry
  assert.equal(directory.snapshot().errors.models, undefined)
  assert.equal(directory.snapshot().error, undefined)
})

test('a refresh failure survives successful directory reads and failed retries', async () => {
  const { directory, requests } = deferredDirectory()
  const refresh = directory.refresh()
  requests[0].reject(new Error('refresh offline')); await refresh
  assert.equal(directory.snapshot().errors.refresh, 'refresh offline')
  assert.equal(directory.snapshot().error, 'refresh offline')
  assert.equal(directory.snapshot().checking, false)

  const reads = [directory.readStatus(), directory.readProviders(), directory.readModels('saved')]
  requests[1].resolve({ snapshotVersion: 'saved', refreshing: false })
  requests[2].resolve([{ id: 'saved' }])
  requests[3].resolve([{ providerId: 'saved', remoteModelId: 'saved-model' }])
  await Promise.all(reads)
  assert.equal(directory.snapshot().errors.status, undefined)
  assert.equal(directory.snapshot().errors.providers, undefined)
  assert.equal(directory.snapshot().errors.models, undefined)
  assert.equal(directory.snapshot().errors.refresh, 'refresh offline')
  assert.equal(directory.snapshot().error, 'refresh offline')

  const failedRetry = directory.refresh()
  assert.equal(directory.snapshot().checking, true)
  assert.equal(directory.snapshot().errors.refresh, 'refresh offline')
  assert.equal(directory.snapshot().error, 'refresh offline')
  requests[4].reject(new Error('retry offline')); await failedRetry
  assert.equal(directory.snapshot().errors.refresh, 'retry offline')
  assert.equal(directory.snapshot().error, 'retry offline')
  const successfulRetry = directory.refresh()
  requests[5].resolve({ snapshotVersion: 'fresh', refreshing: false }); await successfulRetry
  assert.equal(directory.snapshot().status.snapshotVersion, 'fresh')
  assert.equal(directory.snapshot().errors.refresh, undefined)
  assert.equal(directory.snapshot().error, undefined)
  assert.equal(directory.snapshot().checking, false)
})

for (const outcome of ['resolve', 'reject']) test(`invalidated directory ${outcome === 'resolve' ? 'responses' : 'failures'} cannot change the retained snapshot`, async () => {
  const { directory, requests } = deferredDirectory()
  await seedDirectory(directory, requests)
  const obsolete = [directory.refresh(), directory.readStatus(), directory.readProviders('obsolete'), directory.readModels('saved', 'obsolete')]
  directory.invalidate()
  const retained = directory.snapshot(), emitted = []
  const unsubscribe = directory.subscribe(() => emitted.push(directory.snapshot()))
  const values = [{ snapshotVersion: 'obsolete-refresh', refreshing: false }, { snapshotVersion: 'obsolete-status', refreshing: true },
    [{ id: 'obsolete-provider' }], [{ providerId: 'saved', remoteModelId: 'obsolete-model' }]]
  for (const [index, request] of requests.slice(3).entries()) {
    if (outcome === 'resolve') request.resolve(values[index])
    else request.reject(new Error(`obsolete failure ${index}`))
  }
  await Promise.all(obsolete)
  assert.deepEqual(directory.snapshot(), retained)
  assert.equal(directory.snapshot().status.snapshotVersion, 'saved')
  assert.equal(directory.snapshot().models[0].remoteModelId, 'saved-model')
  assert.equal(directory.snapshot().checking, false)
  assert.equal(emitted.length, 0)
  unsubscribe()
})

test('pre-aborted directory calls preserve state and leave current reads eligible to publish', async () => {
  const { directory, requests } = deferredDirectory()
  await seedDirectory(directory, requests)
  const failedRefresh = directory.refresh()
  requests[3].reject(new Error('refresh offline')); await failedRefresh
  const current = [directory.readStatus(), directory.readProviders('current'), directory.readModels('saved', 'current')]
  const retained = directory.snapshot(), emitted = []
  const unsubscribe = directory.subscribe(() => emitted.push(directory.snapshot()))
  const controller = new AbortController(); controller.abort()
  const ignored = [directory.readStatus(controller.signal), directory.readProviders('other', controller.signal),
    directory.readModels('other', '', true, controller.signal), directory.refresh(controller.signal)]
  assert.equal(requests.length, 7)
  await Promise.all(ignored)
  assert.deepEqual(directory.snapshot(), retained)
  assert.equal(emitted.length, 0)
  requests[4].resolve({ snapshotVersion: 'current', refreshing: false })
  requests[5].resolve([{ id: 'current' }])
  requests[6].resolve([{ providerId: 'saved', remoteModelId: 'current-model' }])
  await Promise.all(current)
  assert.equal(directory.snapshot().status.snapshotVersion, 'current')
  assert.deepEqual(directory.snapshot().providers, [{ id: 'current' }])
  assert.equal(directory.snapshot().models[0].remoteModelId, 'current-model')
  assert.equal(directory.snapshot().providerId, 'saved')
  assert.equal(directory.snapshot().errors.refresh, 'refresh offline')
  unsubscribe()
})

test('available text-only models remain selectable without claiming tool support', () => {
  assert.equal(canUseModel(undefined), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: false } }), true)
  assert.equal(canUseModel({ available: false, effectiveCapabilities: { tools: true } }), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: true } }), true)
})

test('settings restore the exact remembered account and otherwise prefer a ready connection', () => {
  const disabled = { id: 'disabled', providerDefinitionId: 'shared-provider', enabled: false, auth: 'api-key', credentialConfigured: true }
  const missingKey = { ...disabled, id: 'needs-key', enabled: true, credentialConfigured: false }
  const work = { ...disabled, id: 'work', enabled: true }
  const personal = { ...work, id: 'personal' }
  const local = { ...work, id: 'local', providerDefinitionId: 'local-provider', auth: 'none', credentialConfigured: false }
  const connections = [disabled, missingKey, work, local, personal]
  const models = [{ id: 'work-model', connectionId: work.id, available: false }, { id: 'personal-model', connectionId: personal.id, available: true }]

  assert.equal(settingsConnectionSelection(connections, models, disabled.id), disabled)
  assert.equal(settingsConnectionSelection(connections, models, missingKey.id), missingKey)
  assert.equal(settingsConnectionSelection(connections, models, work.id), work)
  assert.equal(settingsConnectionSelection(connections, models, personal.id), personal)
  assert.equal(settingsConnectionSelection(connections, models), personal)
  assert.equal(settingsConnectionSelection(connections, models, 'deleted-account'), personal)
  assert.equal(settingsConnectionSelection(connections, models, 'shared-provider'), personal)
  assert.equal(settingsConnectionSelection(connections, []), work)
  assert.equal(settingsConnectionSelection([missingKey, local], []), local)
  assert.equal(settingsConnectionSelection([disabled, missingKey], []), disabled)
  assert.equal(settingsConnectionSelection([], models, personal.id), undefined)
})

test('new model and preset drafts remain selected across refresh and account changes even when collapsed', () => {
  const configurations = [{ id: 'personal-base', connectionId: 'personal' }, { id: 'work-base', connectionId: 'work' }]
  const collapsedDraft = { connectionId: 'personal', target: { kind: 'draft' }, visible: true, expanded: false }
  const workEditor = { connectionId: 'work', target: { kind: 'configuration', id: 'work-base' }, visible: true, expanded: true }

  assert.equal(settingsModelEditorSelection(configurations, 'personal', collapsedDraft, true), collapsedDraft)
  assert.equal(settingsModelEditorSelection(configurations, 'work', workEditor, false), workEditor)
  const refreshed = [...configurations, { id: 'personal-new-baseline', connectionId: 'personal' }]
  const returned = settingsModelEditorSelection(refreshed, 'personal', collapsedDraft, true)
  assert.equal(returned, collapsedDraft)
  assert.equal(returned.target.kind, 'draft')
  assert.equal(returned.visible, true)
  assert.equal(returned.expanded, false)
  assert.equal(settingsModelEditorSelection([], 'personal', { ...collapsedDraft, expanded: true }, true).target.kind, 'draft')
})

test('discarded or removed editing targets fall back within their own account without reviving a new draft', () => {
  const configurations = [{ id: 'personal-base', connectionId: 'personal' }, { id: 'work-base', connectionId: 'work' }]
  const discarded = { connectionId: 'personal', target: { kind: 'draft' }, visible: true, expanded: false }
  const fallback = settingsModelEditorSelection(configurations, 'personal', discarded, false)
  assert.equal(fallback.target.kind, 'configuration')
  assert.equal(fallback.target.id, 'personal-base')
  assert.equal(fallback.visible, false)
  assert.equal(fallback.expanded, false)
  assert.equal(settingsModelEditorSelection(configurations, 'work', discarded, false).target.id, 'work-base')
  const removed = { connectionId: 'personal', target: { kind: 'configuration', id: 'deleted-preset' }, visible: true, expanded: true }
  assert.equal(settingsModelEditorSelection(configurations, 'personal', removed, false).target.id, 'personal-base')
  assert.equal(settingsModelEditorSelection(configurations, 'personal', removed, true).target.kind, 'draft')
  assert.equal(settingsModelEditorSelection(configurations, 'empty', discarded, false), undefined)
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

test('disposing a page catalog releases subscriptions and ignores late data without issuing new requests', async () => {
  const pending = [], subscriptions = new Map(), removed = []
  const api = path => new Promise(resolve => pending.push({ path, resolve }))
  api.subscribeList = (path, listener) => { subscriptions.set(path, listener); return () => removed.push(path) }
  const catalog = createModelsCatalog(api, () => 'offline'), updates = []
  catalog.subscribe(() => updates.push(catalog.snapshot()))
  const read = catalog.refresh()
  catalog.dispose()
  const count = updates.length
  subscriptions.get('/models')([{ id: 'stale' }])
  pending.forEach(call => call.resolve([{ id: 'late' }]))
  await read; await catalog.refresh()
  assert.deepEqual(removed.sort(), ['/models', '/models/connections'])
  assert.equal(updates.length, count); assert.deepEqual(catalog.snapshot().models, []); assert.equal(pending.length, 2)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canUseModel, createModelsCatalog, nativeParameterValues, initialNativeParameters, settingsProviderGroups, settingsProviderSelection, settingsProviderSourceAllowed, settingsModelEditorSelection } from '../packages/app-harness/dist/web/models-client.js'
import { settingsProviderGroups as personalAgentProviderGroups, settingsProviderSelection as personalAgentProviderSelection } from '../packages/app-personal-agent/dist/web/models-client.js'

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

test('new Gemini forms enable summaries only for models with declared reasoning support', () => {
  const fields = [{ key: 'generation_config.thinking_summaries', label: 'Thinking summaries', type: 'enum', values: ['auto', 'none'], defaultValue: 'auto' }]
  const capabilities = support => ({ tools: { support: 'unknown' }, streaming: { support: 'unknown' }, imageInput: { support: 'unknown' }, reasoning: { support } })
  assert.deepEqual(initialNativeParameters(fields, { capabilities: capabilities('supported') }), { generation_config: { thinking_summaries: 'auto' } })
  for (const support of ['unknown', 'unsupported']) assert.deepEqual(initialNativeParameters(fields, { capabilities: capabilities(support) }), {})
  assert.deepEqual(initialNativeParameters(fields), {})
  assert.deepEqual(nativeParameterValues(fields, { 'generation_config.thinking_summaries': '"none"' }), { generation_config: { thinking_summaries: 'none' } })
  assert.deepEqual(nativeParameterValues(fields, {}), {}, 'saved omissions remain omitted')
})

test('new settings require a present models.dev provider while configured providers remain editable', () => {
  const directoryProvider = { state: 'present', source: { kind: 'external', sourceId: 'models.dev', providerId: 'deepseek', sourceVersion: 'current' } }
  const customProvider = { state: 'present', source: { kind: 'user' } }
  const existing = { id: 'saved-custom-provider' }
  assert.equal(settingsProviderSourceAllowed(undefined, undefined), false)
  assert.equal(settingsProviderSourceAllowed(undefined, customProvider), false)
  assert.equal(settingsProviderSourceAllowed(undefined, directoryProvider), true)
  assert.equal(settingsProviderSourceAllowed(undefined, { ...directoryProvider, state: 'missing' }), false)
  assert.equal(settingsProviderSourceAllowed(undefined, { ...directoryProvider, source: { ...directoryProvider.source, sourceId: 'other-directory' } }), false)
  assert.equal(settingsProviderSourceAllowed(existing, customProvider), true)
  assert.equal(settingsProviderSourceAllowed(existing, undefined), true)
})

test('available text-only models remain selectable without claiming tool support', () => {
  assert.equal(canUseModel(undefined), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: false } }), true)
  assert.equal(canUseModel({ available: false, effectiveCapabilities: { tools: true } }), false)
  assert.equal(canUseModel({ available: true, effectiveCapabilities: { tools: true } }), true)
})

test('model settings keep only an explicitly selected provider that still exists', () => {
  const disabled = { id: 'disabled', enabled: false, auth: 'api-key', credentialConfigured: true }
  const missingKey = { ...disabled, id: 'needs-key', enabled: true, credentialConfigured: false }
  const ready = { ...disabled, id: 'ready', enabled: true }
  const providers = [disabled, missingKey, ready]

  for (const select of [settingsProviderSelection, personalAgentProviderSelection]) {
    assert.equal(select(providers), undefined)
    assert.equal(select([ready]), undefined)
    assert.equal(select(providers, 'deleted-provider'), undefined)
    assert.equal(select(providers, disabled.id), disabled)
    assert.equal(select(providers, missingKey.id), missingKey)
    assert.equal(select(providers, ready.id), ready)
    assert.equal(select([ready], disabled.id), undefined)
  }
})

test('provider groups show the whole directory and pin completed API settings by identity', () => {
  const saved = { id: 'saved', name: 'Zulu saved name', enabled: false, auth: 'api-key', credentialConfigured: true }
  const local = { id: 'local', name: 'Alpha Local', enabled: true, auth: 'none', credentialConfigured: false }
  const pendingKey = { id: 'pending-key', name: 'Charlie pending Key', enabled: true, auth: 'api-key', credentialConfigured: false }
  const providers = [saved, pendingKey, local]
  const definition = (id, name, state = 'present', sourceId = 'models.dev') => ({
    id, name, state, source: { kind: 'external', sourceId, providerId: id },
  })
  const definitions = [
    definition('saved', 'Alpha catalogue name', 'missing'),
    definition('pending-key', 'Beta catalogue name'),
    definition('delta', 'Delta'),
    definition('missing', 'Missing', 'missing'),
    definition('unresolved', 'Unresolved', 'unresolved'),
    definition('beta', 'Beta'),
    definition('other-source', 'Other source', 'present', 'untrusted'),
    { id: 'unsaved-custom', name: 'Unsaved custom', state: 'present', source: { kind: 'user' } },
  ]

  for (const group of [settingsProviderGroups, personalAgentProviderGroups]) {
    const { configured, other } = group(providers, definitions)
    assert.deepEqual(configured.map(({ id, name, settings }) => [id, name, settings]), [
      ['local', 'Alpha Local', local],
      ['saved', 'Zulu saved name', saved],
    ])
    assert.deepEqual(other.map(({ id, name, settings }) => [id, name, settings]), [
      ['beta', 'Beta', undefined],
      ['pending-key', 'Charlie pending Key', pendingKey],
      ['delta', 'Delta', undefined],
    ])
    const unconfigured = group([], definitions)
    assert.deepEqual(unconfigured.configured, [])
    assert.deepEqual(unconfigured.other.map(({ id }) => id), ['beta', 'pending-key', 'delta'])
  }
})

test('new model drafts remain selected across refresh and provider changes even when collapsed', () => {
  const settings = [{ id: 'personal-base', providerId: 'personal' }, { id: 'work-base', providerId: 'work' }]
  const collapsedDraft = { providerId: 'personal', target: { kind: 'draft' }, visible: true, expanded: false }
  const workEditor = { providerId: 'work', target: { kind: 'model', id: 'work-base' }, visible: true, expanded: true }

  assert.equal(settingsModelEditorSelection(settings, 'personal', collapsedDraft, true), collapsedDraft)
  assert.equal(settingsModelEditorSelection(settings, 'work', workEditor, false), workEditor)
  const refreshed = [...settings, { id: 'personal-new-model', providerId: 'personal' }]
  const returned = settingsModelEditorSelection(refreshed, 'personal', collapsedDraft, true)
  assert.equal(returned, collapsedDraft)
  assert.equal(returned.target.kind, 'draft')
  assert.equal(returned.visible, true)
  assert.equal(returned.expanded, false)
  assert.equal(settingsModelEditorSelection([], 'personal', { ...collapsedDraft, expanded: true }, true).target.kind, 'draft')
})

test('discarded or removed editing targets fall back within their own provider without reviving a new draft', () => {
  const settings = [{ id: 'personal-base', providerId: 'personal' }, { id: 'work-base', providerId: 'work' }]
  const discarded = { providerId: 'personal', target: { kind: 'draft' }, visible: true, expanded: false }
  const fallback = settingsModelEditorSelection(settings, 'personal', discarded, false)
  assert.equal(fallback.target.kind, 'model')
  assert.equal(fallback.target.id, 'personal-base')
  assert.equal(fallback.visible, false)
  assert.equal(fallback.expanded, false)
  assert.equal(settingsModelEditorSelection(settings, 'work', discarded, false).target.id, 'work-base')
  const removed = { providerId: 'personal', target: { kind: 'model', id: 'deleted-model' }, visible: true, expanded: true }
  assert.equal(settingsModelEditorSelection(settings, 'personal', removed, false).target.id, 'personal-base')
  assert.equal(settingsModelEditorSelection(settings, 'personal', removed, true).target.kind, 'draft')
  assert.equal(settingsModelEditorSelection(settings, 'empty', discarded, false), undefined)
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
  assert.deepEqual(removed.sort(), ['/models', '/models/provider-settings'])
  assert.equal(updates.length, count); assert.deepEqual(catalog.snapshot().models, []); assert.equal(pending.length, 2)
})

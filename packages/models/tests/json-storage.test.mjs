import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createModelsJsonStoreComponent, createModelsStoreComponent } from '../dist/index.js'

const version = id => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
const capabilities = { tools: { support: 'supported' }, streaming: { support: 'unknown' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } }
const provider = () => ({ ...version('p'), name: 'Provider', source: { kind: 'user' }, state: 'present', connectionHints: { protocolIds: ['responses'] } })
const model = () => ({ ...version('m'), name: 'Model', providerId: 'p', remoteModelId: 'remote', source: { kind: 'user' }, state: 'present', capabilities,
  controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['responses'] } })
const providerSettings = () => ({ ...version('p'), versionId: 'settings-v1', restoreScopeId: 'p', name: 'Account', enabled: true, protocolId: 'responses',
  baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, credentialRef: 'existing-slot', historyScopeEpoch: 'original-scope' })
const localModelSettings = () => ({ ...version('m'), versionId: 's-v1', runtimeModelId: 's', modelDefinitionVersionId: 'm-v1', providerId: 'p',
  name: 'Local model', enabled: true, remoteModelId: 'remote', parameters: { protocolId: 'responses', formatVersion: 1, value: {} }, capabilities })
const initial = () => ({ providers: [{ record: provider(), expectedRevision: null }], models: [{ record: model(), expectedRevision: null }],
  providerSettings: { record: providerSettings(), expectedRevision: null }, modelSettings: [{ record: localModelSettings(), expectedRevision: null }] })
const fixtureRoots = new Map()
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-json-store-'))
  const roots = new Set(); fixtureRoots.set(directory, roots)
  t.after(async () => { for (const root of roots) await root.fiber.dispose(); fixtureRoots.delete(directory); await rm(directory, { recursive: true, force: true }) })
  return { directory, path: join(directory, 'models.json'), legacyPath: join(directory, 'models.sqlite') }
}
async function open(path, options = {}) {
  const root = new Context(), fiber = root.installComponent(createModelsJsonStoreComponent({ path, ...options }))
  fixtureRoots.get(dirname(path))?.add(root)
  try { await fiber; assert.equal(fiber.state, FiberState.ACTIVE); return { root, store: root.get('models.store') } }
  catch (error) { await root.fiber.dispose(); throw error }
}
async function edit(path, mutate) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  mutate(value)
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

test('JSON is authoritative and reopening manual capability and parameter edits creates one new immutable version', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  await first.root.fiber.dispose()
  const original = localModelSettings()
  await edit(path, value => {
    value.modelSettings[0].capabilities.reasoning = { support: 'supported', efforts: ['low', 'high'] }
    value.modelSettings[0].parameters.value = { reasoning: { effort: 'high' } }
    value.modelSettings[0].name = 'Deep analysis'
  })
  const second = await open(path), edited = second.store.runtimeModelSettings('s')
  assert.equal(edited.revision, 2)
  assert.notEqual(edited.versionId, original.versionId)
  assert.equal(edited.modelDefinitionVersionId, original.modelDefinitionVersionId)
  assert.deepEqual(edited.capabilities.reasoning, { support: 'supported', efforts: ['low', 'high'] })
  assert.deepEqual(edited.parameters.value, { reasoning: { effort: 'high' } })
  assert.deepEqual(second.store.modelSettingsHistory('m'), [original, edited])
  edited.capabilities.tools.support = 'unsupported'
  assert.equal(second.store.runtimeModelSettings('s').capabilities.tools.support, 'supported')
  await second.root.fiber.dispose()
  const third = await open(path); t.after(() => third.root.fiber.dispose())
  assert.equal(third.store.runtimeModelSettings('s').revision, 2)
  assert.equal(third.store.modelSettingsHistory('m').length, 2)
})

test('manual endpoint edits rotate account scope while renames preserve it and credential references stay fixed', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial()); await first.root.fiber.dispose()
  await edit(path, value => { value.providerSettings[0].name = 'Renamed account' })
  const second = await open(path)
  assert.equal(second.store.providerSettings('p').historyScopeEpoch, 'original-scope')
  assert.equal(second.store.providerSettings('p').revision, 2)
  await second.root.fiber.dispose()
  await edit(path, value => { value.providerSettings[0].baseUrl = 'https://new-account.invalid/v1' })
  const third = await open(path)
  const current = third.store.providerSettings('p')
  assert.notEqual(current.historyScopeEpoch, 'original-scope')
  assert.equal(current.credentialRef, 'existing-slot')
  assert.equal(current.revision, 3)
  await third.root.fiber.dispose()
  await edit(path, value => { value.providerSettings[0].credentialRef = 'different-slot' })
  const before = await readFile(path, 'utf8')
  await assert.rejects(open(path))
  assert.equal(await readFile(path, 'utf8'), before)
})

test('failed JSON batches preserve the complete file and admitted commits finish before close releases ownership', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  const before = await readFile(path, 'utf8')
  await assert.rejects(first.store.commit({
    providerSettings: { record: { ...providerSettings(), revision: 2, versionId: 'c-v2', name: 'Must roll back' }, expectedRevision: 1 },
    modelSettings: [{ record: { ...localModelSettings(), revision: 2, versionId: 's-v2' }, expectedRevision: 9 }],
    addIntents: [{ id: 'not-committed', providerId: 'p', slotId: 'orphan', createdAt: '2026-01-02' }],
  }), { code: 'conflict' })
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(first.store.providerSettings('p').revision, 1)
  assert.deepEqual(first.store.intents(), [])
  const committing = first.store.commit({ providerSettings: { record: { ...providerSettings(), revision: 2, versionId: 'c-v2', name: 'Committed' }, expectedRevision: 1 } })
  await first.root.fiber.dispose(); await committing
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.providerSettings('p').name, 'Committed')
  await assert.rejects(first.store.commit({}), { code: 'closed' })
})

test('external edits made while active are preserved and writes refuse to overwrite them', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  await edit(path, value => { value.modelSettings[0].name = 'Edited with a text editor' })
  const changed = await readFile(path, 'utf8')
  await assert.rejects(first.store.commit({ providerSettings: { record: { ...providerSettings(), revision: 2, versionId: 'c-v2' }, expectedRevision: 1 } }), { code: 'conflict' })
  assert.equal(await readFile(path, 'utf8'), changed)
  assert.equal(first.store.runtimeModelSettings('s').name, 'Local model')
  await first.root.fiber.dispose()
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.runtimeModelSettings('s').name, 'Edited with a text editor')
})

test('deletion preserves immutable history and cleanup intents without allowing manual resurrection', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  const intent = { id: 'retired', providerId: 'p', slotId: 'existing-slot', createdAt: '2026-01-02' }
  await first.store.commit({ deleteProviderSettings: { id: 'p', expectedRevision: 1 }, addIntents: [intent] })
  await first.root.fiber.dispose()
  const second = await open(path)
  assert.equal(second.store.providerSettings('p'), undefined)
  assert.equal(second.store.runtimeModelSettings('s'), undefined)
  assert.deepEqual(second.store.providerSettingsHistory('p'), [providerSettings()])
  assert.deepEqual(second.store.modelSettingsHistory('m'), [localModelSettings()])
  assert.deepEqual(second.store.intents(), [intent])
  await assert.rejects(second.store.commit(initial()), { code: 'conflict' })
  await second.root.fiber.dispose()
  await edit(path, value => { value.providerSettings.push(providerSettings()); value.modelSettings.push(localModelSettings()) })
  await assert.rejects(open(path))
})

function legacySnapshot() {
  const { restoreScopeId: _scope, ...localSettings } = providerSettings()
  const { providerId: _provider, runtimeModelId: id, id: modelDefinitionId, ...settings } = localModelSettings()
  const selection = { ...settings, id, modelDefinitionId, baseline: true }
  const account = { ...localSettings, id: 'legacy-account', providerDefinitionId: 'p' }
  const previous = { ...account, versionId: 'previous-settings', credentialRef: 'retired-key' }
  const current = { ...account, revision: 2 }
  const retired = { ...account, id: 'old-account', versionId: 'old-settings', enabled: false }
  const configured = { ...selection, connectionId: current.id }
  const oldSelection = { ...selection, id: 'old-model', versionId: 'old-model-v1', connectionId: retired.id }
  return {
    schemaVersion: 1, providers: [provider()], models: [model()], connections: [current], configurations: [configured],
    sources: [], syncStates: [{ connectionId: current.id, state: 'ready', targetSourceVersion: null, syncedSourceVersion: null }],
    credentialIntents: [{ id: 'previous-key-cleanup', providerId: retired.id, slotId: 'retired-key', createdAt: '2026-01-02' }],
    history: { providers: [provider()], models: [model()], connections: [previous, current, retired], configurations: [configured, oldSelection] },
    tombstones: { connections: [retired.id], configurations: [oldSelection.id] },
  }
}

test('JSON v1 upgrades by provider ID and preserves the live model ID, scope, revisions, credentials, and retired history', async t => {
  const { path } = await temporary(t), legacy = legacySnapshot()
  await writeFile(path, JSON.stringify(legacy))
  const { root, store } = await open(path)
  const setting = { ...providerSettings(), revision: 2, restoreScopeId: 'legacy-account' }
  assert.deepEqual(store.providerSettings('p'), setting)
  assert.deepEqual(store.providerSettingsHistory('p').map(record => [record.revision, record.versionId, record.credentialRef]),
    [[1, 'previous-settings', 'retired-key'], [2, 'settings-v1', 'existing-slot']])
  assert.deepEqual(store.runtimeModelSettings('s'), localModelSettings())
  assert.equal(store.runtimeModelSettings('old-model'), undefined)
  assert.ok(store.modelSettingsHistory('m').some(record => record.runtimeModelId === 'old-model'))
  assert.equal(store.intents()[0].providerId, 'p')
  assert.equal(store.syncState('p').state, 'ready')
  await root.fiber.dispose()
  const snapshot = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(snapshot.schemaVersion, 3)
  assert.deepEqual(snapshot.history.retiredConnections, [legacy.history.connections[2]])
  const reopened = await open(path)
  assert.deepEqual(reopened.store.providerSettings('p'), setting)
})

test('JSON v1 with multiple saved accounts stops migration before writing any bytes', async t => {
  const { path } = await temporary(t), legacy = legacySnapshot()
  legacy.connections.push(legacy.history.connections[2])
  legacy.tombstones.connections = []
  const before = JSON.stringify(legacy)
  await writeFile(path, before)
  await assert.rejects(open(path), { code: 'conflict', message: /"p".*"legacy-account".*"old-account"/ })
  assert.equal(await readFile(path, 'utf8'), before)
  await assert.rejects(access(path + '.lock'), { code: 'ENOENT' })
})

test('JSON v2 requires exactly one enabled option among old presets and retires the other runtime identity', async t => {
  const { path } = await temporary(t)
  const { runtimeModelId, id: modelDefinitionId, ...parameters } = localModelSettings()
  const baseline = { ...parameters, id: runtimeModelId, modelDefinitionId, baseline: true }
  const preset = { ...baseline, id: 'old-preset', versionId: 'old-preset-v1', baseline: false,
    parameters: { protocolId: 'responses', formatVersion: 1, value: { temperature: 0.7 } } }
  const configurations = [baseline, preset]
  const legacy = { schemaVersion: 2, providers: [provider()], models: [model()], providerSettings: [providerSettings()], configurations,
    sources: [], syncStates: [], credentialIntents: [],
    history: { providers: [provider()], models: [model()], providerSettings: [providerSettings()], retiredConnections: [], configurations },
    tombstones: { providerSettings: [], configurations: [] } }
  for (const enabled of [true, false]) {
    const conflict = { ...legacy, configurations: configurations.map(record => ({ ...record, enabled })) }
    const bytes = JSON.stringify(conflict)
    await writeFile(path, bytes)
    await assert.rejects(open(path), { code: 'conflict', message: /"m".*"old-preset".*"s"/ })
    assert.equal(await readFile(path, 'utf8'), bytes)
    await assert.rejects(access(path + '.lock'), { code: 'ENOENT' })
  }
  await writeFile(path, JSON.stringify({ ...legacy, configurations: [{ ...baseline, enabled: false }, preset] }))
  const { root, store } = await open(path)
  assert.equal(store.modelSettings('m').runtimeModelId, preset.id)
  assert.deepEqual(store.runtimeModelSettings(preset.id).parameters, preset.parameters)
  assert.equal(store.runtimeModelSettings(baseline.id), undefined)
  assert.equal(store.modelRuntimeIdExists(baseline.id), true)
  assert.deepEqual(store.modelSettingsHistory('m').filter(record => record.runtimeModelId === baseline.id).map(record => record.enabled), [true, false])
  await root.fiber.dispose()
  const migrated = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(migrated.schemaVersion, 3)
  assert.deepEqual(migrated.tombstones.modelSettings, [baseline.id])
})

test('JSON enforces one settings record per model, pinned definitions and sync guards atomically', async t => {
  const { path } = await temporary(t), { root, store } = await open(path); t.after(() => root.fiber.dispose())
  await store.commit(initial())
  await assert.rejects(store.commit({ modelSettings: [{ record: { ...localModelSettings(), runtimeModelId: 'duplicate', versionId: 'duplicate-v1' }, expectedRevision: null }] }))
  await assert.rejects(store.commit({ modelSettings: [{ record: { ...localModelSettings(), revision: 2, versionId: 'wrong-version-v2', modelDefinitionVersionId: 'missing' }, expectedRevision: 1 }] }))
  await store.commit({ syncStates: [{ providerId: 'p', state: 'pending', targetSourceVersion: 'new', syncedSourceVersion: null }] })
  await assert.rejects(store.commit({ syncGuards: [{ providerId: 'p', targetSourceVersion: 'old' }],
    syncStates: [{ providerId: 'p', state: 'ready', targetSourceVersion: 'old', syncedSourceVersion: 'old' }] }), { code: 'conflict' })
  assert.equal(store.syncState('p').targetSourceVersion, 'new')
  assert.equal(store.configuredModels().length, 1)
})

test('SQLite imports preserve current records, deleted histories and credential journals only when JSON is absent', async t => {
  const { path, legacyPath } = await temporary(t), oldRoot = new Context()
  await oldRoot.installComponent(createModelsStoreComponent({ path: legacyPath }))
  const old = oldRoot.get('models.store')
  await old.commit(initial())
  await old.commit({ deleteProviderSettings: { id: 'p', expectedRevision: 1 }, addIntents: [{ id: 'orphan', providerId: 'p', slotId: 'existing-slot', createdAt: '2026-01-02' }] })
  await oldRoot.fiber.dispose()
  const first = await open(path, { legacyPath })
  assert.deepEqual(first.store.providers(), [provider()])
  assert.deepEqual(first.store.models(), [model()])
  assert.deepEqual(first.store.configuredProviders(), [])
  assert.deepEqual(first.store.providerSettingsHistory('p'), [providerSettings()])
  assert.deepEqual(first.store.modelSettingsHistory('m'), [localModelSettings()])
  assert.equal(first.store.intents()[0].id, 'orphan')
  await first.root.fiber.dispose(); await access(legacyPath)
  await writeFile(legacyPath, 'no longer a SQLite database')
  const second = await open(path, { legacyPath }); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.providerSettingsHistory('p').length, 1)
})

test('malformed and structurally invalid JSON remains untouched and does not fall back to SQLite', async t => {
  const { path, legacyPath } = await temporary(t)
  await writeFile(path, '{ invalid JSON')
  await assert.rejects(open(path, { legacyPath }))
  assert.equal(await readFile(path, 'utf8'), '{ invalid JSON')
  const cleanPath = path + '.valid', first = await open(cleanPath)
  await first.store.commit(initial()); await first.root.fiber.dispose()
  const clean = await readFile(cleanPath, 'utf8'), invalidBytes = Buffer.from(clean)
  invalidBytes[invalidBytes.indexOf('Local model')] = 0xff
  await writeFile(path, invalidBytes)
  await assert.rejects(open(path, { legacyPath }))
  assert.deepEqual(await readFile(path), invalidBytes)
  const invalid = JSON.parse(clean)
  invalid.modelSettings[0].capabilities.reasoning.support = 'made-up'
  await writeFile(path, JSON.stringify(invalid))
  const before = await readFile(path, 'utf8')
  await assert.rejects(open(path, { legacyPath }))
  assert.equal(await readFile(path, 'utf8'), before)
})

test('unknown native extensions imported to JSON remain readable and upgrade later without rewriting their historical parameters', async t => {
  const { path, legacyPath } = await temporary(t), oldRoot = new Context()
  await oldRoot.installComponent(createModelsStoreComponent({ path: legacyPath }))
  const data = initial()
  data.providerSettings.record.protocolId = 'custom'
  data.modelSettings[0].record.parameters = { protocolId: 'custom', formatVersion: 0, value: { temperature: 0, protocol: { future: false } } }
  await oldRoot.get('models.store').commit(data); await oldRoot.fiber.dispose()
  const first = await open(path, { legacyPath })
  const before = first.store.runtimeModelSettings('s')
  assert.deepEqual(before.parameters, data.modelSettings[0].record.parameters)
  await first.root.fiber.dispose()
  const second = await open(path, { legacyPath, legacyParameterConverters: { custom: value => ({ temperature: value.temperature, future: value.protocol.future }) } })
  assert.equal(second.store.runtimeModelSettings('s').id, before.id)
  assert.deepEqual(second.store.runtimeModelSettings('s').parameters, { protocolId: 'custom', formatVersion: 1, value: { temperature: 0, future: false } })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored.history.modelSettings[0].parameters, before.parameters)
  await second.root.fiber.dispose()
})

test('manual capability structure errors reject the whole edit while preserving the source file', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial()); await first.root.fiber.dispose()
  const clean = await readFile(path, 'utf8')
  for (const reasoning of [
    { support: 'supported', efforts: ['high', 'high'] },
    { support: 'supported', modes: [] },
    { support: 'supported', budget: { min: 1.5, max: 10 } },
    { support: 'supported', budget: { min: 20, max: 10 } },
  ]) {
    const document = JSON.parse(clean)
    document.modelSettings[0].name = 'Should not commit'
    document.modelSettings[0].capabilities.reasoning = reasoning
    await writeFile(path, JSON.stringify(document))
    const before = await readFile(path, 'utf8')
    await assert.rejects(open(path))
    assert.equal(await readFile(path, 'utf8'), before)
  }
})

test('the JSON store holds exclusive ownership across aliases and rejects reserved storage paths', async t => {
  const { directory, path } = await temporary(t), first = await open(path)
  const aliasDirectory = join(directory, 'alias')
  await symlink(directory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(open(join(aliasDirectory, 'models.json')))
  await first.root.fiber.dispose()
  await assert.rejects(open(path, { reservedPaths: [path] }))
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.deepEqual(second.store.configuredModels(), [])
})

test('a confirmed process exit releases JSON ownership without discarding committed credential intents', async t => {
  const { path } = await temporary(t), moduleUrl = new URL('../dist/index.js', import.meta.url).href
  const script = `import { Context } from '@nya/core'; import { createModelsJsonStoreComponent } from ${JSON.stringify(moduleUrl)};
    const root = new Context(); await root.installComponent(createModelsJsonStoreComponent({path:process.argv[1]}));
    await root.get('models.store').commit({addIntents:[{id:'orphan',providerId:'missing',slotId:'slot',createdAt:'2026-01-01'}]});
    process.stdout.write('ready\\n'); setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await new Promise((resolve, reject) => {
    let output = '', errors = ''
    child.stdout.on('data', value => { output += value; if (output.includes('ready')) resolve() })
    child.stderr.on('data', value => { errors += value })
    child.once('error', reject); child.once('exit', code => reject(new Error(`child exited ${code}: ${errors}`)))
  })
  await assert.rejects(open(path))
  child.kill('SIGKILL'); await once(child, 'exit')
  const reopened = await open(path); t.after(() => reopened.root.fiber.dispose())
  assert.equal(reopened.store.intents()[0].id, 'orphan')
})

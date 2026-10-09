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
const connection = () => ({ ...version('c'), providerDefinitionId: 'p', name: 'Account', enabled: true, protocolId: 'responses',
  baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, credentialRef: 'existing-slot', historyScopeEpoch: 'original-scope' })
const configuration = () => ({ ...version('s'), modelDefinitionId: 'm', modelDefinitionVersionId: 'm-v1', connectionId: 'c',
  name: 'Local model', enabled: true, remoteModelId: 'remote', baseline: true, parameters: { protocolId: 'responses', formatVersion: 1, value: {} }, capabilities })
const initial = () => ({ providers: [{ record: provider(), expectedRevision: null }], models: [{ record: model(), expectedRevision: null }],
  connection: { record: connection(), expectedRevision: null }, configurations: [{ record: configuration(), expectedRevision: null }] })
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
  const original = configuration()
  await edit(path, value => {
    value.configurations[0].capabilities.reasoning = { support: 'supported', efforts: ['low', 'high'] }
    value.configurations[0].parameters.value = { reasoning: { effort: 'high' } }
    value.configurations[0].name = 'Deep analysis'
  })
  const second = await open(path), edited = second.store.configuration('s')
  assert.equal(edited.revision, 2)
  assert.notEqual(edited.versionId, original.versionId)
  assert.equal(edited.modelDefinitionVersionId, original.modelDefinitionVersionId)
  assert.deepEqual(edited.capabilities.reasoning, { support: 'supported', efforts: ['low', 'high'] })
  assert.deepEqual(edited.parameters.value, { reasoning: { effort: 'high' } })
  assert.deepEqual(second.store.configurationHistory('s'), [original, edited])
  edited.capabilities.tools.support = 'unsupported'
  assert.equal(second.store.configuration('s').capabilities.tools.support, 'supported')
  await second.root.fiber.dispose()
  const third = await open(path); t.after(() => third.root.fiber.dispose())
  assert.equal(third.store.configuration('s').revision, 2)
  assert.equal(third.store.configurationHistory('s').length, 2)
})

test('manual endpoint edits rotate account scope while renames preserve it and credential references stay fixed', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial()); await first.root.fiber.dispose()
  await edit(path, value => { value.connections[0].name = 'Renamed account' })
  const second = await open(path)
  assert.equal(second.store.connection('c').historyScopeEpoch, 'original-scope')
  assert.equal(second.store.connection('c').revision, 2)
  await second.root.fiber.dispose()
  await edit(path, value => { value.connections[0].baseUrl = 'https://new-account.invalid/v1' })
  const third = await open(path)
  const current = third.store.connection('c')
  assert.notEqual(current.historyScopeEpoch, 'original-scope')
  assert.equal(current.credentialRef, 'existing-slot')
  assert.equal(current.revision, 3)
  await third.root.fiber.dispose()
  await edit(path, value => { value.connections[0].credentialRef = 'different-slot' })
  const before = await readFile(path, 'utf8')
  await assert.rejects(open(path))
  assert.equal(await readFile(path, 'utf8'), before)
})

test('failed JSON batches preserve the complete file and admitted commits finish before close releases ownership', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  const before = await readFile(path, 'utf8')
  await assert.rejects(first.store.commit({
    connection: { record: { ...connection(), revision: 2, versionId: 'c-v2', name: 'Must roll back' }, expectedRevision: 1 },
    configurations: [{ record: { ...configuration(), revision: 2, versionId: 's-v2' }, expectedRevision: 9 }],
    addIntents: [{ id: 'not-committed', providerId: 'c', slotId: 'orphan', createdAt: '2026-01-02' }],
  }), { code: 'conflict' })
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(first.store.connection('c').revision, 1)
  assert.deepEqual(first.store.intents(), [])
  const committing = first.store.commit({ connection: { record: { ...connection(), revision: 2, versionId: 'c-v2', name: 'Committed' }, expectedRevision: 1 } })
  await first.root.fiber.dispose(); await committing
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.connection('c').name, 'Committed')
  await assert.rejects(first.store.commit({}), { code: 'closed' })
})

test('external edits made while active are preserved and writes refuse to overwrite them', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  await edit(path, value => { value.configurations[0].name = 'Edited with a text editor' })
  const changed = await readFile(path, 'utf8')
  await assert.rejects(first.store.commit({ connection: { record: { ...connection(), revision: 2, versionId: 'c-v2' }, expectedRevision: 1 } }), { code: 'conflict' })
  assert.equal(await readFile(path, 'utf8'), changed)
  assert.equal(first.store.configuration('s').name, 'Local model')
  await first.root.fiber.dispose()
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.configuration('s').name, 'Edited with a text editor')
})

test('deletion preserves immutable history and cleanup intents without allowing manual resurrection', async t => {
  const { path } = await temporary(t), first = await open(path)
  await first.store.commit(initial())
  const intent = { id: 'retired', providerId: 'c', slotId: 'existing-slot', createdAt: '2026-01-02' }
  await first.store.commit({ deleteConnection: { id: 'c', expectedRevision: 1 }, addIntents: [intent] })
  await first.root.fiber.dispose()
  const second = await open(path)
  assert.equal(second.store.connection('c'), undefined)
  assert.equal(second.store.configuration('s'), undefined)
  assert.deepEqual(second.store.connectionHistory('c'), [connection()])
  assert.deepEqual(second.store.configurationHistory('s'), [configuration()])
  assert.deepEqual(second.store.intents(), [intent])
  await assert.rejects(second.store.commit(initial()), { code: 'conflict' })
  await second.root.fiber.dispose()
  await edit(path, value => { value.connections.push(connection()); value.configurations.push(configuration()) })
  await assert.rejects(open(path))
})

test('JSON enforces baseline, pinned definitions and sync guards atomically', async t => {
  const { path } = await temporary(t), { root, store } = await open(path); t.after(() => root.fiber.dispose())
  await store.commit(initial())
  await assert.rejects(store.commit({ configurations: [{ record: { ...configuration(), id: 'duplicate', versionId: 'duplicate-v1' }, expectedRevision: null }] }))
  await assert.rejects(store.commit({ configurations: [{ record: { ...configuration(), id: 'wrong-version', versionId: 'wrong-version-v1', baseline: false, modelDefinitionVersionId: 'missing' }, expectedRevision: null }] }))
  await store.commit({ syncStates: [{ connectionId: 'c', state: 'pending', targetSourceVersion: 'new', syncedSourceVersion: null }] })
  await assert.rejects(store.commit({ syncGuards: [{ connectionId: 'c', targetSourceVersion: 'old' }],
    syncStates: [{ connectionId: 'c', state: 'ready', targetSourceVersion: 'old', syncedSourceVersion: 'old' }] }), { code: 'conflict' })
  assert.equal(store.syncState('c').targetSourceVersion, 'new')
  assert.equal(store.configurations().length, 1)
})

test('SQLite imports preserve current records, deleted histories and credential journals only when JSON is absent', async t => {
  const { path, legacyPath } = await temporary(t), oldRoot = new Context()
  await oldRoot.installComponent(createModelsStoreComponent({ path: legacyPath }))
  const old = oldRoot.get('models.store')
  await old.commit(initial())
  await old.commit({ deleteConnection: { id: 'c', expectedRevision: 1 }, addIntents: [{ id: 'orphan', providerId: 'c', slotId: 'existing-slot', createdAt: '2026-01-02' }] })
  await oldRoot.fiber.dispose()
  const first = await open(path, { legacyPath })
  assert.deepEqual(first.store.providers(), [provider()])
  assert.deepEqual(first.store.models(), [model()])
  assert.deepEqual(first.store.connections(), [])
  assert.deepEqual(first.store.connectionHistory('c'), [connection()])
  assert.deepEqual(first.store.configurationHistory('s'), [configuration()])
  assert.equal(first.store.intents()[0].id, 'orphan')
  await first.root.fiber.dispose(); await access(legacyPath)
  await writeFile(legacyPath, 'no longer a SQLite database')
  const second = await open(path, { legacyPath }); t.after(() => second.root.fiber.dispose())
  assert.equal(second.store.connectionHistory('c').length, 1)
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
  invalid.configurations[0].capabilities.reasoning.support = 'made-up'
  await writeFile(path, JSON.stringify(invalid))
  const before = await readFile(path, 'utf8')
  await assert.rejects(open(path, { legacyPath }))
  assert.equal(await readFile(path, 'utf8'), before)
})

test('unknown native extensions imported to JSON remain readable and upgrade later without rewriting their historical parameters', async t => {
  const { path, legacyPath } = await temporary(t), oldRoot = new Context()
  await oldRoot.installComponent(createModelsStoreComponent({ path: legacyPath }))
  const data = initial()
  data.connection.record.protocolId = 'custom'
  data.configurations[0].record.parameters = { protocolId: 'custom', formatVersion: 0, value: { temperature: 0, protocol: { future: false } } }
  await oldRoot.get('models.store').commit(data); await oldRoot.fiber.dispose()
  const first = await open(path, { legacyPath })
  const before = first.store.configuration('s')
  assert.deepEqual(before.parameters, data.configurations[0].record.parameters)
  await first.root.fiber.dispose()
  const second = await open(path, { legacyPath, legacyParameterConverters: { custom: value => ({ temperature: value.temperature, future: value.protocol.future }) } })
  assert.equal(second.store.configuration('s').id, before.id)
  assert.deepEqual(second.store.configuration('s').parameters, { protocolId: 'custom', formatVersion: 1, value: { temperature: 0, future: false } })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored.history.configurations[0].parameters, before.parameters)
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
    document.configurations[0].name = 'Should not commit'
    document.configurations[0].capabilities.reasoning = reasoning
    await writeFile(path, JSON.stringify(document))
    const before = await readFile(path, 'utf8')
    await assert.rejects(open(path))
    assert.equal(await readFile(path, 'utf8'), before)
  }
})

test('the JSON store holds exclusive ownership across aliases and rejects reserved storage paths', async t => {
  const { directory, path } = await temporary(t), first = await open(path)
  const aliasDirectory = join(directory, 'alias')
  await symlink(directory, aliasDirectory)
  await assert.rejects(open(join(aliasDirectory, 'models.json')))
  await first.root.fiber.dispose()
  await assert.rejects(open(path, { reservedPaths: [path] }))
  const second = await open(path); t.after(() => second.root.fiber.dispose())
  assert.deepEqual(second.store.configurations(), [])
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

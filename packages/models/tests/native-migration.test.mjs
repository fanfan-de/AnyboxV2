import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context, FiberState } from '@nya/core'
import { createModelsJsonStoreComponent, createModelsStoreComponent, migrateLegacyParameters } from '../dist/index.js'
const cap = { support: 'unknown' }, capabilities = { tools: cap, streaming: cap, imageInput: cap, reasoning: cap }
const version = id => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
const oldParameters = {
  responses: { temperature: 0, maxOutputTokens: 12, protocol: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
  'chat-completions': { maxOutputTokens: 23, protocol: { reasoningEffort: 'none' } },
  'anthropic-messages': { maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 1024, reasoningDisplay: 'omitted', reasoningEffort: 'high' } },
  'gemini-interactions': { maxOutputTokens: 45, protocol: { thinkingLevel: 'high', thinkingSummaries: 'none' } },
}
const expected = { responses: { temperature: 0, max_output_tokens: 12, reasoning: { effort: 'high', summary: 'auto' } }, 'chat-completions': { max_completion_tokens: 23, reasoning_effort: 'none' }, 'anthropic-messages': { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024, display: 'omitted' }, output_config: { effort: 'high' } }, 'gemini-interactions': { generation_config: { max_output_tokens: 45, thinking_level: 'high', thinking_summaries: 'none' } } }
async function open(path, converters = {}) { const root = new Context(), fiber = root.installComponent(createModelsStoreComponent({ path, legacyParameterConverters: converters })); await fiber; assert.equal(fiber.state, FiberState.ACTIVE); return { root, store: root.get('models.store') } }
async function seedV2(t, values = oldParameters) {
  const directory = await mkdtemp(join(tmpdir(), 'models-v2-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'models.sqlite'), db = new DatabaseSync(path), snapshots = {}
  db.exec(`
    CREATE TABLE provider_definitions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,source_id TEXT,external_provider_id TEXT,record TEXT NOT NULL);
    CREATE TABLE provider_definition_versions(provider_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(provider_id,revision));
    CREATE TABLE model_definitions(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,revision INTEGER NOT NULL,source_id TEXT,external_provider_id TEXT,external_model_id TEXT,record TEXT NOT NULL);
    CREATE TABLE model_definition_versions(model_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(model_id,revision));
    CREATE TABLE connections(id TEXT PRIMARY KEY,provider_definition_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE TABLE connection_versions(connection_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(connection_id,revision));
    CREATE TABLE configurations(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,model_definition_id TEXT NOT NULL,baseline INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE TABLE configuration_versions(configuration_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(configuration_id,revision));
    CREATE TABLE sources(source_id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE connection_sync_states(connection_id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE credential_intents(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    PRAGMA user_version=2;
  `)
  for (const [protocolId, defaults] of Object.entries(values)) {
    const provider = { ...version(`p-${protocolId}`), name: protocolId, source: { kind: 'user' }, state: 'present', connectionHints: { protocolIds: [protocolId] } }
    const model = { ...version(`m-${protocolId}`), providerId: provider.id, remoteModelId: 'remote', name: 'model', source: { kind: 'user' }, state: 'present',
      capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } }
    const connection = { ...version(`c-${protocolId}`), providerDefinitionId: provider.id, protocolId, name: 'account', enabled: true,
      baseUrl: 'https://unit.invalid', auth: 'api-key', timeoutMs: 1000, credentialRef: `slot-${protocolId}` }
    const configuration = { ...version(`s-${protocolId}`), modelDefinitionId: model.id, modelDefinitionVersionId: model.versionId, connectionId: connection.id,
      remoteModelId: 'remote', name: 'saved', enabled: protocolId !== 'responses', baseline: true, capabilities, defaults }
    for (const [table, record] of [['provider_definition_versions', provider], ['model_definition_versions', model],
      ['connection_versions', connection], ['configuration_versions', configuration]]) {
      db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(record.id, record.revision, record.versionId, JSON.stringify(record))
    }
    db.prepare('INSERT INTO provider_definitions VALUES(?,?,NULL,NULL,?)').run(provider.id, 1, JSON.stringify(provider))
    db.prepare('INSERT INTO model_definitions VALUES(?,?,?,NULL,NULL,NULL,?)').run(model.id, provider.id, 1, JSON.stringify(model))
    db.prepare('INSERT INTO connections VALUES(?,?,?,?)').run(connection.id, provider.id, 1, JSON.stringify(connection))
    snapshots[protocolId] = JSON.stringify(configuration)
    db.prepare('INSERT INTO configurations VALUES(?,?,?,?,?,?)').run(configuration.id, connection.id, model.id, 1, 1, snapshots[protocolId])
  }
  db.close()
  return { path, snapshots }
}

test('v2→v5 converts the four supported protocols atomically without rewriting immutable JSON, identity or Key references', async t => {
  const { path, snapshots } = await seedV2(t); let opened = await open(path); const epochs = {}
  for (const protocolId of Object.keys(oldParameters)) { const configuration = opened.store.runtimeModelSettings(`s-${protocolId}`), connection = opened.store.providerSettings(`p-${protocolId}`); assert.deepEqual(configuration.parameters.value, expected[protocolId]); assert.equal(configuration.parameters.formatVersion, 1); assert.equal(configuration.versionId, `s-${protocolId}-v1`); assert.equal(configuration.enabled, protocolId !== 'responses'); assert.equal(connection.credentialRef, `slot-${protocolId}`); epochs[protocolId] = connection.historyScopeEpoch; assert.notEqual(connection.historyScopeEpoch, 'old') }
  await opened.root.fiber.dispose(); const db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); for (const [id, raw] of Object.entries(snapshots)) assert.equal(db.prepare('SELECT record FROM legacy_configuration_versions WHERE configuration_id=?').get(`s-${id}`).record, raw); db.close()
  opened = await open(path); for (const id of Object.keys(epochs)) assert.equal(opened.store.providerSettings(`p-${id}`).historyScopeEpoch, epochs[id]); await opened.root.fiber.dispose()
})

test('unknown extension parameters stay readable and convert on a later startup with a supplied converter', async t => {
  const { path } = await seedV2(t, { custom: { temperature: 0, protocol: { future: false } } }); let opened = await open(path); assert.deepEqual(opened.store.runtimeModelSettings('s-custom').parameters, { protocolId: 'custom', formatVersion: 0, value: { temperature: 0, protocol: { future: false } } }); await opened.root.fiber.dispose()
  opened = await open(path, { custom: old => ({ temperature: old.temperature, future: old.protocol.future }) }); assert.deepEqual(opened.store.runtimeModelSettings('s-custom').parameters.value, { temperature: 0, future: false }); assert.equal(opened.store.runtimeModelSettings('s-custom').parameters.formatVersion, 1); await opened.root.fiber.dispose()
})

test('one-time JSON import converts legacy SQLite data without committing changes to the source', async t => {
  const { path } = await seedV2(t, { responses: oldParameters.responses })
  const before = await readFile(path), root = new Context()
  try {
    const fiber = root.installComponent(createModelsJsonStoreComponent({ path: join(dirname(path), 'models.json'), legacyPath: path }))
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    const store = root.get('models.store'), settings = store.providerSettings('p-responses')
    assert.equal(settings.restoreScopeId, 'c-responses')
    assert.equal(settings.credentialRef, 'slot-responses')
    assert.equal(store.runtimeModelSettings('s-responses').providerId, 'p-responses')
    assert.deepEqual(store.runtimeModelSettings('s-responses').parameters.value, expected.responses)
    assert.deepEqual(await readFile(path), before)
  } finally { await root.fiber.dispose() }
})

test('migration failure rolls back every current record and the schema version', async t => {
  const { path, snapshots } = await seedV2(t); let db = new DatabaseSync(path); db.exec("CREATE TRIGGER fail_native_parameters BEFORE UPDATE ON configurations BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;"); db.close()
  const root = new Context(), fiber = root.installComponent(createModelsStoreComponent({ path })); await assert.rejects(Promise.resolve(fiber), { code: 'storage-unavailable' }); assert.equal(fiber.state, FiberState.FAILED); await root.fiber.dispose(); db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2); assert.equal(db.prepare('SELECT record FROM configurations WHERE id=?').get('s-responses').record, snapshots.responses); assert.equal(JSON.parse(db.prepare('SELECT record FROM connections LIMIT 1').get().record).historyScopeEpoch, undefined); db.close()
})

test('legacy parameter conversion preserves omissions and unsupported fields instead of inventing native values', () => {
  for (const id of Object.keys(oldParameters)) { const empty = migrateLegacyParameters(id, {}); assert.deepEqual(empty.value, {}); assert.equal(empty.formatVersion, 1) }
  assert.equal(migrateLegacyParameters('responses', { protocol: { unknown: false } }).formatVersion, 0)
  assert.deepEqual(migrateLegacyParameters('anthropic-messages', { maxOutputTokens: 7000 }).value, { max_tokens: 7000 })
})

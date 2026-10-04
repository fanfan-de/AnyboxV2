import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context, FiberState } from '@nya/core'
import { createModelsStoreComponent, migrateLegacyParameters } from '../dist/index.js'
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
  const directory = await mkdtemp(join(tmpdir(), 'models-v3-')); t.after(() => rm(directory, { recursive: true, force: true })); const path = join(directory, 'models.sqlite'), { root, store } = await open(path)
  for (const protocolId of Object.keys(values)) {
    await store.commit({ providers: [{ expectedRevision: null, record: { ...version(`p-${protocolId}`), name: protocolId, source: { kind: 'user' }, state: 'present', connectionHints: { protocolIds: [protocolId] } } }], models: [{ expectedRevision: null, record: { ...version(`m-${protocolId}`), providerId: `p-${protocolId}`, remoteModelId: 'remote', name: 'model', source: { kind: 'user' }, state: 'present', capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } } }], connection: { expectedRevision: null, record: { ...version(`c-${protocolId}`), providerDefinitionId: `p-${protocolId}`, protocolId, name: 'account', enabled: true, baseUrl: 'https://unit.invalid', auth: 'api-key', timeoutMs: 1000, credentialRef: `slot-${protocolId}`, historyScopeEpoch: 'old' } }, configurations: [{ expectedRevision: null, record: { ...version(`s-${protocolId}`), modelDefinitionId: `m-${protocolId}`, modelDefinitionVersionId: `m-${protocolId}-v1`, connectionId: `c-${protocolId}`, remoteModelId: 'remote', name: 'saved', enabled: protocolId !== 'responses', baseline: true, capabilities, parameters: { protocolId, formatVersion: 1, value: {} } } }] })
  }
  await root.fiber.dispose(); const db = new DatabaseSync(path), snapshots = {}
  for (const [protocolId, defaults] of Object.entries(values)) {
    for (const table of ['connections', 'connection_versions']) { const key = table === 'connections' ? 'id' : 'connection_id', row = db.prepare(`SELECT record FROM ${table} WHERE ${key}=?`).get(`c-${protocolId}`), { historyScopeEpoch: _epoch, ...record } = JSON.parse(row.record); db.prepare(`UPDATE ${table} SET record=? WHERE ${key}=?`).run(JSON.stringify(record), `c-${protocolId}`) }
    for (const table of ['configurations', 'configuration_versions']) { const key = table === 'configurations' ? 'id' : 'configuration_id', row = db.prepare(`SELECT record FROM ${table} WHERE ${key}=?`).get(`s-${protocolId}`), { parameters: _params, ...record } = JSON.parse(row.record), raw = JSON.stringify({ ...record, defaults }); db.prepare(`UPDATE ${table} SET record=? WHERE ${key}=?`).run(raw, `s-${protocolId}`); if (table === 'configuration_versions') snapshots[protocolId] = raw }
  }
  db.exec('PRAGMA user_version=2'); db.close(); return { path, snapshots }
}

test('v2→v3 converts the four supported protocols atomically without rewriting immutable JSON, identity or Key references', async t => {
  const { path, snapshots } = await seedV2(t); let opened = await open(path); const epochs = {}
  for (const protocolId of Object.keys(oldParameters)) { const configuration = opened.store.configuration(`s-${protocolId}`), connection = opened.store.connection(`c-${protocolId}`); assert.deepEqual(configuration.parameters.value, expected[protocolId]); assert.equal(configuration.parameters.formatVersion, 1); assert.equal(configuration.versionId, `s-${protocolId}-v1`); assert.equal(configuration.enabled, protocolId !== 'responses'); assert.equal(connection.credentialRef, `slot-${protocolId}`); epochs[protocolId] = connection.historyScopeEpoch; assert.notEqual(connection.historyScopeEpoch, 'old') }
  await opened.root.fiber.dispose(); const db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3); for (const [id, raw] of Object.entries(snapshots)) assert.equal(db.prepare('SELECT record FROM configuration_versions WHERE configuration_id=?').get(`s-${id}`).record, raw); db.close()
  opened = await open(path); for (const id of Object.keys(epochs)) assert.equal(opened.store.connection(`c-${id}`).historyScopeEpoch, epochs[id]); await opened.root.fiber.dispose()
})

test('unknown extension parameters stay readable and convert on a later startup with a supplied converter', async t => {
  const { path } = await seedV2(t, { custom: { temperature: 0, protocol: { future: false } } }); let opened = await open(path); assert.deepEqual(opened.store.configuration('s-custom').parameters, { protocolId: 'custom', formatVersion: 0, value: { temperature: 0, protocol: { future: false } } }); await opened.root.fiber.dispose()
  opened = await open(path, { custom: old => ({ temperature: old.temperature, future: old.protocol.future }) }); assert.deepEqual(opened.store.configuration('s-custom').parameters.value, { temperature: 0, future: false }); assert.equal(opened.store.configuration('s-custom').parameters.formatVersion, 1); await opened.root.fiber.dispose()
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

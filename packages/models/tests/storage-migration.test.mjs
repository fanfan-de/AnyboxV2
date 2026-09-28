import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Context, FiberState } from '@nya/core';
import { createModelsStoreComponent } from '../dist/store.js';
import { createModelsComponent } from '../dist/component.js';
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js';
import { externalProviderId } from '../dist/identity.js';
import { fakeProtocol, memoryVault } from './helpers.mjs';

const capability = { support: 'unknown' }, capabilities = { tools: capability, streaming: capability, imageInput: capability, reasoning: capability };
const provider = (id, extras = {}) => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  name: id, enabled: true, protocolId: 'absent', baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, credentialRef: `slot-${id}`, ...extras });
const model = (id, providerId, extras = {}) => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  providerId, name: id, enabled: true, remoteModelId: 'same-remote', capabilities, defaults: { temperature: 0.2 }, ...extras });
async function path(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-v1-migration-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'models.sqlite');
}
function createV1(path, providers, models, providerHistory = providers, modelHistory = models) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE providers(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE TABLE provider_versions(provider_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(provider_id,revision));
    CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),revision INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE TABLE model_versions(model_id TEXT NOT NULL,revision INTEGER NOT NULL,version_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,PRIMARY KEY(model_id,revision));
    CREATE TABLE credential_intents(id TEXT PRIMARY KEY,record TEXT NOT NULL); PRAGMA user_version=1;`);
  for (const item of providers) db.prepare('INSERT INTO providers VALUES(?,?,?)').run(item.id, item.revision, JSON.stringify(item));
  for (const item of providerHistory) db.prepare('INSERT INTO provider_versions VALUES(?,?,?,?)').run(item.id, item.revision, item.versionId, JSON.stringify(item));
  for (const item of models) db.prepare('INSERT INTO models VALUES(?,?,?,?)').run(item.id, item.providerId, item.revision, JSON.stringify(item));
  for (const item of modelHistory) db.prepare('INSERT INTO model_versions VALUES(?,?,?,?)').run(item.id, item.revision, item.versionId, JSON.stringify(item));
  db.prepare('INSERT INTO credential_intents VALUES(?,?)').run('orphan', JSON.stringify({ id: 'orphan', providerId: 'not-committed', slotId: 'uncommitted-secret', createdAt: '2026-01-02' }));
  db.close();
}
async function open(path) {
  const root = new Context(), fiber = root.installComponent(createModelsStoreComponent({ path })); await fiber;
  assert.equal(fiber.state, FiberState.ACTIVE); return { root, store: root.get('models.store') };
}

test('v1 missing/null/valid/unknown references migrate without collapsing identities or rewriting credential references', async t => {
  const database = await path(t);
  const first = provider('plain'), nullable = provider('nullable', { catalogRef: null }),
    known = provider('known', { catalogRef: { sourceId: 'models.dev', providerId: 'public' } }),
    second = provider('second-account', { catalogRef: { sourceId: 'models.dev', providerId: 'public' }, enabled: false }),
    unknown = provider('unknown', { catalogRef: { sourceId: 'unregistered-source', providerId: 'nonexistent' } });
  const historyProvider = provider('known', { revision: 2, versionId: 'known-v2', updatedAt: '2026-01-02', name: 'Changed account',
    catalogRef: known.catalogRef, credentialRef: 'latest-slot' });
  const oldModel = model('default', 'known'), changedModel = model('default', 'known', { revision: 2, versionId: 'default-v2',
    updatedAt: '2026-01-02', name: 'Parameters changed', remoteModelId: 'changed-remote', defaults: { temperature: 0.7, maxOutputTokens: 2000 }, enabled: false }),
    variant = model('variant', 'known', { defaults: { temperature: 0.5 } });
  const providers = [first, nullable, historyProvider, second, unknown], models = [changedModel, variant, model('other', 'plain')];
  createV1(database, providers, models, [first, nullable, known, historyProvider, second, unknown], [oldModel, changedModel, variant, models[2]]);
  let opened = await open(database);
  assert.equal(opened.store.connections().length, 5); assert.equal(opened.store.providers().length, 4);
  assert.equal(opened.store.connection('known').providerDefinitionId, externalProviderId('models.dev', 'public'));
  assert.equal(opened.store.connection('second-account').providerDefinitionId, opened.store.connection('known').providerDefinitionId);
  assert.equal(opened.store.provider(opened.store.connection('plain').providerDefinitionId).source.kind, 'user');
  assert.equal(opened.store.provider(opened.store.connection('nullable').providerDefinitionId).source.kind, 'user');
  const unresolved = opened.store.provider(opened.store.connection('unknown').providerDefinitionId);
  assert.equal(unresolved.state, 'unresolved'); assert.deepEqual(unresolved.source, { kind: 'external', sourceId: 'unregistered-source', providerId: 'nonexistent', sourceVersion: null });
  assert.equal(opened.store.connection('known').credentialRef, 'latest-slot'); assert.equal(opened.store.connection('known').versionId, 'known-v2');
  assert.deepEqual(opened.store.connectionHistory('known').map(item => [item.revision, item.versionId, item.credentialRef]), [[1, 'known-v1', 'slot-known'], [2, 'known-v2', 'latest-slot']]);
  assert.equal(opened.store.connection('second-account').enabled, false);
  assert.equal(opened.store.configuration('default').versionId, 'default-v2'); assert.equal(opened.store.configuration('default').enabled, false);
  assert.deepEqual(opened.store.configurationHistory('default').map(item => [item.versionId, item.remoteModelId, item.defaults]),
    [['default-v1', 'same-remote', { temperature: 0.2 }], ['default-v2', 'changed-remote', { temperature: 0.7, maxOutputTokens: 2000 }]]);
  assert.notEqual(opened.store.configuration('variant').modelDefinitionId, opened.store.configuration('default').modelDefinitionId);
  for (const item of opened.store.models()) assert.equal(item.source.kind, 'user');
  assert.equal(opened.store.model(opened.store.configuration('default').modelDefinitionId).providerId, opened.store.connection('known').providerDefinitionId);
  assert.equal(opened.store.modelHistory(opened.store.configuration('default').modelDefinitionId).length, 2);
  assert.deepEqual(opened.store.intents(), [{ id: 'orphan', providerId: 'not-committed', slotId: 'uncommitted-secret', createdAt: '2026-01-02' }]);
  const ids = opened.store.models().map(item => item.id); await opened.root.fiber.dispose();
  const raw = new DatabaseSync(database);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(JSON.parse(raw.prepare('SELECT record FROM legacy_provider_versions WHERE version_id=?').get('known-v1').record), known);
  assert.deepEqual(JSON.parse(raw.prepare('SELECT record FROM legacy_model_versions WHERE version_id=?').get('default-v1').record), oldModel);
  raw.close();
  opened = await open(database); t.after(() => opened.root.fiber.dispose()); assert.deepEqual(opened.store.models().map(item => item.id), ids);
  assert.equal(opened.store.configurations().length, 3); assert.equal(opened.store.connectionHistory('known').length, 2);
});

test('malformed v1 input rolls back table renames, records, and schema version atomically', async t => {
  const database = await path(t), malformed = provider('broken', { catalogRef: { sourceId: 'models.dev' } });
  createV1(database, [provider('valid'), malformed], [model('selected', 'valid')]);
  const root = new Context(), fiber = root.installComponent(createModelsStoreComponent({ path: database }));
  try { await fiber; } catch {}
  assert.equal(fiber.state, FiberState.FAILED); assert.equal(fiber.error.code, 'storage-unavailable'); await root.fiber.dispose();
  const db = new DatabaseSync(database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM providers').get().count, 2);
  assert.deepEqual(JSON.parse(db.prepare('SELECT record FROM models WHERE id=?').get('selected').record), model('selected', 'valid'));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('connections','provider_definitions','legacy_providers')").get().count, 0);
  db.close();
});

test('migrated external placeholders resolve in place while historical executable configurations remain pinned', async t => {
  const database = await path(t); createV1(database, [provider('account', { catalogRef: { sourceId: 'models.dev', providerId: 'remote-provider' } })], [model('selected', 'account')]);
  const { root, store } = await open(database); t.after(() => root.fiber.dispose());
  const placeholder = store.provider(store.connection('account').providerDefinitionId), config = store.configuration('selected');
  await store.commit({ providers: [{ record: { ...placeholder, revision: 2, versionId: 'upstream-provider-v2', name: 'Remote Provider', state: 'present',
    source: { ...placeholder.source, sourceVersion: 'snapshot-v2' }, connectionHints: { protocolIds: ['absent'] } }, expectedRevision: 1 }],
    sources: [{ sourceId: 'models.dev', snapshotVersion: 'snapshot-v2', fetchedAt: 20 }] });
  assert.equal(store.connection('account').providerDefinitionId, placeholder.id); assert.equal(store.connection('account').revision, 1);
  assert.deepEqual(store.configuration('selected'), config); assert.equal(store.models()[0].source.kind, 'user');
  assert.equal(store.providerHistory(placeholder.id)[0].state, 'unresolved');
});

test('a migrated legacy selection opens through Models before and after source import while external baselines remain independent', async t => {
  const database = await path(t), connectionId = 'anybox-imported-default';
  const priorConnection = provider(connectionId, { protocolId: 'chat-completions', catalogRef: { sourceId: 'models.dev', providerId: 'upstream' } });
  const currentConnection = { ...priorConnection, revision: 2, versionId: 'legacy-connection-v2', updatedAt: '2026-01-02', credentialRef: 'retained-slot' };
  const priorModel = model('default', connectionId), currentModel = { ...priorModel, revision: 2, versionId: 'legacy-model-v2',
    updatedAt: '2026-01-02', name: 'My existing model', defaults: { temperature: 0.7, maxOutputTokens: 1234 } };
  createV1(database, [currentConnection], [currentModel], [priorConnection, currentConnection], [priorModel, currentModel]);
  const vault = memoryVault(); vault.secrets.set('retained-slot', 'existing-key');
  const protocol = fakeProtocol('chat-completions');
  let activeRoot;
  t.after(async () => { protocol.release(); if (activeRoot) await activeRoot.fiber.dispose(); });
  const launch = async () => {
    const opened = await open(database); activeRoot = opened.root;
    await activeRoot.installComponent({ name: 'migration-runtime-vault', apply(ctx) { ctx.provide('models.vault', vault); } });
    await activeRoot.installComponent(createModelsComponent());
    activeRoot.get('models.protocols').register(protocol);
    await activeRoot.get('models.settings').retryConnection(connectionId);
    return { ...opened, models: activeRoot.get('models'), settings: activeRoot.get('models.settings'), source: activeRoot.get('models.source-data') };
  };
  let runtime = await launch();
  const saved = runtime.store.configuration('default'), before = await runtime.models.open({ modelId: 'default' });
  assert.equal(before.snapshot.modelId, 'default'); assert.equal(before.snapshot.providerId, connectionId);
  assert.equal(before.snapshot.modelVersionId, 'legacy-model-v2'); assert.equal(before.snapshot.providerVersionId, 'legacy-connection-v2');
  assert.equal(before.snapshot.modelDefinitionVersionId, saved.modelDefinitionVersionId);
  assert.deepEqual(before.snapshot.options, currentModel.defaults);
  assert.equal(runtime.models.get('default').source.kind, 'user');
  const snapshot = normalizeModelsDevCatalog({ upstream: { id: 'upstream', name: 'Upstream', npm: '@ai-sdk/openai-compatible', api: priorConnection.baseUrl,
    models: { 'same-remote': { id: 'same-remote', name: 'Public default', streaming: true, tool_call: true,
      modalities: { input: ['text'], output: ['text'] } } } } }, 'models.dev', 20);
  await runtime.source.accept(snapshot);
  const after = await runtime.models.open({ modelId: 'default' });
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(runtime.store.configuration('default'), saved);
  assert.equal(runtime.store.connection(connectionId).credentialRef, 'retained-slot');
  assert.equal(runtime.store.connection(connectionId).versionId, 'legacy-connection-v2');
  const external = runtime.models.list().find(item => item.source.kind === 'external');
  assert.ok(external); assert.notEqual(external.id, 'default'); assert.notEqual(external.modelDefinitionId, saved.modelDefinitionId);
  assert.equal(external.connectionId, connectionId); assert.equal(external.providerDefinitionId, before.snapshot.providerDefinitionId);
  assert.equal(external.remoteModelId, before.snapshot.remoteModelId); assert.equal(runtime.models.list({ available: true }).length, 2);
  const externalExecution = await runtime.models.open({ modelId: external.id });
  assert.deepEqual(externalExecution.snapshot.options, {});
  for (const execution of [before, after, externalExecution]) {
    await execution.generate({ messages: [{ role: 'user', content: 'Use the retained Key' }] }).result;
    await execution.close();
  }
  assert.deepEqual(protocol.calls.map(call => call.input.credential), ['existing-key', 'existing-key', 'existing-key']);
  assert.equal(vault.operations.some(operation => operation.kind === 'write'), false);
  assert.deepEqual(runtime.settings.configurationHistory('default').map(item => item.versionId), ['default-v1', 'legacy-model-v2']);
  const stableIds = runtime.models.list().map(item => item.id).sort();
  await runtime.root.fiber.dispose(); activeRoot = undefined;
  runtime = await launch();
  assert.deepEqual(runtime.models.list().map(item => item.id).sort(), stableIds);
  const restarted = await runtime.models.open({ modelId: 'default' });
  assert.deepEqual(restarted.snapshot, before.snapshot); await restarted.close();
  assert.equal(runtime.store.connection(connectionId).credentialRef, 'retained-slot');
  assert.deepEqual(runtime.store.configuration('default'), saved);
});

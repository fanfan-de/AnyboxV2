import { params } from './helpers.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Context, FiberState } from '@nya/core';
import { createModelsStoreComponent } from '../dist/store.js';

const capability = { support: 'unknown' };
const version = (id, overrides = {}) => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides });
const provider = (overrides = {}) => ({ ...version('p'), name: 'Provider', source: { kind: 'user' }, state: 'present', connectionHints: { protocolIds: [] }, ...overrides });
const model = (overrides = {}) => ({ ...version('m'), providerId: 'p', remoteModelId: 'remote', name: 'Model', source: { kind: 'user' }, state: 'present',
  capabilities: { tools: capability, streaming: capability, imageInput: capability, reasoning: capability }, controls: { temperature: 'unknown' },
  modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [] }, ...overrides });
const providerSettings = (overrides = {}) => ({ ...version('p', { versionId: 'settings-v1' }), restoreScopeId: 'p', name: 'Account', enabled: true,
  protocolId: 'not-installed', baseUrl: 'http://localhost:1234/v1', auth: 'api-key', timeoutMs: 1000, credentialRef: 'slot-1', historyScopeEpoch: 'scope-1', ...overrides });
const localModelSettings = (overrides = {}) => ({ ...version('m', { versionId: 's-v1' }), runtimeModelId: 's', modelDefinitionVersionId: 'm-v1', providerId: 'p',
  name: 'Local model', enabled: true, remoteModelId: 'remote', parameters: params('not-installed', {}), capabilities: model().capabilities, ...overrides });
async function open(path) {
  const root = new Context();
  fixtureRoots.get(path)?.add(root);
  const fiber = root.installComponent(createModelsStoreComponent({ path }));
  await fiber; assert.equal(fiber.state, FiberState.ACTIVE);
  return { root, store: root.get('models.store') };
}
const fixtureRoots = new Map();
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-store-'));
  const path = join(directory, 'models.sqlite'), roots = new Set(); fixtureRoots.set(path, roots);
  t.after(async () => { for (const root of roots) await root.fiber.dispose(); fixtureRoots.delete(path); await rm(directory, { recursive: true, force: true }); });
  return path;
}
const initial = (overrides = {}) => ({ providers: [{ record: provider(), expectedRevision: null }], models: [{ record: model(), expectedRevision: null }],
  providerSettings: { record: providerSettings(), expectedRevision: null }, modelSettings: [{ record: localModelSettings(), expectedRevision: null }], ...overrides });

test('definitions, provider and model settings, immutable history, and orphan intents survive reopening without protocols', async t => {
  const path = await temporary(t), first = await open(path);
  await first.store.commit(initial());
  await first.store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2', name: 'Edited', apiKey: 'must-never-be-persisted' }), expectedRevision: 1 },
    modelSettings: [{ record: localModelSettings({ revision: 2, versionId: 's-v2', parameters: params('not-installed', { temperature: 0.3 }) }), expectedRevision: 1 }] });
  await first.store.commit({ addIntents: [{ id: 'cleanup', providerId: 'new-uncommitted-connection', slotId: 'orphan', createdAt: '2026-01-02' }] });
  await first.root.fiber.dispose();
  const second = await open(path); t.after(() => second.root.fiber.dispose());
  assert.equal(second.store.providerSettings('p').name, 'Edited');
  assert.deepEqual(second.store.providerSettingsHistory('p').map(item => item.name), ['Account', 'Edited']);
  assert.deepEqual(second.store.modelSettingsHistory('m').map(item => item.parameters.value), [{}, { temperature: 0.3 }]);
  assert.equal(second.store.intents()[0].slotId, 'orphan');
  assert.equal((await readFile(path)).includes(Buffer.from('must-never-be-persisted')), false);
  second.store.runtimeModelSettings('s').parameters.value.temperature = 123;
  assert.equal(second.store.runtimeModelSettings('s').parameters.value.temperature, 0.3);
});

test('CAS conflicts roll back the entire batch, source ledger, synchronization and credential journal', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  await store.commit(initial());
  await assert.rejects(store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2' }), expectedRevision: 1 },
    modelSettings: [{ record: localModelSettings({ revision: 2, versionId: 's-v2' }), expectedRevision: 77 }],
    sources: [{ sourceId: 'public', snapshotVersion: 'v2', fetchedAt: 10 }],
    syncStates: [{ providerId: 'p', state: 'ready', targetSourceVersion: 'v2', syncedSourceVersion: 'v2' }],
    addIntents: [{ id: 'never-written', slotId: 'orphan', providerId: 'p', createdAt: '2026-01-02' }],
  }), { code: 'conflict' });
  assert.equal(store.providerSettings('p').revision, 1); assert.equal(store.providerSettingsHistory('p').length, 1);
  assert.deepEqual(store.sources(), []); assert.equal(store.syncState('p'), undefined); assert.equal(store.intents().length, 0);
  const one = store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2' }), expectedRevision: 1 } });
  const two = store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2-other' }), expectedRevision: 1 } });
  assert.deepEqual((await Promise.allSettled([one, two])).map(item => item.status), ['fulfilled', 'rejected']);
});

test('deleting provider settings preserves histories and permits a fresh setup with the next revision', async t => {
  const path = await temporary(t), first = await open(path);
  await first.store.commit(initial({ syncStates: [{ providerId: 'p', state: 'ready', targetSourceVersion: null, syncedSourceVersion: null }] }));
  await first.store.commit({ providers: [{ record: provider({ ...version('other-p') }), expectedRevision: null }],
    models: [{ record: model({ ...version('other-m'), providerId: 'other-p' }), expectedRevision: null }],
    providerSettings: { record: providerSettings({ id: 'other-p', restoreScopeId: 'other-p', versionId: 'other-settings-v1' }), expectedRevision: null },
    modelSettings: [{ record: localModelSettings({ ...version('other-m', { versionId: 'other-s-v1' }), runtimeModelId: 'other-s', providerId: 'other-p', modelDefinitionVersionId: 'other-m-v1' }), expectedRevision: null }] });
  const intent = { id: 'retired-key', providerId: 'p', slotId: 'slot-1', createdAt: '2026-01-02' };
  await assert.rejects(first.store.commit({ deleteProviderSettings: { id: 'p', expectedRevision: 2 }, addIntents: [intent] }), { code: 'conflict' });
  assert.equal(first.store.runtimeModelSettings('s').id, 'm'); assert.equal(first.store.syncState('p').state, 'ready'); assert.deepEqual(first.store.intents(), []);
  await assert.rejects(first.store.commit({ deleteProviderSettings: { id: 'p', expectedRevision: 0 } }), { code: 'invalid-config' });
  const input = { deleteProviderSettings: { id: 'p', expectedRevision: 1 }, addIntents: [intent] };
  const deleting = first.store.commit(input); input.deleteProviderSettings.id = 'other-p'; await deleting;
  assert.equal(first.store.providerSettings('p'), undefined); assert.equal(first.store.runtimeModelSettings('s'), undefined); assert.equal(first.store.syncState('p'), undefined);
  assert.equal(first.store.providerSettings('other-p').id, 'other-p'); assert.equal(first.store.runtimeModelSettings('other-s').id, 'other-m');
  assert.equal(first.store.provider('p').id, 'p'); assert.equal(first.store.model('m').id, 'm');
  assert.deepEqual(first.store.intents(), [intent]);
  await first.root.fiber.dispose();
  const second = await open(path); t.after(() => second.root.fiber.dispose());
  assert.equal(second.store.providerSettings('p'), undefined); assert.equal(second.store.runtimeModelSettings('s'), undefined);
  assert.equal(second.store.providerSettingsHistory('p').length, 1); assert.equal(second.store.modelSettingsHistory('m').length, 1);
  await assert.rejects(second.store.commit({ providerSettings: { record: providerSettings(), expectedRevision: null } }), { code: 'conflict' });
  await assert.rejects(second.store.commit({ deleteProviderSettings: { id: 'p', expectedRevision: 1 } }), { code: 'not-found' });
  const fresh = providerSettings({ revision: 2, versionId: 'settings-v2', protocolId: 'other', historyScopeEpoch: 'scope-2', credentialRef: null });
  await second.store.commit({ providerSettings: { record: fresh, expectedRevision: null } });
  assert.deepEqual(second.store.providerSettingsHistory('p'), [providerSettings(), fresh]);
  await assert.rejects(second.store.commit({ modelSettings: [{ record: localModelSettings(), expectedRevision: null }] }), { code: 'conflict' });
  await assert.rejects(second.store.commit({ modelSettings: [{ record: localModelSettings({ revision: 2, versionId: 's-v2' }), expectedRevision: null }] }), { code: 'conflict' });
  const replacement = localModelSettings({ revision: 2, versionId: 's-v2', runtimeModelId: 'new-runtime' });
  await second.store.commit({ modelSettings: [{ record: replacement, expectedRevision: null }] });
  assert.equal(second.store.runtimeModelSettings('s'), undefined);
  assert.equal(second.store.modelRuntimeIdExists('s'), true);
  assert.deepEqual(second.store.configuredModels().find(record => record.id === 'm'), replacement);
  assert.deepEqual(second.store.modelSettingsHistory('m'), [localModelSettings(), replacement]);
});

test('storage enforces immutable identities, fixed protocols, one settings record per model, and pins historical definition versions', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  const admittedInput = initial(), admitted = store.commit(admittedInput); admittedInput.providerSettings.record.name = 'Changed'; await admitted;
  assert.equal(store.providerSettings('p').name, 'Account');
  await assert.rejects(store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2', protocolId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ providerSettings: { record: providerSettings({ revision: 2, versionId: 'c-v2', restoreScopeId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ providerSettings: { record: providerSettings({ id: 'ghost' }), expectedRevision: null } }), { code: 'not-found' });
  await assert.rejects(store.commit({ modelSettings: [{ record: localModelSettings({ revision: 2, versionId: 's-v2', providerId: 'other' }), expectedRevision: 1 }] }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ modelSettings: [{ record: localModelSettings({ runtimeModelId: 'second', versionId: 'second-v1' }), expectedRevision: null }] }), { code: 'conflict' });
  await store.commit({ models: [{ record: model({ revision: 2, versionId: 'm-v2', remoteModelId: 'new-remote' }), expectedRevision: 1 }] });
  await store.commit({ modelSettings: [{ record: localModelSettings({ revision: 2, versionId: 's-v2', parameters: params('not-installed', { temperature: 0.4 }) }), expectedRevision: 1 }] });
  assert.equal(store.runtimeModelSettings('s').remoteModelId, 'remote');
  await assert.rejects(store.commit({ modelSettings: [{ record: localModelSettings({ revision: 3, versionId: 'bad-pin-v3', modelDefinitionVersionId: 'm-v2' }), expectedRevision: 2 }] }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ models: [{ record: model({ id: 'missing-owner', versionId: 'missing-v1', providerId: 'other' }), expectedRevision: null }] }), { code: 'not-found' });
});

test('SQLite v4 migration is atomic on conflicting presets and keeps archived runtime IDs unavailable', async t => {
  const path = await temporary(t), seed = await open(path);
  await seed.store.commit(initial({ modelSettings: [] })); await seed.root.fiber.dispose();
  const { id: modelDefinitionId, runtimeModelId: id, ...settings } = localModelSettings();
  const baseline = { ...settings, id, modelDefinitionId, baseline: true };
  const preset = { ...baseline, id: 'old-preset', versionId: 'old-preset-v1', baseline: false,
    parameters: params('not-installed', { temperature: 0.7 }) };
  let db = new DatabaseSync(path);
  db.exec(`DROP TABLE model_settings_versions; DROP TABLE model_settings;
    CREATE TABLE model_configurations (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider_settings(id),
      model_definition_id TEXT NOT NULL REFERENCES model_definitions(id), baseline INTEGER NOT NULL,
      revision INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE UNIQUE INDEX model_configuration_baseline ON model_configurations(provider_id,model_definition_id) WHERE baseline=1;
    CREATE TABLE model_configuration_versions (configuration_id TEXT NOT NULL, revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(configuration_id,revision)); PRAGMA user_version=4;`);
  for (const record of [baseline, preset]) {
    const encoded = JSON.stringify(record);
    db.prepare('INSERT INTO model_configurations VALUES (?,?,?,?,?,?)').run(record.id, record.providerId, record.modelDefinitionId, Number(record.baseline), record.revision, encoded);
    db.prepare('INSERT INTO model_configuration_versions VALUES (?,?,?,?)').run(record.id, record.revision, record.versionId, encoded);
  }
  db.close();
  const before = await readFile(path);
  const root = new Context(), blocked = root.installComponent(createModelsStoreComponent({ path }));
  await assert.rejects(Promise.resolve(blocked), { code: 'conflict', message: /"m".*"old-preset".*"s"/ });
  await root.fiber.dispose();
  assert.deepEqual(await readFile(path), before);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  const revision = { ...baseline, enabled: false, revision: 2, versionId: 's-v2' };
  db.prepare('UPDATE model_configurations SET revision=?,record=? WHERE id=?').run(revision.revision, JSON.stringify(revision), revision.id);
  db.prepare('INSERT INTO model_configuration_versions VALUES (?,?,?,?)').run(revision.id, revision.revision, revision.versionId, JSON.stringify(revision));
  db.close();
  const migrated = await open(path);
  assert.equal(migrated.store.modelSettings('m').runtimeModelId, preset.id);
  assert.deepEqual(migrated.store.runtimeModelSettings(preset.id).parameters, preset.parameters);
  assert.equal(migrated.store.runtimeModelSettings(baseline.id), undefined);
  assert.equal(migrated.store.modelRuntimeIdExists(baseline.id), true);
  assert.deepEqual(migrated.store.modelSettingsHistory('m').filter(record => record.runtimeModelId === baseline.id).map(record => record.enabled), [true, false]);
  await migrated.root.fiber.dispose();
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  db.close();
});

test('external identities are source-scoped and nested metadata is whitelisted', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  const external = { kind: 'external', sourceId: 'first', providerId: 'public', sourceVersion: 'v1', apiKey: 'secret-source' };
  await store.commit(initial({ providers: [{ record: provider({ source: external, apiKey: 'secret-top', connectionHints: { protocolIds: [], apiKey: 'secret-hint' } }), expectedRevision: null }],
    models: [{ record: model({ source: { ...external, modelId: 'remote' }, capabilities: { ...model().capabilities, tools: { support: 'unknown', apiKey: 'secret-cap' } },
      controls: { temperature: 'unknown', reasoning: [{ kind: 'effort', values: ['low'], apiKey: 'secret-control' }] },
      cost: { currency: 'USD', unit: 'million-tokens', input: 1, tiers: [{ output: 2, reasoning: 3, apiKey: 'secret-tier' }], apiKey: 'secret-cost' } }), expectedRevision: null }] }));
  assert.equal(JSON.stringify([store.providers(), store.models()]).includes('secret-'), false);
  assert.deepEqual(store.model('m').cost.tiers, [{ output: 2, reasoning: 3 }]);
  await assert.rejects(store.commit({ providers: [{ record: provider({ id: 'duplicate', versionId: 'duplicate-v1', source: external }), expectedRevision: null }] }), { code: 'conflict' });
  await assert.rejects(store.commit({ models: [{ record: model({ id: 'duplicate-model', versionId: 'dup-v1', source: { ...external, modelId: 'remote' } }), expectedRevision: null }] }), { code: 'conflict' });
  await store.commit({ providers: [{ record: provider({ id: 'p2', versionId: 'p2-v1', source: { ...external, sourceId: 'second' } }), expectedRevision: null }],
    models: [{ record: model({ id: 'm2', versionId: 'm2-v1', providerId: 'p2', source: { ...external, sourceId: 'second', modelId: 'remote' } }), expectedRevision: null },
      { record: model({ id: 'user-model', versionId: 'user-model-v1' }), expectedRevision: null }] });
  assert.equal(store.models().length, 3); assert.equal(store.model('user-model').source.kind, 'user');
});

test('stale synchronization guards reject all writes before replacing a newer target', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  await store.commit(initial({ modelSettings: [], syncStates: [{ providerId: 'p', state: 'pending', targetSourceVersion: 'new', syncedSourceVersion: null }] }));
  await assert.rejects(store.commit({ syncGuards: [{ providerId: 'p', targetSourceVersion: 'old' }],
    modelSettings: [{ record: localModelSettings(), expectedRevision: null }],
    syncStates: [{ providerId: 'p', state: 'ready', targetSourceVersion: 'old', syncedSourceVersion: 'old' }] }), { code: 'conflict' });
  assert.deepEqual(store.configuredModels(), []); assert.equal(store.syncState('p').targetSourceVersion, 'new');
  await store.commit({ syncGuards: [{ providerId: 'p', targetSourceVersion: 'new' }], modelSettings: [{ record: localModelSettings(), expectedRevision: null }],
    syncStates: [{ providerId: 'p', state: 'ready', targetSourceVersion: 'new', syncedSourceVersion: 'new' }] });
  assert.equal(store.providerSettings('p').revision, 1); assert.equal(store.providerSettingsHistory('p').length, 1);
});

test('SQLite ownership excludes another component, joins admitted writes and releases on close', async t => {
  const path = await temporary(t), first = await open(path), second = new Context();
  const blocked = second.installComponent(createModelsStoreComponent({ path }));
  try { await blocked; } catch {}
  assert.equal(blocked.state, FiberState.FAILED); assert.equal(blocked.error.code, 'storage-unavailable'); await second.fiber.dispose();
  const accepted = first.store.commit(initial()); await first.root.fiber.dispose(); await accepted;
  await assert.rejects(first.store.commit({}), { code: 'closed' });
  const third = await open(path); t.after(() => third.root.fiber.dispose()); assert.equal(third.store.providerSettings('p').id, 'p');
});

test('process death releases SQLite ownership and preserves the durable orphan cleanup intent', async t => {
  const path = await temporary(t), moduleUrl = new URL('../dist/store.js', import.meta.url).href;
  const script = `import { Context } from '@nya/core'; import { createModelsStoreComponent } from ${JSON.stringify(moduleUrl)};
    const root = new Context(); await root.installComponent(createModelsStoreComponent({ path: process.argv[1] }));
    await root.get('models.store').commit({ addIntents: [{ id: 'pending', providerId: 'missing', slotId: 'orphan', createdAt: '2026-01-01' }] });
    process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('child failed to acquire storage'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = await open(path); t.after(() => reopened.root.fiber.dispose()); assert.equal(reopened.store.intents()[0].slotId, 'orphan');
  await reopened.store.commit({ removeIntentIds: ['pending'] }); assert.deepEqual(reopened.store.intents(), []);
});

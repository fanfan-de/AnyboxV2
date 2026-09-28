import { params } from './helpers.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Context, FiberState } from '@nya/core';
import { createModelsStoreComponent } from '../dist/store.js';

const capability = { support: 'unknown' };
const version = (id, overrides = {}) => ({ id, revision: 1, versionId: `${id}-v1`, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides });
const provider = (overrides = {}) => ({ ...version('p'), name: 'Provider', source: { kind: 'user' }, state: 'present', connectionHints: { protocolIds: [] }, ...overrides });
const model = (overrides = {}) => ({ ...version('m'), providerId: 'p', remoteModelId: 'remote', name: 'Model', source: { kind: 'user' }, state: 'present',
  capabilities: { tools: capability, streaming: capability, imageInput: capability, reasoning: capability }, controls: { temperature: 'unknown' },
  modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [] }, ...overrides });
const connection = (overrides = {}) => ({ ...version('c'), providerDefinitionId: 'p', name: 'Account', enabled: true,
  protocolId: 'not-installed', baseUrl: 'http://localhost:1234/v1', auth: 'api-key', timeoutMs: 1000, credentialRef: 'slot-1', historyScopeEpoch: 'scope-1', ...overrides });
const configuration = (overrides = {}) => ({ ...version('s'), modelDefinitionId: 'm', modelDefinitionVersionId: 'm-v1', connectionId: 'c',
  name: 'Local model', enabled: true, remoteModelId: 'remote', baseline: true, parameters: params('not-installed', {}), capabilities: model().capabilities, ...overrides });
async function open(path) {
  const root = new Context();
  const fiber = root.installComponent(createModelsStoreComponent({ path }));
  await fiber; assert.equal(fiber.state, FiberState.ACTIVE);
  return { root, store: root.get('models.store') };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'models.sqlite');
}
const initial = (overrides = {}) => ({ providers: [{ record: provider(), expectedRevision: null }], models: [{ record: model(), expectedRevision: null }],
  connection: { record: connection(), expectedRevision: null }, configurations: [{ record: configuration(), expectedRevision: null }], ...overrides });

test('definitions, connections, immutable configurations, and orphan intents survive reopening without protocols', async t => {
  const path = await temporary(t), first = await open(path);
  await first.store.commit(initial());
  await first.store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2', name: 'Edited', apiKey: 'must-never-be-persisted' }), expectedRevision: 1 },
    configurations: [{ record: configuration({ revision: 2, versionId: 's-v2', parameters: params('not-installed', { temperature: 0.3 }) }), expectedRevision: 1 }] });
  await first.store.commit({ addIntents: [{ id: 'cleanup', providerId: 'new-uncommitted-connection', slotId: 'orphan', createdAt: '2026-01-02' }] });
  await first.root.fiber.dispose();
  const second = await open(path); t.after(() => second.root.fiber.dispose());
  assert.equal(second.store.connection('c').name, 'Edited');
  assert.deepEqual(second.store.connectionHistory('c').map(item => item.name), ['Account', 'Edited']);
  assert.deepEqual(second.store.configurationHistory('s').map(item => item.parameters.value), [{}, { temperature: 0.3 }]);
  assert.equal(second.store.intents()[0].slotId, 'orphan');
  assert.equal((await readFile(path)).includes(Buffer.from('must-never-be-persisted')), false);
  second.store.configuration('s').parameters.value.temperature = 123;
  assert.equal(second.store.configuration('s').parameters.value.temperature, 0.3);
});

test('CAS conflicts roll back the entire batch, source ledger, synchronization and credential journal', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  await store.commit(initial());
  await assert.rejects(store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2' }), expectedRevision: 1 },
    configurations: [{ record: configuration({ revision: 2, versionId: 's-v2' }), expectedRevision: 77 }],
    sources: [{ sourceId: 'public', snapshotVersion: 'v2', fetchedAt: 10 }],
    syncStates: [{ connectionId: 'c', state: 'ready', targetSourceVersion: 'v2', syncedSourceVersion: 'v2' }],
    addIntents: [{ id: 'never-written', slotId: 'orphan', providerId: 'c', createdAt: '2026-01-02' }],
  }), { code: 'conflict' });
  assert.equal(store.connection('c').revision, 1); assert.equal(store.connectionHistory('c').length, 1);
  assert.deepEqual(store.sources(), []); assert.equal(store.syncState('c'), undefined); assert.equal(store.intents().length, 0);
  const one = store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2' }), expectedRevision: 1 } });
  const two = store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2-other' }), expectedRevision: 1 } });
  assert.deepEqual((await Promise.allSettled([one, two])).map(item => item.status), ['fulfilled', 'rejected']);
});

test('connection deletion atomically removes current configurations and sync state, retains histories and reserves deleted identities', async t => {
  const path = await temporary(t), first = await open(path);
  await first.store.commit(initial({ syncStates: [{ connectionId: 'c', state: 'ready', targetSourceVersion: null, syncedSourceVersion: null }] }));
  await first.store.commit({ connection: { record: connection({ id: 'other-c', versionId: 'other-c-v1' }), expectedRevision: null },
    configurations: [{ record: configuration({ id: 'other-s', versionId: 'other-s-v1', connectionId: 'other-c' }), expectedRevision: null }] });
  const intent = { id: 'retired-key', providerId: 'c', slotId: 'slot-1', createdAt: '2026-01-02' };
  await assert.rejects(first.store.commit({ deleteConnection: { id: 'c', expectedRevision: 2 }, addIntents: [intent] }), { code: 'conflict' });
  assert.equal(first.store.configuration('s').id, 's'); assert.equal(first.store.syncState('c').state, 'ready'); assert.deepEqual(first.store.intents(), []);
  await assert.rejects(first.store.commit({ deleteConnection: { id: 'c', expectedRevision: 0 } }), { code: 'invalid-config' });
  const input = { deleteConnection: { id: 'c', expectedRevision: 1 }, addIntents: [intent] };
  const deleting = first.store.commit(input); input.deleteConnection.id = 'other-c'; await deleting;
  assert.equal(first.store.connection('c'), undefined); assert.equal(first.store.configuration('s'), undefined); assert.equal(first.store.syncState('c'), undefined);
  assert.equal(first.store.connection('other-c').id, 'other-c'); assert.equal(first.store.configuration('other-s').id, 'other-s');
  assert.equal(first.store.provider('p').id, 'p'); assert.equal(first.store.model('m').id, 'm');
  assert.deepEqual(first.store.intents(), [intent]);
  await first.root.fiber.dispose();
  const second = await open(path); t.after(() => second.root.fiber.dispose());
  assert.equal(second.store.connection('c'), undefined); assert.equal(second.store.configuration('s'), undefined);
  assert.equal(second.store.connectionHistory('c').length, 1); assert.equal(second.store.configurationHistory('s').length, 1);
  await assert.rejects(second.store.commit({ connection: { record: connection(), expectedRevision: null } }), { code: 'conflict' });
  await assert.rejects(second.store.commit({ configurations: [{ record: configuration({ connectionId: 'other-c' }), expectedRevision: null }] }), { code: 'conflict' });
  await assert.rejects(second.store.commit({ deleteConnection: { id: 'c', expectedRevision: 1 } }), { code: 'not-found' });
});

test('storage enforces immutable identities, fixed protocols, baseline uniqueness, and pins historical definition versions', async t => {
  const { root, store } = await open(await temporary(t)); t.after(() => root.fiber.dispose());
  const admittedInput = initial(), admitted = store.commit(admittedInput); admittedInput.connection.record.name = 'Changed'; await admitted;
  assert.equal(store.connection('c').name, 'Account');
  await assert.rejects(store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2', protocolId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ connection: { record: connection({ revision: 2, versionId: 'c-v2', providerDefinitionId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ configurations: [{ record: configuration({ revision: 2, versionId: 's-v2', connectionId: 'other' }), expectedRevision: 1 }] }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ configurations: [{ record: configuration({ id: 'second', versionId: 'second-v1' }), expectedRevision: null }] }), { code: 'conflict' });
  await store.commit({ configurations: [{ record: configuration({ id: 'variant', versionId: 'variant-v1', baseline: false }), expectedRevision: null }] });
  await store.commit({ models: [{ record: model({ revision: 2, versionId: 'm-v2', remoteModelId: 'new-remote' }), expectedRevision: 1 }] });
  await store.commit({ configurations: [{ record: configuration({ revision: 2, versionId: 's-v2', parameters: params('not-installed', { temperature: 0.4 }) }), expectedRevision: 1 }] });
  assert.equal(store.configuration('s').remoteModelId, 'remote');
  await assert.rejects(store.commit({ configurations: [{ record: configuration({ id: 'bad-pin', versionId: 'bad-pin-v1', baseline: false, modelDefinitionVersionId: 'm-v2' }), expectedRevision: null }] }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ models: [{ record: model({ id: 'missing-owner', versionId: 'missing-v1', providerId: 'other' }), expectedRevision: null }] }), { code: 'not-found' });
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
  await store.commit(initial({ configurations: [], syncStates: [{ connectionId: 'c', state: 'pending', targetSourceVersion: 'new', syncedSourceVersion: null }] }));
  await assert.rejects(store.commit({ syncGuards: [{ connectionId: 'c', targetSourceVersion: 'old' }],
    configurations: [{ record: configuration(), expectedRevision: null }],
    syncStates: [{ connectionId: 'c', state: 'ready', targetSourceVersion: 'old', syncedSourceVersion: 'old' }] }), { code: 'conflict' });
  assert.deepEqual(store.configurations(), []); assert.equal(store.syncState('c').targetSourceVersion, 'new');
  await store.commit({ syncGuards: [{ connectionId: 'c', targetSourceVersion: 'new' }], configurations: [{ record: configuration(), expectedRevision: null }],
    syncStates: [{ connectionId: 'c', state: 'ready', targetSourceVersion: 'new', syncedSourceVersion: 'new' }] });
  assert.equal(store.connection('c').revision, 1); assert.equal(store.connectionHistory('c').length, 1);
});

test('SQLite ownership excludes another component, joins admitted writes and releases on close', async t => {
  const path = await temporary(t), first = await open(path), second = new Context();
  const blocked = second.installComponent(createModelsStoreComponent({ path }));
  try { await blocked; } catch {}
  assert.equal(blocked.state, FiberState.FAILED); assert.equal(blocked.error.code, 'storage-unavailable'); await second.fiber.dispose();
  const accepted = first.store.commit(initial()); await first.root.fiber.dispose(); await accepted;
  await assert.rejects(first.store.commit({}), { code: 'closed' });
  const third = await open(path); t.after(() => third.root.fiber.dispose()); assert.equal(third.store.connection('c').id, 'c');
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

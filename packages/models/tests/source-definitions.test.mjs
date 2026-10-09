import { params, exchange } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@nya/core';
import { normalizeModelsDevCatalog, validateCatalogSnapshot } from '../dist/catalog-domain.js';
import { createModelsStoreComponent } from '../dist/store.js';
import { createModelsCatalogComponent } from '../dist/catalog.js';
import { createMemoryModelsCatalogCache } from '../dist/catalog-cache.js';
import { modelsError } from '../dist/errors.js';
import { capabilities, deferred, fakeProtocol, fixture, memoryStore, memoryVault, tick } from './helpers.mjs';

const sourceInput = (models = { first: { id: 'first', name: 'First' } }) => ({ upstream: {
  id: 'upstream', name: 'Shared provider name', npm: '@ai-sdk/openai-compatible', api: 'https://provider.invalid/v1',
  models: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { tool_call: true, streaming: true, temperature: true, modalities: { input: ['text'], output: ['text'] }, ...model }])),
} });
const imported = (models, fetchedAt = 1) => normalizeModelsDevCatalog(sourceInput(models), 'models.dev', fetchedAt);
const connectionInput = (provider, id, extra = {}) => ({ id, providerDefinitionId: provider.id, name: id, enabled: true, protocolId: 'chat-completions', baseUrl: 'https://account.invalid/v1', auth: 'api-key', timeoutMs: 10_000, ...extra });
async function sourceFixture(options = {}) {
  const f = await fixture({ protocols: [fakeProtocol('chat-completions')], ...options });
  await f.sourceData.accept(imported());
  return f;
}

test('JSON and user definitions share module types while keeping namespaced source identities', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const external = f.settings.providers()[0];
  const custom = await f.settings.createProvider({ name: external.name, connectionHints: { protocolIds: ['chat-completions'] } });
  assert.notEqual(external.id, custom.id); assert.equal(external.source.kind, 'external'); assert.deepEqual(custom.source, { kind: 'user' });
  assert.equal(external.source.providerId, 'upstream');
  const other = normalizeModelsDevCatalog(sourceInput(), 'other-source', 1);
  await f.sourceData.accept(other);
  assert.equal(f.settings.providers().length, 3); assert.equal(f.settings.models().length, 2);
  assert.equal(new Set(f.settings.models().map(model => model.id)).size, 2);
  for (const definition of [external, custom, ...f.settings.models()]) {
    assert.equal(definition.state, 'present'); assert.ok(definition.versionId); assert.equal(definition.revision, 1);
  }
  await assert.rejects(f.settings.updateProvider(external.id, { name: 'User overwrite' }, external.revision), { code: 'invalid-config' });
});

test('saving two keyed connections creates distinct runnable groups without changing external provenance', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const provider = f.settings.providers()[0], before = structuredClone(provider);
  const first = await f.settings.createConnection(connectionInput(provider, 'first', { apiKey: 'private-first' }));
  const second = await f.settings.createConnection(connectionInput(provider, 'second', { apiKey: 'private-second' }));
  assert.equal(first.sync.state, 'ready'); assert.equal(second.sync.state, 'ready');
  assert.equal(f.models.list({ available: true }).length, 2);
  const [firstModel] = f.models.list({ connectionId: first.id }), [secondModel] = f.models.list({ connectionId: second.id });
  assert.notEqual(firstModel.id, secondModel.id); assert.equal(firstModel.modelDefinitionId, secondModel.modelDefinitionId);
  assert.equal(firstModel.providerDefinitionId, provider.id); assert.equal(firstModel.source.kind, 'external');
  assert.notEqual(f.store.connection(first.id).credentialRef, f.store.connection(second.id).credentialRef);
  assert.deepEqual(f.settings.providers()[0], before); assert.equal(f.vault.reads.length, 0);
  await f.settings.retryConnection(first.id); await f.settings.retryConnection(second.id);
  assert.equal(f.settings.configurations().length, 2);
  const removedKey = await f.settings.deleteApiKey(first.id, first.revision);
  assert.equal(removedKey.credentialConfigured, false); assert.equal(f.models.get(firstModel.id).unavailableReason, 'credential-missing');
  assert.equal(f.models.get(secondModel.id).available, true);
  const publicText = JSON.stringify([f.settings.providers(), f.settings.connections(), f.settings.models(), f.models.list()]);
  assert.ok(!publicText.includes('private-first')); assert.ok(!publicText.includes(f.store.connection(second.id).credentialRef));
});

test('a user Model may belong to a sourced Provider and is initialized using the same connection', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const provider = f.settings.providers()[0];
  const connection = await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'key' }));
  const model = await f.settings.createModel({ providerId: provider.id, remoteModelId: 'private-model', name: 'Custom model', capabilities: capabilities(),
    controls: { temperature: 'supported' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } });
  assert.deepEqual(model.source, { kind: 'user' }); assert.equal(model.providerId, provider.id);
  await f.settings.retryConnection(connection.id);
  const runnable = f.models.list({ connectionId: connection.id });
  assert.equal(runnable.length, 2); assert.equal(runnable.find(value => value.modelDefinitionId === model.id).source.kind, 'user');
  assert.equal(f.settings.providers()[0].source.kind, 'external');
});

test('source refresh adds compatible models and preserves user parameters, disabled state and pinned versions', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const provider = f.settings.providers()[0];
  await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'key' }));
  const initial = f.models.list()[0];
  const edited = await f.settings.updateConfiguration(initial.id, { name: 'My configuration', parameters: params('chat-completions', { temperature: 0.3, maxOutputTokens: 42 }), enabled: false }, initial.revision);
  const candidate = imported({ first: { id: 'first', name: 'Renamed by source', tool_call: false }, second: { id: 'second', name: 'New model' },
    images: { id: 'images', name: 'Images', modalities: { input: ['text'], output: ['image'] } } }, 2);
  await f.sourceData.accept(candidate); await f.sourceData.accept(candidate);
  assert.equal(f.settings.configurations().length, 2);
  assert.deepEqual(f.settings.configurations().find(value => value.id === initial.id), edited);
  const definition = f.settings.models().find(value => value.id === initial.modelDefinitionId);
  assert.equal(definition.name, 'Renamed by source'); assert.notEqual(definition.versionId, initial.modelDefinitionVersionId);
  assert.equal(f.models.get(initial.id).modelDefinitionVersionId, initial.modelDefinitionVersionId);
  assert.equal(f.models.list({ available: true })[0].remoteModelId, 'second');
  assert.equal(f.settings.connectionModels('account').find(value => value.remoteModelId === 'images').unavailableReason, 'text-unsupported');
});

test('source removals retain historical definitions and existing configurations and executions', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const provider = f.settings.providers()[0];
  await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'original-key' }));
  const configuration = f.models.list()[0], existing = await f.open({ modelId: configuration.id });
  const before = f.settings.configurations()[0];
  await f.sourceData.accept(normalizeModelsDevCatalog({}, 'models.dev', 2));
  assert.deepEqual(f.settings.providers(), []); assert.deepEqual(f.settings.models(), []);
  assert.equal(f.settings.models({ includeMissing: true })[0].state, 'missing');
  assert.deepEqual(f.settings.configurations()[0], before); assert.equal(f.models.get(configuration.id).available, true);
  const next = await f.open({ modelId: configuration.id });
  for (const execution of [existing, next]) {
    assert.equal(execution.snapshot.schemaVersion, 3); assert.equal(execution.snapshot.modelId, configuration.id);
    assert.equal(execution.snapshot.providerId, 'account'); assert.equal(execution.snapshot.providerDefinitionId, provider.id);
    assert.equal((await exchange(execution, { messages: [{ role: 'user', content: 'Still available' }] }).result).status, 'completed');
    await execution.close();
  }
});

test('saved connection and Key survive a failed automatic batch and idempotent retry repairs it', async t => {
  const store = memoryStore(), commit = store.commit.bind(store); let failInitialization = false;
  store.commit = async change => { if (failInitialization && change.configurations?.length) throw modelsError('storage-unavailable'); return commit(change); };
  const f = await sourceFixture({ store }); t.after(() => f.close());
  const provider = f.settings.providers()[0]; failInitialization = true;
  const saved = await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'saved-key' }));
  assert.equal(saved.credentialConfigured, true); assert.equal(saved.sync.state, 'failed'); assert.equal(f.settings.configurations().length, 0);
  assert.ok(f.vault.secrets.has(store.connection(saved.id).credentialRef));
  failInitialization = false; const repaired = await f.settings.retryConnection(saved.id);
  assert.equal(repaired.sync.state, 'ready'); assert.equal(repaired.revision, saved.revision);
  await f.settings.retryConnection(saved.id); assert.equal(f.models.list({ available: true }).length, 1);
});

test('protocol re-registration initializes models added while their connection protocol was absent', async t => {
  const protocol = fakeProtocol('chat-completions'), f = await sourceFixture({ protocols: [protocol] }); t.after(() => f.close());
  const provider = f.settings.providers()[0];
  await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'key' }));
  await f.registrations[0].unregister();
  await f.sourceData.accept(imported({ first: { id: 'first', name: 'First' }, later: { id: 'later', name: 'Later' } }, 2));
  assert.equal(f.models.list().length, 1); assert.equal(f.settings.connections()[0].sync.state, 'pending');
  const replacement = fakeProtocol('chat-completions', '2');
  const registration = f.registry.register(replacement); t.after(() => registration.unregister());
  await tick();
  assert.equal(f.models.list({ available: true }).length, 2); assert.equal(f.settings.connections()[0].sync.state, 'ready');
});

test('user definition writes reject malformed URLs and metadata with fixed errors and immutable associations', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  for (const connectionHints of [{ protocolIds: ['chat-completions'], baseUrl: 'private-malformed-address' }, { protocolIds: ['chat-completions', 'chat-completions'] }]) {
    await assert.rejects(f.settings.createProvider({ name: 'Custom', connectionHints }), error => error.code === 'invalid-config' && !String(error).includes('private-malformed-address'));
  }
  await assert.rejects(f.settings.createProvider({ name: 'Custom', documentationUrl: 'private-malformed-doc', connectionHints: { protocolIds: [] } }), { code: 'invalid-config' });
  const provider = f.settings.providers()[0], valid = { providerId: provider.id, remoteModelId: 'custom', name: 'Custom', capabilities: capabilities(),
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } };
  for (const metadata of [{ openWeights: 'yes' }, { description: 1 }, { limits: { context: -1 } }, { controls: { temperature: 'unknown', structuredOutput: true } },
    { controls: { temperature: 'unknown', reasoning: [{ kind: 'effort', values: ['low', 'low'] }] } },
    { controls: { temperature: 'unknown', reasoning: [{ kind: 'budget', min: 100, max: 1 }] } },
    { controls: { temperature: 'unknown', reasoning: [{ kind: 'toggle', apiKey: 'private-key' }] } },
    { cost: { currency: 'USD', unit: 'million-tokens', apiKey: 'private-key' } },
    { cost: { currency: 'USD', unit: 'million-tokens', tiers: [{ input: -1 }] } },
    { modalities: { input: ['text', 'text'], output: ['text'] } }]) {
    await assert.rejects(f.settings.createModel({ ...valid, ...metadata }), error => error.code === 'invalid-config' && !String(error).includes('private-key'));
  }
  const created = await f.settings.createModel(valid), other = await f.settings.createProvider({ name: 'Other', connectionHints: { protocolIds: [] } });
  await assert.rejects(f.settings.updateModel(created.id, { providerId: other.id }, created.revision), { code: 'invalid-config' });
  assert.equal(f.settings.models().find(value => value.id === created.id).providerId, provider.id);
  assert.equal(f.settings.models().length, 2);
});

test('accepted source content survives SQLite sanitizing field order, tier prices and reopening without network', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-roundtrip-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'models.sqlite');
  const snapshot = imported({ first: { id: 'first', name: 'Tiered', reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 100, max: 200 }],
    cost: { input: 0.1, reasoning: 0.2, tiers: [{ input: 0.4, output: 0.5, reasoning: 0.6, tier: { type: 'context', size: 1000 } }] } } }, 3);
  const storage = new Context(); await storage.installComponent(createModelsStoreComponent({ path }));
  const f = await fixture({ store: storage.get('models.store'), protocols: [] });
  await f.sourceData.accept(snapshot);
  const saved = f.sourceData.accepted('models.dev'); validateCatalogSnapshot(saved);
  assert.equal(saved.snapshotVersion, snapshot.snapshotVersion); assert.equal(saved.models[0].cost.tiers[0].reasoning, 0.6);
  await f.close(); await storage.fiber.dispose();
  const reopenedStorage = new Context(); await reopenedStorage.installComponent(createModelsStoreComponent({ path }));
  const reopened = await fixture({ store: reopenedStorage.get('models.store'), protocols: [] });
  try {
    const accepted = reopened.sourceData.accepted('models.dev'); validateCatalogSnapshot(accepted);
    assert.equal(accepted.snapshotVersion, snapshot.snapshotVersion);
    await reopened.root.installComponent({ name: 'source-roundtrip-ports', apply(ctx) {
      ctx.provide('models.catalog-cache', createMemoryModelsCatalogCache());
      ctx.provide('models.catalog-source', { id: 'models.dev', cacheKey: 'source-roundtrip', fetch() { assert.fail('startup must not fetch'); } });
    } });
    await reopened.root.installComponent(createModelsCatalogComponent({ bundledSnapshot: normalizeModelsDevCatalog({}, 'models.dev', 1), autoRefresh: false }));
    assert.equal(reopened.root.get('models.catalog').status().origin, 'store');
    assert.equal(reopened.settings.models()[0].cost.tiers[0].reasoning, 0.6);
  } finally { await reopened.close(); await reopenedStorage.fiber.dispose(); }
});

test('source acceptance captures confirmation options before the asynchronous definition queue', async t => {
  const f = await sourceFixture(); t.after(() => f.close());
  const options = { confirmed: false }, alternative = imported({ first: { id: 'first', name: 'Unconfirmed change' } });
  const request = f.sourceData.accept(alternative, options); options.confirmed = true;
  const outcome = await request;
  assert.equal(outcome.accepted, false); assert.equal(f.settings.models()[0].name, 'First');
});

test('a concurrent Key rotation and source update serialize one additive model batch', async t => {
  const vault = memoryVault(), write = vault.write.bind(vault), gate = deferred(), started = deferred();
  vault.write = async (slot, value, signal) => { if (value === 'rotated-key') { started.resolve(); await gate.promise; } return write(slot, value, signal); };
  const f = await sourceFixture({ vault }); t.after(() => f.close());
  const provider = f.settings.providers()[0], connection = await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'original-key' }));
  const first = f.models.list()[0];
  const sourceCommitted = deferred(), commit = f.store.commit.bind(f.store);
  f.store.commit = async change => { await commit(change); if (change.sources?.some(state => state.fetchedAt === 2)) sourceCommitted.resolve(); };
  const changingKey = f.settings.setApiKey(connection.id, 'rotated-key', connection.revision); await started.promise;
  const updatingSource = f.sourceData.accept(imported({ first: { id: 'first', name: 'First' }, later: { id: 'later', name: 'Later' } }, 2));
  await sourceCommitted.promise; assert.equal(f.settings.models().length, 2); assert.equal(f.models.list().length, 1);
  const changingParams = f.settings.updateConfiguration(first.id, { parameters: params('chat-completions', { temperature: 0.4 }) }, first.revision);
  gate.resolve(); await Promise.all([changingKey, updatingSource, changingParams]);
  assert.equal(f.models.list({ available: true }).length, 2);
  assert.equal(f.models.get(first.id).parameters.value.temperature, 0.4);
  assert.equal(f.models.list().filter(value => value.remoteModelId === 'later').length, 1);
  assert.equal(vault.secrets.get(f.store.connection(connection.id).credentialRef), 'rotated-key');
  assert.equal(vault.reads.length, 0);
});

test('closing Models drains an admitted source transaction and its later connection synchronization', async () => {
  const store = memoryStore(), commit = store.commit.bind(store), gate = deferred(), started = deferred();
  store.commit = async change => { if (change.sources?.some(state => state.fetchedAt === 2)) { started.resolve(); await gate.promise; } return commit(change); };
  const vault = memoryVault(), f = await sourceFixture({ store, vault }), provider = f.settings.providers()[0];
  await f.settings.createConnection(connectionInput(provider, 'account', { apiKey: 'key' }));
  const candidate = imported({ first: { id: 'first', name: 'First' }, later: { id: 'later', name: 'Later' } }, 2);
  const request = f.sourceData.accept(candidate); await started.promise;
  let disposed = false; const disposal = f.component.dispose().then(() => { disposed = true; }); await tick();
  assert.equal(disposed, false); gate.resolve(); await Promise.all([request, disposal]);
  assert.equal(store.sources()[0].snapshotVersion, candidate.snapshotVersion);
  assert.equal(store.syncState('account').targetSourceVersion, candidate.snapshotVersion);
  await f.close();
  const resumed = await fixture({ store, vault, protocols: [fakeProtocol('chat-completions')] });
  try { await tick(); assert.equal(resumed.models.list({ available: true }).length, 2); }
  finally { await resumed.close(); }
});

import { params, exchange } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelsError } from '../dist/errors.js';
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js';
import { complete, deferred, fakeProtocol, fixture, memoryStore, memoryVault, tick } from './helpers.mjs';

test('deleting a connection removes its configurations and Key while preserving definitions, history, other accounts and open executions', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'private-first' });
  const second = await f.settings.createConnection({ id: 'second', providerDefinitionId: provider.providerDefinitionId,
    name: 'Second account', enabled: true, protocolId: provider.protocolId, baseUrl: provider.baseUrl, auth: 'api-key', timeoutMs: 1000, apiKey: 'private-second' });
  const secondModels = f.models.list({ connectionId: second.id });
  const variant = await f.settings.createConfiguration({ connectionId: provider.id, modelDefinitionId: model.modelDefinitionId,
    name: 'Variant', enabled: true, capabilities: model.capabilities, parameters: params('test', { temperature: 0.2 }), baseline: false });
  const definitions = [f.settings.providers(), f.settings.models()];
  const execution = await f.open({ modelId: model.id });
  const snapshot = execution.snapshot;
  f.protocols[0].next();
  const call = exchange(execution, { messages: [{ role: 'user', content: 'first turn' }] });
  await tick();
  await assert.rejects(f.settings.deleteConnection(provider.id, provider.revision + 1), { code: 'conflict' });
  await assert.rejects(f.settings.deleteConnection(provider.id, 0), { code: 'invalid-config' });
  assert.ok(f.vault.secrets.has(f.store.connection(provider.id).credentialRef));
  await f.settings.deleteConnection(provider.id, provider.revision);
  assert.equal(f.store.connection(provider.id), undefined); assert.equal(f.store.syncState(provider.id), undefined);
  assert.deepEqual(f.settings.configurations(provider.id), []);
  assert.equal(f.models.get(model.id), undefined); assert.equal(f.models.get(variant.id), undefined);
  assert.equal([...f.vault.secrets.values()].includes('private-first'), false);
  assert.deepEqual(f.models.list({ connectionId: second.id }), secondModels);
  assert.equal([...f.vault.secrets.values()].includes('private-second'), true);
  assert.deepEqual([f.settings.providers(), f.settings.models()], definitions);
  assert.equal(f.settings.connectionHistory(provider.id).length, 1);
  assert.equal(f.settings.configurationHistory(model.id).length, 1);
  assert.equal(f.settings.configurationHistory(variant.id).length, 1);
  assert.deepEqual(execution.snapshot, snapshot); assert.equal(f.protocols[0].calls[0].input.signal.aborted, false);
  f.protocols[0].calls[0].succeed({ ...complete('first answer'), retained: true });
  assert.equal((await call.result).text, 'first answer');
  const next = exchange(execution, { messages: [{ role: 'user', content: 'second turn' }] });
  assert.equal((await next.result).status, 'completed');
  assert.deepEqual(f.protocols[0].calls.map(value => value.input.credential), ['private-first', 'private-first']);
  await execution.close();
  await assert.rejects(f.open({ modelId: model.id }), { code: 'not-found' });
  await assert.rejects(f.settings.deleteConnection(provider.id, provider.revision), { code: 'not-found' });
  await assert.rejects(f.settings.createConnection({ ...provider, id: provider.id }), { code: 'invalid-config' });
  const { id: _id, revision: _revision, versionId: _version, createdAt: _created, updatedAt: _updated, credentialConfigured: _key, sync: _sync, ...input } = provider;
  await assert.rejects(f.settings.createConnection({ ...input, id: provider.id }), { code: 'conflict' });
});

test('failed storage deletion preserves the connection and Key; failed vault cleanup is journaled and retried on restart', async t => {
  const store = memoryStore(), vault = memoryVault(), f = await fixture({ store, vault }); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'private-key' });
  const slot = store.connection(provider.id).credentialRef;
  store.failCommit = modelsError('storage-unavailable');
  await assert.rejects(f.settings.deleteConnection(provider.id, provider.revision), { code: 'storage-unavailable' });
  assert.equal(f.models.get(model.id).available, true); assert.equal(vault.secrets.get(slot), 'private-key'); assert.deepEqual(store.intents(), []);
  store.failCommit = undefined; vault.failDelete = modelsError('credential-unavailable');
  await f.settings.deleteConnection(provider.id, provider.revision);
  assert.equal(store.connection(provider.id), undefined); assert.equal(store.intents()[0].slotId, slot);
  assert.equal(vault.secrets.has(slot), true);
  await f.close(); vault.failDelete = undefined;
  const restarted = await fixture({ store, vault }); t.after(() => restarted.close());
  assert.deepEqual(restarted.settings.connections(), []); assert.deepEqual(restarted.models.list(), []);
  assert.deepEqual(store.intents(), []); assert.equal(vault.secrets.has(slot), false);
  assert.equal(restarted.settings.configurationHistory(model.id).length, 1);
});

test('deletion waits for admitted credential acquisition and rejects later initialization on the same connection', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'captured-key' });
  f.vault.holdReads = true;
  const opened = f.open({ modelId: model.id }); await tick();
  let deleted = false;
  const deleting = f.settings.deleteConnection(provider.id, provider.revision).then(() => { deleted = true; });
  const later = assert.rejects(f.open({ modelId: model.id }), { code: 'not-found' });
  await tick(); assert.equal(deleted, false);
  f.vault.release();
  const execution = await opened; await deleting; await later;
  const call = exchange(execution, { messages: [{ role: 'user', content: 'after deletion' }] });
  await call.result; assert.equal(f.protocols[0].calls[0].input.credential, 'captured-key');
  await execution.close();
});

test('source ingestion skips a connection deleted before its queued reconciliation and never recreates it', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const store = memoryStore(), f = await fixture({ store, protocols: [fakeProtocol('chat-completions')] }); t.after(() => f.close());
  const data = { upstream: { id: 'upstream', name: 'Upstream', npm: '@ai-sdk/openai-compatible', models: {
    first: { id: 'first', name: 'First', modalities: { input: ['text'], output: ['text'] } },
  } } };
  await f.sourceData.accept(normalizeModelsDevCatalog(data, 'models.dev', 1));
  const definition = f.settings.providers()[0];
  const connection = await f.settings.createConnection({ providerDefinitionId: definition.id, name: 'Account', enabled: true,
    protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 1000 });
  const original = store.commit.bind(store), entered = deferred();
  let deleted = false;
  store.commit = async change => {
    if (change.sources) { entered.resolve(); await gate.promise; }
    await original(change);
    if (change.deleteConnection) deleted = true;
  };
  data.upstream.models.second = { id: 'second', name: 'Second', modalities: { input: ['text'], output: ['text'] } };
  const refreshing = f.sourceData.accept(normalizeModelsDevCatalog(data, 'models.dev', 2));
  await entered.promise;
  const deleting = f.settings.deleteConnection(connection.id, connection.revision);
  await tick(); assert.equal(deleted, false); gate.resolve();
  await deleting; const result = await refreshing;
  assert.equal(result.accepted, true); assert.deepEqual(result.connections, []);
  assert.deepEqual(f.settings.connections(), []); assert.deepEqual(f.models.list(), []);
  assert.equal(f.settings.models().length, 2);
});

import { params, exchange } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelsError } from '../dist/errors.js';
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js';
import { complete, deferred, fakeProtocol, fixture, memoryStore, memoryVault, tick } from './helpers.mjs';

test('deleting provider settings preserves definitions, history, other providers and open executions', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'private-first' });
  const { provider: second } = await f.add({ providerId: 'second', modelId: 'second-model', key: 'private-second' });
  const secondModels = f.models.list({ providerId: second.id });
  const alternate = await f.addModelSettings({ id: 'alternate', providerId: provider.id, remoteModelId: 'alternate-remote',
    name: 'Alternate', enabled: true, capabilities: model.capabilities, parameters: params('test', { temperature: 0.2 }) });
  const definitions = [f.settings.providers(), f.settings.models()];
  const epoch = f.store.providerSettings(provider.id).historyScopeEpoch;
  const execution = await f.open({ modelId: model.id });
  const snapshot = execution.snapshot;
  f.protocols[0].next();
  const call = exchange(execution, { messages: [{ role: 'user', content: 'first turn' }] });
  await tick();
  await assert.rejects(f.settings.deleteProviderSettings(provider.id, provider.revision + 1), { code: 'conflict' });
  await assert.rejects(f.settings.deleteProviderSettings(provider.id, 0), { code: 'invalid-config' });
  assert.ok(f.vault.secrets.has(f.store.providerSettings(provider.id).credentialRef));
  await f.settings.deleteProviderSettings(provider.id, provider.revision);
  assert.equal(f.store.providerSettings(provider.id), undefined); assert.equal(f.store.syncState(provider.id), undefined);
  assert.deepEqual(f.settings.modelSettings(provider.id), []);
  assert.equal(f.models.get(model.runtimeModelId), undefined); assert.equal(f.models.get(alternate.runtimeModelId), undefined);
  assert.equal([...f.vault.secrets.values()].includes('private-first'), false);
  assert.deepEqual(f.models.list({ providerId: second.id }), secondModels);
  assert.equal([...f.vault.secrets.values()].includes('private-second'), true);
  assert.deepEqual([f.settings.providers(), f.settings.models()], definitions);
  assert.equal(f.settings.providerSettingsHistory(provider.id).length, 1);
  assert.equal(f.settings.modelSettingsHistory(model.id).length, 1);
  assert.equal(f.settings.modelSettingsHistory(alternate.id).length, 1);
  assert.deepEqual(execution.snapshot, snapshot); assert.equal(f.protocols[0].calls[0].input.signal.aborted, false);
  f.protocols[0].calls[0].succeed({ ...complete('first answer'), retained: true });
  assert.equal((await call.result).text, 'first answer');
  const next = exchange(execution, { messages: [{ role: 'user', content: 'second turn' }] });
  assert.equal((await next.result).status, 'completed');
  assert.deepEqual(f.protocols[0].calls.map(value => value.input.credential), ['private-first', 'private-first']);
  await execution.close();
  await assert.rejects(f.open({ modelId: model.id }), { code: 'not-found' });
  await assert.rejects(f.settings.deleteProviderSettings(provider.id, provider.revision), { code: 'not-found' });
  const { id, name, enabled, protocolId, baseUrl, auth, timeoutMs } = provider;
  const input = { providerId: id, name, enabled, protocolId, baseUrl, auth, timeoutMs, apiKey: 'replacement' };
  const readded = await f.settings.createProviderSettings(input);
  assert.equal(readded.id, id);
  assert.equal(readded.revision, provider.revision + 1);
  assert.notEqual(f.store.providerSettings(id).historyScopeEpoch, epoch);
  assert.deepEqual(f.settings.providerSettingsHistory(id).map(record => record.revision), [provider.revision, readded.revision]);
  assert.equal(f.models.get(model.id), undefined);
  const readdedModels = f.models.list({ providerId: id });
  assert.equal(readdedModels.length, 2);
  const recreated = readdedModels.find(value => value.modelDefinitionId === model.id);
  assert.notEqual(recreated.id, model.runtimeModelId);
  assert.deepEqual(f.settings.modelSettingsHistory(model.id).map(record => record.runtimeModelId), [model.runtimeModelId, recreated.id]);
  await assert.rejects(f.settings.deleteProviderSettings(id, provider.revision), { code: 'conflict' });
  await assert.rejects(f.settings.createProviderSettings(input), { code: 'conflict' });
});

test('failed storage deletion preserves provider settings and Key; failed vault cleanup is journaled and retried on restart', async t => {
  const store = memoryStore(), vault = memoryVault(), f = await fixture({ store, vault }); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'private-key' });
  const slot = store.providerSettings(provider.id).credentialRef;
  store.failCommit = modelsError('storage-unavailable');
  await assert.rejects(f.settings.deleteProviderSettings(provider.id, provider.revision), { code: 'storage-unavailable' });
  assert.equal(f.models.get(model.id).available, true); assert.equal(vault.secrets.get(slot), 'private-key'); assert.deepEqual(store.intents(), []);
  store.failCommit = undefined; vault.failDelete = modelsError('credential-unavailable');
  await f.settings.deleteProviderSettings(provider.id, provider.revision);
  assert.equal(store.providerSettings(provider.id), undefined); assert.equal(store.intents()[0].slotId, slot);
  assert.equal(vault.secrets.has(slot), true);
  await f.close(); vault.failDelete = undefined;
  const restarted = await fixture({ store, vault }); t.after(() => restarted.close());
  assert.deepEqual(restarted.settings.configuredProviders(), []); assert.deepEqual(restarted.models.list(), []);
  assert.deepEqual(store.intents(), []); assert.equal(vault.secrets.has(slot), false);
  assert.equal(restarted.settings.modelSettingsHistory(model.id).length, 1);
});

test('deletion waits for admitted credential acquisition and rejects later initialization for that provider', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { provider, model } = await f.add({ key: 'captured-key' });
  f.vault.holdReads = true;
  const opened = f.open({ modelId: model.id }); await tick();
  let deleted = false;
  const deleting = f.settings.deleteProviderSettings(provider.id, provider.revision).then(() => { deleted = true; });
  const later = assert.rejects(f.open({ modelId: model.id }), { code: 'not-found' });
  await tick(); assert.equal(deleted, false);
  f.vault.release();
  const execution = await opened; await deleting; await later;
  const call = exchange(execution, { messages: [{ role: 'user', content: 'after deletion' }] });
  await call.result; assert.equal(f.protocols[0].calls[0].input.credential, 'captured-key');
  await execution.close();
});

test('source ingestion skips provider settings deleted before queued reconciliation', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const store = memoryStore(), f = await fixture({ store, protocols: [fakeProtocol('chat-completions')] }); t.after(() => f.close());
  const data = { upstream: { id: 'upstream', name: 'Upstream', npm: '@ai-sdk/openai-compatible', models: {
    first: { id: 'first', name: 'First', modalities: { input: ['text'], output: ['text'] } },
  } } };
  await f.sourceData.accept(normalizeModelsDevCatalog(data, 'models.dev', 1));
  const definition = f.settings.providers()[0];
  const connection = await f.settings.createProviderSettings({ providerId: definition.id, name: 'Account', enabled: true,
    protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 1000 });
  const original = store.commit.bind(store), entered = deferred();
  let deleted = false;
  store.commit = async change => {
    if (change.sources) { entered.resolve(); await gate.promise; }
    await original(change);
    if (change.deleteProviderSettings) deleted = true;
  };
  data.upstream.models.second = { id: 'second', name: 'Second', modalities: { input: ['text'], output: ['text'] } };
  const refreshing = f.sourceData.accept(normalizeModelsDevCatalog(data, 'models.dev', 2));
  await entered.promise;
  const deleting = f.settings.deleteProviderSettings(connection.id, connection.revision);
  await tick(); assert.equal(deleted, false); gate.resolve();
  await deleting; const result = await refreshing;
  assert.equal(result.accepted, true); assert.deepEqual(result.providers, []);
  assert.deepEqual(f.settings.configuredProviders(), []); assert.deepEqual(f.models.list(), []);
  assert.equal(f.settings.models().length, 2);
});

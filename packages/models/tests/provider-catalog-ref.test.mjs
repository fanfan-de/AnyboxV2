import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@nya/core';
import { createModelsStoreComponent } from '../dist/store.js';
import { createModelsCatalogComponent } from '../dist/catalog.js';
import { createMemoryModelsCatalogCache } from '../dist/catalog-cache.js';
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js';
import { capabilities, fixture } from './helpers.mjs';

const reference = { sourceId: 'models.dev', providerId: 'google' };
const providerInput = (id, overrides = {}) => ({
  id, name: id, enabled: true, protocolId: 'test', baseUrl: 'https://manual.invalid/v1', auth: 'none', timeoutMs: 10_000, ...overrides,
});

test('Provider catalog references are explicit, versioned and can be rebound or cleared with CAS protection', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const manual = await f.settings.createProvider(providerInput('manual', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
  assert.equal(manual.catalogRef, null);
  const firstInput = providerInput('bound', { catalogRef: { ...reference } });
  const admission = f.settings.createProvider(firstInput);
  firstInput.catalogRef.providerId = 'mutated-after-admission';
  const first = await admission;
  assert.deepEqual(first.catalogRef, reference);
  assert.equal(first.revision, 1);
  assert.ok(Object.isFrozen(first.catalogRef));
  const update = { catalogRef: { sourceId: 'other-directory', providerId: 'account-service' } };
  const updating = f.settings.updateProvider(first.id, update, first.revision);
  update.catalogRef.providerId = 'mutated-after-admission';
  const second = await updating;
  assert.equal(second.revision, 2);
  assert.notEqual(second.versionId, first.versionId);
  assert.deepEqual(second.catalogRef, { sourceId: 'other-directory', providerId: 'account-service' });
  await assert.rejects(f.settings.updateProvider(first.id, { catalogRef: null }, first.revision), { code: 'conflict' });
  assert.deepEqual(f.settings.providers().find(item => item.id === first.id).catalogRef, second.catalogRef);
  const third = await f.settings.updateProvider(first.id, { catalogRef: null }, second.revision);
  assert.equal(third.revision, 3);
  assert.equal(third.catalogRef, null);
  assert.deepEqual(f.settings.providerHistory(first.id).map(item => item.catalogRef), [reference, second.catalogRef, null]);
  const competing = await Promise.allSettled([
    f.settings.updateProvider(first.id, { catalogRef: reference }, third.revision),
    f.settings.updateProvider(first.id, { catalogRef: { sourceId: 'models.dev', providerId: 'anthropic' } }, third.revision),
  ]);
  assert.deepEqual(competing.map(item => item.status), ['fulfilled', 'rejected']);
  assert.equal(competing[1].reason.code, 'conflict');
  assert.equal(f.settings.providerHistory(first.id).length, 4);
  assert.deepEqual(f.settings.providers().find(item => item.id === first.id).catalogRef, reference);
});

test('Multiple local accounts can share a catalog reference and binding never reads keys or modifies models', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await f.settings.createProvider(providerInput('first-account', { auth: 'api-key', apiKey: 'first-private-key', catalogRef: reference }));
  const second = await f.settings.createProvider(providerInput('second-account', { auth: 'api-key', apiKey: 'second-private-key', catalogRef: reference, baseUrl: 'http://localhost:3000/custom/v1' }));
  const model = await f.settings.createModel({ id: 'local-model', name: 'Saved local model', enabled: true, providerId: first.id, remoteModelId: 'local-remote', capabilities: capabilities(), defaults: { temperature: 0.3, maxOutputTokens: 42 } });
  const savedModel = structuredClone(model);
  const savedModelHistory = f.settings.modelHistory(model.id);
  const savedOperations = structuredClone(f.vault.operations);
  const firstCredential = f.store.provider(first.id).credentialRef;
  const secondCredential = f.store.provider(second.id).credentialRef;
  assert.notEqual(firstCredential, secondCredential);
  const rebound = await f.settings.updateProvider(first.id, { catalogRef: { sourceId: 'models.dev', providerId: 'openai' } }, first.revision);
  await f.settings.updateProvider(first.id, { catalogRef: null }, rebound.revision);
  assert.deepEqual(f.vault.operations, savedOperations);
  assert.equal(f.vault.reads.length, 0);
  assert.equal(f.store.provider(first.id).credentialRef, firstCredential);
  assert.equal(f.store.provider(second.id).credentialRef, secondCredential);
  assert.deepEqual(f.settings.models(first.id), [savedModel]);
  assert.deepEqual(f.settings.modelHistory(model.id), savedModelHistory);
  assert.deepEqual(f.settings.providers().find(item => item.id === second.id).catalogRef, reference);
  assert.equal(f.settings.providers().find(item => item.id === second.id).baseUrl, 'http://localhost:3000/custom/v1');
  const publicRecords = JSON.stringify([f.settings.providers(), f.settings.providerHistory(first.id), f.settings.models()]);
  assert.ok(!publicRecords.includes('private-key'));
  assert.ok(!publicRecords.includes(firstCredential));
});

test('Provider reference validation accepts absent or null bindings and rejects malformed identity data', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await f.settings.createProvider(providerInput('unbound', { catalogRef: null }));
  assert.equal(first.catalogRef, null);
  for (const catalogRef of [
    {}, { sourceId: 'models.dev' }, { providerId: 'google' }, { sourceId: '', providerId: 'google' },
    { sourceId: 'models.dev', providerId: '' }, { sourceId: 'models.dev', providerId: 'google', apiKey: 'private-key' },
    { sourceId: 'https://models.dev', providerId: 'google' }, [], 'google',
  ]) {
    await assert.rejects(f.settings.updateProvider(first.id, { catalogRef }, first.revision), { code: 'invalid-config' });
  }
  assert.equal(f.settings.providerHistory(first.id).length, 1);
});

async function openStore(path) {
  const root = new Context();
  await root.installComponent(createModelsStoreComponent({ path }));
  return { root, store: root.get('models.store') };
}
function rawProviderRecords(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      current: db.prepare('SELECT record FROM providers WHERE id = ?').get('legacy').record,
      history: db.prepare('SELECT record FROM provider_versions WHERE provider_id = ? ORDER BY revision').all('legacy').map(row => row.record),
      version: db.prepare('PRAGMA user_version').get().user_version,
    };
  } finally { db.close(); }
}

test('Legacy SQLite Provider JSON reads as an unbound public reference without rewriting immutable history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-catalog-ref-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'models.sqlite');
  const initialized = await openStore(path);
  await initialized.root.fiber.dispose();
  const legacy = revision => ({
    id: 'legacy', name: `Legacy ${revision}`, enabled: true, protocolId: 'test', baseUrl: 'https://legacy.invalid/v1', auth: 'none', timeoutMs: 10_000,
    credentialRef: null, revision, versionId: `legacy-v${revision}`, createdAt: '2026-01-01', updatedAt: `2026-01-0${revision}`,
  });
  const encoded = [JSON.stringify(legacy(1)), JSON.stringify(legacy(2))];
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO providers (id, revision, record) VALUES (?, ?, ?)').run('legacy', 2, encoded[1]);
    for (let revision = 1; revision <= 2; revision++) db.prepare('INSERT INTO provider_versions (provider_id, revision, version_id, record) VALUES (?, ?, ?, ?)').run('legacy', revision, `legacy-v${revision}`, encoded[revision - 1]);
  } finally { db.close(); }
  const before = rawProviderRecords(path);
  const firstStorage = await openStore(path);
  const first = await fixture({ store: firstStorage.store });
  try {
    assert.equal(first.settings.providers()[0].catalogRef, null);
    assert.deepEqual(first.settings.providerHistory('legacy').map(item => item.catalogRef), [null, null]);
    assert.deepEqual(first.settings.providerHistory('legacy').map(item => item.versionId), ['legacy-v1', 'legacy-v2']);
  } finally { await first.close(); await firstStorage.root.fiber.dispose(); }
  assert.deepEqual(rawProviderRecords(path), before);
  const secondStorage = await openStore(path);
  const second = await fixture({ store: secondStorage.store });
  try {
    const updated = await second.settings.updateProvider('legacy', { catalogRef: reference }, 2);
    assert.equal(updated.revision, 3);
    assert.deepEqual(second.settings.providerHistory('legacy').map(item => item.catalogRef), [null, null, reference]);
  } finally { await second.close(); await secondStorage.root.fiber.dispose(); }
  const after = rawProviderRecords(path);
  assert.deepEqual(after.history.slice(0, 2), encoded);
  assert.deepEqual(JSON.parse(after.current).catalogRef, reference);
  assert.equal(after.version, before.version);
});

test('Removing a provider from the external catalog leaves saved models and existing or new executions runnable', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const provider = await f.settings.createProvider(providerInput('local-google', { catalogRef: reference }));
  const model = await f.settings.createModel({ id: 'local-model', name: 'Local', enabled: true, providerId: provider.id, remoteModelId: 'saved-remote', capabilities: capabilities(), defaults: { maxOutputTokens: 50 } });
  const initial = normalizeModelsDevCatalog({ google: {
    id: 'google', name: 'Google', api: 'https://generativelanguage.googleapis.com/v1beta', npm: '@ai-sdk/google',
    models: { 'saved-remote': { id: 'saved-remote', name: 'Catalog name', tool_call: true, reasoning: false, modalities: { input: ['text'], output: ['text'] } } },
  } }, 'models.dev', 1);
  const empty = normalizeModelsDevCatalog({}, 'models.dev', 2);
  await f.root.installComponent({ name: 'test-catalog-ports', apply(ctx) {
    ctx.provide('models.catalog-cache', createMemoryModelsCatalogCache());
    ctx.provide('models.catalog-source', {
      id: 'models.dev', cacheKey: 'unit-catalog', fetch() {
        return { result: Promise.resolve({ status: 'modified', snapshot: empty }), done: Promise.resolve(), cancel() {} };
      },
    });
  } });
  await f.root.installComponent(createModelsCatalogComponent({ bundledSnapshot: initial, autoRefresh: false }));
  const catalog = f.root.get('models.catalog');
  assert.ok(catalog.provider(reference));
  assert.ok(catalog.model(reference, model.remoteModelId));
  const existing = await f.models.open({ modelId: model.id });
  await catalog.refresh();
  assert.equal(catalog.provider(reference), undefined);
  assert.equal(catalog.model(reference, model.remoteModelId), undefined);
  assert.deepEqual(f.settings.providers()[0], provider);
  assert.deepEqual(f.settings.models()[0], model);
  assert.equal(f.models.get(model.id).available, true);
  const next = await f.models.open({ modelId: model.id });
  for (const execution of [existing, next]) {
    assert.ok(!JSON.stringify(execution.snapshot).includes('models.dev'));
    const operation = execution.generate({ messages: [{ role: 'user', content: 'Still available' }] });
    assert.equal((await operation.result).status, 'completed');
    await operation.done;
    await execution.close();
  }
  assert.equal(f.vault.reads.length, 0);
});

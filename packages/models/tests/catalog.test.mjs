import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Context, FiberState } from '@nya/core';
import { createModelsCatalogComponent } from '../dist/catalog.js';
import { createMemoryModelsCatalogCache, createModelsCatalogCacheComponent } from '../dist/catalog-cache.js';
import { normalizeModelsDevCatalog, resolveCatalogConnections, validateCatalogSnapshot, readCatalogSnapshot } from '../dist/catalog-domain.js';
import { loadBundledModelsDevCatalog } from '../dist/catalog-builtin.js';
import { modelsError } from '../dist/errors.js';
import { code, deferred, tick } from './helpers.mjs';

const raw = (name = 'Model', extra = {}) => ({ p: { id: 'p', name: 'Provider', npm: '@ai-sdk/openai-compatible', api: 'https://example.invalid/v1', models: {
  m: { id: 'm', name, tool_call: true, reasoning: true, temperature: true, modalities: { input: ['text'], output: ['text'] }, ...extra },
} } });
const snapshot = (name = 'Model', extra = {}) => normalizeModelsDevCatalog(raw(name, extra), 'test', 1);
function clock() {
  let now = 100, nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    timers,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort(([, left], [, right]) => left.at - right.at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await tick();
      }
      now = target; await tick();
    },
  };
}
function source() {
  const operations = [];
  return {
    id: 'test', cacheKey: 'test:https://example.invalid/all', operations, hold: false,
    fetch(input) {
      const result = deferred(), done = deferred(), aborted = deferred();
      const item = { input, result, done, aborted, cancellations: 0,
        succeed(value = { status: 'modified', snapshot: snapshot('Network'), etag: 'version-1' }) { result.resolve(value); done.resolve(); } };
      operations.push(item);
      if (input.signal.aborted) aborted.resolve(); else input.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      if (!this.hold) queueMicrotask(() => item.succeed());
      return { result: result.promise, done: done.promise, cancel() { item.cancellations++; aborted.resolve(); } };
    },
  };
}
function sourceStore(initial) {
  let current = initial;
  const commits = [];
  return { commits, accepted: () => current, async accept(candidate, options = {}) {
    validateCatalogSnapshot(candidate); commits.push({ candidate, options });
    const accepted = !current || candidate.fetchedAt > current.fetchedAt || candidate.snapshotVersion === current.snapshotVersion || options.confirmed && candidate.fetchedAt === current.fetchedAt;
    if (accepted) current = candidate;
    return { accepted, source: { sourceId: current.sourceId, snapshotVersion: current.snapshotVersion, fetchedAt: current.fetchedAt }, connections: [] };
  } };
}
async function fixture(options = {}) {
  const root = new Context(), scheduler = options.scheduler ?? clock(), upstream = options.source ?? source(), cache = options.cache ?? createMemoryModelsCatalogCache(), sourceData = options.sourceData ?? sourceStore();
  const ports = root.installComponent({ name: 'catalog-test-ports', apply(ctx) { ctx.provide('models.catalog-source', upstream); ctx.provide('models.catalog-cache', cache); ctx.provide('models.source-data', sourceData); } });
  await ports;
  const component = root.installComponent(createModelsCatalogComponent({ bundledSnapshot: snapshot(), scheduler, autoRefresh: false, ...options }));
  await component; assert.equal(component.state, FiberState.ACTIVE);
  return { root, ports, component, scheduler, source: upstream, sourceData, cache, catalog: root.get('models.catalog'),
    getModel: (providerId, remoteModelId) => sourceData.accepted('test')?.models.find(model => model.source.providerId === providerId && model.remoteModelId === remoteModelId),
    close: () => root.fiber.dispose() };
}
const observe = promise => { const value = { settled: false }; promise.then(() => { value.settled = true; }, () => { value.settled = true; }); return value; };

test('real bundled type=all snapshot includes all providers, preserves costs and explicit metadata', () => {
  const bundled = loadBundledModelsDevCatalog();
  assert.ok(bundled.providers.length > 100); assert.ok(bundled.models.length > 1000);
  assert.equal(bundled.sourceId, 'models.dev'); assert.ok(bundled.fetchedAt > 0); assert.match(bundled.snapshotVersion, /^[a-f0-9]{64}$/);
  assert.ok(bundled.models.some(model => model.cost?.currency === 'USD'));
  assert.ok(bundled.models.every(model => model.capabilities.streaming.support === 'unknown'));
});

test('normalization retains model connection overrides and does not invent reasoning ranges or streaming', () => {
  const value = normalizeModelsDevCatalog(raw('Model', {
    provider: { api: 'https://other.invalid/v1/responses', npm: '@ai-sdk/openai', shape: 'responses' },
    reasoning_options: [{ type: 'effort', values: ['low', null, 'high'] }, { type: 'budget_tokens', min: 1024 }],
    structured_output: false, limit: { context: 32000, output: 1000 }, cost: { input: 0.1, cache_read: 0.01 },
  }));
  const model = value.models[0];
  assert.deepEqual(value.providers[0].connectionHints, { baseUrl: 'https://example.invalid/v1', protocolIds: ['chat-completions'] });
  assert.deepEqual(model.connectionHints, { baseUrl: 'https://other.invalid/v1', protocolIds: ['responses'] });
  assert.deepEqual(model.capabilities.reasoning, { support: 'supported', efforts: ['low', 'high'] });
  assert.deepEqual(model.controls.reasoning[1], { kind: 'budget', min: 1024 });
  assert.equal(model.capabilities.streaming.support, 'unknown');
  assert.equal(model.controls.structuredOutput, 'unsupported'); assert.equal(model.cost.cacheRead, 0.01);
  assert.throws(() => normalizeModelsDevCatalog({ p: { id: 'p', name: 'Missing models' } }), code('invalid-response'));
});

test('DeepSeek SDK metadata selects the installed standard Chat protocol without using provider identity or hostname', () => {
  const input = raw(), endpoint = 'https://independent.invalid/v1/chat/completions';
  input.p.npm = '@ai-sdk/deepseek'; input.p.api = endpoint;
  const value = normalizeModelsDevCatalog(input), provider = value.providers[0], model = value.models[0];
  assert.deepEqual(provider.connectionHints, { baseUrl: 'https://independent.invalid/v1', protocolIds: ['chat-completions'] });
  assert.deepEqual(model.connectionHints.protocolIds, ['chat-completions']);
  const installed = ['responses', 'chat-completions'].map(id => ({ id, name: id }));
  const choices = resolveCatalogConnections(provider, installed, [], model);
  assert.deepEqual(choices.map(choice => choice.values.protocolId), ['chat-completions']);
  assert.equal(choices[0].values.baseUrl, 'https://independent.invalid/v1');
  input.p.npm = '@ai-sdk/unknown'; input.p.api = 'https://api.deepseek.com';
  const unknown = normalizeModelsDevCatalog(input);
  assert.deepEqual(unknown.providers[0].connectionHints.protocolIds, []);
  assert.deepEqual(resolveCatalogConnections(unknown.providers[0], installed), []);
});

test('connection templates use installed protocols and host catalog identities, with model overrides first', () => {
  const value = normalizeModelsDevCatalog(raw('Model', { provider: { api: 'https://alternate.invalid/v1', shape: 'responses' } }));
  const provider = value.providers[0], model = value.models[0];
  const descriptor = id => ({ id, name: id });
  const host = [{ id: 'special', name: 'Special', values: { enabled: true, protocolId: 'special', baseUrl: 'https://example.invalid/v1', auth: 'api-key', timeoutMs: 1000, sourceRef: { sourceId: 'models.dev', providerId: 'p' } } }];
  assert.equal(resolveCatalogConnections(provider, [descriptor('special')], host)[0].id, 'special');
  assert.deepEqual(resolveCatalogConnections(provider, [descriptor('special')], host, model), []);
  const choices = resolveCatalogConnections(provider, [descriptor('responses')], host, model);
  assert.equal(choices[0].values.baseUrl, 'https://alternate.invalid/v1');
  assert.equal(choices[0].values.protocolId, 'responses');
  assert.deepEqual(choices[0].values.sourceRef, { sourceId: 'models.dev', providerId: 'p' });
  const cloud = normalizeModelsDevCatalog({ p: { id: 'p', name: 'Cloud', npm: '@ai-sdk/amazon-bedrock', models: raw().p.models } });
  assert.deepEqual(resolveCatalogConnections(cloud.providers[0], [descriptor('chat-completions')]), []);
});

test('protocol-only model hints narrow host recipes without borrowing a different API address', () => {
  const value = normalizeModelsDevCatalog({ openai: { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', models: {
    native: { id: 'native', name: 'Native', provider: { shape: 'responses' } },
    external: { id: 'external', name: 'External', provider: { npm: '@ai-sdk/anthropic' } },
  } } });
  const descriptor = id => ({ id, name: id });
  const host = ['responses', 'chat-completions'].map(protocolId => ({ id: protocolId, name: protocolId, values: {
    enabled: true, protocolId, baseUrl: 'https://api.openai.com/v1', auth: 'api-key', timeoutMs: 1000,
    sourceRef: { sourceId: 'models.dev', providerId: 'openai' },
  } }));
  const installed = ['responses', 'chat-completions', 'anthropic-messages'].map(descriptor);
  assert.deepEqual(resolveCatalogConnections(value.providers[0], installed, host, value.models.find(model => model.remoteModelId === 'native')).map(choice => choice.id), ['responses']);
  assert.deepEqual(resolveCatalogConnections(value.providers[0], installed, host, value.models.find(model => model.remoteModelId === 'external')), []);
});

test('catalog initializes the unified source pool without credentials, protocols or network', async () => {
  const value = raw();
  value.p.models.old = { ...value.p.models.m, id: 'old', name: 'Old', status: 'deprecated' };
  value.p.models.embed = { ...value.p.models.m, id: 'embed', name: 'Embedding', modalities: { input: ['text'], output: ['embedding'] } };
  const f = await fixture({ bundledSnapshot: normalizeModelsDevCatalog(value, 'test', 1) });
  try {
    assert.equal(f.source.operations.length, 0); assert.equal(f.catalog.status().origin, 'bundled');
    assert.deepEqual(Object.keys(f.catalog).sort(), ['refresh', 'status']);
    const accepted = f.sourceData.accepted('test');
    assert.equal(accepted.providers.length, 1); assert.equal(accepted.models.length, 3);
    assert.equal(accepted.providers[0].source.kind, 'external');
    assert.equal(accepted.models[0].providerId, accepted.providers[0].id);
    assert.throws(() => { accepted.models[0].name = 'mutation'; });
    assert.equal(f.getModel('p', 'm').name, 'Model');
  } finally { await f.close(); }
});

test('refresh waits for source actual exit before publishing and rejects overlapping admission', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream });
  try {
    const request = f.catalog.refresh(), state = observe(request); await tick();
    await assert.rejects(f.catalog.refresh(), code('busy'));
    upstream.operations[0].result.resolve({ status: 'modified', snapshot: snapshot('Candidate'), etag: 'e1' });
    await tick(); assert.equal(state.settled, false); assert.equal(f.getModel('p', 'm').name, 'Model');
    assert.equal(f.cache.read(upstream.cacheKey), undefined);
    upstream.operations[0].done.resolve(); await request;
    assert.equal(f.getModel('p', 'm').name, 'Candidate'); assert.equal(f.catalog.status().refreshing, false);
    assert.equal(f.cache.read(upstream.cacheKey).etag, 'e1');
  } finally { await f.close(); }
});

test('cancellation between source result and exit preserves the old cache and joins actual cleanup', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream });
  try {
    const signal = new AbortController(), request = f.catalog.refresh(signal.signal), rejected = assert.rejects(request, code('cancelled'));
    await tick(); const state = observe(request), operation = upstream.operations[0];
    operation.result.resolve({ status: 'modified', snapshot: snapshot('Discard') }); signal.abort(); await operation.aborted.promise; await tick();
    assert.equal(state.settled, false); assert.equal(operation.cancellations, 1);
    operation.done.resolve(); await rejected;
    assert.equal(f.getModel('p', 'm').name, 'Model'); assert.equal(f.cache.read(upstream.cacheKey), undefined);
    assert.equal(f.catalog.status().error, undefined);
  } finally { await f.close(); }
});

test('failed source cleanup never publishes and remains visible to component disposal', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream });
  const request = f.catalog.refresh(), rejected = assert.rejects(request, code('cleanup-failure'));
  await tick(); const operation = upstream.operations[0];
  operation.done.reject(new Error('native cleanup secret detail'));
  await tick(); assert.equal(f.catalog.status().refreshing, false);
  operation.result.resolve({ status: 'modified', snapshot: snapshot('Discard') }); await rejected;
  assert.equal(f.getModel('p', 'm').name, 'Model');
  await assert.rejects(f.component.dispose(), code('cleanup-failure'));
  await f.close().catch(error => assert.equal(error.code, 'cleanup-failure'));
});

test('auto refresh starts after setup, uses a 24 hour TTL including 304, and can be manually refreshed', async () => {
  const f = await fixture({ autoRefresh: true });
  try {
    assert.equal(f.source.operations.length, 0); assert.equal(f.catalog.status().stale, true);
    await f.scheduler.advance(0); assert.equal(f.source.operations.length, 1);
    const checked = f.catalog.status().checkedAt;
    await f.scheduler.advance(24 * 60 * 60 * 1000 - 1); assert.equal(f.source.operations.length, 1);
    f.source.hold = true; await f.scheduler.advance(1); assert.equal(f.source.operations.length, 2);
    const operation = f.source.operations[1]; assert.equal(operation.input.etag, 'version-1');
    operation.succeed({ status: 'not-modified' }); await tick();
    assert.ok(f.catalog.status().checkedAt > checked); assert.equal(f.getModel('p', 'm').name, 'Network');
    const manual = f.catalog.refresh(); await tick(); f.source.operations[2].succeed(); await manual;
    assert.equal(f.catalog.status().nextRefreshAt, f.scheduler.now() + 24 * 60 * 60 * 1000);
  } finally { await f.close(); }
});

test('automatic failure backs off one hour, manual refresh bypasses it, and busy is not a failure', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream, autoRefresh: true });
  try {
    await f.scheduler.advance(0); upstream.operations[0].result.reject(modelsError('unavailable')); upstream.operations[0].done.resolve(); await tick();
    assert.equal(f.catalog.status().nextRefreshAt, f.scheduler.now() + 60 * 60 * 1000);
    const manual = f.catalog.refresh(), rejected = assert.rejects(f.catalog.refresh(), code('busy')); await rejected; await tick();
    upstream.operations[1].succeed(); await manual; assert.equal(f.catalog.status().error, undefined);
    await f.scheduler.advance(60 * 60 * 1000); assert.equal(upstream.operations.length, 2);
  } finally { await f.close(); }
});

test('timeout aborts at 30 seconds and still waits for the source exit', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream });
  try {
    const request = f.catalog.refresh(), rejected = assert.rejects(request, code('timeout')), state = observe(request); await tick();
    await f.scheduler.advance(30_000); await upstream.operations[0].aborted.promise; assert.equal(state.settled, false);
    upstream.operations[0].succeed(); await rejected;
    assert.equal(f.getModel('p', 'm').name, 'Model');
  } finally { await f.close(); }
});

test('cache failure leaves old data, while an admitted commit wins over late cancellation and disposal joins it', async () => {
  const base = createMemoryModelsCatalogCache(), gate = deferred(); let writeStarted = false, fail = true;
  const cache = { ...base, async write(record) { if (fail) throw modelsError('storage-unavailable'); writeStarted = true; await gate.promise; await base.write(record); } };
  const f = await fixture({ cache });
  await assert.rejects(f.catalog.refresh(), code('storage-unavailable')); assert.equal(f.getModel('p', 'm').name, 'Model');
  fail = false;
  const signal = new AbortController(), request = f.catalog.refresh(signal.signal); await tick(); assert.equal(writeStarted, true);
  signal.abort(); const disposal = f.component.dispose(), state = observe(disposal); await tick(); assert.equal(state.settled, false);
  gate.resolve(); await request; await disposal;
  assert.equal(base.read(f.source.cacheKey).snapshot.models[0].name, 'Network');
  assert.throws(() => f.catalog.status(), code('closed'));
  await f.close();
});

test('closing catalog stops timers and admission, aborts refresh, and waits for actual exit', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream, autoRefresh: true });
  const request = f.catalog.refresh(), rejected = assert.rejects(request, code('cancelled')); await tick();
  const disposal = f.component.dispose(), state = observe(disposal); await upstream.operations[0].aborted.promise; await tick();
  assert.equal(state.settled, false); assert.equal(f.scheduler.timers.size, 1); // refresh timeout, no recurring timer
  await assert.rejects(f.catalog.refresh(), code('closed'));
  upstream.operations[0].succeed(); await Promise.all([rejected, disposal]); assert.equal(f.scheduler.timers.size, 0);
  await f.scheduler.advance(24 * 60 * 60 * 1000); assert.equal(upstream.operations.length, 1);
  await f.close();
});

test('Nya source dependency replacement closes the old facade before a fresh catalog reads its new source', async () => {
  const upstream = source(); upstream.hold = true;
  const f = await fixture({ source: upstream }), old = f.catalog;
  const request = old.refresh(), rejected = assert.rejects(request, code('cancelled')); await tick();
  const withdrawing = f.ports.dispose(), state = observe(withdrawing);
  await upstream.operations[0].aborted.promise; await tick(); assert.equal(state.settled, false);
  upstream.operations[0].succeed({ status: 'modified', snapshot: snapshot('Old late result') }); await Promise.all([rejected, withdrawing]);
  assert.equal(f.component.state, FiberState.PENDING); assert.throws(() => old.status(), code('closed'));
  const next = source(); next.cacheKey = 'replacement-source';
  await f.root.installComponent({ name: 'replacement-catalog-ports', apply(ctx) { ctx.provide('models.catalog-source', next); ctx.provide('models.catalog-cache', f.cache); ctx.provide('models.source-data', f.sourceData); } });
  await f.component;
  const fresh = f.root.get('models.catalog'); assert.notEqual(fresh, old); assert.equal(f.getModel('p', 'm').name, 'Model');
  await fresh.refresh(); assert.equal(next.operations.length, 1); assert.equal(upstream.operations.length, 1);
  await f.close();
});

async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'models-catalog-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function openCache(path, options = {}) {
  const root = new Context(), component = root.installComponent(createModelsCatalogCacheComponent({ path, ...options }));
  await component; assert.equal(component.state, FiberState.ACTIVE);
  return { root, component, cache: root.get('models.catalog-cache') };
}
test('SQLite cache atomically survives reopening, isolates sources and releases exclusive ownership', async t => {
  const path = join(await directory(t), 'catalog.sqlite'), first = await openCache(path);
  const record = { cacheKey: 'one', snapshot: snapshot(), checkedAt: 123, etag: 'e' };
  const write = first.cache.write(record); record.checkedAt = 999; await write;
  assert.equal(first.cache.read('one').checkedAt, 123); assert.equal(first.cache.read('two'), undefined);
  const blocked = await openCache(path); assert.deepEqual(blocked.cache.status(), { persistence: 'memory', error: 'storage-unavailable' });
  await blocked.root.fiber.dispose();
  const accepted = first.cache.write({ ...record, checkedAt: 456 }); await first.root.fiber.dispose(); await accepted;
  await assert.rejects(first.cache.write(record), code('closed'));
  const reopened = await openCache(path); t.after(() => reopened.root.fiber.dispose()); assert.equal(reopened.cache.read('one').checkedAt, 456);
});

test('cache initialization failures provide explicit nonsecret memory fallback after releasing SQLite', async t => {
  const path = join(await directory(t), 'future.sqlite'), db = new DatabaseSync(path); db.exec('PRAGMA user_version = 99'); db.close();
  const f = await openCache(path); t.after(() => f.root.fiber.dispose());
  assert.deepEqual(f.cache.status(), { persistence: 'memory', error: 'storage-unavailable' });
  await f.cache.write({ cacheKey: 'one', snapshot: snapshot(), checkedAt: 1 }); assert.equal(f.cache.read('one').checkedAt, 1);
  const check = new DatabaseSync(path); check.exec('BEGIN EXCLUSIVE'); check.exec('ROLLBACK'); check.close();
  const disabled = new Context(), failed = disabled.installComponent(createModelsCatalogCacheComponent({ path, fallbackToMemory: false }));
  try { await failed; } catch {}
  assert.equal(failed.state, FiberState.FAILED); assert.equal(failed.error.code, 'storage-unavailable'); await disabled.fiber.dispose();
  const invalidPath = join(await directory(t), 'file'); await writeFile(invalidPath, 'plain file');
  const other = await openCache(join(invalidPath, 'catalog.sqlite')); t.after(() => other.root.fiber.dispose()); assert.equal(other.cache.status().persistence, 'memory');
});

test('valid cached data takes precedence over bundled snapshot and malformed cache cannot block startup', async () => {
  const upstream = source(), cache = createMemoryModelsCatalogCache();
  await cache.write({ cacheKey: upstream.cacheKey, snapshot: snapshot('Cached'), checkedAt: 100, etag: 'e' });
  const f = await fixture({ source: upstream, cache });
  assert.equal(f.catalog.status().origin, 'cache'); assert.equal(f.catalog.status().stale, false); assert.equal(f.getModel('p', 'm').name, 'Cached'); await f.close();
  const broken = { ...createMemoryModelsCatalogCache(), read() { throw modelsError('storage-unavailable'); } };
  const second = await fixture({ cache: broken });
  assert.equal(second.catalog.status().origin, 'bundled'); assert.equal(second.catalog.status().error, 'storage-unavailable'); await second.close();
});

test('catalog cache refuses host database paths and symbolic/hard-link aliases before opening SQLite or falling back', async t => {
  const parent = await directory(t), path = join(parent, 'models.sqlite');
  await writeFile(path, 'host database content');
  const symbolic = join(parent, 'symbolic.sqlite'), hard = join(parent, 'hard.sqlite');
  await symlink(path, symbolic); await link(path, hard);
  for (const candidate of [path, symbolic, hard]) {
    const root = new Context(), component = root.installComponent(createModelsCatalogCacheComponent({ path: candidate, reservedPaths: [path] }));
    try { await component; } catch {}
    assert.equal(component.state, FiberState.FAILED); assert.equal(component.error.code, 'invalid-config');
    assert.equal(root.get('models.catalog-cache'), undefined);
    await root.fiber.dispose();
  }
  const aliasDirectory = join(parent, 'directory-alias'); await symlink(parent, aliasDirectory, 'dir');
  const uncreated = join(parent, 'uncreated.sqlite'), alias = join(aliasDirectory, 'uncreated.sqlite');
  const root = new Context(), blocked = root.installComponent(createModelsCatalogCacheComponent({ path: uncreated, reservedPaths: [alias] }));
  try { await blocked; } catch {}
  assert.equal(blocked.state, FiberState.FAILED); assert.equal(blocked.error.code, 'invalid-config'); await root.fiber.dispose();
});

function legacySnapshot(value = snapshot()) {
  const providers = value.providers.map(provider => ({ sourceId: value.sourceId, id: provider.source.providerId, name: provider.name,
    ...(provider.documentationUrl ? { documentationUrl: provider.documentationUrl } : {}), connectionHints: provider.connectionHints }));
  const models = value.models.map(model => {
    const { id, revision, versionId, createdAt, updatedAt, state, source, capabilities, ...fields } = model;
    return { sourceId: value.sourceId, ...fields, providerId: source.providerId, suggestedCapabilities: capabilities };
  });
  return { schemaVersion: 1, sourceId: value.sourceId, fetchedAt: value.fetchedAt,
    snapshotVersion: createHash('sha256').update(JSON.stringify({ providers, models })).digest('hex'), providers, models };
}

test('source definition identity and content versions are stable across fetch times and isolated across sources', () => {
  const first = normalizeModelsDevCatalog(raw(), 'one', 10), newer = normalizeModelsDevCatalog(raw(), 'one', 20), other = normalizeModelsDevCatalog(raw(), 'two', 10);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.providers[0].id, newer.providers[0].id); assert.equal(first.models[0].id, newer.models[0].id);
  assert.equal(first.snapshotVersion, newer.snapshotVersion); assert.equal(first.models[0].versionId, newer.models[0].versionId);
  assert.notEqual(first.models[0].id, other.models[0].id); assert.notEqual(first.providers[0].id, other.providers[0].id);
  assert.equal(first.models[0].source.modelId, 'm'); assert.equal(first.models[0].source.sourceVersion, first.snapshotVersion);
  assert.equal(first.models[0].providerId, first.providers[0].id);
  const changed = normalizeModelsDevCatalog(raw('Changed'), 'one', 20);
  assert.equal(first.models[0].id, changed.models[0].id); assert.notEqual(first.models[0].versionId, changed.models[0].versionId);
  validateCatalogSnapshot(first); validateCatalogSnapshot(changed);
});

test('source snapshots reject altered content, unmatched identities and secret-shaped fields', () => {
  for (const alter of [value => { value.models[0].name = 'tampered'; }, value => { value.models[0].source.modelId = 'different'; },
    value => { value.providers[0].apiKey = 'secret'; }, value => { value.models[0].connectionHints.credential = 'secret'; },
    value => { value.models[0].providerId = 'unmatched'; }]) {
    const candidate = structuredClone(snapshot()); alter(candidate);
    assert.throws(() => validateCatalogSnapshot(candidate), code('invalid-response'));
  }
});

test('the legacy cache reader validates the original checksum before converting to module definitions', () => {
  const legacy = legacySnapshot(), normalized = readCatalogSnapshot(legacy);
  assert.equal(normalized.schemaVersion, 2); assert.equal(normalized.models[0].id, snapshot().models[0].id);
  assert.deepEqual(normalized.models[0].capabilities, snapshot().models[0].capabilities);
  assert.equal(normalized.models[0].providerId, normalized.providers[0].id); validateCatalogSnapshot(normalized);
  const bad = structuredClone(legacy); bad.models[0].name = 'bad';
  assert.throws(() => readCatalogSnapshot(bad), code('invalid-response'));
  assert.throws(() => validateCatalogSnapshot(legacy), code('invalid-response'));
});

test('SQLite cache converts legacy records only on reads and all subsequent writes use schema 2', async t => {
  const path = join(await directory(t), 'legacy.sqlite'), db = new DatabaseSync(path), legacy = legacySnapshot();
  db.exec('CREATE TABLE catalog_cache (cache_key TEXT PRIMARY KEY, record TEXT NOT NULL); PRAGMA user_version = 1');
  db.prepare('INSERT INTO catalog_cache (cache_key, record) VALUES (?, ?)').run('legacy', JSON.stringify({ cacheKey: 'legacy', snapshot: legacy, checkedAt: 3 })); db.close();
  const opened = await openCache(path), read = opened.cache.read('legacy');
  assert.equal(read.snapshot.schemaVersion, 2);
  await assert.rejects(opened.cache.write({ ...read, snapshot: legacy }), code('invalid-response'));
  await opened.cache.write(read); await opened.root.fiber.dispose();
  const inspection = new DatabaseSync(path);
  assert.equal(JSON.parse(inspection.prepare('SELECT record FROM catalog_cache').get().record).snapshot.schemaVersion, 2); inspection.close();
});

test('accepted source data cannot be downgraded by an older cache or bundle', async () => {
  const stored = normalizeModelsDevCatalog(raw('Accepted'), 'test', 20), old = normalizeModelsDevCatalog(raw('Old cache'), 'test', 10), cache = createMemoryModelsCatalogCache(), upstream = source();
  await cache.write({ cacheKey: upstream.cacheKey, snapshot: old, checkedAt: 100, etag: 'old-tag' });
  const sourceData = sourceStore(stored), f = await fixture({ sourceData, cache, source: upstream });
  try {
    assert.equal(f.catalog.status().origin, 'store'); assert.equal(f.getModel('p', 'm').name, 'Accepted');
    assert.equal(sourceData.commits.length, 0); assert.equal(f.catalog.status().stale, true);
    upstream.hold = true; const refresh = f.catalog.refresh(); await tick();
    assert.equal(upstream.operations[0].input.etag, undefined);
    upstream.operations[0].succeed({ status: 'modified', snapshot: normalizeModelsDevCatalog(raw('Confirmed'), 'test', 30) }); await refresh;
    assert.equal(f.getModel('p', 'm').name, 'Confirmed');
  } finally { await f.close(); }
});

test('equal-time different cache content preserves accepted data and requires a full source response', async () => {
  const stored = normalizeModelsDevCatalog(raw('Accepted'), 'test', 10), alternative = normalizeModelsDevCatalog(raw('Cache conflict'), 'test', 10), cache = createMemoryModelsCatalogCache(), upstream = source();
  await cache.write({ cacheKey: upstream.cacheKey, snapshot: alternative, checkedAt: 100, etag: 'conflicting-tag' });
  const sourceData = sourceStore(stored), f = await fixture({ sourceData, cache, source: upstream });
  try {
    assert.equal(f.catalog.status().origin, 'store'); assert.equal(f.getModel('p', 'm').name, 'Accepted');
    upstream.hold = true; const refresh = f.catalog.refresh(); await tick();
    assert.equal(upstream.operations[0].input.etag, undefined);
    upstream.operations[0].succeed({ status: 'modified', snapshot: alternative }); await refresh;
    assert.equal(f.getModel('p', 'm').name, 'Cache conflict');
    assert.equal(sourceData.commits[0].options.confirmed, true);
  } finally { await f.close(); }
});

test('refresh waits for unified definitions and connection initialization after committing cache', async () => {
  const base = sourceStore(), gate = deferred(), started = deferred(); let hold = false;
  const sourceData = { ...base, async accept(value, options) {
    if (hold) { started.resolve(); await gate.promise; }
    const committed = await base.accept(value, options);
    return { ...committed, connections: [{ connectionId: 'connection', state: 'failed', targetSourceVersion: value.snapshotVersion, syncedSourceVersion: null, error: 'invalid-configuration' }] };
  } };
  const f = await fixture({ sourceData }); hold = true;
  const request = f.catalog.refresh(), state = observe(request); await started.promise;
  assert.equal(f.cache.read(f.source.cacheKey).snapshot.models[0].name, 'Network');
  assert.equal(f.getModel('p', 'm').name, 'Model'); assert.equal(state.settled, false);
  const disposal = f.component.dispose(), disposing = observe(disposal); await tick(); assert.equal(disposing.settled, false);
  gate.resolve(); const result = await request; await disposal;
  assert.equal(result.connections[0].state, 'failed'); assert.equal(f.getModel('p', 'm').name, 'Network');
  assert.equal(result.error, undefined); await f.close();
});

test('a committed cache is replayed after a shared definition transaction failure', async () => {
  const base = sourceStore(), upstream = source(), cache = createMemoryModelsCatalogCache(); let fail = false;
  const sourceData = { ...base, async accept(value, options) { if (fail) throw modelsError('storage-unavailable'); return base.accept(value, options); } };
  const f = await fixture({ sourceData, source: upstream, cache }); fail = true; upstream.hold = true;
  const request = f.catalog.refresh(), rejected = assert.rejects(request, code('storage-unavailable')); await tick();
  upstream.operations[0].succeed({ status: 'modified', snapshot: normalizeModelsDevCatalog(raw('Network'), 'test', 2) }); await rejected;
  assert.equal(f.getModel('p', 'm').name, 'Model'); assert.equal(cache.read(upstream.cacheKey).snapshot.models[0].name, 'Network');
  await f.close(); fail = false;
  const recovered = await fixture({ sourceData, source: upstream, cache });
  assert.equal(recovered.getModel('p', 'm').name, 'Network'); assert.equal(recovered.catalog.status().origin, 'cache');
  await recovered.close();
});

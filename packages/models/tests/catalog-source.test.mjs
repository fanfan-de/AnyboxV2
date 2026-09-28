import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@nya/core';
import { createModelsDevCatalogSource, createModelsDevCatalogSourceComponent, modelsDevCatalogUrl } from '../dist/catalog-source.js';
import { joinOperation } from '../dist/lifecycle.js';
import { code, deferred, tick } from './helpers.mjs';

const data = { p: { id: 'p', name: 'Provider', npm: '@ai-sdk/openai-compatible', api: 'https://example.invalid/v1', models: { m: { id: 'm', name: '中文 Model', modalities: { input: ['text'], output: ['text'] } } } } };
const input = () => ({ signal: new AbortController().signal });
const encoder = new TextEncoder();
function streamed(chunks, options = {}) {
  let index = 0, cancellations = 0, releases = 0;
  const reader = {
    async read() { return index < chunks.length ? { value: chunks[index++], done: false } : { done: true }; },
    async cancel() { cancellations++; if (options.cancel) await options.cancel(); },
    releaseLock() { releases++; if (options.releaseError) throw new Error('release details'); },
  };
  return { response: { ok: options.ok ?? true, status: options.status ?? 200, headers: new Headers(options.headers), body: { getReader: () => reader } },
    counts: () => ({ cancellations, releases }) };
}

test('models.dev source always requests type=all without credentials and normalizes chunked UTF-8', async () => {
  const bytes = encoder.encode(JSON.stringify(data)), fake = streamed([...bytes].map(value => new Uint8Array([value])), { headers: { ETag: 'version-1' } });
  let request;
  const source = createModelsDevCatalogSource({ now: () => 123, fetch: async (url, init) => { request = { url, init }; return fake.response; } });
  const params = input(), outcome = await joinOperation(source.fetch(params), params.signal);
  assert.equal(request.url, modelsDevCatalogUrl); assert.equal(request.init.credentials, 'omit');
  assert.deepEqual(request.init.headers, { Accept: 'application/json' });
  assert.equal(outcome.snapshot.sourceId, 'models.dev'); assert.equal(outcome.snapshot.fetchedAt, 123);
  assert.equal(outcome.snapshot.models[0].name, '中文 Model'); assert.equal(outcome.etag, 'version-1');
  assert.deepEqual(fake.counts(), { cancellations: 0, releases: 1 });
});

test('catalog source invalid addresses and network failures expose only fixed module errors', async () => {
  for (const url of ['not-a-url', 'file:///tmp/catalog', 'https://user:secret@example.invalid']) assert.throws(() => createModelsDevCatalogSource({ url }), code('invalid-config'));
  const source = createModelsDevCatalogSource({ fetch: async () => { throw new TypeError('private socket address'); } }), params = input();
  await assert.rejects(joinOperation(source.fetch(params), params.signal), error => error.code === 'unavailable' && !error.message.includes('socket'));
});

test('a catalog response interrupted during reading is unavailable and releases its errored reader', async () => {
  let releases = 0, cancellations = 0;
  const source = createModelsDevCatalogSource({ fetch: async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    async read() { throw new TypeError('private interrupted socket'); },
    async cancel() { cancellations++; }, releaseLock() { releases++; },
  }) } }) });
  const params = input();
  await assert.rejects(joinOperation(source.fetch(params), params.signal), error => error.code === 'unavailable' && !error.message.includes('socket'));
  assert.equal(releases, 1); assert.equal(cancellations, 0);
});

test('ETag conditional request accepts 304 only when a cached validator exists', async () => {
  let header;
  const source = createModelsDevCatalogSource({ fetch: async (_url, init) => { header = init.headers['If-None-Match']; return new Response(null, { status: 304, headers: { etag: 'new-tag' } }); } });
  const params = { ...input(), etag: 'old-tag' }, result = await joinOperation(source.fetch(params), params.signal);
  assert.equal(header, 'old-tag'); assert.deepEqual(result, { status: 'not-modified', etag: 'new-tag' });
  const absent = input(); await assert.rejects(joinOperation(source.fetch(absent), absent.signal), code('invalid-response'));
});

test('catalog HTTP errors are fixed and response reader cleanup is joined', async () => {
  const gate = deferred(), fake = streamed([], { ok: false, status: 503, cancel: () => gate.promise });
  const source = createModelsDevCatalogSource({ fetch: async () => fake.response });
  const params = input(), request = joinOperation(source.fetch(params), params.signal);
  let settled = false; void request.catch(() => { settled = true; }); await tick(); assert.equal(settled, false);
  gate.resolve(); await assert.rejects(request, code('unavailable')); assert.deepEqual(fake.counts(), { cancellations: 1, releases: 1 });
});

for (const [label, chunks, headers] of [
  ['malformed JSON', [encoder.encode('{invalid')], {}],
  ['invalid UTF-8', [new Uint8Array([0xc3, 0x28])], {}],
  ['oversize response body', [new Uint8Array(32 * 1024 * 1024 + 1)], {}],
  ['oversize Content-Length', [encoder.encode('{}')], { 'content-length': String(32 * 1024 * 1024 + 1) }],
  ['invalid provider structure', [encoder.encode('{"p":{"id":"p","name":"Provider"}}')], {}],
]) {
  test(`source rejects ${label} without exposing its raw response`, async () => {
    const fake = streamed(chunks, { headers }), source = createModelsDevCatalogSource({ fetch: async () => fake.response }), params = input();
    await assert.rejects(joinOperation(source.fetch(params), params.signal), error => error.code === 'invalid-response' && error.message === 'The model provider returned an invalid response.');
    assert.equal(fake.counts().releases, 1);
  });
}

test('cancellation aborts fetch but public joining waits for a fetch implementation to really exit', async () => {
  const gate = deferred(), fetched = deferred(); let seenSignal;
  const fake = streamed([encoder.encode(JSON.stringify(data))]);
  const source = createModelsDevCatalogSource({ fetch: async (_url, init) => { seenSignal = init.signal; fetched.resolve(); await gate.promise; return fake.response; } });
  const controller = new AbortController(), request = joinOperation(source.fetch({ signal: controller.signal }), controller.signal);
  const rejected = assert.rejects(request, code('cancelled')); await fetched.promise; controller.abort();
  assert.equal(seenSignal.aborted, true); let settled = false; void request.catch(() => { settled = true; }); await tick(); assert.equal(settled, false);
  gate.resolve(); await rejected; assert.deepEqual(fake.counts(), { cancellations: 1, releases: 1 });
});

test('source done includes reader cleanup failure and Nya source owner remembers it', async () => {
  const root = new Context(), fake = streamed([encoder.encode(JSON.stringify(data))], { releaseError: true });
  const component = root.installComponent(createModelsDevCatalogSourceComponent({ fetch: async () => fake.response }));
  await component;
  const params = input(), source = root.get('models.catalog-source');
  await assert.rejects(joinOperation(source.fetch(params), params.signal), code('cleanup-failure'));
  await assert.rejects(component.dispose(), code('cleanup-failure'));
  assert.throws(() => source.fetch(input()), code('closed'));
  await root.fiber.dispose().catch(error => assert.equal(error.code, 'cleanup-failure'));
});

test('source component disposal aborts all owned fetches and waits before releasing its service', async () => {
  const root = new Context(), gate = deferred(), started = deferred(); let signal;
  const component = root.installComponent(createModelsDevCatalogSourceComponent({ fetch: async (_url, init) => { signal = init.signal; started.resolve(); await gate.promise; return new Response(JSON.stringify(data)); } }));
  await component;
  const source = root.get('models.catalog-source'), params = input(), request = joinOperation(source.fetch(params), params.signal), rejected = assert.rejects(request, code('cancelled'));
  await started.promise; const disposal = component.dispose(); await tick(); assert.equal(signal.aborted, true);
  let disposed = false; void disposal.then(() => { disposed = true; }); await tick(); assert.equal(disposed, false);
  gate.resolve(); await Promise.all([rejected, disposal]); await root.fiber.dispose();
});

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
const provider = (overrides = {}) => ({
  id: 'p', revision: 1, versionId: 'p-v1', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  name: 'Local provider', enabled: true, protocolId: 'not-installed', baseUrl: 'http://localhost:1234/v1',
  auth: 'api-key', timeoutMs: 1000, credentialRef: 'slot-1', ...overrides,
});
const model = (overrides = {}) => ({
  id: 'm', revision: 1, versionId: 'm-v1', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  name: 'Local model', enabled: true, providerId: 'p', remoteModelId: 'remote', defaults: {},
  capabilities: { tools: capability, streaming: capability, imageInput: capability, reasoning: capability },
  ...overrides,
});
async function open(path) {
  const root = new Context();
  const fiber = root.installComponent(createModelsStoreComponent({ path }));
  await fiber;
  assert.equal(fiber.state, FiberState.ACTIVE);
  return { root, store: root.get('models.store') };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'models.sqlite');
}

test('configuration, immutable versions, and credential intents survive reopening without protocols', async t => {
  const path = await temporary(t);
  const first = await open(path);
  const input = provider({ apiKey: 'must-never-be-persisted' });
  await first.store.commit({ provider: { record: input, expectedRevision: null } });
  await first.store.commit({ model: { record: model(), expectedRevision: null } });
  await first.store.commit({ provider: { record: provider({ revision: 2, versionId: 'p-v2', name: 'Edited' }), expectedRevision: 1 } });
  await first.store.commit({ model: { record: model({ revision: 2, versionId: 'm-v2', defaults: { temperature: 0.3 } }), expectedRevision: 1 } });
  await first.store.commit({ addIntents: [{ id: 'cleanup', providerId: 'new-uncommitted-provider', slotId: 'orphan', createdAt: '2026-01-02' }] });
  await first.root.fiber.dispose();
  const second = await open(path);
  t.after(() => second.root.fiber.dispose());
  assert.equal(second.store.provider('p').name, 'Edited');
  assert.deepEqual(second.store.providerHistory('p').map(p => p.name), ['Local provider', 'Edited']);
  assert.deepEqual(second.store.modelHistory('m').map(m => m.defaults), [{}, { temperature: 0.3 }]);
  assert.equal(second.store.intents()[0].slotId, 'orphan');
  assert.equal((await readFile(path)).includes(Buffer.from('must-never-be-persisted')), false);
  const received = second.store.model('m');
  received.defaults.temperature = 123;
  assert.equal(second.store.model('m').defaults.temperature, 0.3);
});

test('CAS conflicts roll back the whole configuration and credential-journal transaction', async t => {
  const { root, store } = await open(await temporary(t));
  t.after(() => root.fiber.dispose());
  await store.commit({ provider: { record: provider(), expectedRevision: null }, model: { record: model(), expectedRevision: null } });
  await assert.rejects(store.commit({
    provider: { record: provider({ revision: 2, versionId: 'p-v2' }), expectedRevision: 1 },
    model: { record: model({ revision: 2, versionId: 'm-v2' }), expectedRevision: 77 },
    addIntents: [{ id: 'never-written', slotId: 'orphan', providerId: 'p', createdAt: '2026-01-02' }],
  }), { code: 'conflict' });
  assert.equal(store.provider('p').revision, 1);
  assert.equal(store.providerHistory('p').length, 1);
  assert.equal(store.intents().length, 0);
  const one = store.commit({ provider: { record: provider({ revision: 2, versionId: 'p-v2' }), expectedRevision: 1 } });
  const two = store.commit({ provider: { record: provider({ revision: 2, versionId: 'p-v2-other' }), expectedRevision: 1 } });
  assert.deepEqual((await Promise.allSettled([one, two])).map(item => item.status), ['fulfilled', 'rejected']);
  assert.equal(store.providerHistory('p').length, 2);
});

test('storage enforces immutable protocol and model ownership and snapshots queued inputs', async t => {
  const { root, store } = await open(await temporary(t));
  t.after(() => root.fiber.dispose());
  const original = provider();
  const admitted = store.commit({ provider: { record: original, expectedRevision: null } });
  original.name = 'Mutated after admission';
  await admitted;
  assert.equal(store.provider('p').name, 'Local provider');
  await assert.rejects(store.commit({ provider: { record: provider({ revision: 2, versionId: 'p-v2', protocolId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await store.commit({ model: { record: model(), expectedRevision: null } });
  await assert.rejects(store.commit({ model: { record: model({ revision: 2, versionId: 'm-v2', providerId: 'other' }), expectedRevision: 1 } }), { code: 'invalid-config' });
  await assert.rejects(store.commit({ model: { record: model({ id: 'missing-owner', providerId: 'other' }), expectedRevision: null } }), { code: 'not-found' });
});

test('SQLite ownership excludes another component and releases on close', async t => {
  const path = await temporary(t);
  const first = await open(path);
  const second = new Context();
  const blocked = second.installComponent(createModelsStoreComponent({ path }));
  try { await blocked; } catch {}
  assert.equal(blocked.state, FiberState.FAILED);
  assert.equal(blocked.error.code, 'storage-unavailable');
  await second.fiber.dispose();
  const accepted = first.store.commit({ provider: { record: provider(), expectedRevision: null } });
  await first.root.fiber.dispose();
  await accepted;
  await assert.rejects(first.store.commit({}), { code: 'closed' });
  const third = await open(path);
  t.after(() => third.root.fiber.dispose());
  assert.equal(third.store.provider('p').id, 'p');
});

test('process death releases database ownership and preserves the durable key cleanup intent', async t => {
  const path = await temporary(t);
  const moduleUrl = new URL('../dist/store.js', import.meta.url).href;
  const script = `
    import { Context } from '@nya/core';
    import { createModelsStoreComponent } from ${JSON.stringify(moduleUrl)};
    const root = new Context();
    await root.installComponent(createModelsStoreComponent({ path: process.argv[1] }));
    await root.get('models.store').commit({ addIntents: [{ id: 'pending', providerId: 'p', slotId: 'orphan', createdAt: '2026-01-01' }] });
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('child did not acquire storage'); }),
  ]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const reopened = await open(path);
  t.after(() => reopened.root.fiber.dispose());
  assert.equal(reopened.store.intents()[0].slotId, 'orphan');
  await reopened.store.commit({ removeIntentIds: ['pending'] });
  assert.deepEqual(reopened.store.intents(), []);
});

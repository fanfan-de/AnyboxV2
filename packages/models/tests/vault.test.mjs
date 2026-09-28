import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@nya/core';
import { createModelsVaultComponent } from '../dist/vault.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function open(openEntry) {
  const root = new Context();
  await root.installComponent(createModelsVaultComponent({ namespace: 'models-tests', openEntry }));
  return { root, vault: root.get('models.vault') };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('reads, writes and deletion are ordered per slot while different slots progress independently', async t => {
  const values = new Map();
  const entered = deferred();
  const release = deferred();
  const sequence = [];
  const { root, vault } = await open((namespace, slot) => {
    assert.equal(namespace, 'models-tests');
    return {
      async getPassword() { sequence.push(`read:${slot}`); return values.get(slot); },
      async setPassword(value) {
        sequence.push(`write:${slot}`);
        if (slot === 'a') { entered.resolve(); await release.promise; }
        values.set(slot, value);
      },
      async deleteCredential() { sequence.push(`delete:${slot}`); return values.delete(slot); },
    };
  });
  t.after(() => root.fiber.dispose());
  const write = vault.write('a', 'first');
  await entered.promise;
  const read = vault.read('a');
  const deleted = vault.delete('a');
  await vault.write('b', 'independent');
  assert.deepEqual(sequence, ['write:a', 'write:b']);
  release.resolve();
  await write;
  assert.equal(await read, 'first');
  await deleted;
  assert.equal(await vault.read('a'), undefined);
  assert.equal(await vault.read('b'), 'independent');
});

test('cancellation and component disposal join actual in-flight exits and skip queued writes', async () => {
  const entered = deferred();
  const release = deferred();
  let signal;
  let wrote = false;
  const { root, vault } = await open(() => ({
    async getPassword(owned) { signal = owned; entered.resolve(); await release.promise; return 'must-not-return'; },
    async setPassword() { wrote = true; },
    async deleteCredential() { return false; },
  }));
  const read = vault.read('a');
  await entered.promise;
  const queued = vault.write('a', 'never-written');
  let readSettled = false;
  let closed = false;
  const readObserved = read.finally(() => { readSettled = true; }).catch(error => error);
  const queuedObserved = queued.catch(error => error);
  const closing = root.fiber.dispose().then(() => { closed = true; });
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(readSettled, false);
  assert.equal(closed, false);
  release.resolve();
  await closing;
  assert.equal((await readObserved).code, 'cancelled');
  assert.equal((await queuedObserved).code, 'cancelled');
  assert.equal(wrote, false);
  await assert.rejects(vault.read('a'), { code: 'closed' });
});

test('caller cancellation cannot reveal a completed native result and vault failures hide backend details', async t => {
  const entered = deferred();
  const release = deferred();
  const { root, vault } = await open((_, slot) => {
    if (slot === 'constructor-error') throw new Error('sensitive-backend-details');
    return {
      async getPassword() { entered.resolve(); await release.promise; return 'sensitive-secret'; },
      async setPassword(value) { throw new Error(value); },
      async deleteCredential() { throw new Error('native-path'); },
    };
  });
  t.after(() => root.fiber.dispose());
  const controller = new AbortController();
  const result = vault.read('a', controller.signal);
  await entered.promise;
  controller.abort(new Error('user-sensitive-reason'));
  release.resolve();
  await assert.rejects(result, error => error.code === 'cancelled' && !String(error).includes('sensitive'));
  for (const operation of [vault.read('constructor-error'), vault.write('a', 'secret-value'), vault.delete('b')]) {
    await assert.rejects(operation, error => error.code === 'credential-unavailable' && !String(error).match(/secret|native|sensitive/));
  }
});

test('already-cancelled work never opens a keyring entry and invalid inputs never expose values', async t => {
  let opened = 0;
  const { root, vault } = await open(() => { opened++; throw new Error('unreachable'); });
  t.after(() => root.fiber.dispose());
  const controller = new AbortController();
  controller.abort('private-reason');
  await assert.rejects(vault.read('a', controller.signal), { code: 'cancelled' });
  await assert.rejects(vault.write('a', '  '), { code: 'invalid-config' });
  await assert.rejects(vault.delete(''), { code: 'invalid-config' });
  assert.equal(opened, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { code, complete, deferred, fakeProtocol, fixture, tick } from './helpers.mjs';

const input = content => ({ messages: [{ role: 'user', content }] });
const observe = promise => {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
};

for (const method of ['discoverModels', 'checkConnection']) {
  test(`unregister reports ${method} cleanup failure after waiting for its actual exit`, async () => {
    const f = await fixture(), protocol = f.protocols[0];
    try {
      await f.add();
      protocol.next();
      const operation = f.settings[method]('provider');
      const rejectedOperation = assert.rejects(operation, code('cleanup-failure'));
      await tick();
      const closing = f.registrations[0].unregister();
      const rejectedClose = assert.rejects(closing, code('cleanup-failure'));
      const state = observe(closing);
      protocol.operations[0].done.reject(new Error('private-native-cleanup-details'));
      await tick();
      assert.equal(state.settled, false);
      protocol.operations[0].result.resolve(method === 'discoverModels' ? [] : undefined);
      await Promise.all([rejectedOperation, rejectedClose]);
    } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')); }
  });
}

test('an already-settled call cleanup failure remains visible to execution close and protocol unregister', async () => {
  const f = await fixture(), protocol = f.protocols[0];
  try {
    await f.add();
    const execution = await f.models.open({ modelId: 'model' });
    protocol.next();
    const call = execution.generate(input('cleanup fails'));
    const rejectedResult = assert.rejects(call.result, code('cleanup-failure'));
    const rejectedDone = assert.rejects(call.done, code('cleanup-failure'));
    await tick();
    protocol.calls[0].result.resolve({ result: complete('uncommitted') });
    protocol.calls[0].done.reject(new Error('native cleanup failed'));
    await Promise.all([rejectedResult, rejectedDone]);
    await assert.rejects(execution.close(), code('cleanup-failure'));
    await assert.rejects(execution.close(), code('cleanup-failure'));
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'));
  } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')); }
});

test('discovery cleanup failure settled before unregister is remembered by its registration generation', async () => {
  const f = await fixture(), protocol = f.protocols[0];
  try {
    await f.add();
    protocol.next();
    const result = f.settings.discoverModels('provider');
    const rejected = assert.rejects(result, code('cleanup-failure'));
    await tick();
    protocol.operations[0].result.resolve([]);
    protocol.operations[0].done.reject(new Error('native cleanup failed'));
    await rejected;
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'));
  } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')); }
});

test('replacement generation waits for old pending credential initialization to actually exit', async () => {
  const f = await fixture(), old = f.protocols[0];
  try {
    await f.add({ key: 'fixed-secret' });
    f.vault.holdReads = true;
    const oldOpening = f.models.open({ modelId: 'model' });
    const oldRejected = assert.rejects(oldOpening, code('cancelled'));
    await tick();
    const oldClosing = f.registrations[0].unregister(), closed = observe(oldClosing);
    await f.vault.reads[0].aborted.promise;
    const replacement = fakeProtocol('test', 'replacement');
    f.protocols.push(replacement);
    const registration = f.registry.register(replacement);
    const newOpening = f.models.open({ modelId: 'model' }), opened = observe(newOpening);
    await tick();
    assert.equal(closed.settled, false);
    assert.equal(opened.settled, false);
    f.vault.holdReads = false;
    f.vault.reads[0].release.resolve();
    await Promise.all([oldRejected, oldClosing]);
    const execution = await newOpening;
    assert.equal(execution.snapshot.protocolVersion, 'replacement');
    await execution.generate(input('new implementation')).result;
    assert.equal(old.calls.length, 0);
    assert.equal(replacement.calls.length, 1);
    await f.registrations[0].unregister();
    assert.equal(f.models.get('model').available, true);
    await execution.close();
    await registration.unregister();
  } finally { await f.close(); }
});

test('cancellation between protocol result and exit retains only the last committed continuation', async () => {
  const f = await fixture(), protocol = f.protocols[0];
  try {
    await f.add();
    const execution = await f.models.open({ modelId: 'model' });
    protocol.next(call => call.succeed({ result: complete('committed answer'), continuation: { turn: 'committed' } }));
    await execution.generate(input('committed input')).result;
    protocol.next();
    const interrupted = execution.generate(input('discarded input'));
    await tick();
    const active = protocol.calls[1];
    active.result.resolve({ result: complete('discarded answer'), continuation: { turn: 'discarded' } });
    await tick();
    interrupted.cancel();
    const rejecting = assert.rejects(interrupted.result, code('cancelled'));
    active.done.resolve();
    await rejecting;
    await execution.generate(input('explicit retry')).result;
    assert.deepEqual(protocol.calls[2].input.continuation, { turn: 'committed' });
    assert.deepEqual(protocol.calls[2].input.messages.map(message => message.content), [
      'committed input', 'committed answer', 'explicit retry',
    ]);
    await execution.close();
  } finally { await f.close(); }
});

test('component close joins accepted key mutation and queued config writes before releasing dependencies', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  const originalWrite = f.vault.write.bind(f.vault);
  let disposal;
  try {
    const { provider } = await f.add({ key: 'initial-secret' });
    f.vault.write = async (...args) => { entered.resolve(); await release.promise; return originalWrite(...args); };
    const replacing = f.settings.setApiKey(provider.id, 'replacement-secret', provider.revision);
    await entered.promise;
    const renaming = f.settings.updateProvider(provider.id, { name: 'queued edit' }, provider.revision + 1);
    disposal = f.component.dispose();
    const disposed = observe(disposal);
    await tick();
    assert.equal(disposed.settled, false);
    await assert.rejects(f.settings.setApiKey(provider.id, 'rejected-secret', provider.revision), code('closed'));
    release.resolve();
    await Promise.all([replacing, renaming, disposal]);
    assert.equal(f.store.provider(provider.id).name, 'queued edit');
    assert.equal(f.store.provider(provider.id).revision, provider.revision + 2);
    assert.deepEqual([...f.vault.secrets.values()], ['replacement-secret']);
    assert.deepEqual(f.store.intents(), []);
  } finally {
    release.resolve();
    await disposal;
    await f.close();
  }
});

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilities, code, complete, deferred, exchange, fakeProtocol, fixture, params, tick } from './helpers.mjs'
const input = content => ({ messages: [{ role: 'user', content }] })
const tracked = promise => { const state = { settled: false }; promise.then(() => { state.settled = true }, () => { state.settled = true }); return state }

test('native protocol identities do not collide with compatibility dictionary prototype names', async () => {
  const f = await fixture({ protocols: [fakeProtocol('constructor'), fakeProtocol('toString')] })
  try {
    assert.deepEqual(f.settings.protocols().map(item => item.id), ['constructor', 'toString'])
    for (const protocolId of ['constructor', 'toString']) {
      const lease = f.registry.acquire(protocolId)
      assert.equal(lease.protocolId, protocolId)
      lease.release()
    }
  } finally { await f.close() }
})

test('malformed restore metadata fails with a fixed error before reading credentials', async () => {
  const f = await fixture()
  try {
    await f.add({ key: 'private-key' })
    const reads = f.vault.reads.length
    for (const restore of [{}, { protocolId: 'test', records: [] },
      { protocolId: 'test', modelSnapshot: null, records: [] },
      { protocolId: 'test', modelSnapshot: { schemaVersion: 3, protocolId: 'test', parameters: null }, records: [] }]) {
      await assert.rejects(f.open({ modelId: 'model', restore }), code('invalid-config'))
    }
    assert.equal(f.vault.reads.length, reads)
  } finally { await f.close() }
})

test('independent native executions retain their own configuration, credential and protocol generation', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add({ providerId: 'one', modelId: 'quick', key: 'first-secret', defaults: { temperature: 0.1 } })
    await f.add({ providerId: 'two', modelId: 'deep', key: 'second-secret', defaults: { temperature: 0.8 } })
    const [quick, deep] = await Promise.all([f.open({ modelId: 'quick' }), f.open({ modelId: 'deep' })]); protocol.next(); protocol.next()
    const a = exchange(quick, input('first')), b = exchange(deep, input('second')); await tick()
    assert.deepEqual(protocol.calls.map(call => [call.input.request.parameters.temperature, call.input.credential]), [[0.1, 'first-secret'], [0.8, 'second-secret']])
    protocol.calls[1].succeed(complete('second finishes first')); assert.equal((await b.result).text, 'second finishes first')
    const first = tracked(a.result); await tick(); assert.equal(first.settled, false)
    protocol.calls[0].succeed(complete('first')); await a.result; await Promise.all([quick.close(), deep.close()])
  } finally { await f.close() }
})

test('prepare fixes an immutable incremental recipe without starting a request', async () => {
  const f = await fixture(); try {
    await f.add(); const execution = await f.open({ modelId: 'model' }); const intent = input('first'); const prepared = execution.prepareExchange(intent); intent.messages[0].content = 'mutated'
    assert.equal(f.protocols[0].calls.length, 0); assert.equal(prepared.record.payload.messages[0].content, 'first'); assert.equal(prepared.request.precedingRecordId, null)
    assert.throws(() => execution.prepareExchange(input('another')), code('busy'))
    const reply = await prepared.start().result; assert.equal(reply.records[0].id, prepared.record.id); assert.throws(() => prepared.start(), code('busy'))
    const second = execution.prepareExchange(input('second')); assert.equal(second.request.precedingRecordId, reply.records[1].id); assert.deepEqual(second.request.intent, input('second'))
    await second.start().result; const report = await execution.close(); assert.equal(report.records.length, 4); assert.ok(report.restoreState)
  } finally { await f.close() }
})

test('result waits for actual exit and atomically commits native state before the next exchange', async () => {
  const f = await fixture(), protocol = f.protocols[0]; try {
    await f.add(); const execution = await f.open({ modelId: 'model' }); protocol.next(); const call = exchange(execution, input('first')); await tick()
    protocol.calls[0].result.resolve({ text: 'reply', signature: 'native-signature' }); const result = tracked(call.result), done = tracked(call.done); await tick()
    assert.equal(result.settled, false); assert.equal(done.settled, false); assert.throws(() => execution.prepareExchange(input('overlap')), code('busy'))
    protocol.calls[0].done.resolve(); await call.result; await exchange(execution, input('second')).result
    assert.deepEqual(protocol.calls[1].input.request.previousResponse, { text: 'reply', signature: 'native-signature' }); assert.deepEqual(protocol.calls[1].input.request.newMessages, input('second').messages)
    assert.doesNotMatch(JSON.stringify(execution.snapshot), /native-signature/); await execution.close()
  } finally { await f.close() }
})

test('native refusals, incomplete responses and pauses remain protocol decisions rather than unified statuses', async () => {
  const f = await fixture(); try {
    await f.add(); const execution = await f.open({ modelId: 'model' })
    for (const reason of ['pause_turn', 'refusal', 'max_tokens']) { f.protocols[0].next(call => call.succeed({ stop_reason: reason, text: reason })); assert.equal((await exchange(execution, input(reason)).result).stop_reason, reason) }
    assert.equal((await execution.close()).records.filter(record => record.kind === 'response').length, 3)
  } finally { await f.close() }
})

test('cancel waits for actual exit, suppresses late events and never commits the candidate', async () => {
  const f = await fixture(); try {
    await f.add(); const execution = await f.open({ modelId: 'model' }); f.protocols[0].next(); const events = []; const call = exchange(execution, input('cancel'), event => events.push(event)); await tick()
    const active = f.protocols[0].calls[0]; active.result.resolve({ text: 'late' }); call.cancel(); await active.aborted.promise; active.input.onEvent({ type: 'late' })
    const result = tracked(call.result); await tick(); assert.equal(result.settled, false); active.done.resolve(); await assert.rejects(call.result, code('cancelled')); await call.done
    const report = await execution.close(); assert.equal(report.restoreState, undefined); assert.deepEqual(events, []); assert.ok(report.records.some(record => record.kind === 'diagnostic'))
  } finally { await f.close() }
})

test('timeout requests cancellation and still waits for transport cleanup', { timeout: 3000 }, async () => {
  const f = await fixture(); try {
    await f.add({ timeoutMs: 10 }); const execution = await f.open({ modelId: 'model' }); f.protocols[0].next(); const call = exchange(execution, input('timeout')); await tick()
    await f.protocols[0].calls[0].aborted.promise; const result = tracked(call.result); await tick(); assert.equal(result.settled, false)
    f.protocols[0].calls[0].succeed(); await assert.rejects(call.result, code('timeout')); await execution.close()
  } finally { await f.close() }
})

test('cleanup failure preserves immutable diagnostics and is visible to every resource owner', async () => {
  const f = await fixture(); try {
    await f.add(); const execution = await f.open({ modelId: 'model' }); f.protocols[0].next(); const call = exchange(execution, input('fail')); await tick()
    const candidate = { text: 'candidate', signature: 'opaque' }; f.protocols[0].calls[0].result.resolve(candidate); f.protocols[0].calls[0].done.reject(new Error('private failure'))
    await assert.rejects(call.result, code('cleanup-failure')); await assert.rejects(call.done, code('cleanup-failure'))
    const first = execution.close(), second = execution.close(); assert.equal(first, second); const report = await first; candidate.signature = 'changed'
    assert.equal(report.cleanup, 'failed'); assert.equal(report.restoreState, undefined); assert.equal(report.records.at(-1).payload.signature, 'opaque')
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
  } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')) }
})

test('observer exceptions, including rejected async listeners, cannot affect native execution', async () => {
  const f = await fixture(); try {
    await f.add(); const execution = await f.open({ modelId: 'model' })
    for (const onEvent of [undefined, () => { throw new Error('bad observer') }, async () => { throw new Error('bad observer') }]) {
      f.protocols[0].next(call => { call.input.onEvent({ type: 'text', text: 'hello' }); call.succeed() }); await exchange(execution, input('hello'), onEvent).result
    }
    await execution.close()
  } finally { await f.close() }
})

test('unknown required capabilities and per-open overrides fail before credentials or network', async () => {
  const f = await fixture(); try {
    await f.add({ capabilityDeclarations: capabilities({ reasoning: { support: 'unknown' } }) })
    await assert.rejects(f.open({ modelId: 'model', requirements: { reasoning: true } }), code('capability-unsupported'))
    await assert.rejects(f.open({ modelId: 'model', options: { temperature: 0.2 } }), code('invalid-config')); assert.equal(f.protocols[0].calls.length, 0)
  } finally { await f.close() }
})

for (const enabled of [false, true]) test(`unknown streaming respects the protocol decision (${enabled})`, async () => {
  const protocol = fakeProtocol()
  const effective = protocol.effectiveCapabilities
  protocol.effectiveCapabilities = declared => ({ ...effective(declared), streaming: enabled })
  const f = await fixture({ protocols: [protocol] })
  try {
    await f.add({ capabilityDeclarations: capabilities({ streaming: { support: 'unknown' } }) })
    if (!enabled) {
      await assert.rejects(f.open({ modelId: 'model', requirements: { streaming: true } }), code('capability-unsupported'))
      assert.equal(f.vault.reads.length, 0)
      assert.equal(protocol.calls.length, 0)
    }
    const execution = await f.open({ modelId: 'model', ...(enabled ? { requirements: { streaming: true } } : {}) })
    assert.equal(execution.capabilities.streaming, enabled)
    await execution.close()
  } finally { await f.close() }
})

for (const firstSupport of ['supported', 'unsupported']) test(`native restore preserves context when streaming changes from ${firstSupport}`, async () => {
  const f = await fixture()
  try {
    const { model } = await f.add({ capabilityDeclarations: capabilities({ streaming: { support: firstSupport } }) })
    const first = await f.open({ modelId: 'model' })
    f.protocols[0].next(call => call.succeed({ text: 'first answer', signature: 'kept signature' }))
    await exchange(first, input('first')).result
    const report = await first.close(), restore = { ...report.restoreState, records: report.records }
    const history = JSON.stringify(restore)
    const nextSupport = firstSupport === 'supported' ? 'unsupported' : 'supported'
    await f.settings.updateConfiguration(model.id, { capabilities: capabilities({ streaming: { support: nextSupport } }) }, model.revision)
    const second = await f.open({ modelId: 'model', restore })
    assert.equal(second.capabilities.streaming, nextSupport === 'supported')
    await exchange(second, input('second')).result
    assert.deepEqual(f.protocols[0].calls[1].input.request.messages.map(message => message.content), ['first', 'first answer', 'second'])
    assert.equal(f.protocols[0].calls[1].input.request.previousResponse.signature, 'kept signature')
    assert.equal(JSON.stringify(restore), history)
    await second.close()
    for (const changes of [{ tools: false }, { webSearch: true }, { reasoning: { support: 'unsupported' } },
      ...[undefined, null, 'true', {}].map(streaming => ({ streaming }))]) {
      const incompatible = { ...restore, modelSnapshot: { ...restore.modelSnapshot, capabilities: { ...restore.modelSnapshot.capabilities, ...changes } } }
      await assert.rejects(f.open({ modelId: 'model', restore: incompatible }), code('invalid-config'))
    }
  } finally { await f.close() }
})

test('existing unknown configurations keep their history when the protocol enables streaming by default', async () => {
  const legacy = fakeProtocol(), f = await fixture({ protocols: [legacy] })
  try {
    const { model } = await f.add({ capabilityDeclarations: capabilities({ streaming: { support: 'unknown' } }) })
    const first = await f.open({ modelId: 'model' })
    assert.equal(first.capabilities.streaming, false)
    await exchange(first, input('first')).result
    const report = await first.close(), restore = { ...report.restoreState, records: report.records }
    const savedConfiguration = JSON.stringify(f.store.configuration(model.id)), savedHistory = JSON.stringify(restore)
    await f.registrations[0].unregister()
    const upgraded = { ...legacy, effectiveCapabilities: declared => ({ ...legacy.effectiveCapabilities(declared), streaming: declared.streaming.support !== 'unsupported' }) }
    f.registrations.push(f.registry.register(upgraded))
    const second = await f.open({ modelId: 'model', restore, requirements: { streaming: true } })
    await exchange(second, input('second')).result
    assert.equal(second.capabilities.streaming, true)
    assert.deepEqual(legacy.calls[1].input.request.messages.map(message => message.content), ['first', 'answer', 'second'])
    assert.equal(JSON.stringify(f.store.configuration(model.id)), savedConfiguration)
    assert.equal(JSON.stringify(restore), savedHistory)
    await second.close()
  } finally { await f.close() }
})

test('restoring serializable native records retains full context while each execution archives only its increment', async () => {
  const f = await fixture(); try {
    await f.add(); const first = await f.open({ modelId: 'model' }); f.protocols[0].next(call => call.succeed({ text: 'first answer', signature: 'first signature' })); await exchange(first, input('first')).result
    const report = await first.close(), restore = JSON.parse(JSON.stringify({ ...report.restoreState, records: report.records })); const second = await f.open({ modelId: 'model', restore }); await exchange(second, input('second')).result
    assert.deepEqual(f.protocols[0].calls[1].input.request.messages.map(message => message.content), ['first', 'first answer', 'second']); assert.equal(f.protocols[0].calls[1].input.request.previousResponse.signature, 'first signature')
    const next = await second.close(); assert.equal(next.records.length, 2); assert.equal(next.records[0].payload.messages[0].content, 'second')
  } finally { await f.close() }
})

test('restore rejects changed model, native parameters, malformed records and unknown formats without fallback', async () => {
  const f = await fixture(); try {
    const { model } = await f.add(); const execution = await f.open({ modelId: 'model' }); await exchange(execution, input('one')).result; const report = await execution.close(); const restore = { ...report.restoreState, records: report.records }
    for (const changed of [{ ...restore, recordFormatVersion: 99 }, { ...restore, records: restore.records.slice(1) }, { ...restore, modelSnapshot: { ...restore.modelSnapshot, remoteModelId: 'other' } }]) await assert.rejects(f.open({ modelId: 'model', restore: changed }), code('invalid-config'))
    await f.settings.updateConfiguration(model.id, { parameters: params('test', { temperature: 0.7 }) }, model.revision); await assert.rejects(f.open({ modelId: 'model', restore }), code('invalid-config'))
  } finally { await f.close() }
})

test('key rotation and endpoint changes rotate history scope only after durable success', async () => {
  const f = await fixture(); try {
    let { provider } = await f.add({ key: 'first' }); const initial = f.store.connection(provider.id).historyScopeEpoch
    provider = await f.settings.updateConnection(provider.id, { name: 'renamed', timeoutMs: 999 }, provider.revision); assert.equal(f.store.connection(provider.id).historyScopeEpoch, initial)
    f.vault.failWrite = new Error('failure'); await assert.rejects(f.settings.setApiKey(provider.id, 'failed-key', provider.revision), code('credential-unavailable')); assert.equal(f.store.connection(provider.id).historyScopeEpoch, initial); f.vault.failWrite = undefined
    provider = await f.settings.setApiKey(provider.id, 'second', provider.revision); const keyEpoch = f.store.connection(provider.id).historyScopeEpoch; assert.notEqual(keyEpoch, initial)
    provider = await f.settings.updateConnection(provider.id, { baseUrl: 'https://second.invalid/v1' }, provider.revision); assert.notEqual(f.store.connection(provider.id).historyScopeEpoch, keyEpoch)
    const last = f.store.connection(provider.id).historyScopeEpoch; await f.settings.deleteApiKey(provider.id, provider.revision); assert.notEqual(f.store.connection(provider.id).historyScopeEpoch, last)
  } finally { await f.close() }
})

test('configuration/key changes affect new executions and reject old native account-bound restore', async () => {
  const f = await fixture(); try {
    const { provider, model } = await f.add({ key: 'old', defaults: { temperature: 0.1 } }); const execution = await f.open({ modelId: 'model' })
    await f.settings.setApiKey(provider.id, 'new', provider.revision); await f.settings.updateConfiguration(model.id, { parameters: params('test', { temperature: 0.9 }) }, model.revision)
    await exchange(execution, input('old')).result; const report = await execution.close(); assert.equal(f.protocols[0].calls[0].input.credential, 'old'); assert.equal(execution.snapshot.parameters.value.temperature, 0.1)
    await assert.rejects(f.open({ modelId: 'model', restore: { ...report.restoreState, records: report.records } }), code('invalid-config'))
    const next = await f.open({ modelId: 'model' }); await exchange(next, input('new')).result; assert.equal(f.protocols[0].calls[1].input.credential, 'new'); await next.close()
  } finally { await f.close() }
})

test('credential acquisition serializes edits but network does not hold the configuration queue', async () => {
  const f = await fixture(); try {
    const { provider } = await f.add({ key: 'old' }); f.vault.holdReads = true; const opening = f.open({ modelId: 'model' }); await tick()
    const changing = f.settings.setApiKey(provider.id, 'new', provider.revision), state = tracked(changing); await tick(); assert.equal(state.settled, false)
    f.vault.holdReads = false; f.vault.reads[0].release.resolve(); const execution = await opening; await changing
    f.protocols[0].next(); const call = exchange(execution, input('slow')); await tick(); await f.settings.updateConnection(provider.id, { name: 'while network runs' }, 2)
    assert.equal(f.protocols[0].calls[0].input.credential, 'old'); f.protocols[0].calls[0].succeed(); await call.result; await execution.close()
  } finally { await f.close() }
})

test('lease release and revocation prevent admission; old unregister cannot erase a replacement', async () => {
  const f = await fixture(); try {
    await f.add(); const lease = f.registry.acquire('test'); lease.release(); await assert.rejects(f.models.openNative({ modelId: 'model', lease }), code('protocol-unavailable'))
    const held = f.registry.acquire('test'), execution = await f.open({ modelId: 'model' }); const closing = f.registrations[0].unregister(); assert.equal(held.signal.aborted, true); assert.throws(() => execution.prepareExchange(input('late')), code('closed'))
    const replacement = fakeProtocol('test', '2'); f.protocols.push(replacement); const registration = f.registry.register(replacement); await closing
    await f.registrations[0].unregister(); const next = await f.open({ modelId: 'model' }); assert.equal(next.snapshot.protocolVersion, '2'); await next.close(); await registration.unregister()
  } finally { await f.close() }
})

for (const method of ['discoverModels', 'checkConnection']) test(`protocol unregister joins ${method} while another protocol stays available`, async () => {
  const f = await fixture({ protocols: [fakeProtocol('a'), fakeProtocol('b')] }); try {
    await f.add({ protocolId: 'a' }); await f.add({ protocolId: 'b', providerId: 'other', modelId: 'other-model' }); f.protocols[0].next(); const operation = f.settings[method]('provider'); await tick()
    const closing = f.registrations[0].unregister(), state = tracked(closing); await f.protocols[0].operations[0].aborted.promise; assert.equal(state.settled, false)
    const next = await f.open({ modelId: 'other-model' }); await exchange(next, input('unaffected')).result; await next.close(); f.protocols[0].operations[0].succeed(); await assert.rejects(operation, code('cancelled')); await closing
  } finally { await f.close() }
})

test('disabled configuration blocks new opens while captured execution stays usable', async () => {
  const f = await fixture(); try { const { model } = await f.add(); const execution = await f.open({ modelId: 'model' }); await f.settings.updateConfiguration(model.id, { enabled: false }, model.revision); await assert.rejects(f.open({ modelId: 'model' }), code('unavailable')); await exchange(execution, input('existing')).result; await execution.close() } finally { await f.close() }
})

test('optimistic writes preserve immutable histories and orphan Key intents recover', async () => {
  const f = await fixture(); try {
    const { provider, model } = await f.add({ key: 'old' }); await f.settings.updateConfiguration(model.id, { name: 'new' }, model.revision); await assert.rejects(f.settings.updateConfiguration(model.id, { name: 'stale' }, model.revision), code('conflict'))
    assert.deepEqual(f.settings.configurationHistory(model.id).map(value => value.name), ['model', 'new'])
    f.vault.failWrite = new Error('failure'); await assert.rejects(f.settings.setApiKey(provider.id, 'bad', provider.revision), code('credential-unavailable')); assert.deepEqual([...f.vault.secrets.values()], ['old']); assert.equal(f.store.intents().length, 0)
  } finally { await f.close() }
})

test('component teardown joins held credential initialization and close is idempotent', async () => {
  const f = await fixture(); try {
    await f.add({ key: 'key' }); f.vault.holdReads = true; const opening = f.open({ modelId: 'model' }); const rejection = assert.rejects(opening, code('cancelled')); await tick()
    const closing = f.component.dispose(), state = tracked(closing); await f.vault.reads[0].aborted.promise; assert.equal(state.settled, false); f.vault.reads[0].release.resolve(); await Promise.all([rejection, closing])
  } finally { await f.close() }
})

test('restore ignores object key order and cosmetic names but rejects changed effective capabilities', async () => {
  const f = await fixture(); try {
    const { model } = await f.add({ defaults: { temperature: 0.1, max_tokens: 100 } }); const execution = await f.open({ modelId: 'model' }); await exchange(execution, input('one')).result; const report = await execution.close(), restore = { ...report.restoreState, records: report.records };
    const renamed = await f.settings.updateConfiguration(model.id, { name: 'cosmetic', parameters: params('test', { max_tokens: 100, temperature: 0.1 }) }, model.revision);
    const next = await f.open({ modelId: 'model', restore }); await next.close();
    await f.settings.updateConfiguration(model.id, { capabilities: { ...model.capabilities, tools: { support: 'unsupported' } } }, renamed.revision);
    await assert.rejects(f.open({ modelId: 'model', restore }), code('invalid-config'));
  } finally { await f.close() }
});

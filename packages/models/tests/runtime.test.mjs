import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilities, code, complete, fakeProtocol, fixture, memoryStore, memoryVault, tick } from './helpers.mjs'

const input = content => ({ messages: [{ role: 'user', content }] })
const tracked = promise => {
  const state = { settled: false }
  promise.then(() => { state.settled = true }, () => { state.settled = true })
  return state
}

test('two providers execute concurrently by model ID with independent frozen defaults', async () => {
  const protocol = fakeProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    await f.add({ providerId: 'one', modelId: 'quick', key: 'first-secret', defaults: { temperature: 0.1 } })
    await f.add({ providerId: 'two', modelId: 'deep', key: 'second-secret', defaults: { temperature: 0.8 } })
    const [quick, deep] = await Promise.all([f.models.open({ modelId: 'quick' }), f.models.open({ modelId: 'deep' })])
    protocol.next(); protocol.next()
    const a = quick.generate(input('first')), b = deep.generate(input('second'))
    await tick()
    assert.equal(protocol.calls.length, 2)
    assert.deepEqual(protocol.calls.map(call => [call.input.remoteModelId, call.input.options.temperature, call.input.credential]), [
      ['same-remote-model', 0.1, 'first-secret'], ['same-remote-model', 0.8, 'second-secret'],
    ])
    protocol.calls[1].succeed({ result: complete('second finishes first') })
    assert.equal((await b.result).text, 'second finishes first')
    const first = tracked(a.result); await tick(); assert.equal(first.settled, false)
    protocol.calls[0].succeed({ result: complete('first') }); await a.result
    await Promise.all([quick.close(), deep.close()])
  } finally { await f.close() }
})

test('multiple local models of the same remote model apply their own defaults and call overrides', async () => {
  const f = await fixture()
  try {
    const { model } = await f.add({ defaults: { temperature: 0.2, maxOutputTokens: 100 } })
    await f.settings.createModel({ id: 'long', name: 'Long', providerId: model.providerId, remoteModelId: model.remoteModelId, capabilities: model.capabilities, enabled: true, defaults: { temperature: 0.9, maxOutputTokens: 500 } })
    const first = await f.models.open({ modelId: model.id, options: { maxOutputTokens: 50 } })
    const second = await f.models.open({ modelId: 'long' })
    await Promise.all([first.generate(input('short')).result, second.generate(input('long')).result])
    assert.deepEqual(f.protocols[0].calls.map(call => call.input.options), [{ temperature: 0.2, maxOutputTokens: 50 }, { temperature: 0.9, maxOutputTokens: 500 }])
    await Promise.all([first.close(), second.close()])
  } finally { await f.close() }
})

test('undefined call overrides preserve configured defaults instead of silently erasing them', async () => {
  const f = await fixture()
  try {
    await f.add({ defaults: { temperature: 0.2, maxOutputTokens: 100 } })
    const execution = await f.models.open({ modelId: 'model', options: { temperature: undefined, maxOutputTokens: undefined } })
    await execution.generate(input('use configured defaults')).result
    assert.deepEqual(execution.snapshot.options, { temperature: 0.2, maxOutputTokens: 100 })
    assert.deepEqual(f.protocols[0].calls[0].input.options, execution.snapshot.options)
    await execution.close()
  } finally { await f.close() }
})

test('result waits for actual exit and commits continuation and releases ownership before resolving', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add()
    const execution = await f.models.open({ modelId: 'model', history: [{ role: 'system', content: 'instruction' }] })
    protocol.next()
    const call = execution.generate(input('first'))
    await tick()
    const active = protocol.calls[0], final = tracked(call.result), exited = tracked(call.done)
    active.result.resolve({ result: complete('reply'), continuation: { opaque: 'private-context' } })
    await tick()
    assert.equal(final.settled, false); assert.equal(exited.settled, false)
    assert.throws(() => execution.generate(input('overlap')), code('busy'))
    active.done.resolve()
    await call.result
    await execution.generate(input('second')).result
    assert.deepEqual(protocol.calls[1].input.continuation, { opaque: 'private-context' })
    assert.deepEqual(protocol.calls[1].input.newMessages, [{ role: 'user', content: 'second' }])
    assert.deepEqual(protocol.calls[1].input.messages.map(message => [message.role, message.content]), [
      ['system', 'instruction'], ['user', 'first'], ['assistant', 'reply'], ['user', 'second'],
    ])
    assert.doesNotMatch(JSON.stringify(execution.snapshot), /private-context/)
    await execution.close()
  } finally { await f.close() }
})

test('text and tools coexist, and tool results must match outstanding calls before another turn', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add()
    const execution = await f.models.open({ modelId: 'model', requirements: { tools: true }, tools: [
      { name: 'lookup', parameters: { type: 'object' } },
    ] })
    const toolCalls = [{ id: 'call-1', name: 'lookup', arguments: { city: 'Shanghai' } }, { id: 'call-2', name: 'lookup', arguments: { city: 'Beijing' } }]
    protocol.next(call => call.succeed({ result: complete('Looking up both cities.', toolCalls), continuation: { turn: 1 } }))
    const result = await execution.generate(input('weather')).result
    assert.equal(result.text, 'Looking up both cities.'); assert.deepEqual(result.toolCalls, toolCalls)
    assert.throws(() => execution.generate({ messages: [{ role: 'tool', callId: 'unrequested', content: 'fake' }] }), code('invalid-config'))
    assert.throws(() => execution.generate({ messages: [{ role: 'tool', callId: 'call-1', content: 'partial' }] }), code('invalid-config'))
    assert.throws(() => execution.generate({ messages: [{ role: 'tool', callId: 'call-1', content: 'one' }, { role: 'tool', callId: 'call-1', content: 'duplicate' }] }), code('invalid-config'))
    await execution.generate({ messages: toolCalls.map(call => ({ role: 'tool', callId: call.id, content: 'sunny' })) }).result
    assert.equal(protocol.calls.length, 2)
    await execution.close()
  } finally { await f.close() }
})

test('cancellation requests exit, withholds late output and does not commit a candidate', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add(); const execution = await f.models.open({ modelId: 'model' })
    protocol.next(); const call = execution.generate(input('cancel me')); await tick()
    const active = protocol.calls[0], final = tracked(call.result), exited = tracked(call.done)
    active.result.resolve({ result: complete('too late'), continuation: { forbidden: true } })
    call.cancel('caller wants to stop'); await active.aborted.promise; await tick()
    assert.equal(final.settled, false); assert.equal(exited.settled, false)
    active.done.resolve()
    await assert.rejects(call.result, code('cancelled')); await call.done
    await execution.close()
  } finally { await f.close() }
})

test('timeout cancels transport but waits for transport cleanup before rejecting result', { timeout: 3000 }, async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add({ timeoutMs: 20 }); const execution = await f.models.open({ modelId: 'model' })
    protocol.next(); const call = execution.generate(input('slow')); const final = tracked(call.result); await tick()
    await protocol.calls[0].aborted.promise
    assert.equal(final.settled, false)
    protocol.calls[0].succeed()
    await assert.rejects(call.result, code('timeout')); await call.done; await execution.close()
  } finally { await f.close() }
})

test('cleanup failure rejects both handles and permanently closes the execution', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add(); const execution = await f.models.open({ modelId: 'model' })
    protocol.next(); const call = execution.generate(input('cleanup failure')); await tick()
    const resultCheck = assert.rejects(call.result, code('cleanup-failure')), doneCheck = assert.rejects(call.done, code('cleanup-failure'))
    protocol.calls[0].done.reject(new Error('native secret must not be reported'))
    await tick()
    protocol.calls[0].result.resolve({ result: complete('must not return') })
    await Promise.all([resultCheck, doneCheck])
    assert.throws(() => execution.generate(input('again')), code('closed'))
    await assert.rejects(execution.close(), code('cleanup-failure'))
    await assert.rejects(execution.close(), code('cleanup-failure'))
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
  } finally { await assert.rejects(f.close(), code('cleanup-failure')) }
})

test('provider errors preserve previous context and allow an explicit retry after exit', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add(); const execution = await f.models.open({ modelId: 'model' })
    protocol.next(); const call = execution.generate(input('failed turn')); await tick()
    const rejection = assert.rejects(call.result, error => error.code === 'provider-failure' && !String(error).includes('private-token'))
    protocol.calls[0].result.reject(new Error('private-token failed')); protocol.calls[0].done.resolve()
    await rejection; await call.done
    await execution.generate(input('retry')).result
    assert.deepEqual(protocol.calls[1].input.messages, [{ role: 'user', content: 'retry' }])
    await execution.close()
  } finally { await f.close() }
})

for (const status of ['incomplete', 'refused']) {
  test(`${status} output resolves without executable tools and ends the execution chain`, async () => {
    const f = await fixture(), protocol = f.protocols[0]
    try {
      await f.add(); const execution = await f.models.open({ modelId: 'model' })
      protocol.next(call => call.succeed({ result: { status, text: 'partial', toolCalls: [] } }))
      const result = await execution.generate(input('request')).result
      assert.equal(result.status, status); assert.deepEqual(result.toolCalls, [])
      assert.throws(() => execution.generate(input('continue')), code('closed'))
      await execution.close()
    } finally { await f.close() }
  })
}

test('missing subscribers and synchronous or asynchronous observer exceptions do not affect results', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add()
    for (const onEvent of [undefined, () => { throw new Error('observer error') }, async () => { throw new Error('async observer error') }]) {
      const execution = await f.models.open({ modelId: 'model' })
      protocol.next(call => { call.input.onEvent({ type: 'text-delta', delta: 'hello' }); call.input.onEvent({ type: 'text-delta', delta: ' world' }); call.succeed({ result: complete('hello world') }) })
      assert.equal((await execution.generate({ ...input('request'), onEvent }).result).text, 'hello world')
      await tick(); await execution.close()
    }
  } finally { await f.close() }
})

test('unknown and unsupported required capabilities fail before the provider call', async () => {
  const f = await fixture()
  try {
    await f.add({ capabilityDeclarations: capabilities({ tools: { support: 'unknown' }, streaming: { support: 'unsupported' }, reasoning: { support: 'unknown' } }) })
    for (const requirements of [{ tools: true }, { streaming: true }, { reasoning: true }]) {
      await assert.rejects(f.models.open({ modelId: 'model', requirements }), code('capability-unsupported'))
    }
    assert.equal(f.protocols[0].calls.length, 0)
    const model = f.models.get('model')
    assert.equal(model.capabilities.tools.support, 'unknown'); assert.equal(model.effectiveCapabilities.tools, false)
  } finally { await f.close() }
})

test('configuration and submitted messages are copied so caller mutation cannot alter an execution', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add({ defaults: { temperature: 0.2 } })
    const history = [{ role: 'system', content: 'original system instruction' }]
    const execution = await f.models.open({ modelId: 'model', history })
    history[0].content = 'changed after open'
    const request = input('original prompt')
    const call = execution.generate(request)
    request.messages[0].content = 'changed after generate'
    await call.result
    assert.deepEqual(protocol.calls[0].input.messages.map(message => message.content), ['original system instruction', 'original prompt'])
    assert.throws(() => { execution.snapshot.options.temperature = 9 }, TypeError)
    assert.throws(() => { execution.capabilities.tools = false }, TypeError)
    await execution.close()
  } finally { await f.close() }
})

test('protocol results cannot introduce unregistered tools or incomplete tool arguments into execution', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add()
    const execution = await f.models.open({ modelId: 'model', tools: [{ name: 'known_tool', parameters: { type: 'object' } }] })
    for (const result of [
      complete('', [{ id: 'unknown', name: 'unregistered_tool', arguments: {} }]),
      { status: 'incomplete', text: '', toolCalls: [{ id: 'partial', name: 'known_tool', arguments: {} }] },
    ]) {
      protocol.next(call => call.succeed({ result }))
      const call = execution.generate(input('request'))
      await assert.rejects(call.result, code('invalid-response')); await call.done
    }
    await execution.generate(input('explicit retry')).result
    assert.deepEqual(protocol.calls[2].input.messages, [{ role: 'user', content: 'explicit retry' }])
    await execution.close()
  } finally { await f.close() }
})

test('protocol and provider ownership are immutable and unknown parameters are rejected', async () => {
  const f = await fixture()
  try {
    const { provider, model } = await f.add()
    await assert.rejects(f.settings.updateProvider(provider.id, { protocolId: 'other' }, provider.revision), code('invalid-config'))
    await assert.rejects(f.settings.updateModel(model.id, { providerId: 'other' }, model.revision), code('invalid-config'))
    await assert.rejects(f.settings.updateModel(model.id, { defaults: { protocol: { unsupported: true } } }, model.revision), code('invalid-config'))
    assert.equal(f.settings.providerHistory(provider.id).length, 1); assert.equal(f.settings.modelHistory(model.id).length, 1)
  } finally { await f.close() }
})

test('discovery only returns candidates and never edits existing local models', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    const { model } = await f.add()
    protocol.next(operation => operation.succeed([{ remoteModelId: 'new-remote', name: 'Suggested model', suggestedCapabilities: { tools: { support: 'unknown' } } }]))
    const discovered = await f.settings.discoverModels('provider')
    assert.equal(discovered[0].remoteModelId, 'new-remote')
    assert.deepEqual(f.settings.models(), [model]); assert.deepEqual(f.settings.modelHistory(model.id), [model])
  } finally { await f.close() }
})

test('editing model/provider and replacing keys only changes newly opened executions', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    const { provider, model } = await f.add({ key: 'old-private-key', defaults: { temperature: 0.1 } })
    const old = await f.models.open({ modelId: 'model' })
    const updatedModel = await f.settings.updateModel(model.id, { defaults: { temperature: 0.9 } }, model.revision)
    const rotated = await f.settings.setApiKey(provider.id, 'new-private-key', provider.revision)
    const updatedProvider = await f.settings.updateProvider(provider.id, { baseUrl: 'https://new.example.invalid/v1' }, rotated.revision)
    const current = await f.models.open({ modelId: 'model' })
    await old.generate(input('old execution')).result; await current.generate(input('new execution')).result
    assert.deepEqual(protocol.calls.map(call => [call.input.credential, call.input.options.temperature, call.input.provider.baseUrl]), [
      ['old-private-key', 0.1, 'https://example.invalid/v1'], ['new-private-key', 0.9, 'https://new.example.invalid/v1'],
    ])
    assert.equal(old.snapshot.providerRevision, provider.revision); assert.equal(current.snapshot.providerRevision, updatedProvider.revision)
    assert.equal(old.snapshot.modelRevision, model.revision); assert.equal(current.snapshot.modelRevision, updatedModel.revision)
    const publicData = JSON.stringify([f.settings.providers(), f.settings.providerHistory(provider.id), f.settings.models(), f.settings.modelHistory(model.id), f.models.list(), old.snapshot, current.snapshot])
    assert.doesNotMatch(publicData, /old-private-key|new-private-key|credentialRef/)
    await Promise.all([old.close(), current.close()])
  } finally { await f.close() }
})

test('provider serialization holds edits behind local credential acquisition but releases before network calls', async () => {
  const f = await fixture()
  try {
    const { provider } = await f.add({ key: 'old-value' })
    f.vault.holdReads = true
    const opening = f.models.open({ modelId: 'model' }); await tick()
    assert.equal(f.vault.reads.length, 1)
    const editing = f.settings.setApiKey(provider.id, 'new-value', provider.revision), edited = tracked(editing)
    await tick(); assert.equal(edited.settled, false)
    f.vault.reads[0].release.resolve(); const execution = await opening; await editing
    f.protocols[0].next(); const call = execution.generate(input('held network')); await tick()
    const latest = f.settings.providers()[0]
    await f.settings.updateProvider(provider.id, { name: 'still editable' }, latest.revision)
    f.protocols[0].calls[0].succeed(); await call.result
    assert.equal(f.protocols[0].calls[0].input.credential, 'old-value')
    await execution.close()
  } finally { await f.close() }
})

test('disabled configuration does not interrupt existing executions and rejects new execution admission', async () => {
  const f = await fixture()
  try {
    const { model } = await f.add(); const active = await f.models.open({ modelId: model.id })
    await f.settings.updateModel(model.id, { enabled: false }, model.revision)
    assert.equal(f.models.get(model.id).available, false)
    await assert.rejects(f.models.open({ modelId: model.id }), code('unavailable'))
    await active.generate(input('already opened')).result; await active.close()
  } finally { await f.close() }
})

test('unregistering a protocol joins its generation and cannot unregister a replacement or other protocol', async () => {
  const oldProtocol = fakeProtocol('one', '1'), other = fakeProtocol('two', '1'), f = await fixture({ protocols: [oldProtocol, other] })
  try {
    await f.add({ providerId: 'one', modelId: 'one', protocolId: 'one' })
    await f.add({ providerId: 'two', modelId: 'two', protocolId: 'two' })
    const old = await f.models.open({ modelId: 'one' }), untouched = await f.models.open({ modelId: 'two' })
    oldProtocol.next(); const call = old.generate(input('old generation')); await tick()
    const stopped = f.registrations[0].unregister(), stopping = tracked(stopped)
    await oldProtocol.calls[0].aborted.promise; await tick(); assert.equal(stopping.settled, false)
    assert.equal(f.models.get('one').available, false)
    const replacement = fakeProtocol('one', '2'); f.protocols.push(replacement)
    const registration = f.registry.register(replacement)
    const newExecution = await f.models.open({ modelId: 'one' })
    assert.equal(newExecution.snapshot.protocolVersion, '2')
    await untouched.generate(input('other protocol works')).result
    oldProtocol.calls[0].succeed(); await assert.rejects(call.result, code('cancelled')); await stopped
    await f.registrations[0].unregister()
    assert.equal(f.models.get('one').available, true)
    await newExecution.generate(input('replacement works')).result
    assert.throws(() => old.generate(input('old again')), code('closed'))
    await Promise.all([newExecution.close(), untouched.close(), old.close()]); await registration.unregister()
  } finally { await f.close() }
})

test('unregistering joins discovery and connection checks without blocking another protocol', async () => {
  const protocol = fakeProtocol(), other = fakeProtocol('other'), f = await fixture({ protocols: [protocol, other] })
  try {
    await f.add(); await f.add({ providerId: 'other', modelId: 'other', protocolId: 'other' })
    protocol.next(); protocol.next()
    const discovery = f.settings.discoverModels('provider'), check = f.settings.checkConnection('provider')
    const discoveryCheck = assert.rejects(discovery, code('cancelled')), connectionCheck = assert.rejects(check, code('cancelled'))
    await tick(); assert.equal(protocol.operations.length, 2)
    const unregistering = f.registrations[0].unregister(), pending = tracked(unregistering)
    await Promise.all(protocol.operations.map(operation => operation.aborted.promise)); await tick(); assert.equal(pending.settled, false)
    assert.deepEqual(await f.settings.discoverModels('other'), [])
    protocol.release(); await Promise.all([discoveryCheck, connectionCheck, unregistering])
  } finally { await f.close() }
})

for (const method of ['discoverModels', 'checkConnection']) {
  test(`${method} cleanup failure remains visible to protocol and service resource owners`, async () => {
    const f = await fixture(), protocol = f.protocols[0]
    try {
      await f.add(); protocol.next()
      const request = f.settings[method]('provider')
      const rejectedRequest = assert.rejects(request, code('cleanup-failure'))
      await tick()
      const operation = protocol.operations[0]
      const unregistering = f.registrations[0].unregister()
      const rejectedUnregister = assert.rejects(unregistering, code('cleanup-failure'))
      await operation.aborted.promise
      operation.done.reject(new Error('cleanup failed in platform resource'))
      await tick()
      operation.result.resolve(method === 'discoverModels' ? [] : undefined)
      await Promise.all([rejectedRequest, rejectedUnregister])
      await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
    } finally { await assert.rejects(f.close(), code('cleanup-failure')) }
  })
}

test('configuration remains queryable across restart when its protocol is absent', async () => {
  const store = memoryStore(), vault = memoryVault(), original = await fixture({ store, vault })
  await original.add(); await original.close()
  const restarted = await fixture({ store, vault, protocols: [] })
  try {
    assert.equal(restarted.settings.providers().length, 1); assert.equal(restarted.settings.models().length, 1)
    assert.equal(restarted.models.get('model').unavailableReason, 'protocol-unavailable')
    await assert.rejects(restarted.models.open({ modelId: 'model' }), code('protocol-unavailable'))
  } finally { await restarted.close() }
})

test('optimistic revisions reject stale edits and preserve immutable provider and model history', async () => {
  const f = await fixture()
  try {
    const { provider, model } = await f.add()
    const edits = await Promise.allSettled([
      f.settings.updateProvider(provider.id, { name: 'first' }, provider.revision),
      f.settings.updateProvider(provider.id, { name: 'second' }, provider.revision),
    ])
    assert.equal(edits.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(edits.find(item => item.status === 'rejected').reason.code, 'conflict')
    await f.settings.updateModel(model.id, { name: 'new name' }, model.revision)
    await assert.rejects(f.settings.updateModel(model.id, { name: 'stale' }, model.revision), code('conflict'))
    assert.deepEqual(f.settings.providerHistory(provider.id).map(item => item.name), ['provider', 'first'])
    assert.deepEqual(f.settings.modelHistory(model.id).map(item => item.name), ['model', 'new name'])
    assert.equal(f.settings.providerHistory(provider.id)[0].versionId, provider.versionId)
  } finally { await f.close() }
})

test('failed key writes preserve the active reference and orphan journals recover after restart', async () => {
  const store = memoryStore(), vault = memoryVault(), f = await fixture({ store, vault })
  try {
    const { provider } = await f.add({ key: 'working-secret' })
    const oldReference = store.provider(provider.id).credentialRef
    vault.failWrite = new Error('new-secret written but backend failed')
    vault.failDelete = new Error('native secret deletion failed')
    await assert.rejects(f.settings.setApiKey(provider.id, 'uncommitted-secret', provider.revision), error => error.code === 'credential-unavailable' && !String(error).includes('secret'))
    assert.equal(store.provider(provider.id).credentialRef, oldReference)
    assert.equal(store.provider(provider.id).revision, provider.revision)
    assert.equal(vault.secrets.get(oldReference), 'working-secret')
    assert.ok(store.intents().length > 0)
    vault.failWrite = undefined; vault.failDelete = undefined
  } finally { await f.close() }
  const restarted = await fixture({ store, vault })
  try {
    assert.equal(store.intents().length, 0)
    assert.deepEqual([...vault.secrets.values()], ['working-secret'])
    const execution = await restarted.models.open({ modelId: 'model' }); await execution.generate(input('usable')).result
    assert.equal(restarted.protocols[0].calls[0].input.credential, 'working-secret'); await execution.close()
  } finally { await restarted.close() }
})

test('recovery retains a referenced slot and deletes only unreferenced journal entries', async () => {
  const store = memoryStore(), vault = memoryVault(), f = await fixture({ store, vault })
  const { provider } = await f.add({ key: 'current-secret' }), current = store.provider(provider.id).credentialRef
  await f.close()
  vault.secrets.set('orphan-slot', 'old-secret')
  await store.commit({ addIntents: [
    { id: 'referenced', providerId: provider.id, slotId: current, createdAt: new Date().toISOString() },
    { id: 'orphan', providerId: provider.id, slotId: 'orphan-slot', createdAt: new Date().toISOString() },
  ] })
  const restarted = await fixture({ store, vault })
  try {
    assert.equal(vault.secrets.get(current), 'current-secret'); assert.equal(vault.secrets.has('orphan-slot'), false)
    assert.deepEqual(store.intents(), [])
  } finally { await restarted.close() }
})

test('close is idempotent, cancels the active call, and waits until resources really exit', async () => {
  const f = await fixture(), protocol = f.protocols[0]
  try {
    await f.add(); const execution = await f.models.open({ modelId: 'model' })
    protocol.next(); const call = execution.generate(input('working')); await tick()
    const closing = execution.close(), closed = tracked(closing), closingAgain = execution.close()
    await protocol.calls[0].aborted.promise; await tick(); assert.equal(closed.settled, false)
    assert.throws(() => execution.generate(input('after close')), code('closed'))
    protocol.calls[0].succeed(); await assert.rejects(call.result, code('cancelled'))
    await Promise.all([closing, closingAgain, call.done]); await execution.close()
  } finally { await f.close() }
})

test('component teardown joins an execution being opened during a held credential read', async () => {
  const f = await fixture()
  try {
    await f.add({ key: 'private' }); f.vault.holdReads = true
    const opening = f.models.open({ modelId: 'model' }), rejection = assert.rejects(opening, error => ['closed', 'cancelled'].includes(error.code))
    await tick(); assert.equal(f.vault.reads.length, 1)
    const disposing = f.component.dispose(), disposed = tracked(disposing)
    await f.vault.reads[0].aborted.promise; await tick(); assert.equal(disposed.settled, false)
    f.vault.reads[0].release.resolve(); await Promise.all([rejection, disposing])
    await assert.rejects(f.models.open({ modelId: 'model' }), code('closed'))
  } finally { await f.close() }
})

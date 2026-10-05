import assert from 'node:assert/strict'
import test from 'node:test'
import { createResponsesProtocol, createChatCompletionsProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol } from '../dist/index.js'
import { capabilities, code, complete, deferred, fakeProtocol, fixture, tick } from './helpers.mjs'
import { jsonResponse, responseReply, responseText, chatReply } from './native-protocol-helpers.mjs'

const observe = promise => { const state = { settled: false }; promise.then(() => { state.settled = true }, () => { state.settled = true }); return state }
const generationProtocol = (id = 'test') => {
  const protocol = fakeProtocol(id), prepare = protocol.prepare
  protocol.descriptor.responseModes = ['stream', 'complete']
  protocol.prepare = input => ({ ...prepare(input), stream: input.responseMode === 'stream' })
  protocol.textGeneration = {
    createIntent: ({ input, instruction }) => ({ messages: [...(instruction === undefined ? [] : [{ role: 'system', content: instruction }]), { role: 'user', content: input }] }),
    validateParameters() {},
    readText: response => response.text,
  }
  return protocol
}

const cases = [
  { create: createResponsesProtocol, reply: responseReply([{ type: 'reasoning', encrypted_content: 'private' }, responseText('  # Heading\n\nAnswer  ')]),
    verify: (body, input, instruction) => { assert.equal(body.instructions, instruction); assert.deepEqual(body.input, [{ role: 'user', content: input }]); assert.equal(body.store, false) } },
  { create: createChatCompletionsProtocol, reply: chatReply({ role: 'assistant', content: '  # Heading\n\nAnswer  ', reasoning_content: 'private' }),
    verify: (body, input, instruction) => { assert.deepEqual(body.messages, [{ role: 'system', content: instruction }, { role: 'user', content: input }]); assert.equal(Object.hasOwn(body, 'stream_options'), false) } },
  { create: createAnthropicMessagesProtocol, reply: { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private', signature: 'signature' }, { type: 'text', text: '  # Heading\n\nAnswer  ' }] },
    verify: (body, input, instruction) => { assert.deepEqual(body.system, [{ type: 'text', text: instruction }]); assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: input }] }]); assert.equal(body.max_tokens, 4096) } },
  { create: createGeminiInteractionsProtocol, reply: { status: 'completed', steps: [{ type: 'thought', signature: 'private', summary: [] }, { type: 'model_output', content: [{ type: 'text', text: '  # Heading\n\nAnswer  ' }] }] },
    verify: (body, input, instruction) => { assert.equal(body.system_instruction, instruction); assert.deepEqual(body.input, [{ type: 'user_input', content: [{ type: 'text', text: input }] }]); assert.equal(body.store, false) } },
]
for (const item of cases) test(`${item.create().descriptor.id}: generateText sends complete text requests with independent contexts and fixed configuration`, async () => {
  const requests = [], protocol = item.create({ fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return jsonResponse(item.reply) } })
  protocol.release = () => {}
  const f = await fixture({ protocols: [protocol] })
  try {
    const { model } = await f.add({ defaults: protocol.descriptor.id === 'anthropic-messages' ? { maxOutputTokens: 4096 } : {}, capabilityDeclarations: capabilities({ webSearch: { support: 'supported' } }) })
    const saved = JSON.stringify(f.store.configurationHistory(model.id))
    for (const streaming of ['supported', 'unsupported']) {
      if (streaming === 'unsupported') await f.settings.updateConfiguration(model.id, { capabilities: capabilities({ streaming: { support: streaming } }) }, model.revision)
      const current = f.store.configuration(model.id)
      const input = `  ${streaming} input\n`, instruction = '  Exact instruction\n'
      const operation = f.models.generateText({ modelId: model.id, input, instruction })
      assert.deepEqual(await operation.result, { text: '  # Heading\n\nAnswer  ', modelId: model.id, modelRevision: current.revision, protocolId: protocol.descriptor.id })
      await operation.done
      assert.equal(requests.at(-1).stream, false)
      item.verify(requests.at(-1), input, instruction)
      assert.equal(Object.hasOwn(requests.at(-1), 'tools'), false)
      if (streaming === 'supported') assert.equal(JSON.stringify(f.store.configurationHistory(model.id)), saved)
    }
  } finally { await f.close() }
})

test('generateText validates through result, preserves arbitrary text length, and never substitutes a model', async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    await f.add()
    const opened = [], open = f.models.openNative.bind(f.models)
    f.models.openNative = async input => { const execution = await open(input); opened.push(execution); return execution }
    for (const [input, expected] of [
      [undefined, 'invalid-config'], [null, 'invalid-config'], [{ input: 'x' }, 'invalid-config'],
      [{ modelId: 'model', input: ' \n' }, 'invalid-config'], [{ modelId: 'model', input: 'x', instruction: ' \n' }, 'invalid-config'],
      [{ modelId: 'model', input: 3 }, 'invalid-config'], [{ modelId: 'model', input: 'x', signal: {} }, 'invalid-config'],
      [{ modelId: 'model', input: 'x', history: [] }, 'invalid-config'], [{ modelId: 'absent', input: 'x' }, 'not-found'],
    ]) {
      let operation
      assert.doesNotThrow(() => { operation = f.models.generateText(input) })
      await assert.rejects(operation.result, code(expected)); await operation.done
    }
    assert.equal(protocol.calls.length, 0)
    const long = 'x'.repeat(20000), input = { modelId: 'model', instruction: 'Keep spaces  ', input: long }
    const operation = f.models.generateText(input); input.input = 'mutated'; input.instruction = 'mutated'
    await operation.result
    assert.deepEqual(protocol.calls[0].input.request.messages, [{ role: 'system', content: 'Keep spaces  ' }, { role: 'user', content: long }])
    assert.equal(opened[0].signal.aborted, true, 'result follows execution close')
    for (const text of ['', ' \t\n', 3]) {
      protocol.next(call => call.succeed({ text }))
      const invalid = f.models.generateText({ modelId: 'model', input: 'x' })
      await assert.rejects(invalid.result, code('invalid-response')); await invalid.done
    }
  } finally { await f.close() }
})

test('generateText requires both a captured adapter and declared complete mode; registration freezes methods', async () => {
  for (const remove of ['adapter', 'modes', 'complete']) {
    const protocol = generationProtocol()
    if (remove === 'adapter') delete protocol.textGeneration
    if (remove === 'modes') delete protocol.descriptor.responseModes
    if (remove === 'complete') protocol.descriptor.responseModes = ['stream']
    const f = await fixture({ protocols: [protocol] })
    try {
      await f.add({ key: 'private' })
      const operation = f.models.generateText({ modelId: 'model', input: 'x' })
      await assert.rejects(operation.result, code('capability-unsupported')); await operation.done
      assert.equal(f.vault.reads.length, 0); assert.equal(protocol.calls.length, 0)
    } finally { await f.close() }
  }
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    await f.add()
    protocol.descriptor.responseModes.length = 0
    protocol.textGeneration.createIntent = () => { throw new Error('replaced') }
    protocol.textGeneration.readText = () => 'replaced'
    protocol.textGeneration.validateParameters = () => { throw new Error('replaced') }
    assert.equal((await f.models.generateText({ modelId: 'model', input: 'x' }).result).text, 'answer')
  } finally { await f.close() }
})

for (const cancelBy of ['cancel', 'signal', 'unregister', 'root']) test(`generateText ${cancelBy} during credential initialization waits for its actual exit`, async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  let closing
  try {
    await f.add({ key: 'private-key' }); f.vault.holdReads = true
    const controller = new AbortController(), operation = f.models.generateText({ modelId: 'model', input: 'x', signal: controller.signal })
    await tick()
    const state = observe(operation.result), done = observe(operation.done)
    if (cancelBy === 'cancel') { operation.cancel(); operation.cancel() }
    else if (cancelBy === 'signal') { controller.abort(); controller.abort() }
    else if (cancelBy === 'unregister') closing = f.registrations[0].unregister()
    else closing = f.root.fiber.dispose()
    const closingState = closing && observe(closing)
    await f.vault.reads[0].aborted.promise; await tick()
    assert.equal(state.settled, false); assert.equal(done.settled, false)
    if (closingState) assert.equal(closingState.settled, false)
    f.vault.release()
    await assert.rejects(operation.result, code('cancelled')); await operation.done; await closing
    assert.equal(protocol.calls.length, 0)
  } finally { await f.close() }
})

for (const cancelBy of ['cancel', 'signal', 'timeout', 'unregister', 'root']) test(`generateText ${cancelBy} during request waits for done and discards late output`, { timeout: 3000 }, async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  let closing
  try {
    await f.add({ timeoutMs: cancelBy === 'timeout' ? 10 : 10000 }); protocol.next()
    const controller = new AbortController(), operation = f.models.generateText({ modelId: 'model', input: 'x', signal: controller.signal })
    await tick(); const call = protocol.calls[0], state = observe(operation.result), done = observe(operation.done)
    call.result.resolve(complete('late output'))
    if (cancelBy === 'cancel') { operation.cancel(); operation.cancel() }
    else if (cancelBy === 'signal') controller.abort()
    else if (cancelBy === 'unregister') closing = f.registrations[0].unregister()
    else if (cancelBy === 'root') closing = f.root.fiber.dispose()
    const closingState = closing && observe(closing)
    await call.aborted.promise; await tick()
    assert.equal(state.settled, false); assert.equal(done.settled, false)
    if (closingState) assert.equal(closingState.settled, false)
    call.done.resolve()
    await assert.rejects(operation.result, code(cancelBy === 'timeout' ? 'timeout' : 'cancelled')); await operation.done; await closing
    assert.equal(call.cancellations.length, 1)
  } finally { await f.close() }
})

test('generateText ordinary errors await resource exit, while cleanup failure reaches both promises and runtime', async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    await f.add(); protocol.next()
    const operation = f.models.generateText({ modelId: 'model', input: 'x' })
    await tick(); const state = observe(operation.result), call = protocol.calls[0]
    call.result.reject(new Error('private details'))
    await tick(); assert.equal(state.settled, false)
    call.done.resolve()
    await assert.rejects(operation.result, error => error.code === 'provider-failure' && !String(error).includes('private details')); await operation.done
    assert.equal(call.input.signal.aborted, true)
    protocol.next()
    const broken = f.models.generateText({ modelId: 'model', input: 'x' })
    await tick(); const failed = protocol.calls[1]
    failed.done.reject(new Error('private cleanup'))
    await assert.rejects(broken.result, code('cleanup-failure')); await assert.rejects(broken.done, code('cleanup-failure'))
    failed.result.resolve(complete('too late')); await tick()
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
  } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')) }
})

for (const unregister of [false, true]) test(`outer generation remains owned until execution close exits (unregister=${unregister})`, async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] }), entered = deferred(), release = deferred()
  try {
    await f.add()
    const open = f.models.openNative.bind(f.models)
    f.models.openNative = async input => {
      const execution = await open(input)
      return { ...execution, async close() { const report = await execution.close(); entered.resolve(); await release.promise; return report } }
    }
    const operation = f.models.generateText({ modelId: 'model', input: 'x' })
    await entered.promise
    const result = observe(operation.result), done = observe(operation.done)
    const closing = unregister ? f.registrations[0].unregister() : undefined, closed = closing && observe(closing)
    await tick(); assert.equal(result.settled, false); assert.equal(done.settled, false)
    if (closed) assert.equal(closed.settled, false)
    release.resolve()
    if (unregister) await assert.rejects(operation.result, code('cancelled'))
    else assert.equal((await operation.result).text, 'answer')
    await operation.done; await closing
  } finally { release.resolve(); await f.close() }
})

test('execution close failure after a successful response marks outer operation and generation cleanup as failed', async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    await f.add()
    const open = f.models.openNative.bind(f.models)
    f.models.openNative = async input => {
      const execution = await open(input)
      return { ...execution, async close() { await execution.close(); throw new Error('private close failure') } }
    }
    const operation = f.models.generateText({ modelId: 'model', input: 'x' })
    await assert.rejects(operation.result, code('cleanup-failure')); await assert.rejects(operation.done, code('cleanup-failure'))
    await assert.rejects(f.registrations[0].unregister(), code('cleanup-failure'))
  } finally { await f.close().catch(error => assert.equal(error.code, 'cleanup-failure')) }
})

test('generation network holds no configuration queue; captured keys and parameters affect only new executions', async () => {
  const protocol = generationProtocol(), f = await fixture({ protocols: [protocol] })
  try {
    const { provider, model } = await f.add({ key: 'old-key', defaults: { temperature: 0.1 } })
    const saved = JSON.stringify(f.store.configurationHistory(model.id))
    protocol.next()
    const first = f.models.generateText({ modelId: model.id, input: 'first' })
    await tick()
    await f.settings.setApiKey(provider.id, 'new-key', provider.revision)
    await f.settings.updateConfiguration(model.id, { parameters: { protocolId: 'test', formatVersion: 1, value: { temperature: 0.9 } } }, model.revision)
    const second = await f.models.generateText({ modelId: model.id, input: 'second' }).result
    assert.equal(second.modelRevision, 2)
    assert.deepEqual(protocol.calls.map(call => [call.input.credential, call.input.request.parameters.temperature, call.input.request.messages]), [
      ['old-key', 0.1, [{ role: 'user', content: 'first' }]], ['new-key', 0.9, [{ role: 'user', content: 'second' }]],
    ])
    assert.equal(f.store.configurationHistory(model.id).length, JSON.parse(saved).length + 1)
    protocol.calls[0].succeed(); const result = await first.result
    assert.equal(result.modelRevision, 1); assert.deepEqual(Object.keys(result).sort(), ['modelId', 'modelRevision', 'protocolId', 'text'])
  } finally { await f.close() }
})

test('multiple providers generate in parallel and an immediately cancelled call cannot initialize or send', async () => {
  const a = generationProtocol('one'), b = generationProtocol('two'), f = await fixture({ protocols: [a, b] })
  try {
    await f.add({ providerId: 'one', modelId: 'a', protocolId: 'one' }); await f.add({ providerId: 'two', modelId: 'b', protocolId: 'two' })
    const cancelled = f.models.generateText({ modelId: 'a', input: 'x' }); cancelled.cancel()
    await assert.rejects(cancelled.result, code('cancelled')); await cancelled.done
    assert.equal(a.calls.length, 0)
    a.next(); b.next()
    const first = f.models.generateText({ modelId: 'a', input: 'a' }), second = f.models.generateText({ modelId: 'b', input: 'b' })
    await tick(); assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1)
    b.calls[0].succeed(complete('b')); assert.equal((await second.result).text, 'b')
    const pending = observe(first.result); await tick(); assert.equal(pending.settled, false)
    a.calls[0].succeed(complete('a')); assert.equal((await first.result).text, 'a')
  } finally { await f.close() }
})

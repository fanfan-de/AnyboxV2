import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createResponsesProtocol, createChatCompletionsProtocol,
  createAnthropicMessagesProtocol, createGeminiInteractionsProtocol,
} from '../dist/index.js'
import { fakeProtocol, fixture } from './helpers.mjs'
import { chatChunk, chatReply, jsonResponse, nativeSession, responseReply, responseText, sse } from './native-protocol-helpers.mjs'

const answer = 'First line\n  preserved second line  '
const anthropicReply = () => ({ type: 'message', id: 'message-id', role: 'assistant', model: 'remote',
  content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } })
const geminiReply = () => ({ id: 'interaction-id', status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: answer }] }] })
const cases = [
  { id: 'responses', create: createResponsesProtocol, intent: text => ({ input: [{ role: 'user', content: text }] }),
    reply: () => responseReply([responseText(answer)]),
    events: () => [{ type: 'response.output_text.delta', item_id: 'message-id', output_index: 0, content_index: 0, delta: answer },
      { type: 'response.completed', response: responseReply([responseText(answer)]) }],
    readText: reply => reply.output[0].content[0].text, messages: request => request.input },
  { id: 'chat-completions', create: createChatCompletionsProtocol, intent: text => ({ messages: [{ role: 'user', content: text }] }),
    reply: () => chatReply({ role: 'assistant', content: answer }),
    events: () => [chatChunk({ role: 'assistant', content: answer }, 'stop'), '[DONE]'],
    readText: reply => reply.choices[0].message.content, messages: request => request.messages },
  { id: 'anthropic-messages', create: createAnthropicMessagesProtocol,
    intent: text => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }), reply: anthropicReply,
    events: () => [{ type: 'message_start', message: { ...anthropicReply(), content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }], readText: reply => reply.content[0].text, messages: request => request.messages },
  { id: 'gemini-interactions', create: createGeminiInteractionsProtocol,
    intent: text => ({ input: [{ type: 'user_input', content: [{ type: 'text', text }] }] }), reply: geminiReply,
    events: () => [{ event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: answer } },
      { event_type: 'step.stop', index: 0 }, { event_type: 'interaction.completed', interaction: { id: 'interaction-id', status: 'completed' } }],
    readText: reply => reply.steps[0].content[0].text, messages: request => request.input },
]

function capture(entry) {
  const sent = []
  const protocol = entry.create({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body); sent.push(request)
    return request.stream ? sse(entry.events()) : jsonResponse(entry.reply())
  } })
  return { protocol, sent }
}
async function exchange(execution, intent, options, callback) {
  const prepared = execution.prepareExchange(intent, options)
  const operation = prepared.start(callback)
  const reply = await operation.result; await operation.done
  return { prepared, reply }
}

for (const entry of cases) for (const streaming of [false, true]) for (const responseMode of [undefined, 'stream', 'complete']) {
  test(`${entry.id}: effective streaming ${streaming}, ${responseMode ?? 'default'} mode prepares the requested JSON/SSE transport`, async () => {
    const { protocol, sent } = capture(entry)
    const execution = nativeSession(protocol, { streaming })
    const snapshot = structuredClone(execution.snapshot), observed = []
    try {
      assert.deepEqual(protocol.descriptor.responseModes, ['stream', 'complete'])
      assert.equal(protocol.descriptor.version, '2.2.0')
      const intent = entry.intent('Keep this input unchanged')
      if (responseMode === 'stream' && !streaming) {
        assert.throws(() => execution.prepareExchange(intent, { responseMode }), { code: 'capability-unsupported' })
        assert.equal(sent.length, 0)
        const { reply } = await exchange(execution, intent, { responseMode: 'complete' })
        assert.equal(entry.readText(reply.response), answer, 'a mode rejection must leave the execution usable')
      } else {
        // Stream explicitly without an observer, and complete with an observer.
        const callback = responseMode === 'stream' ? undefined : event => observed.push(event)
        const { prepared, reply } = await exchange(execution, intent, responseMode ? { responseMode } : undefined, callback)
        assert.deepEqual(prepared.record.payload, intent)
        assert.deepEqual(prepared.request.intent, intent)
        assert.equal('responseMode' in prepared.record, false)
        assert.equal('responseMode' in prepared.request, false)
        assert.equal(entry.readText(reply.response), answer)
        if (responseMode === 'complete' || !streaming) assert.deepEqual(observed, [])
        else if (responseMode === undefined) assert.ok(observed.length > 0)
      }
      const expectedStream = responseMode === 'stream' ? streaming : responseMode === 'complete' ? false : streaming
      assert.equal(sent.length, 1)
      assert.equal(sent[0].stream, expectedStream)
      if (entry.id === 'chat-completions') assert.deepEqual(sent[0].stream_options, expectedStream ? { include_usage: true } : undefined)
      assert.deepEqual(execution.snapshot, snapshot)
      assert.equal(execution.capabilities.streaming, streaming)
      const report = await execution.close()
      assert.equal(report.cleanup, 'succeeded')
      assert.equal(report.records.length, 2)
      assert.equal('responseMode' in report.restoreState, false)
    } finally { await execution.close() }
  })
}

for (const entry of cases) test(`${entry.id}: one execution switches transport without changing context or capabilities`, async () => {
  const { protocol, sent } = capture(entry), execution = nativeSession(protocol, { streaming: true })
  try {
    for (const [index, responseMode] of ['complete', 'stream', 'complete'].entries()) {
      const { reply } = await exchange(execution, entry.intent(`Turn ${index + 1}`), { responseMode })
      assert.equal(entry.readText(reply.response), answer)
      assert.equal(entry.messages(sent[index]).length, index * 2 + 1)
      assert.equal(sent[index].stream, responseMode === 'stream')
      assert.equal(execution.capabilities.streaming, true)
    }
    const report = await execution.close()
    assert.equal(report.records.length, 6)
    assert.ok(report.records.filter(record => record.kind === 'request').every(record => !('responseMode' in record.payload)))
  } finally { await execution.close() }
})

for (const entry of cases) for (const version of ['2.0.0', '2.1.0', '2.2.0'])
  test(`${entry.id}: ${version} history remains immutable when reopened with another response mode`, async () => {
    const { protocol, sent } = capture(entry)
    const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
    let first, restored
    try {
      await f.add({ protocolId: entry.id, defaults: { maxOutputTokens: 4096 } })
      first = await f.open({ modelId: 'model' })
      await exchange(first, entry.intent('Original input'), { responseMode: 'complete' })
      const report = await first.close(), format = version === '2.0.0' ? 1 : 2
      const restore = { ...report.restoreState, recordFormatVersion: format,
        modelSnapshot: { ...report.restoreState.modelSnapshot, protocolVersion: version },
        records: report.records.map(({ resourceRefs, ...record }) => ({ ...record, recordFormatVersion: format,
          ...(format === 2 && resourceRefs ? { resourceRefs } : {}) })) }
      const before = structuredClone(restore)
      restored = await f.open({ modelId: 'model', restore })
      await exchange(restored, entry.intent('Continued input'), { responseMode: 'stream' })
      assert.equal(sent[0].stream, false)
      assert.equal(sent[1].stream, true)
      assert.equal(entry.messages(sent[1]).length, 3)
      assert.deepEqual(restore, before)
      const exit = await restored.close()
      assert.equal(exit.records.length, 2, 'reopening exposes only the new incremental exchange')
      assert.equal(exit.restoreState.modelSnapshot.protocolVersion, '2.2.0')
      assert.ok(exit.records.every(record => record.recordFormatVersion === 2))
    } finally { await first?.close(); await restored?.close(); await f.close() }
  })

test('old extension protocols keep default exchange but reject every explicit response mode before prepare', async () => {
  const protocol = fakeProtocol(), prepare = protocol.prepare
  let preparations = 0
  protocol.prepare = input => { preparations++; return prepare(input) }
  const execution = nativeSession(protocol)
  try {
    for (const responseMode of ['stream', 'complete'])
      assert.throws(() => execution.prepareExchange({ messages: [] }, { responseMode }), { code: 'capability-unsupported' })
    assert.equal(preparations, 0)
    assert.equal(protocol.calls.length, 0)
    await exchange(execution, { messages: [] })
    assert.equal(preparations, 1)
    assert.equal(protocol.calls.length, 1)
    assert.equal((await execution.close()).records.length, 2)
  } finally { await execution.close() }
})

test('invalid response modes and unsupported declared modes cannot reserve or record an exchange', async () => {
  const protocol = fakeProtocol(), prepare = protocol.prepare
  protocol.descriptor.responseModes = ['complete']
  let preparations = 0
  protocol.prepare = input => { preparations++; assert.equal(input.responseMode, 'complete'); return prepare(input) }
  const execution = nativeSession(protocol, { streaming: true })
  try {
    for (const responseMode of ['', 'automatic', null, 0, {}, []])
      assert.throws(() => execution.prepareExchange({ messages: [] }, { responseMode }), { code: 'invalid-config' })
    assert.throws(() => execution.prepareExchange({ messages: [] }, { responseMode: 'stream' }), { code: 'capability-unsupported' })
    assert.equal(preparations, 0)
    assert.equal(protocol.calls.length, 0)
    await exchange(execution, { messages: [] }, { responseMode: 'complete' })
    assert.equal(preparations, 1)
    assert.equal((await execution.close()).records.length, 2)
  } finally { await execution.close() }
})

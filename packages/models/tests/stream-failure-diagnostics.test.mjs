import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatCompletionsProtocol } from '../dist/protocols/chat-completions.js'
import { createResponsesProtocol } from '../dist/protocols/responses.js'
import { createAnthropicMessagesProtocol } from '../dist/protocols/anthropic-messages.js'
import { createGeminiInteractionsProtocol } from '../dist/protocols/gemini-interactions.js'
import { nativeSession, chatChunk } from './native-protocol-helpers.mjs'
import { deferred, tick } from './helpers.mjs'

const secret = 'private-native-test-key', text = '已经收到🙂', reasoning = `正在分析 ${secret}`
const entries = [
  {
    name: 'Chat', create: createChatCompletionsProtocol,
    intent: { messages: [{ role: 'user', content: 'question' }] },
    events: () => [
      chatChunk({ role: 'assistant', reasoning_content: reasoning }),
      chatChunk({ content: text }),
      chatChunk({ tool_calls: [{ index: 0, id: 'partial-call', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }),
    ],
    check(value) {
      const { message, finish_reason } = value.choices[0]
      assert.equal(message.content, text)
      assert.equal(message.reasoning_content, '正在分析 [redacted]')
      assert.equal(message.tool_calls[0].function.arguments, '{"q":')
      assert.equal(message.tool_calls[0].id, 'partial-call')
      assert.equal(finish_reason, undefined)
    },
  },
  {
    name: 'Responses', create: createResponsesProtocol,
    intent: { input: [{ role: 'user', content: 'question' }] },
    events: () => [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text },
      { type: 'response.output_text.annotation.added', output_index: 1, content_index: 0, annotation: { type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 2 } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'lookup', call_id: 'partial-call', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"q":' },
    ],
    check(value) {
      assert.equal(value.output[0].summary[0].text, '正在分析 [redacted]')
      assert.equal(value.output[1].content[0].text, text)
      assert.equal(value.output[1].content[0].annotations[0].url, 'https://example.test')
      assert.equal(value.output[2].arguments, '{"q":')
      assert.equal(value.output[2].call_id, 'partial-call')
      assert.equal(value.status, undefined)
    },
  },
  {
    name: 'Anthropic', create: createAnthropicMessagesProtocol,
    intent: { messages: [{ role: 'user', content: 'question' }] },
    events: () => [
      { type: 'message_start', message: { type: 'message', id: 'partial-message', role: 'assistant', content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoning } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-so-far' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'partial-call', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    ],
    check(value) {
      assert.equal(value.content[0].thinking, '正在分析 [redacted]')
      assert.equal(value.content[0].signature, 'signature-so-far')
      assert.equal(value.content[1].text, text)
      assert.equal(value.content[2].input, '{"q":')
      assert.equal(value.content[2].id, 'partial-call')
      assert.equal(value.stop_reason, undefined)
    },
  },
  {
    name: 'Gemini', create: createGeminiInteractionsProtocol,
    intent: { input: [{ type: 'user_input', content: [{ type: 'text', text: 'question' }] }] },
    events: () => [
      { event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'signature-so-far' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: reasoning } } },
      { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text } },
      { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'partial-call', name: 'lookup', arguments: {} } },
      { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"q":' } },
    ],
    check(value) {
      assert.equal(value.steps[0].summary[0].text, '正在分析 [redacted]')
      assert.equal(value.steps[0].signature, 'signature-so-far')
      assert.equal(value.steps[1].content[0].text, text)
      assert.equal(value.steps[2].arguments, '{"q":')
      assert.equal(value.steps[2].id, 'partial-call')
      assert.equal(value.status, undefined)
    },
  },
]

for (const entry of entries) for (const ending of ['eof', 'read-error', 'malformed', 'timeout', 'cancel']) {
  test(`${entry.name} ${ending} archives received text, reasoning and unfinished tool data`, { timeout: 3000 }, async () => {
    const received = deferred(), cancelEntered = deferred(), release = deferred(), encoder = new TextEncoder()
    const events = entry.events(), payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    let stream, seen = 0, cancelled = false
    const protocol = entry.create({ fetch: async () => new Response(new ReadableStream({
      start(controller) { stream = controller; controller.enqueue(encoder.encode(payload)) },
      async cancel() { cancelled = true; cancelEntered.resolve(); await release.promise },
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const execution = nativeSession(protocol, { streaming: true, timeoutMs: ending === 'timeout' ? 40 : 10000 })
    const operation = execution.prepareExchange(entry.intent).start(() => { if (++seen === events.length) received.resolve() })
    let settled = false
    void operation.result.then(() => { settled = true }, () => { settled = true })
    try {
      await received.promise
      if (ending === 'eof') stream.close()
      else if (ending === 'read-error') stream.error(new Error(`untrusted error ${secret}`))
      else if (ending === 'malformed') stream.enqueue(encoder.encode('data: invalid JSON\n\n'))
      else if (ending === 'cancel') operation.cancel()
      if (['malformed', 'timeout', 'cancel'].includes(ending)) {
        await cancelEntered.promise
        await tick()
        assert.equal(settled, false, 'failure must still await actual reader cleanup')
      }
      release.resolve()
      const code = ending === 'read-error' ? 'provider-failure' : ending === 'timeout' ? 'timeout' : ending === 'cancel' ? 'cancelled' : 'invalid-response'
      await assert.rejects(operation.result, { code })
      await operation.done
      const report = await execution.close(), record = report.records.at(-1)
      assert.equal(report.cleanup, 'succeeded')
      assert.equal(report.restoreState, undefined)
      assert.deepEqual(report.records.map(record => record.kind), ['request', 'diagnostic'])
      assert.equal(record.exchangeId, report.records[0].exchangeId)
      entry.check(record.payload)
      assert.equal(JSON.stringify(report).includes(secret), false)
      assert.equal(JSON.stringify(report).includes('untrusted error'), false)
      assert.equal(cancelled, ['malformed', 'timeout', 'cancel'].includes(ending))
    } finally { release.resolve(); await execution.close() }
  })
}

test('Responses retains admitted deltas when a compatible stream omits item-start events', async () => {
  const events = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'reasoning' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"q":' },
    { type: 'response.reasoning_summary.future_status', output_index: 0 },
  ]
  const protocol = createResponsesProtocol({ fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')) })
  const execution = nativeSession(protocol, { streaming: true })
  try {
    await assert.rejects(execution.prepareExchange({ input: [{ role: 'user', content: 'question' }] }).start().result, { code: 'invalid-response' })
    const report = await execution.close(), output = report.records.at(-1).payload.output
    assert.equal(output[0].summary[0].text, 'reasoning')
    assert.equal(output[1].content[0].text, text)
    assert.equal(output[2].arguments, '{"q":')
    assert.equal(report.restoreState, undefined)
  } finally { await execution.close() }
})

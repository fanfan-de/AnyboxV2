import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js'
import { createResponsesProtocol } from '../dist/protocols/responses.js'
import { createChatCompletionsProtocol } from '../dist/protocols/chat-completions.js'
import { createAnthropicMessagesProtocol } from '../dist/protocols/anthropic-messages.js'
import { createGeminiInteractionsProtocol } from '../dist/protocols/gemini-interactions.js'
import { deferred, fixture, tick } from './helpers.mjs'
import { chatChunk, chatReply, jsonResponse, responseReply, responseText } from './native-protocol-helpers.mjs'

const partial = 'First chunk', tail = ' and final chunk', answer = partial + tail
const anthropicReply = () => ({ type: 'message', id: 'message-id', role: 'assistant', model: 'remote',
  content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } })
const geminiReply = () => ({ id: 'interaction-id', status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: answer }] }] })
const protocols = [
  { id: 'responses', create: createResponsesProtocol, npm: '@ai-sdk/openai', shape: 'responses',
    intent: { input: [{ role: 'user', content: 'Say hello' }] }, reply: () => responseReply([responseText(answer)]),
    prefix: [{ type: 'response.output_text.delta', item_id: 'message-id', output_index: 0, content_index: 0, delta: partial }],
    next: { type: 'response.output_text.delta', item_id: 'message-id', output_index: 0, content_index: 0, delta: tail },
    suffix: [{ type: 'response.completed', response: responseReply([responseText(answer)]) }],
    deltaText: event => event.type === 'response.output_text.delta' ? event.delta : undefined, text: reply => reply.output[0].content[0].text },
  { id: 'chat-completions', create: createChatCompletionsProtocol, npm: '@ai-sdk/openai-compatible',
    intent: { messages: [{ role: 'user', content: 'Say hello' }] }, reply: () => chatReply({ role: 'assistant', content: answer }),
    prefix: [chatChunk({ role: 'assistant', content: partial })], next: chatChunk({ content: tail }),
    suffix: [chatChunk({}, 'stop'), '[DONE]'],
    deltaText: event => event.choices?.[0]?.delta?.content, text: reply => reply.choices[0].message.content },
  { id: 'anthropic-messages', create: createAnthropicMessagesProtocol, npm: '@ai-sdk/anthropic',
    intent: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }] }, reply: anthropicReply,
    prefix: [{ type: 'message_start', message: { ...anthropicReply(), content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial } }],
    next: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tail } },
    suffix: [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }],
    deltaText: event => event.type === 'content_block_delta' ? event.delta?.text : undefined, text: reply => reply.content[0].text },
  { id: 'gemini-interactions', create: createGeminiInteractionsProtocol, npm: '@ai-sdk/google',
    intent: { input: [{ type: 'user_input', content: [{ type: 'text', text: 'Say hello' }] }] }, reply: geminiReply,
    prefix: [{ event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: partial } }],
    next: { event_type: 'step.delta', index: 0, delta: { type: 'text', text: tail } },
    suffix: [{ event_type: 'step.stop', index: 0 }, { event_type: 'interaction.completed', interaction: { id: 'interaction-id', status: 'completed' } }],
    deltaText: event => event.event_type === 'step.delta' ? event.delta?.text : undefined, text: reply => reply.steps[0].content[0].text },
]

function controlledStream(prefix, suffix) {
  let controller, closed = false
  const encode = values => new TextEncoder().encode(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''))
  return {
    response: new Response(new ReadableStream({
      start(value) { controller = value; controller.enqueue(encode(prefix)) },
      cancel() { closed = true },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    append(value) { if (!closed) controller.enqueue(encode([value])) },
    finish() { if (!closed) { closed = true; controller.enqueue(encode(suffix)); controller.close() } },
  }
}

const cases = [
  { name: 'omitted', support: 'unknown', enabled: true },
  { name: 'supported', streaming: true, support: 'supported', enabled: true },
  { name: 'unsupported', streaming: false, support: 'unsupported', enabled: false },
]

for (const protocolCase of protocols) for (const streamingCase of cases)
  test(`${protocolCase.id}: ${streamingCase.name} source streaming keeps its declaration and ${streamingCase.enabled ? 'delivers live text before completion' : 'uses JSON'}`, { timeout: 5000 }, async () => {
    const requested = deferred(), firstDelta = deferred(), secondDelta = deferred(), observed = []
    let stream, execution, operation, resultSettled = false
    const protocol = protocolCase.create({ fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      requested.resolve(body)
      if (!body.stream) return jsonResponse(protocolCase.reply())
      stream = controlledStream(protocolCase.prefix, protocolCase.suffix)
      return stream.response
    } })
    // The shared fixture calls release() for controlled protocols; the real adapter's
    // resources are joined by the Models component when the root closes.
    const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
    try {
      const source = normalizeModelsDevCatalog({ upstream: { id: 'upstream', name: 'Upstream', npm: protocolCase.npm,
        ...(protocolCase.shape ? { shape: protocolCase.shape } : {}), api: 'https://provider.invalid/v1',
        models: { remote: { id: 'remote', name: 'Remote model', modalities: { input: ['text'], output: ['text'] },
          ...(streamingCase.streaming === undefined ? {} : { streaming: streamingCase.streaming }) } },
      } })
      assert.equal(source.models[0].capabilities.streaming.support, streamingCase.support)
      await f.sourceData.accept(source)
      const provider = f.settings.providers()[0]
      const connection = await f.settings.createConnection({ id: 'account', providerDefinitionId: provider.id, name: 'Account',
        enabled: true, protocolId: protocolCase.id, baseUrl: 'https://provider.invalid/v1', auth: 'api-key',
        apiKey: 'private-streaming-test-key', timeoutMs: 1000 })
      assert.equal(connection.sync.state, 'ready')
      const [baseline] = f.settings.configurations(connection.id)
      assert.ok(baseline, 'saving a keyed connection creates its baseline')
      assert.equal(baseline.baseline, true)
      assert.equal(baseline.capabilities.streaming.support, streamingCase.support)
      assert.equal(f.settings.models()[0].capabilities.streaming.support, streamingCase.support)

      execution = await f.open({ modelId: baseline.id })
      operation = execution.prepareExchange(protocolCase.intent).start(event => {
        observed.push(event)
        if (protocolCase.deltaText(event) === partial) firstDelta.resolve(event)
        if (protocolCase.deltaText(event) === tail) secondDelta.resolve(event)
      })
      void operation.result.then(() => { resultSettled = true }, () => { resultSettled = true })
      assert.equal((await requested.promise).stream, streamingCase.enabled)
      assert.equal(execution.snapshot.capabilities.streaming, streamingCase.enabled)
      assert.equal(f.models.get(baseline.id).effectiveCapabilities.streaming, streamingCase.enabled)

      if (streamingCase.enabled) {
        await Promise.race([firstDelta.promise, operation.result.then(() => assert.fail('result completed before a live text delta'))])
        await tick()
        assert.equal(resultSettled, false, 'the live delta is observable while the provider result is pending')
        stream.append(protocolCase.next)
        await Promise.race([secondDelta.promise, operation.result.then(() => assert.fail('result completed before the next live text delta'))])
        assert.equal(resultSettled, false, 'another text delta is delivered before the terminal response')
        stream.finish()
      }
      const result = await operation.result
      await operation.done
      assert.equal(protocolCase.text(result.response), answer)
      if (!streamingCase.enabled) assert.deepEqual(observed, [], 'explicit unsupported streaming produces no live frames')
    } finally {
      stream?.finish()
      await execution?.close()
      await f.close()
    }
  })

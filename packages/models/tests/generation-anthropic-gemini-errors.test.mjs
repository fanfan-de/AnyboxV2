import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicMessagesProtocol } from '../dist/protocols/anthropic-messages.js'
import { createGeminiInteractionsProtocol } from '../dist/protocols/gemini-interactions.js'
import { capabilities, deferred, fixture, params, tick } from './helpers.mjs'
import { jsonResponse } from './native-protocol-helpers.mjs'

const text = value => ({ type: 'text', text: value })
const anthropicReply = (content, stop_reason = 'end_turn') => ({ type: 'message', role: 'assistant', content, stop_reason })
const geminiReply = (steps, status = 'completed') => ({ status, steps })
const cases = [
  { id: 'anthropic-messages', create: createAnthropicMessagesProtocol, defaults: { maxOutputTokens: 4096 }, replies: [
    [anthropicReply([text('refused')], 'refusal'), 'refused-response'],
    [anthropicReply([text('partial')], 'max_tokens'), 'incomplete-response'],
    [anthropicReply([text('partial')], 'model_context_window_exceeded'), 'incomplete-response'],
    [anthropicReply([text('partial')], 'pause_turn'), 'incomplete-response'],
    [anthropicReply([{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }], 'tool_use'), 'capability-unsupported'],
    [anthropicReply([{ type: 'server_tool_use', id: 'search', name: 'web_search', input: {} }], 'pause_turn'), 'capability-unsupported'],
    [anthropicReply([text(' \t\n')]), 'invalid-response'],
    [anthropicReply([{ type: 'thinking', thinking: 'private', signature: 'private-signature' }]), 'invalid-response'],
    [anthropicReply([{ type: 'unknown-output' }]), 'invalid-response'],
    [anthropicReply([text(5)]), 'invalid-response'],
  ] },
  { id: 'gemini-interactions', create: createGeminiInteractionsProtocol, defaults: {}, replies: [
    [{ status: 'failed', errors: [{ code: 'safety', message: 'private blocked detail' }], steps: [] }, 'refused-response'],
    [{ error: { code: 'content_blocked', message: 'private blocked detail' } }, 'refused-response'],
    [geminiReply([{ type: 'model_output', content: [text('partial')] }], 'incomplete'), 'incomplete-response'],
    [geminiReply([{ type: 'model_output', content: [text('partial')] }], 'budget_exceeded'), 'incomplete-response'],
    [geminiReply([{ type: 'function_call', id: 'call', name: 'lookup', arguments: {} }], 'requires_action'), 'capability-unsupported'],
    [geminiReply([{ type: 'function_call', id: 'call', name: 'lookup', arguments: '{' }], 'incomplete'), 'capability-unsupported'],
    [geminiReply([{ type: 'google_search_call', id: 'search', arguments: {} }]), 'capability-unsupported'],
    [geminiReply([{ type: 'model_output', content: [text(' \t\n')] }]), 'invalid-response'],
    [geminiReply([{ type: 'thought', signature: 'private', summary: [text('private')] }]), 'invalid-response'],
    [geminiReply([{ type: 'unknown-output' }]), 'invalid-response'],
    [geminiReply([{ type: 'model_output', content: [{ type: 'image', data: 'unknown' }] }]), 'invalid-response'],
    [{ error: { code: 'api_error', message: 'private provider detail' } }, 'provider-failure'],
  ] },
]

for (const item of cases) test(`${item.id} generateText returns fixed errors for terminal JSON without retries and keeps done successful`, async () => {
  const replies = [...item.replies], requests = []
  const protocol = item.create({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return jsonResponse(replies.shift()[0])
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    await f.add({ defaults: item.defaults })
    const before = f.store.configurationHistory('model')
    for (const [, code] of item.replies) {
      const operation = f.models.generateText({ modelId: 'model', input: 'question' })
      await assert.rejects(operation.result, error => error.code === code && !String(error).includes('private'))
      await operation.done
    }
    assert.equal(requests.length, item.replies.length)
    assert.ok(requests.every(request => request.stream === false))
    assert.deepEqual(f.store.configurationHistory('model'), before)
  } finally { await f.close() }
})

test('Anthropic generateText allows declared search support and preserves reasoning, while saved search tools fail before transport', async () => {
  const requests = [], protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return jsonResponse(anthropicReply([text('  complete text\n')], 'stop_sequence'))
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    const { model } = await f.add({ defaults: { maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 1024 } },
      capabilityDeclarations: capabilities({ webSearch: { support: 'supported' }, reasoning: { support: 'supported', modes: ['enabled'], budget: { min: 1024, max: 8192 } } }) })
    const parameters = model.parameters.value
    const operation = f.models.generateText({ modelId: model.id, input: 'question' })
    const result = await operation.result
    await operation.done
    assert.deepEqual(result, { text: '  complete text\n', modelId: model.id, modelRevision: model.revision, protocolId: 'anthropic-messages' })
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].thinking, { type: 'enabled', budget_tokens: 1024 })
    assert.equal(requests[0].max_tokens, 4096)
    const updated = await f.settings.updateConfiguration(model.id, { parameters: params('anthropic-messages', { ...parameters, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }) }, model.revision)
    const before = f.store.configurationHistory(model.id)
    const refused = f.models.generateText({ modelId: model.id, input: 'question' })
    await assert.rejects(refused.result, { code: 'capability-unsupported' })
    await refused.done
    assert.equal(requests.length, 1)
    assert.deepEqual(f.settings.configurations().find(value => value.id === model.id).parameters, updated.parameters)
    assert.deepEqual(f.store.configurationHistory(model.id), before)
  } finally { await f.close() }
})

test('Gemini generateText maps explicit blocked HTTP errors and keeps ordinary/malformed errors as provider failures', async () => {
  const responses = [
    [JSON.stringify({ error: { code: 'safety', message: 'private blocked detail' } }), 'refused-response'],
    [JSON.stringify({ error: { code: 'content_blocked', message: 'private blocked detail' } }), 'refused-response'],
    [JSON.stringify({ error: { code: 'invalid_request', message: 'private detail mentioning safety' } }), 'provider-failure'],
    ['malformed private error', 'provider-failure'],
    [JSON.stringify({ error: { code: 400, message: 'private error' } }), 'provider-failure'],
  ], queued = [...responses]
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => new Response(queued.shift()[0], { status: 400 }) })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    await f.add()
    for (const [, code] of responses) {
      const operation = f.models.generateText({ modelId: 'model', input: 'question' })
      await assert.rejects(operation.result, error => error.code === code && !String(error).includes('private'))
      await operation.done
    }
    assert.equal(queued.length, 0)
  } finally { await f.close() }
})

test('Gemini HTTP error-body cancellation waits for actual reader cancellation before settling generation', async () => {
  const reading = deferred(), entered = deferred(), release = deferred()
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"code":"safety"}}')) },
    pull() { reading.resolve() },
    async cancel() { entered.resolve(); await release.promise },
  }), { status: 400 }) })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    await f.add()
    const operation = f.models.generateText({ modelId: 'model', input: 'question' })
    let resultSettled = false, doneSettled = false
    void operation.result.catch(() => { resultSettled = true })
    void operation.done.then(() => { doneSettled = true })
    await reading.promise
    await tick()
    operation.cancel()
    await entered.promise
    await tick()
    assert.equal(resultSettled, false)
    assert.equal(doneSettled, false)
    release.resolve()
    await assert.rejects(operation.result, { code: 'cancelled' })
    await operation.done
  } finally { release.resolve(); await f.close() }
})

test('Gemini unreadable HTTP error cleanup waits and cleanup failure overrides result and done', async () => {
  for (const failed of [false, true]) {
    const entered = deferred(), release = deferred()
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0xff])) },
      async cancel() { entered.resolve(); await release.promise; if (failed) throw new Error('private cleanup detail') },
    }), { status: 400 }) })
    const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
    try {
      await f.add()
      const operation = f.models.generateText({ modelId: 'model', input: 'question' })
      let resultSettled = false, doneSettled = false
      void operation.result.catch(() => { resultSettled = true })
      void operation.done.then(() => { doneSettled = true }, () => { doneSettled = true })
      await entered.promise
      await tick()
      assert.equal(resultSettled, false)
      assert.equal(doneSettled, false)
      release.resolve()
      await assert.rejects(operation.result, { code: failed ? 'cleanup-failure' : 'provider-failure' })
      if (failed) await assert.rejects(operation.done, { code: 'cleanup-failure' })
      else await operation.done
    } finally {
      release.resolve()
      if (failed) await assert.rejects(f.close())
      else await f.close()
    }
  }
})

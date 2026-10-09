import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicMessagesProtocol } from '../dist/protocols/anthropic-messages.js'
import { createGeminiInteractionsProtocol } from '../dist/protocols/gemini-interactions.js'
import { jsonResponse, nativeSession, sse } from './native-protocol-helpers.mjs'

const text = value => ({ type: 'text', text: value })
const anthropicReply = (content = [text('answer')], stop_reason = 'end_turn') => ({ type: 'message', role: 'assistant', content, stop_reason })
const geminiReply = (steps = [{ type: 'model_output', content: [text('answer')] }], status = 'completed') => ({ status, steps })
test('Anthropic generation preserves text blocks and excludes private thinking and redaction', () => {
  const adapter = createAnthropicMessagesProtocol().textGeneration
  const content = [{ type: 'thinking', thinking: 'private', signature: 'private-signature' }, text('  first\n'), { type: 'redacted_thinking', data: 'private-redaction' }, text(' second  ')]
  assert.equal(adapter.readText(anthropicReply(content)), '  first\n\n second  ')
  assert.equal(adapter.readText(anthropicReply([text('done')], 'stop_sequence')), 'done')
  assert.throws(() => adapter.readText(anthropicReply([text('refusal')], 'refusal')), { code: 'refused-response' })
  for (const reason of ['max_tokens', 'model_context_window_exceeded', 'pause_turn'])
    assert.throws(() => adapter.readText(anthropicReply([text('partial')], reason)), { code: 'incomplete-response' })
  for (const block of [{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }, { type: 'server_tool_use', id: 'search', name: 'web_search', input: {} }, { type: 'web_search_tool_result', tool_use_id: 'search', content: [] }])
    assert.throws(() => adapter.readText(anthropicReply([text('answer'), block])), { code: 'capability-unsupported' })
  for (const content of [[], [text(' \n\t')], [{ type: 'unknown' }], [text(5)]])
    assert.throws(() => adapter.readText(anthropicReply(content)), { code: 'invalid-response' })
  const parameters = { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 } }
  adapter.validateParameters(parameters)
  adapter.validateParameters({ ...parameters, tools: [] })
  assert.throws(() => adapter.validateParameters({ ...parameters, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), { code: 'capability-unsupported' })
  assert.deepEqual(parameters, { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 } })
})

test('Gemini generation reads ordered model text, excludes private thought and rejects partial/tool/unknown output', () => {
  const adapter = createGeminiInteractionsProtocol().textGeneration
  const steps = [{ type: 'thought', signature: 'private', summary: [text('private-summary')] }, { type: 'model_output', content: [text('  first\n'), text('middle')] }, { type: 'model_output', content: [text(' second  ')] }]
  assert.equal(adapter.readText(geminiReply(steps)), '  first\n\nmiddle\n second  ')
  for (const status of ['incomplete', 'budget_exceeded'])
    assert.throws(() => adapter.readText(geminiReply(steps, status)), { code: 'incomplete-response' })
  assert.throws(() => adapter.readText(geminiReply([{ type: 'function_call', id: 'call', name: 'lookup', arguments: {} }], 'requires_action')), { code: 'capability-unsupported' })
  assert.throws(() => adapter.readText(geminiReply([{ type: 'google_search_call', id: 'search', arguments: {} }])), { code: 'capability-unsupported' })
  for (const steps of [[], [{ type: 'model_output', content: [text(' \n\t')] }], [{ type: 'unknown' }], [{ type: 'model_output', content: [{ type: 'image', data: 'unknown' }] }]])
    assert.throws(() => adapter.readText(geminiReply(steps)), { code: 'invalid-response' })
  assert.throws(() => adapter.readText({ status: 'failed', errors: [{ code: 'safety', message: 'private refusal' }], steps: [] }), { code: 'refused-response' })
})

test('Gemini native blocked errors are projected to fixed refusal errors for JSON and SSE', async () => {
  for (const streaming of [false, true]) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => streaming
      ? sse([{ event_type: 'error', error: { code: 'content_blocked', message: 'private provider detail' } }])
      : jsonResponse({ status: 'failed', errors: [{ code: 'safety', message: 'private provider detail' }], steps: [] }) })
    const execution = nativeSession(protocol, { streaming })
    await assert.rejects(execution.prepareExchange(protocol.textGeneration.createIntent({ input: 'question' })).start().result,
      error => error.code === 'refused-response' && !String(error).includes('private provider detail'))
    assert.equal((await execution.close()).restoreState, undefined)
  }
})

test('Gemini recognizes only explicit blocked codes and leaves other native failures as provider failures', async () => {
  const values = [
    [{ error: { code: 'safety', message: 'private blocked detail' } }, 'refused-response'],
    [geminiReply([{ type: 'model_output', error: { code: 'content_blocked', message: 'private blocked detail' } }]), 'refused-response'],
    [{ error: { code: 'api_error', message: 'private provider detail' } }, 'provider-failure'],
    [{ status: 'failed', errors: [{ code: 'api_error', message: 'private provider detail' }], steps: [] }, 'provider-failure'],
    [geminiReply([{ type: 'model_output', error: { code: 'api_error', message: 'private provider detail' } }]), 'provider-failure'],
  ]
  for (const [response, code] of values) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => jsonResponse(response) }), execution = nativeSession(protocol)
    await assert.rejects(execution.prepareExchange(protocol.textGeneration.createIntent({ input: 'question' })).start().result,
      error => error.code === code && !String(error).includes('private'))
    await execution.close()
  }
})

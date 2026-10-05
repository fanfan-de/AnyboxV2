import test from 'node:test'
import assert from 'node:assert/strict'
import { createResponsesProtocol } from '../dist/protocols/responses.js'
import { createChatCompletionsProtocol } from '../dist/protocols/chat-completions.js'
import { chatReply, responseReply, responseText } from './native-protocol-helpers.mjs'

test('Responses text generation preserves instruction and input, ignores private reasoning and joins text in native order', () => {
  const adapter = createResponsesProtocol().textGeneration, input = { instruction: '  Keep Markdown\n', input: '\nUser question  ' }
  assert.deepEqual(adapter.createIntent(input), { instructions: input.instruction, input: [{ role: 'user', content: input.input }] })
  assert.deepEqual(adapter.createIntent({ input: 'plain' }), { input: [{ role: 'user', content: 'plain' }] })
  const response = responseReply([
    { type: 'reasoning', encrypted_content: 'private', summary: [{ type: 'summary_text', text: 'private thought' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '  # Heading\n' }, { type: 'output_text', text: 'Paragraph  ' }] },
    responseText('Last'),
  ])
  assert.equal(adapter.readText(response), '  # Heading\n\nParagraph  \nLast')
  adapter.validateParameters({ reasoning: { effort: 'high' } })
  adapter.validateParameters({ tools: [] })
  assert.throws(() => adapter.validateParameters({ tools: [{ type: 'web_search' }] }), { code: 'capability-unsupported' })
})

test('Responses text generation classifies refusal, incomplete, tool, unknown and empty outputs', () => {
  const readText = createResponsesProtocol().textGeneration.readText
  for (const [response, code] of [
    [responseReply([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }]), 'refused-response'],
    [responseReply([responseText('partial')], 'incomplete'), 'incomplete-response'],
    [{ ...responseReply([], 'incomplete'), incomplete_details: { reason: 'content_filter' } }, 'refused-response'],
    [{ ...responseReply([], 'incomplete'), incomplete_details: { reason: 'max_output_tokens' } }, 'incomplete-response'],
    [{ ...responseReply([], 'incomplete'), incomplete_details: { reason: 'max_messages' } }, 'incomplete-response'],
    [{ ...responseReply([], 'incomplete'), incomplete_details: { reason: 'steered' } }, 'incomplete-response'],
    [responseReply([{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial' }] }]), 'incomplete-response'],
    [responseReply([{ type: 'function_call', call_id: 'call', name: 'fn', arguments: '{}' }]), 'capability-unsupported'],
    [responseReply([{ type: 'web_search_call', status: 'completed' }]), 'capability-unsupported'],
    [responseReply([{ type: 'message', role: 'assistant', content: [{ type: 'image', data: 'unknown' }] }]), 'invalid-response'],
    [responseReply([{ type: 'future_output' }]), 'invalid-response'],
    [responseReply([responseText(' \n\t')]), 'invalid-response'],
    [responseReply([{ type: 'reasoning', encrypted_content: 'private' }]), 'invalid-response'],
  ]) assert.throws(() => readText(response), { code })
})

test('Chat text generation maps a system instruction and preserves final content while ignoring private reasoning', () => {
  const adapter = createChatCompletionsProtocol().textGeneration, input = { instruction: '  Exact instruction\n', input: '\nQuestion  ' }
  assert.deepEqual(adapter.createIntent(input), { messages: [{ role: 'system', content: input.instruction }, { role: 'user', content: input.input }] })
  assert.deepEqual(adapter.createIntent({ input: 'plain' }), { messages: [{ role: 'user', content: 'plain' }] })
  assert.equal(adapter.readText(chatReply({ role: 'assistant', content: '  # Heading\n\nAnswer  ', reasoning_content: 'private' })), '  # Heading\n\nAnswer  ')
  adapter.validateParameters({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
})

test('Chat text generation classifies refusal, incomplete, tool and invalid outputs', () => {
  const readText = createChatCompletionsProtocol().textGeneration.readText
  const call = { id: 'call', type: 'function', function: { name: 'fn', arguments: '{}' } }
  for (const [response, code] of [
    [chatReply({ role: 'assistant', content: 'partial', refusal: 'No' }), 'refused-response'],
    [chatReply({ role: 'assistant', content: null }, 'content_filter'), 'refused-response'],
    [chatReply({ role: 'assistant', content: 'partial' }, 'length'), 'incomplete-response'],
    [chatReply({ role: 'assistant', content: null, tool_calls: [call] }, 'tool_calls'), 'capability-unsupported'],
    [chatReply({ role: 'assistant', content: 'answer', tool_calls: [call] }), 'capability-unsupported'],
    [chatReply({ role: 'assistant', content: ' \t\n' }), 'invalid-response'],
    [chatReply({ role: 'assistant', content: null, reasoning_content: 'private' }), 'invalid-response'],
    [chatReply({ role: 'assistant', content: [{ type: 'text', text: 'unknown shape' }] }), 'invalid-response'],
    [{ choices: [] }, 'invalid-response'],
    [{ choices: [chatReply().choices[0], chatReply().choices[0]] }, 'invalid-response'],
  ]) assert.throws(() => readText(response), { code })
})

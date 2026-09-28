import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatCompletionsProtocol } from '../dist/protocols/chat-completions.js'
import { createResponsesProtocol } from '../dist/protocols/responses.js'
import { declared, jsonResponse, sse, nativeSession, run, responseText, responseReply, chatReply, chatChunk } from './native-protocol-helpers.mjs'
import { deferred, tick } from './helpers.mjs'

for (const streaming of [false, true]) test(`Responses preserves complete native reasoning, phases, search annotations and tool IDs (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const sent = [], reasoning = { type: 'reasoning', id: 'reason-id', encrypted_content: 'encrypted', summary: [], future: { kept: true } }, search = { type: 'web_search_call', id: 'search-id', status: 'completed', action: { type: 'search', query: 'topic' } }, text = responseText('answer'); text.content[0].annotations = [{ type: 'url_citation', start_index: 0, end_index: 6, url: 'https://example.test', title: 'Citation' }]
  const output = [reasoning, search, text, { type: 'function_call', id: 'item-id', call_id: 'tool-id', name: 'lookup', arguments: '{"query":"x"}', status: 'completed' }]
  const protocol = createResponsesProtocol({ fetch: async (_url, init) => { sent.push({ ...init, body: JSON.parse(init.body) }); const reply = responseReply(sent.length === 1 ? output : [responseText('done')]); return streaming ? sse([{ type: 'response.output_text.delta', item_id: 'text-id', output_index: 2, delta: 'answer' }, { type: 'response.completed', response: reply }], { newline: '\r\n' }) : jsonResponse(reply) } })
  const execution = nativeSession(protocol, { streaming, parameters: { max_output_tokens: 123, reasoning: { effort: 'high', summary: 'auto' }, tools: [{ type: 'web_search' }] } }), events = []
  const reply = await run(execution, { input: [{ role: 'user', content: 'first' }], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }, events)
  assert.deepEqual(reply.output, output); await run(execution, { input: [{ type: 'function_call_output', call_id: 'tool-id', output: 'result' }] })
  assert.deepEqual(sent[1].body.input.slice(1, 5), output); assert.equal(sent[1].body.input.at(-1).call_id, 'tool-id'); assert.equal(sent[0].body.tools.length, 2); assert.equal(sent[0].body.store, false); assert.equal(sent[0].headers.Authorization, 'Bearer private-native-test-key')
  const archive = await execution.close(), restored = nativeSession(protocol, { streaming, parameters: execution.snapshot.parameters.value, restore: { ...archive.restoreState, records: archive.records } }); await run(restored, { input: [{ role: 'user', content: 'new Run' }] }); assert.equal(sent[2].body.input.length, sent[1].body.input.length + 2); await restored.close()
  if (streaming) assert.equal(events[0].item_id, 'text-id')
})

for (const streaming of [false, true]) test(`Chat keeps native multiple calls, finish reason, unknown fields and tools across restore (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const sent = [], calls = [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":"甲"}' } }, { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":"乙"}' } }]
  const protocol = createChatCompletionsProtocol({ fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); if (!streaming) return jsonResponse(chatReply({ role: 'assistant', content: 'thinking', tool_calls: calls, future_field: { kept: true } }, 'tool_calls')); return sse([chatChunk({ role: 'assistant', content: 'thinking', future_field: { kept: true } }), chatChunk({ tool_calls: calls.map((call, index) => ({ ...call, index })) }, 'tool_calls'), { choices: [], usage: { total_tokens: 42 } }, '[DONE]']) } })
  const execution = nativeSession(protocol, { streaming, parameters: { temperature: 0, max_completion_tokens: 55, reasoning_effort: 'low' } }); const reply = await run(execution, { messages: [{ role: 'system', content: 'instruction' }, { role: 'user', content: 'ask' }] })
  assert.equal(reply.choices[0].finish_reason, 'tool_calls'); assert.deepEqual(reply.choices[0].message.tool_calls, calls); assert.deepEqual(reply.choices[0].message.future_field, { kept: true })
  await run(execution, { messages: calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'done' })) }); assert.equal(sent[1].messages.length, 5); assert.equal(sent[1].messages[2].tool_calls[0].id, 'a'); await execution.close()
})

test('Chat extension policy makes DeepSeek differences explicit without wrapping transport', async () => {
  let sent; const protocol = createChatCompletionsProtocol({ fetch: async (_url, init) => { sent = JSON.parse(init.body); return jsonResponse(chatReply()) } }, { protocolId: 'deepseek-chat-completions', name: 'DeepSeek', maxTokensField: 'max_tokens', disableThinking: true, allowDeveloper: false })
  const execution = nativeSession(protocol, { parameters: { max_tokens: 75 } }); assert.throws(() => execution.prepareExchange({ messages: [{ role: 'developer', content: 'forbidden' }] }), { code: 'invalid-config' })
  await run(execution, { messages: [{ role: 'user', content: 'hello' }] }); assert.equal(sent.max_tokens, 75); assert.deepEqual(sent.thinking, { type: 'disabled' }); assert.equal(sent.max_completion_tokens, undefined); await execution.close()
})

test('parameter validation rejects unimplemented fields and requires explicit server-search support', () => {
  const responses = createResponsesProtocol(), chat = createChatCompletionsProtocol()
  for (const value of [{ maxOutputTokens: 1 }, { model: 'other' }, { tools: [{ type: 'function', name: 'bad' }] }]) assert.throws(() => responses.validateParameters(value, declared))
  assert.throws(() => responses.validateParameters({ tools: [{ type: 'web_search' }] }, { ...declared, webSearch: { support: 'unknown' } }), { code: 'capability-unsupported' })
  assert.throws(() => chat.validateParameters({ reasoning_effort: 'unknown' }, declared)); responses.validateParameters({}, declared); chat.validateParameters({ temperature: 0 }, declared)
})

for (const kind of ['responses', 'chat']) test(`${kind} malformed terminal, unterminated stream and errors stay failures`, async () => {
  const create = kind === 'responses' ? createResponsesProtocol : createChatCompletionsProtocol, intent = kind === 'responses' ? { input: [{ role: 'user', content: 'x' }] } : { messages: [{ role: 'user', content: 'x' }] }
  for (const response of [sse(['[DONE]']), jsonResponse({ error: { message: 'private-native-test-key' } }), new Response('not JSON')]) { const execution = nativeSession(create({ fetch: async () => response }), { streaming: response.headers.get('content-type') !== 'application/json' }); await assert.rejects(run(execution, intent)); await execution.close() }
})

for (const failCleanup of [false, true]) test(`terminal provider result waits for actual stream cleanup (failure=${failCleanup})`, async () => {
  const release = deferred(), entered = deferred(); const execution = nativeSession(createResponsesProtocol({ fetch: async () => sse([{ type: 'response.completed', response: responseReply([responseText('done')]) }], { close: false, cancel: async () => { entered.resolve(); await release.promise; if (failCleanup) throw new Error('private cleanup'); } }) }), { streaming: true })
  const operation = execution.prepareExchange({ input: [{ role: 'user', content: 'x' }] }).start(); await entered.promise; let settled = false; void operation.result.then(() => { settled = true }, () => { settled = true }); await tick(); assert.equal(settled, false); release.resolve()
  if (failCleanup) { await assert.rejects(operation.result, { code: 'cleanup-failure' }); await assert.rejects(operation.done, { code: 'cleanup-failure' }); assert.equal((await execution.close()).cleanup, 'failed') } else { await operation.result; assert.equal((await execution.close()).cleanup, 'succeeded') }
})

test('HTTP errors and fetch exceptions are sanitized and unconsumed bodies cancel', async () => {
  let cancelled = false; const protocol = createResponsesProtocol({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 500 }) }), execution = nativeSession(protocol)
  await assert.rejects(run(execution, { input: [{ role: 'user', content: 'x' }] }), error => error.code === 'provider-failure' && !String(error).includes('private')); assert.equal(cancelled, true); await execution.close()
})

for (const streaming of [false, true]) for (const status of ['failed', 'cancelled']) test(`Responses archives sanitized ${status} diagnostics (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const secret = 'private-native-test-key', output = [responseText(`partial ${secret}`)], response = { ...responseReply(output, status), error: { type: 'server_error', code: 'upstream_failure', message: `provider message echoes ${secret}` }, authorization: secret }
  const terminal = streaming ? sse([{ type: `response.${status}`, response }]) : jsonResponse(response)
  const execution = nativeSession(createResponsesProtocol({ fetch: async () => terminal }), { streaming })
  await assert.rejects(run(execution, { input: [{ role: 'user', content: 'hello' }] }), error => error.code === 'provider-failure' && Object.keys(error).join(',') === 'name,code')
  const report = await execution.close(), diagnostic = report.records.at(-1)
  assert.equal(report.restoreState, undefined); assert.equal(report.cleanup, 'succeeded'); assert.equal(diagnostic.kind, 'diagnostic'); assert.equal(diagnostic.payload.status, status); assert.equal(diagnostic.payload.id, 'response-id'); assert.deepEqual(diagnostic.payload.error, { type: 'server_error', code: 'upstream_failure' }); assert.equal(diagnostic.payload.output[0].content[0].text, 'partial [redacted]')
  assert.equal(JSON.stringify(report).includes(secret), false); assert.equal(JSON.stringify(report).includes('provider message'), false)
})

test('Responses stream failure preserves already-received blocks and waits for reader cancellation', async () => {
  const entered = deferred(), release = deferred()
  const execution = nativeSession(createResponsesProtocol({ fetch: async () => sse([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'partial-message', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '部分内容' },
    { type: 'response.failed', response: { id: 'failed-response', status: 'failed', error: { type: 'server_error', message: 'never archive this' } } },
  ], { close: false, cancel: async () => { entered.resolve(); await release.promise } }) }), { streaming: true })
  const operation = execution.prepareExchange({ input: [{ role: 'user', content: 'hello' }] }).start()
  await entered.promise; let settled = false; void operation.result.catch(() => { settled = true }); await tick(); assert.equal(settled, false)
  release.resolve(); await assert.rejects(operation.result, { code: 'provider-failure' }); await operation.done
  const report = await execution.close(); assert.equal(report.records.at(-1).payload.output[0].content[0].text, '部分内容'); assert.equal(report.restoreState, undefined)
})

test('a later successful exchange cannot make an earlier failed record chain restorable', async () => {
  let count = 0; const execution = nativeSession(createResponsesProtocol({ fetch: async () => jsonResponse(++count === 1 ? responseReply([], 'failed') : responseReply([responseText('success')])) }))
  await assert.rejects(run(execution, { input: [{ role: 'user', content: 'failed question' }] }), { code: 'provider-failure' })
  await run(execution, { input: [{ role: 'user', content: 'new question' }] }); const report = await execution.close()
  assert.equal(report.records.at(-1).kind, 'response'); assert.equal(report.restoreState, undefined)
})

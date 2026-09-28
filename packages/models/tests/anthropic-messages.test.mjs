import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicMessagesProtocol, createAnthropicMessagesProtocolComponent } from '../dist/protocols/anthropic-messages.js'
import { declared, jsonResponse, sse, nativeSession, run } from './native-protocol-helpers.mjs'
import { deferred, tick } from './helpers.mjs'
const text = value => ({ type: 'text', text: value })
const thinking = { type: 'thinking', thinking: 'summary', signature: 'private-signature', future: 'kept' }
const redacted = { type: 'redacted_thinking', data: 'private-redacted' }
const tool = (id = 'native-tool') => ({ type: 'tool_use', id, name: 'lookup', input: { q: 'x' } })
const reply = (content = [text('done')], stop_reason = 'end_turn', usage = { input_tokens: 3, output_tokens: 5 }) => ({ type: 'message', id: 'native-message', role: 'assistant', model: 'remote', content, stop_reason, usage })
const initial = { messages: [{ role: 'user', content: [text('你好')] }], system: [text('instruction')], tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }
const events = content => [{ type: 'message_start', message: reply([], null, { input_tokens: 3, output_tokens: 0 }) }, ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]), { type: 'message_delta', delta: { stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]

for (const streaming of [false, true]) test(`Anthropic preserves ordered native thinking, redaction and tool blocks through restore (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const sent = [], blocks = [thinking, text('before'), redacted, tool(), text('after')]
  const protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => { sent.push({ ...init, body: JSON.parse(init.body) }); return streaming ? sse(events(blocks), { newline: '\r\n' }) : jsonResponse(reply(blocks, 'tool_use')) } })
  const execution = nativeSession(protocol, { streaming, parameters: { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' }, output_config: { effort: 'high' } } }), observed = []
  const response = await run(execution, initial, observed); assert.deepEqual(response.content, blocks); assert.equal(response.stop_reason, 'tool_use'); assert.equal(sent[0].headers['x-api-key'], 'private-native-test-key'); assert.equal(sent[0].headers['anthropic-version'], '2023-06-01'); assert.equal(sent[0].headers.Authorization, undefined)
  const report = await execution.close(), restored = nativeSession(protocol, { streaming, parameters: execution.snapshot.parameters.value, restore: { ...report.restoreState, records: report.records } }); await run(restored, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'result' }] }] })
  assert.deepEqual(sent[1].body.messages[1].content, blocks); assert.equal(sent[1].body.messages.at(-1).content[0].tool_use_id, 'native-tool'); assert.deepEqual(sent[1].body.system, initial.system); await restored.close(); if (streaming) assert.ok(observed.some(event => event.type === 'content_block_start'))
})

test('Anthropic pause_turn retains server-search blocks and repeats the same native tool configuration', async () => {
  const sent = [], search = [{ type: 'server_tool_use', id: 'server-1', name: 'web_search', input: { query: 'topic' } }, { type: 'web_search_tool_result', tool_use_id: 'server-1', content: [{ type: 'web_search_result', title: 'Source', url: 'https://example.test', encrypted_content: 'opaque-source' }] }]
  const protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return jsonResponse(reply(sent.length === 1 ? search : [text('done')], sent.length === 1 ? 'pause_turn' : 'end_turn')) } })
  const execution = nativeSession(protocol, { parameters: { max_tokens: 4096, tools: [{ type: 'web_search_20250305', name: 'web_search' }] } }); const first = await run(execution, initial); assert.equal(first.stop_reason, 'pause_turn')
  await run(execution, { messages: [] }); assert.deepEqual(sent[1].messages.at(-1).content, search); assert.deepEqual(sent[1].tools, sent[0].tools); assert.equal(sent[1].tools.length, 2); const report = await execution.close(); assert.equal(report.records.length, 4)
})

test('Anthropic fragmented deltas assemble native signatures, tool JSON, text and citation annotations', async () => {
  const stream = [
    { type: 'message_start', message: reply([], null) },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"汉字"}' } }, { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, { type: 'message_stop' },
  ]
  const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => sse(stream) }), { streaming: true }); const response = await run(execution, initial)
  assert.equal(response.content[0].signature, 'sig'); assert.equal(response.content[0].thinking, '思考'); assert.deepEqual(response.content[1].input, { q: '汉字' }); assert.equal(response.usage.output_tokens, 9); await execution.close()
})

for (const reason of ['max_tokens', 'model_context_window_exceeded', 'refusal']) test(`Anthropic returns native ${reason} without fabricating a completed result`, async () => {
  const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => jsonResponse(reply([text('partial')], reason)) })); const response = await run(execution, initial); assert.equal(response.stop_reason, reason); assert.equal(response.status, undefined); await execution.close()
})

test('Anthropic validates explicit modes, budget, effort, search declaration and default max_tokens', () => {
  const protocol = createAnthropicMessagesProtocol(); assert.deepEqual(protocol.initialParameters(1000), { max_tokens: 1000 }); assert.throws(() => protocol.validateParameters({}, declared))
  for (const value of [{ max_tokens: 4096, thinking: { type: 'enabled' } }, { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 4096 } }, { max_tokens: 4096, thinking: { type: 'adaptive', budget_tokens: 1024 } }, { max_tokens: 4096, thinking: { display: 'omitted' } }, { max_tokens: 4096, output_config: { effort: 'minimal' } }]) assert.throws(() => protocol.validateParameters(value, declared))
  protocol.validateParameters({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 1 }, declared)
  assert.throws(() => protocol.validateParameters({ max_tokens: 4096, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { ...declared, webSearch: undefined }), { code: 'capability-unsupported' })
})

test('Anthropic changing initial system or tool declarations after history is rejected before a request', async () => {
  let count = 0; const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => { count++; return jsonResponse(reply()) } })); await run(execution, initial)
  assert.throws(() => execution.prepareExchange({ messages: [], system: [text('new instruction')] }), { code: 'invalid-config' }); assert.equal(count, 1); await execution.close()
})

test('Anthropic malformed terminals and incomplete block structure never commit native context', async () => {
  for (const data of [sse([{ type: 'message_start', message: reply([], null) }, { type: 'message_stop' }]), jsonResponse(reply([], 'unknown')), jsonResponse(reply([{ type: 'thinking', thinking: 'missing signature' }]))]) {
    const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => data }), { streaming: data.headers.get('content-type') !== 'application/json' }); await assert.rejects(run(execution, initial)); assert.equal((await execution.close()).restoreState, undefined)
  }
})

test('Anthropic cancellation between terminal output and cleanup preserves diagnostic signatures without success', async () => {
  const release = deferred(), entered = deferred(); const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => sse(events([thinking, text('done')]), { close: false, cancel: async () => { entered.resolve(); await release.promise } }) }), { streaming: true })
  const operation = execution.prepareExchange(initial).start(); await entered.promise; operation.cancel(); let settled = false; void operation.result.catch(() => { settled = true }); await tick(); assert.equal(settled, false); release.resolve(); await assert.rejects(operation.result, { code: 'cancelled' }); const report = await execution.close(); assert.equal(report.restoreState, undefined); assert.equal(report.records.at(-1).payload.content[0].signature, 'private-signature')
})

test('Anthropic discovery follows cursor pages without inventing model capabilities', async () => {
  const urls = [], protocol = createAnthropicMessagesProtocol({ fetch: async url => { urls.push(url); return jsonResponse(urls.length === 1 ? { data: [{ id: 'first', display_name: 'First', capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } } } }], has_more: true, last_id: 'first' } : { data: [{ id: 'second' }], has_more: false }) } })
  const operation = protocol.discover({ provider: { protocolId: 'anthropic-messages', baseUrl: 'https://unit.invalid/v1', auth: 'none' }, signal: new AbortController().signal }); const models = await operation.result; await operation.done; assert.equal(models.length, 2); assert.ok(urls[1].endsWith('after_id=first')); assert.equal(models[1].suggestedCapabilities, undefined)
})

test('Anthropic component registers and awaits generation cleanup through Effect', async () => {
  const { Context } = await import('@nya/core'); const root = new Context(), release = deferred(); let registered
  await root.installComponent({ name: 'registry', apply(ctx) { ctx.provide('models.protocols', { register(protocol) { registered = protocol; return { unregister: () => release.promise } } }) } }); const component = root.installComponent(createAnthropicMessagesProtocolComponent()); await component
  assert.equal(registered.descriptor.id, 'anthropic-messages'); let done = false; const closing = component.dispose().then(() => { done = true }); await tick(); assert.equal(done, false); release.resolve(); await closing; await root.fiber.dispose()
})

for (const streaming of [false, true]) test(`Anthropic archives sanitized provider errors (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const secret = 'private-native-test-key', failure = { type: 'error', error: { type: 'overloaded_error', code: 'busy', message: `provider failure ${secret}`, headers: { 'x-api-key': secret } } }
  const response = streaming ? sse([
    { type: 'message_start', message: reply([], null) },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'partial', signature: 'signature-so-far' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: `visible ${secret}` } }, failure,
  ]) : jsonResponse(failure)
  const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => response }), { streaming })
  await assert.rejects(run(execution, initial), error => error.code === 'provider-failure' && !String(error).includes(secret))
  const report = await execution.close(), diagnostic = report.records.at(-1)
  assert.equal(report.restoreState, undefined); assert.equal(diagnostic.kind, 'diagnostic'); assert.deepEqual(diagnostic.payload.error, { type: 'overloaded_error', code: 'busy' }); assert.equal(JSON.stringify(report).includes(secret), false); assert.equal(JSON.stringify(report).includes('provider failure'), false)
  if (streaming) { assert.equal(diagnostic.payload.id, 'native-message'); assert.equal(diagnostic.payload.content[0].signature, 'signature-so-far'); assert.equal(diagnostic.payload.content[1].text, 'visible [redacted]') }
})

test('Anthropic rejects deltas that do not match their native content block', async () => {
  for (const delta of [{ type: 'signature_delta', signature: 'not-text' }, { type: 'thinking_delta', thinking: 'not-text' }, { type: 'input_json_delta', partial_json: '{}' }]) {
    const execution = nativeSession(createAnthropicMessagesProtocol({ fetch: async () => sse([
      { type: 'message_start', message: reply([], null) }, { type: 'content_block_start', index: 0, content_block: text('') },
      { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ]) }), { streaming: true })
    await assert.rejects(run(execution, initial), { code: 'invalid-response' }); assert.equal((await execution.close()).restoreState, undefined)
  }
})

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicMessagesProtocol, createAnthropicMessagesProtocolComponent } from '../dist/protocols/anthropic-messages.js';
import { createExecution } from '../dist/execution.js';

const declared = {
  tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'supported' },
  reasoning: { support: 'supported', modes: ['disabled', 'adaptive', 'enabled'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], budget: { min: 1024, max: 8192 } },
};
const effective = { tools: true, streaming: true, imageInput: false, reasoning: declared.reasoning };
const tools = [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
function input(overrides = {}) {
  const messages = [{ role: 'user', content: '你好' }];
  return {
    provider: { name: 'Anthropic', enabled: true, protocolId: 'anthropic-messages', baseUrl: 'https://unit.invalid/v1/', auth: 'api-key', timeoutMs: 10_000 },
    credential: 'private-key-never-in-error', signal: new AbortController().signal,
    remoteModelId: 'unit-model', options: { maxOutputTokens: 4096 }, capabilities: effective,
    messages, newMessages: messages, tools, onEvent() {}, ...overrides,
  };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const text = value => ({ type: 'text', text: value });
const thinking = (value = 'thinking summary', signature = 'private-native-signature') => ({ type: 'thinking', thinking: value, signature });
const tool = (id, query) => ({ type: 'tool_use', id, name: 'lookup', input: { query } });
const reply = (content = [text('finished')], stop_reason = 'end_turn', usage = { input_tokens: 3, output_tokens: 5 }) => ({
  id: 'private-native-message-id', type: 'message', role: 'assistant', model: 'unit-model', content, stop_reason, stop_sequence: null, usage,
});
const start = (usage = { input_tokens: 3, output_tokens: 1 }) => ({ type: 'message_start', message: reply([], null, usage) });
const blockStart = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const blockDelta = (index, delta) => ({ type: 'content_block_delta', index, delta });
const blockStop = index => ({ type: 'content_block_stop', index });
const finish = (stop_reason = 'end_turn', output_tokens = 5) => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } });
const stop = { type: 'message_stop' };
function stream(values, { newline = '\n', fragment = 1, close = true, cancel } = {}) {
  const bytes = new TextEncoder().encode(values.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}${newline}${newline}`).join(''));
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.slice(offset, offset + fragment));
      if (close) controller.close();
    },
    ...(cancel ? { cancel } : {}),
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function settle(operation) {
  try { return await operation.result; } finally { await operation.done; }
}
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function execution(protocol, overrides = {}) {
  const base = input(overrides);
  return createExecution({
    protocol, provider: base.provider, credential: base.credential, capabilities: base.capabilities, tools: base.tools,
    history: [], controller: new AbortController(), onRelease() {},
    snapshot: {
      modelId: 'local-model', modelRevision: 1, modelVersionId: 'model-version',
      providerId: 'local-provider', providerRevision: 1, providerVersionId: 'provider-version',
      remoteModelId: base.remoteModelId, protocolId: base.provider.protocolId, protocolVersion: protocol.descriptor.version, options: base.options,
    },
  });
}

test('Anthropic JSON encodes instruction roles, history tool identity, scoped-key headers and native controls', async () => {
  let sent;
  const protocol = createAnthropicMessagesProtocol({ fetch: async (url, init) => {
    sent = { url, ...init, body: JSON.parse(init.body) };
    return json(reply([text('I will look up both.'), tool('private-native-a', '甲'), tool('private-native-b', '乙')], 'tool_use', {
      input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 9,
    }));
  } });
  const history = [
    { role: 'system', content: 'System instruction' }, { role: 'developer', content: 'Developer instruction' },
    { role: 'user', content: 'First' }, { role: 'user', content: 'Second' },
    { role: 'assistant', content: 'Earlier', toolCalls: [{ id: 'public-old', name: 'lookup', arguments: { query: 'old' } }] },
    { role: 'tool', callId: 'public-old', content: 'found' }, { role: 'user', content: 'Continue' },
  ];
  const outcome = await settle(protocol.call(input({
    capabilities: { ...effective, streaming: false }, messages: history,
    options: { maxOutputTokens: 12345, temperature: 1, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 2048, reasoningEffort: 'max', reasoningDisplay: 'summarized' } },
  })));
  assert.equal(sent.url, 'https://unit.invalid/v1/messages');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['x-api-key'], 'private-key-never-in-error');
  assert.equal(sent.headers.Authorization, undefined);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.headers['anthropic-beta'], undefined);
  assert.equal(sent.body.max_tokens, 12345);
  assert.equal(sent.body.temperature, 1);
  assert.deepEqual(sent.body.thinking, { type: 'enabled', budget_tokens: 2048, display: 'summarized' });
  assert.deepEqual(sent.body.output_config, { effort: 'max' });
  assert.deepEqual(sent.body.system, [text('System instruction'), text('Developer instruction')]);
  assert.deepEqual(sent.body.tools, [{ name: 'lookup', description: 'Look up a record', input_schema: tools[0].parameters }]);
  assert.deepEqual(sent.body.messages[0], { role: 'user', content: [text('First'), text('Second')] });
  const oldNative = sent.body.messages[1].content[1].id;
  assert.ok(oldNative.startsWith('toolu_'));
  assert.notEqual(oldNative, 'public-old');
  assert.deepEqual(sent.body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: oldNative, content: 'found' }, text('Continue')] });
  assert.equal(outcome.result.text, 'I will look up both.');
  assert.deepEqual(outcome.result.toolCalls.map(call => call.arguments), [{ query: '甲' }, { query: '乙' }]);
  assert.ok(outcome.result.toolCalls.every(call => uuid(call.id)));
  assert.equal(JSON.stringify(outcome.result).includes('private-native'), false);
  assert.deepEqual(outcome.result.usage, { inputTokens: 12, outputTokens: 9, totalTokens: 21 });
});

test('Anthropic private continuation preserves thinking signatures, redaction, content order and parallel results', async () => {
  const requests = [];
  const original = [thinking(), { type: 'redacted_thinking', data: 'private-redacted-data' }, text('Checking'), tool('private-native-a', '甲'), tool('private-native-b', '乙')];
  const protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return json(requests.length === 1 ? reply(original, 'tool_use') : reply());
  } });
  const events = [];
  const base = input({ capabilities: { ...effective, streaming: false }, onEvent: event => events.push(event) });
  const first = await settle(protocol.call(base));
  const results = first.result.toolCalls.map(call => ({ role: 'tool', callId: call.id, content: `result ${call.arguments.query}` }));
  await settle(protocol.call({ ...base, messages: [...base.messages, { role: 'assistant', content: first.result.text, toolCalls: first.result.toolCalls }, ...results], newMessages: results, continuation: first.continuation }));
  assert.deepEqual(requests[1].messages[1], { role: 'assistant', content: original });
  assert.deepEqual(requests[1].messages[2], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'private-native-a', content: 'result 甲' },
    { type: 'tool_result', tool_use_id: 'private-native-b', content: 'result 乙' },
  ] });
  assert.equal(requests[1].messages.length, 3);
  assert.deepEqual(events, [{ type: 'reasoning-summary-delta', delta: 'thinking summary' }]);
  assert.equal(JSON.stringify(first.result).includes('private'), false);
  assert.equal(JSON.stringify(events).includes('private'), false);
});

test('Anthropic streaming maps fragmented UTF-8, multiple tools and summary events while keeping signatures private', async () => {
  const requests = [];
  const values = [
    start({ input_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 1 }),
    { type: 'ping' }, { type: 'future-observability-event', private: 'ignored' },
    blockStart(0, thinking('', '')),
    blockDelta(0, { type: 'thinking_delta', thinking: '思考' }),
    blockDelta(0, { type: 'signature_delta', signature: 'private-' }),
    blockDelta(0, { type: 'signature_delta', signature: 'signature' }), blockStop(0),
    blockStart(1, { type: 'redacted_thinking', data: 'private-redacted' }), blockStop(1),
    blockStart(2, text('')), blockDelta(2, { type: 'text_delta', text: '查询两个。' }), blockStop(2),
    blockStart(3, { type: 'tool_use', id: 'private-native-a', name: 'lookup', input: {} }),
    blockStart(4, { type: 'tool_use', id: 'private-native-b', name: 'lookup', input: {} }),
    blockDelta(3, { type: 'input_json_delta', partial_json: '{"query":' }),
    blockDelta(4, { type: 'input_json_delta', partial_json: '{"query":"乙"}' }), blockStop(4),
    blockDelta(3, { type: 'input_json_delta', partial_json: '"甲"}' }), blockStop(3),
    { type: 'message_delta', delta: {}, usage: { output_tokens: 7 } }, finish('tool_use', 9), stop,
  ];
  const protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? stream(values, { newline: '\r\n' }) : json(reply());
  } });
  const events = [];
  const base = input({ onEvent: event => events.push(event) });
  const first = await settle(protocol.call(base));
  assert.deepEqual(first.result.usage, { inputTokens: 9, outputTokens: 9, totalTokens: 18 });
  assert.equal(first.result.text, '查询两个。');
  assert.deepEqual(first.result.toolCalls.map(call => call.arguments), [{ query: '甲' }, { query: '乙' }]);
  assert.ok(first.result.toolCalls.every(call => uuid(call.id)));
  assert.deepEqual(events.filter(event => event.type === 'reasoning-summary-delta'), [{ type: 'reasoning-summary-delta', delta: '思考' }]);
  const announced = events.filter(event => event.type === 'tool-call-delta' && event.id);
  assert.deepEqual(announced.map(event => event.id), first.result.toolCalls.map(call => call.id));
  assert.equal(JSON.stringify(events).includes('private'), false);
  const added = first.result.toolCalls.map(call => ({ role: 'tool', callId: call.id, content: 'found' }));
  await settle(protocol.call({ ...base, capabilities: { ...effective, streaming: false }, continuation: first.continuation, newMessages: added }));
  assert.deepEqual(requests[1].messages[1].content.slice(0, 2), [thinking('思考', 'private-signature'), { type: 'redacted_thinking', data: 'private-redacted' }]);
  assert.deepEqual(requests[1].messages[2].content.map(block => block.tool_use_id), ['private-native-a', 'private-native-b']);
});

test('Omitted thinking preserves an empty summary and signature without publishing a reasoning event', async () => {
  const events = [];
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => stream([
    start(), blockStart(0, thinking('', '')), blockDelta(0, { type: 'thinking_delta', thinking: '' }),
    blockDelta(0, { type: 'signature_delta', signature: 'private-signature' }), blockStop(0),
    blockStart(1, text('')), blockDelta(1, { type: 'text_delta', text: 'done' }), blockStop(1), finish(), stop,
  ]) });
  const result = await settle(protocol.call(input({ onEvent: event => events.push(event) })));
  assert.equal(result.result.text, 'done');
  assert.equal(events.some(event => event.type === 'reasoning-summary-delta'), false);
  assert.equal(result.continuation.messages[1].content[0].signature, 'private-signature');
});

test('Anthropic incomplete and refused results discard partial executable tool arguments and continuation', async () => {
  for (const [reason, status] of [['max_tokens', 'incomplete'], ['model_context_window_exceeded', 'incomplete'], ['pause_turn', 'incomplete'], ['refusal', 'refused']]) {
    const protocol = createAnthropicMessagesProtocol({ fetch: async () => stream([
      start(), blockStart(0, text('')), blockDelta(0, { type: 'text_delta', text: 'partial' }), blockStop(0),
      blockStart(1, { type: 'tool_use', id: 'private-native-a', name: 'lookup', input: {} }),
      blockDelta(1, { type: 'input_json_delta', partial_json: '{' }), blockStop(1), finish(reason), stop,
    ]) });
    const output = await settle(protocol.call(input()));
    assert.deepEqual(output.result, { status, text: 'partial', toolCalls: [], usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });
    assert.equal(output.continuation, undefined);
  }
});

test('Anthropic JSON maps normal endings and refuses policy stop details', async () => {
  for (const reason of ['end_turn', 'stop_sequence']) {
    const protocol = createAnthropicMessagesProtocol({ fetch: async () => json(reply([text('done')], reason)) });
    assert.equal((await settle(protocol.call(input({ capabilities: { ...effective, streaming: false } })))).result.status, 'completed');
  }
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => json({ ...reply(), stop_details: { type: 'refusal', explanation: 'declined' } }) });
  assert.equal((await settle(protocol.call(input({ capabilities: { ...effective, streaming: false } })))).result.status, 'refused');
});

test('Anthropic rejects malformed JSON responses, unknown terminals and incomplete stream structure', async () => {
  const badJson = [
    reply([], null), reply([], 'unknown-stop'), reply([tool('same', 'x'), tool('same', 'y')], 'tool_use'),
    reply([{ type: 'tool_use', id: 'a', name: 'lookup', input: [] }], 'tool_use'), reply([], 'tool_use'),
    reply([tool('a', 'x')], 'end_turn'), reply([thinking('summary', '')]),
    reply([{ type: 'server_tool_use', id: 'srv-a', name: 'search', input: {} }], 'tool_use'),
    reply([text('a')], 'end_turn', { input_tokens: -1, output_tokens: 2 }),
  ];
  for (const value of badJson) {
    const protocol = createAnthropicMessagesProtocol({ fetch: async () => json(value) });
    await assert.rejects(settle(protocol.call(input({ capabilities: { ...effective, streaming: false } }))), { code: 'invalid-response' });
  }
  const badStreams = [
    [start(), finish()], [finish(), stop], [start(), start(), finish(), stop],
    [start(), blockStart(0, text('')), finish(), stop],
    [start(), blockDelta(0, { type: 'text_delta', text: 'x' }), finish(), stop],
    [start(), blockStart(1, text('')), blockStop(1), finish(), stop],
    [start(), blockStart(0, text('')), blockStop(0), blockStop(0), finish(), stop],
    [start(), blockStart(0, text('')), blockDelta(0, { type: 'signature_delta', signature: 'secret' }), blockStop(0), finish(), stop],
    [start(), blockStart(0, { type: 'tool_use', id: 'a', name: 'lookup', input: {} }), blockDelta(0, { type: 'input_json_delta', partial_json: '{' }), blockStop(0), finish('tool_use'), stop],
  ];
  for (const value of badStreams) {
    const protocol = createAnthropicMessagesProtocol({ fetch: async () => stream(value) });
    await assert.rejects(settle(protocol.call(input())), { code: 'invalid-response' });
  }
  const error = createAnthropicMessagesProtocol({ fetch: async () => stream([{ type: 'error', error: { type: 'overloaded_error', message: 'private-key-never-in-error' } }]) });
  await assert.rejects(settle(error.call(input())), failure => failure.code === 'provider-failure' && !String(failure).includes('private-key'));
});

test('Anthropic validates declared modes, budgets and native effort without inventing model restrictions', () => {
  const protocol = createAnthropicMessagesProtocol();
  assert.equal(protocol.descriptor.modelFields.find(field => field.key === 'maxOutputTokens').defaultValue, 4096);
  protocol.validateOptions({ maxOutputTokens: 4096 }, declared);
  protocol.validateOptions({ maxOutputTokens: 4096, protocol: { reasoningMode: 'adaptive', reasoningEffort: 'xhigh', reasoningDisplay: 'summarized' } }, declared);
  protocol.validateOptions({ maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 2048 } }, declared);
  for (const options of [
    {}, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: 4096, temperature: 2 },
    { maxOutputTokens: 4096, protocol: { unknown: true } },
    { maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled' } },
    { maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 1023 } },
    { maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 4096 } },
    { maxOutputTokens: 4096, protocol: { reasoningMode: 'adaptive', reasoningBudgetTokens: 2048 } },
    { maxOutputTokens: 4096, temperature: 0.2, protocol: { reasoningMode: 'adaptive' } },
    { maxOutputTokens: 4096, protocol: { reasoningEffort: 'none' } },
    { maxOutputTokens: 4096, protocol: { reasoningDisplay: 'summarized' } },
    { maxOutputTokens: 4096, protocol: { reasoningMode: 'disabled', reasoningDisplay: 'omitted' } },
  ]) assert.throws(() => protocol.validateOptions(options, declared), { code: 'invalid-config' });
  assert.throws(() => protocol.validateOptions({ maxOutputTokens: 4096, protocol: { reasoningMode: 'adaptive' } }, { ...declared, reasoning: { support: 'supported' } }), { code: 'capability-unsupported' });
  assert.throws(() => protocol.validateOptions({ maxOutputTokens: 4096, protocol: { reasoningEffort: 'max' } }, { ...declared, reasoning: { support: 'unknown' } }), { code: 'capability-unsupported' });
  assert.throws(() => protocol.validateOptions({ maxOutputTokens: 4096, protocol: { reasoningMode: 'enabled', reasoningBudgetTokens: 3000 } }, {
    ...declared, reasoning: { ...declared.reasoning, budget: { min: 1024, max: 2048 } },
  }), { code: 'capability-unsupported' });
  assert.equal(protocol.effectiveCapabilities(declared, { maxOutputTokens: 4096, protocol: { reasoningMode: 'disabled' } }).reasoning.support, 'unsupported');
  assert.equal(protocol.effectiveCapabilities(declared, { maxOutputTokens: 4096 }).imageInput, false);
});

test('Anthropic refuses mid-conversation instructions instead of moving their authority into the initial system prompt', () => {
  let requests = 0;
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => { requests++; return json(reply()); } });
  assert.throws(() => protocol.call(input({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'later' }] })), { code: 'invalid-config' });
  assert.throws(() => protocol.call(input({ messages: [{ role: 'user', content: 'a' }, { role: 'developer', content: 'later' }] })), { code: 'invalid-config' });
  assert.equal(requests, 0);
});

test('Anthropic discovery follows read-only cursor pages and maps only native capability evidence', async () => {
  const requests = [];
  const protocol = createAnthropicMessagesProtocol({ fetch: async (url, init) => {
    requests.push({ url, ...init });
    if (url.endsWith('models?limit=1')) return json({ data: [{ id: 'a', display_name: 'Alpha' }], has_more: true, last_id: 'a' });
    return json(requests.length === 1 ? {
      data: [{ id: 'a', display_name: 'Alpha', capabilities: {
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
        effort: { supported: true, low: { supported: true }, max: { supported: true } }, image_input: { supported: true },
      } }], has_more: true, last_id: 'a',
    } : { data: [{ id: 'b', display_name: 'Beta', capabilities: null }], has_more: false, last_id: 'b' });
  } });
  assert.deepEqual(await settle(protocol.discover(input())), [
    { remoteModelId: 'a', name: 'Alpha', suggestedCapabilities: { reasoning: { support: 'supported', modes: ['adaptive'], efforts: ['low', 'max'] }, imageInput: { support: 'supported' } } },
    { remoteModelId: 'b', name: 'Beta' },
  ]);
  await settle(protocol.check(input()));
  assert.deepEqual(requests.map(item => item.url), ['https://unit.invalid/v1/models?limit=1000', 'https://unit.invalid/v1/models?limit=1000&after_id=a', 'https://unit.invalid/v1/models?limit=1']);
  assert.ok(requests.every(item => item.method === 'GET' && item.body === undefined && item.headers['anthropic-version'] === '2023-06-01' && item.headers['x-api-key'] === 'private-key-never-in-error' && item.headers.Authorization === undefined));
});

test('Anthropic discovery rejects invalid pagination, repeated IDs and native capability types', async () => {
  for (const pages of [
    [{ data: [{ id: 'a' }], has_more: true }], [{ data: [], has_more: true, last_id: 'a' }],
    [{ data: [{ id: 'a' }], has_more: true, last_id: 'wrong' }],
    [{ data: [{ id: 'a' }], has_more: true, last_id: 'a' }, { data: [{ id: 'a' }], has_more: false }],
    [{ data: [{ id: 'a' }], has_more: true, last_id: 'a' }, { data: [{ id: 'a' }], has_more: true, last_id: 'a' }],
    [{ data: [{ id: 'a', capabilities: { thinking: { supported: 'yes' } } }], has_more: false }],
  ]) {
    let index = 0;
    const protocol = createAnthropicMessagesProtocol({ fetch: async () => json(pages[Math.min(index++, pages.length - 1)]) });
    await assert.rejects(settle(protocol.discover(input())), { code: 'invalid-response' });
  }
});

test('Anthropic cancellation during discovery joins the current page reader before done', async () => {
  let releaseCancel;
  const gate = new Promise(resolve => { releaseCancel = resolve; });
  let ready;
  const prepared = new Promise(resolve => { ready = resolve; });
  let count = 0;
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => {
    count++;
    if (count === 1) return json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' });
    ready();
    return new Response(new ReadableStream({ cancel() { return gate; } }));
  } });
  const operation = protocol.discover(input());
  await prepared; await Promise.resolve();
  operation.cancel();
  let done = false; void operation.done.then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(done, false);
  releaseCancel();
  await assert.rejects(operation.result, { code: 'cancelled' });
  await operation.done;
  assert.equal(count, 2);
});

test('Anthropic terminal protocol output does not publish an execution result before actual stream cleanup', async () => {
  let releaseCancel;
  const gate = new Promise(resolve => { releaseCancel = resolve; });
  let cancelled;
  const cancelling = new Promise(resolve => { cancelled = resolve; });
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => stream([
    start(), blockStart(0, text('')), blockDelta(0, { type: 'text_delta', text: 'done' }), blockStop(0), finish(), stop,
  ], { close: false, cancel() { cancelled(); return gate; } }) });
  const model = execution(protocol);
  const call = model.generate({ messages: [{ role: 'user', content: 'go' }] });
  let resultSettled = false; void call.result.then(() => { resultSettled = true; });
  await cancelling; await Promise.resolve();
  assert.equal(resultSettled, false);
  releaseCancel();
  assert.equal((await call.result).text, 'done');
  await call.done; await model.close();
});

test('Anthropic failed terminal cleanup cannot commit a successful execution or native continuation', async () => {
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => stream([
    start(), blockStart(0, text('')), blockDelta(0, { type: 'text_delta', text: 'done' }), blockStop(0), finish(), stop,
  ], { close: false, cancel() { throw new Error('private-key-never-in-error'); } }) });
  const model = execution(protocol);
  const call = model.generate({ messages: [{ role: 'user', content: 'go' }] });
  await assert.rejects(call.result, failure => failure.code === 'cleanup-failure' && !String(failure).includes('private-key'));
  await assert.rejects(call.done, { code: 'cleanup-failure' });
  assert.throws(() => model.generate({ messages: [{ role: 'user', content: 'retry' }] }), { code: 'closed' });
  await assert.rejects(model.close(), { code: 'cleanup-failure' });
});

test('Anthropic cancellation between terminal output and cleanup discards candidate thinking and tool identities', async () => {
  let releaseCancel;
  const gate = new Promise(resolve => { releaseCancel = resolve; });
  let cancelled;
  const cancelling = new Promise(resolve => { cancelled = resolve; });
  const requests = [];
  const protocol = createAnthropicMessagesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return stream([
      start(), blockStart(0, thinking('', '')), blockDelta(0, { type: 'thinking_delta', thinking: 'candidate summary' }),
      blockDelta(0, { type: 'signature_delta', signature: 'private-candidate-signature' }), blockStop(0),
      blockStart(1, { type: 'tool_use', id: 'private-candidate-tool', name: 'lookup', input: {} }),
      blockDelta(1, { type: 'input_json_delta', partial_json: '{"query":"candidate"}' }), blockStop(1), finish('tool_use'), stop,
    ], { close: false, cancel() { cancelled(); return gate; } });
    return stream([start(), blockStart(0, text('')), blockDelta(0, { type: 'text_delta', text: 'retry completed' }), blockStop(0), finish(), stop]);
  } });
  const model = execution(protocol);
  const first = model.generate({ messages: [{ role: 'user', content: 'first' }] });
  await cancelling;
  first.cancel();
  releaseCancel();
  await assert.rejects(first.result, { code: 'cancelled' });
  await first.done;
  assert.equal((await model.generate({ messages: [{ role: 'user', content: 'retry' }] }).result).text, 'retry completed');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: [text('retry')] }]);
  assert.equal(JSON.stringify(requests[1]).includes('private-candidate'), false);
  await model.close();
});

test('Anthropic cancellation waits for actual reader cancellation and suppresses later events', async () => {
  let releaseCancel;
  const gate = new Promise(resolve => { releaseCancel = resolve; });
  let ready;
  const prepared = new Promise(resolve => { ready = resolve; });
  const events = [];
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => {
    ready();
    return new Response(new ReadableStream({ cancel() { return gate; } }));
  } });
  const model = execution(protocol);
  const call = model.generate({ messages: [{ role: 'user', content: 'go' }], onEvent: event => events.push(event) });
  await prepared; await Promise.resolve();
  call.cancel();
  let done = false; void call.done.then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(done, false);
  releaseCancel();
  await assert.rejects(call.result, { code: 'cancelled' });
  await call.done;
  assert.deepEqual(events, []);
  await model.close();
});

test('Anthropic provider failures are sanitized and unconsumed bodies are cancelled', async () => {
  let cancelled = false;
  const protocol = createAnthropicMessagesProtocol({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }) });
  await assert.rejects(settle(protocol.call(input())), { code: 'provider-failure' });
  assert.equal(cancelled, true);
  const broken = createAnthropicMessagesProtocol({ fetch: async () => { throw new Error('private-key-never-in-error'); } });
  await assert.rejects(settle(broken.call(input())), failure => failure.code === 'provider-failure' && !String(failure).includes('private-key'));
});

test('Anthropic Nya component registers from its dependency snapshot and joins unregistration', async () => {
  const effects = [];
  let registered;
  let unregistered = false;
  const component = createAnthropicMessagesProtocolComponent();
  component.apply({ effect: effect => effects.push(effect()) }, undefined, { 'models.protocols': {
    register(protocol) { registered = protocol; return { unregister: async () => { unregistered = true; } }; },
  } });
  assert.equal(registered.descriptor.id, 'anthropic-messages');
  assert.deepEqual(component.inject, ['models.protocols']);
  await effects[0]();
  assert.equal(unregistered, true);
});

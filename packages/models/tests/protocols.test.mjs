import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatCompletionsProtocol, createChatCompletionsProtocolComponent } from '../dist/protocols/chat-completions.js';
import { createResponsesProtocol, createResponsesProtocolComponent } from '../dist/protocols/responses.js';

const declared = {
  tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'supported' },
  reasoning: { support: 'supported', efforts: ['none', 'low', 'high'] },
};
const effective = { tools: true, streaming: true, imageInput: false, reasoning: { support: 'supported', efforts: ['none', 'low', 'high'] } };
const tools = [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
function input(protocolId, overrides = {}) {
  const messages = [{ role: 'user', content: '你好' }];
  return {
    provider: { name: 'test', enabled: true, protocolId, baseUrl: 'https://unit.invalid/v1/', auth: 'api-key', timeoutMs: 10_000 },
    credential: 'private-key-never-in-error', signal: new AbortController().signal,
    remoteModelId: 'unit-model', options: {}, capabilities: effective, messages, newMessages: messages,
    tools, onEvent() {}, ...overrides,
  };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function stream(values, { newline = '\n', fragment = 1 } = {}) {
  const data = values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`).join('');
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.slice(offset, offset + fragment));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function settle(operation) {
  try { return await operation.result; } finally { await operation.done; }
}
const chatReply = (message, finish_reason = 'stop', usage) => ({ choices: [{ message, finish_reason, index: 0 }], usage });
const chunk = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason, index: 0 }] });
const outputText = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const responseReply = (output, status = 'completed') => ({ object: 'response', id: 'resp-test', status, output, usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } });

test('Chat Completions maps full history, options and text plus multiple parsed tool calls', async () => {
  let sent;
  const protocol = createChatCompletionsProtocol({ fetch: async (url, init) => {
    sent = { url, ...init, body: JSON.parse(init.body) };
    return json(chatReply({ content: 'I will look up both.', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"query":"甲"}' } },
      { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"query":"乙"}' } },
    ] }, 'tool_calls', { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 }));
  } });
  const history = [{ role: 'assistant', content: 'Earlier', toolCalls: [{ id: 'old', name: 'lookup', arguments: { query: 'x' } }] }, { role: 'tool', callId: 'old', content: 'found' }];
  const output = await settle(protocol.call(input('chat-completions', {
    capabilities: { ...effective, streaming: false }, messages: history,
    options: { maxOutputTokens: 123, temperature: 0.25, protocol: { reasoningEffort: 'low' } },
  })));
  assert.equal(sent.url, 'https://unit.invalid/v1/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer private-key-never-in-error');
  assert.equal(sent.body.max_completion_tokens, 123);
  assert.equal(sent.body.reasoning_effort, 'low');
  assert.equal(sent.body.temperature, 0.25);
  assert.equal(sent.body.messages[0].tool_calls[0].function.arguments, '{"query":"x"}');
  assert.equal(sent.body.messages[1].tool_call_id, 'old');
  assert.deepEqual(output.result, { status: 'completed', text: 'I will look up both.', toolCalls: [
    { id: 'a', name: 'lookup', arguments: { query: '甲' } }, { id: 'b', name: 'lookup', arguments: { query: '乙' } },
  ], usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } });
});

test('Chat streaming handles fragmented UTF-8, CRLF, interleaved tools and usage', async () => {
  const events = [];
  const protocol = createChatCompletionsProtocol({ fetch: async () => stream([
    chunk({ role: 'assistant', content: '你好🙂' }),
    chunk({ tool_calls: [
      { index: 1, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"query":' } },
      { index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{' } },
    ] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"query":"甲"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"乙"}' } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, '[DONE]',
  ], { newline: '\r\n' }) });
  const output = await settle(protocol.call(input('chat-completions', { onEvent: event => events.push(event) })));
  assert.equal(output.result.text, '你好🙂');
  assert.deepEqual(output.result.toolCalls.map(call => call.arguments), [{ query: '甲' }, { query: '乙' }]);
  assert.equal(output.result.usage.totalTokens, 3);
  assert.deepEqual(events[0], { type: 'text-delta', delta: '你好🙂' });
  assert.equal(events.filter(event => event.type === 'tool-call-delta').length, 4);
});

test('Chat truncation and refusal never expose partial executable tool arguments', async () => {
  for (const [finish, refusal, expected] of [['length', null, 'incomplete'], ['content_filter', null, 'refused'], ['stop', 'No', 'refused']]) {
    const protocol = createChatCompletionsProtocol({ fetch: async () => stream([
      chunk({ content: 'partial', refusal, tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{' } }] }),
      chunk({}, finish), '[DONE]',
    ]) });
    const output = await settle(protocol.call(input('chat-completions')));
    assert.equal(output.result.status, expected);
    assert.deepEqual(output.result.toolCalls, []);
  }
});

test('Chat rejects malformed completed arguments and unterminated/error streams', async () => {
  for (const payload of [
    [chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{' } }] }, 'tool_calls'), '[DONE]'],
    [chunk({ content: 'partial' })],
    [{ error: { message: 'contains private-key-never-in-error' } }],
  ]) {
    const protocol = createChatCompletionsProtocol({ fetch: async () => stream(payload) });
    await assert.rejects(settle(protocol.call(input('chat-completions'))), error => {
      assert.ok(['invalid-response', 'provider-failure'].includes(error.code));
      assert.ok(!error.message.includes('private-key'));
      return true;
    });
  }
});

test('Responses preserves native reasoning, phase and tool identity in private candidate continuation', async () => {
  const requests = [];
  const rawOutput = [
    { type: 'reasoning', id: 'rs-one', encrypted_content: 'opaque-signature', summary: [] },
    { ...outputText('Checking now.'), phase: 'commentary' },
    { type: 'function_call', id: 'fc-one', call_id: 'call-one', name: 'lookup', arguments: '{"query":"first"}', status: 'completed' },
  ];
  const protocol = createResponsesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return json(responseReply(requests.length === 1 ? rawOutput : [{ ...outputText('Done.'), phase: 'final_answer' }]));
  } });
  const base = input('responses', { capabilities: { ...effective, streaming: false }, options: { protocol: { reasoningEffort: 'high', reasoningSummary: 'auto' } } });
  const first = await settle(protocol.call(base));
  assert.equal(first.result.text, 'Checking now.');
  assert.equal(first.result.toolCalls[0].id, 'call-one');
  assert.ok(!JSON.stringify(first.result).includes('opaque-signature'));
  const next = { role: 'tool', callId: 'call-one', content: 'a result' };
  await settle(protocol.call({ ...base, messages: [...base.messages, { role: 'assistant', content: first.result.text, toolCalls: first.result.toolCalls }, next], newMessages: [next], continuation: first.continuation }));
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].previous_response_id, undefined);
  assert.deepEqual(requests[0].reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(requests[1].input, [...base.messages, ...rawOutput, { type: 'function_call_output', call_id: 'call-one', output: 'a result' }]);
  // Producing a candidate does not mutate the prior continuation.
  assert.equal(first.continuation.input.length, 4);
});

test('Responses streaming uses terminal response as authority and emits progress', async () => {
  const events = [];
  const terminal = responseReply([outputText('hello🙂'), { type: 'function_call', call_id: 'one', name: 'lookup', arguments: '{"query":"ok"}' }]);
  const protocol = createResponsesProtocol({ fetch: async () => stream([
    { type: 'response.created', response: { id: 'x' } },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking summary' },
    { type: 'response.output_text.delta', delta: 'hello🙂' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'one', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"query":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"ok"}' },
    { type: 'response.completed', response: terminal },
  ], { newline: '\r' }) });
  const output = await settle(protocol.call(input('responses', { onEvent: event => events.push(event) })));
  assert.equal(output.result.status, 'completed');
  assert.equal(output.result.text, 'hello🙂');
  assert.deepEqual(output.result.toolCalls[0].arguments, { query: 'ok' });
  assert.equal(events[0].type, 'reasoning-summary-delta');
  assert.equal(events.length, 5);
});

test('Responses incomplete and refusal terminate without a candidate continuation', async () => {
  for (const [raw, expected] of [
    [responseReply([{ type: 'function_call', call_id: 'one', name: 'lookup', arguments: '{', status: 'incomplete' }], 'incomplete'), 'incomplete'],
    [responseReply([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }]), 'refused'],
  ]) {
    const protocol = createResponsesProtocol({ fetch: async () => stream([{ type: `response.${raw.status}`, response: raw }]) });
    const output = await settle(protocol.call(input('responses')));
    assert.equal(output.result.status, expected);
    assert.deepEqual(output.result.toolCalls, []);
    assert.equal(output.continuation, undefined);
  }
});

test('Responses rejects uncompleted streams, malformed JSON tools and unsupported output kinds', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.failed', response: { error: { message: 'private-key-never-in-error' } } }],
    [{ type: 'response.completed', response: responseReply([{ type: 'function_call', call_id: 'one', name: 'lookup', arguments: '[]' }]) }],
    [{ type: 'response.completed', response: responseReply([{ type: 'web_search_call' }]) }],
  ]) {
    const protocol = createResponsesProtocol({ fetch: async () => stream(events) });
    await assert.rejects(settle(protocol.call(input('responses'))), error => {
      assert.ok(['invalid-response', 'provider-failure'].includes(error.code));
      assert.ok(!error.message.includes('private-key'));
      return true;
    });
  }
});

test('Transport cancellation waits for reader cancellation before done', async () => {
  let releaseCancel;
  const gate = new Promise(resolve => { releaseCancel = resolve; });
  let fetched;
  const ready = new Promise(resolve => { fetched = resolve; });
  let cancelCount = 0;
  const protocol = createChatCompletionsProtocol({ fetch: async () => {
    fetched();
    return new Response(new ReadableStream({ cancel() { cancelCount++; return gate; } }));
  } });
  const operation = protocol.call(input('chat-completions'));
  await ready;
  await Promise.resolve();
  operation.cancel();
  let done = false;
  void operation.done.then(() => { done = true; });
  await assert.rejects(operation.result, { code: 'cancelled' });
  assert.equal(done, false);
  assert.equal(cancelCount, 1);
  releaseCancel();
  await operation.done;
  assert.equal(done, true);
});

test('Transport observes and reports real cleanup failure separately from result', async () => {
  let cancelCount = 0;
  const protocol = createResponsesProtocol({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: not-json\n\n')); },
    cancel() { cancelCount++; throw new Error('private-key-never-in-error'); },
  })) });
  const operation = protocol.call(input('responses'));
  await assert.rejects(operation.result, { code: 'invalid-response' });
  await assert.rejects(operation.done, error => error.code === 'cleanup-failure' && !error.message.includes('private-key'));
  assert.equal(cancelCount, 1);
});

test('Provider HTTP errors and fetch exceptions are sanitized; unconsumed bodies are cancelled', async () => {
  let cancelled = false;
  const badHttp = createChatCompletionsProtocol({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }) });
  await assert.rejects(settle(badHttp.call(input('chat-completions'))), { code: 'provider-failure' });
  assert.equal(cancelled, true);
  const failure = createResponsesProtocol({ fetch: async () => { throw new Error('private-key-never-in-error'); } });
  await assert.rejects(settle(failure.call(input('responses'))), error => error.code === 'provider-failure' && !error.message.includes('private-key'));
});

test('Discovery returns candidates without inventing capabilities; check performs explicit read-only request', async () => {
  for (const factory of [createChatCompletionsProtocol, createResponsesProtocol]) {
    const requests = [];
    const protocol = factory({ fetch: async (url, init) => { requests.push({ url, ...init }); return json({ data: [{ id: 'alpha' }, { id: 'beta' }] }); } });
    const candidates = await settle(protocol.discover(input(protocol.descriptor.id)));
    assert.deepEqual(candidates, [{ remoteModelId: 'alpha', name: 'alpha' }, { remoteModelId: 'beta', name: 'beta' }]);
    await settle(protocol.check(input(protocol.descriptor.id)));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === 'GET' && request.url === 'https://unit.invalid/v1/models'));
  }
});

test('Native parameter validation rejects unsupported options and unknown reasoning; omission preserves server defaults', async () => {
  for (const factory of [createChatCompletionsProtocol, createResponsesProtocol]) {
    const requests = [];
    const protocol = factory({ fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return protocol.descriptor.id === 'responses' ? json(responseReply([outputText('ok')])) : json(chatReply({ content: 'ok' }));
    } });
    protocol.validateOptions({}, declared);
    for (const options of [{ temperature: 3 }, { maxOutputTokens: 0 }, { protocol: { foo: true } }, { protocol: { reasoningEffort: 'medium' } }]) {
      assert.throws(() => protocol.validateOptions(options, declared));
    }
    assert.throws(() => protocol.validateOptions({ protocol: { reasoningEffort: 'low' } }, { ...declared, reasoning: { support: 'unknown' } }), { code: 'capability-unsupported' });
    const available = protocol.effectiveCapabilities(declared, { protocol: { reasoningEffort: 'none' } });
    assert.equal(available.reasoning.support, 'unsupported');
    assert.equal(available.imageInput, false);
    await settle(protocol.call(input(protocol.descriptor.id, { capabilities: { ...effective, streaming: false }, tools: [] })));
    for (const key of ['temperature', 'max_output_tokens', 'max_completion_tokens', 'reasoning', 'reasoning_effort', 'tools']) assert.equal(requests[0][key], undefined);
  }
});

test('Protocol components register through Nya dependencies and unregister in effects', async () => {
  for (const factory of [createChatCompletionsProtocolComponent, createResponsesProtocolComponent]) {
    const effects = [];
    let registered;
    let unregistered = false;
    const component = factory();
    component.apply({ effect: effect => effects.push(effect()) }, undefined, { 'models.protocols': { register(protocol) { registered = protocol; return { unregister: async () => { unregistered = true; } }; } } });
    assert.ok(registered.descriptor.version);
    assert.deepEqual(component.inject, ['models.protocols']);
    await effects[0]();
    assert.equal(unregistered, true);
  }
});

test('A terminal stream result is available before body cleanup, while done joins actual cancellation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let cancelled = false;
  const terminal = { type: 'response.completed', response: responseReply([outputText('finished')]) };
  const protocol = createResponsesProtocol({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`)); },
    cancel() { cancelled = true; return gate; },
  })) });
  const operation = protocol.call(input('responses'));
  assert.equal((await operation.result).result.text, 'finished');
  let done = false;
  void operation.done.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(done, false);
  release();
  await operation.done;
});

test('Successful provider output cannot hide a terminal stream cleanup failure', async () => {
  const protocol = createChatCompletionsProtocol({ fetch: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'ok' }, 'stop'))}\n\ndata: [DONE]\n\n`));
    },
    cancel() { throw new Error('private-key-never-in-error'); },
  })) });
  const operation = protocol.call(input('chat-completions'));
  assert.equal((await operation.result).result.text, 'ok');
  await assert.rejects(operation.done, { code: 'cleanup-failure' });
});

test('An already errored response stream reports provider failure without a false cleanup failure', async () => {
  let cancelCalled = false;
  const protocol = createResponsesProtocol({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('network failure contains private-key-never-in-error')); },
    cancel() { cancelCalled = true; },
  })) });
  const operation = protocol.call(input('responses'));
  await assert.rejects(operation.result, { code: 'provider-failure' });
  await operation.done;
  assert.equal(cancelCalled, false);
});

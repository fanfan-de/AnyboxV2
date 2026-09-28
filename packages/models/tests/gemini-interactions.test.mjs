import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiInteractionsProtocol, createGeminiInteractionsProtocolComponent } from '../dist/protocols/gemini-interactions.js';

const declared = {
  tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'supported' },
  reasoning: { support: 'supported', efforts: ['minimal', 'low', 'high'] },
};
const effective = { tools: true, streaming: true, imageInput: false, reasoning: { support: 'supported', efforts: ['minimal', 'low', 'high'] } };
const tools = [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
function input(overrides = {}) {
  const messages = [{ role: 'user', content: '你好' }];
  return {
    provider: { name: 'Google', enabled: true, protocolId: 'gemini-interactions', baseUrl: 'https://unit.invalid/v1beta/', auth: 'api-key', timeoutMs: 10_000 },
    credential: 'private-google-key', signal: new AbortController().signal, remoteModelId: 'gemini-unit', options: {},
    capabilities: effective, messages, newMessages: messages, tools, onEvent() {}, ...overrides,
  };
}
const text = value => ({ type: 'text', text: value });
const output = value => ({ type: 'model_output', content: [text(value)] });
const call = (id = 'native-call', args = { query: 'x' }) => ({ type: 'function_call', id, name: 'lookup', arguments: args });
const reply = (steps, status = 'completed', usage) => ({ id: 'interaction-unit', status, steps, ...(usage === undefined ? {} : { usage }) });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function stream(values, { newline = '\n', fragment = 1 } = {}) {
  const wire = values.map(value => `event: ignored${newline}data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`).join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.slice(offset, offset + fragment));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const start = (index, step) => ({ event_type: 'step.start', index, step });
const delta = (index, value) => ({ event_type: 'step.delta', index, delta: value });
const stop = (index, extras = {}) => ({ event_type: 'step.stop', index, ...extras });
const completed = (status = 'completed', extras = {}) => ({ event_type: 'interaction.completed', interaction: { id: 'interaction-unit', status, ...extras } });
async function settle(operation) { try { return await operation.result; } finally { await operation.done; } }

test('Gemini rejects instructions inserted after conversation input before making a request', () => {
  let requests = 0;
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => { requests++; return json(reply([])); } });
  for (const role of ['system', 'developer']) {
    assert.throws(() => protocol.call(input({ messages: [{ role: 'user', content: 'First' }, { role, content: 'Late instruction' }] })), { code: 'invalid-config' });
  }
  assert.equal(requests, 0);
});

test('Gemini JSON responses publish thought summaries while keeping signatures private', async () => {
  const events = [];
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => json(reply([
    { type: 'thought', signature: 'private-json-signature', summary: [text('Checking.')] }, output('Done.'),
  ])) });
  const outcome = await settle(protocol.call(input({ capabilities: { ...effective, streaming: false }, onEvent: event => events.push(event) })));
  assert.deepEqual(events, [{ type: 'reasoning-summary-delta', delta: 'Checking.' }]);
  assert.ok(!JSON.stringify([outcome.result, events]).includes('private-json-signature'));
});

test('Gemini Interactions encodes chronological input and uses only the new stateless wire fields', async () => {
  let sent;
  const protocol = createGeminiInteractionsProtocol({ fetch: async (url, init) => {
    sent = { url, ...init, body: JSON.parse(init.body) };
    return json(reply([output('Done.')], 'completed', { total_input_tokens: 7, total_output_tokens: 9, total_thought_tokens: 90, total_tokens: 106 }));
  } });
  const messages = [
    { role: 'system', content: 'System instructions' }, { role: 'developer', content: 'Developer instructions' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'old-public', name: 'lookup', arguments: { query: 'old' } }] },
    { role: 'tool', callId: 'old-public', content: 'Found.' }, { role: 'user', content: 'Continue.' },
  ];
  const result = await settle(protocol.call(input({ messages, capabilities: { ...effective, streaming: false },
    options: { maxOutputTokens: 400, protocol: { thinkingLevel: 'high', thinkingSummaries: 'auto' } } })));
  assert.equal(sent.url, 'https://unit.invalid/v1beta/interactions');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['x-goog-api-key'], 'private-google-key');
  assert.equal(sent.headers.Authorization, undefined);
  assert.deepEqual(sent.body, {
    model: 'gemini-unit', store: false, stream: false, system_instruction: 'System instructions\n\nDeveloper instructions',
    input: [
      { type: 'user_input', content: [text('Earlier question')] }, output('Checking.'),
      call('old-public', { query: 'old' }),
      { type: 'function_result', call_id: 'old-public', name: 'lookup', result: [text('Found.')] },
      { type: 'user_input', content: [text('Continue.')] },
    ],
    tools: [{ type: 'function', name: 'lookup', description: 'Look up a record', parameters: tools[0].parameters }],
    generation_config: { max_output_tokens: 400, thinking_level: 'high', thinking_summaries: 'auto' },
  });
  assert.deepEqual(result.result, { status: 'completed', text: 'Done.', toolCalls: [], usage: { inputTokens: 7, outputTokens: 9, totalTokens: 106 } });
  for (const forbidden of ['contents', 'parts', 'config', 'previous_interaction_id', 'background', 'temperature', 'thinking_budget']) assert.equal(sent.body[forbidden], undefined);
});

test('Gemini keeps native signatures and tool IDs privately and resends exact history without mutating prior candidates', async () => {
  const requests = [];
  const nativeOutput = [
    { type: 'thought', signature: 'private-native-signature', summary: [text('Checking records.')] },
    output('I will look it up.'), call('same-native-id'),
  ];
  const protocol = createGeminiInteractionsProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return json(reply(requests.length === 1 ? nativeOutput : requests.length === 2 ? [call('same-native-id', { query: 'again' })] : [output('Finished.')], requests.length < 3 ? 'requires_action' : 'completed'));
  } });
  const base = input({ capabilities: { ...effective, streaming: false }, messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Start' }] });
  const first = await settle(protocol.call(base));
  assert.equal(first.result.toolCalls[0].id, 'gemini-call-0');
  assert.ok(!JSON.stringify(first.result).includes('private-native-signature'));
  assert.ok(!JSON.stringify(first.result).includes('same-native-id'));
  const saved = structuredClone(first.continuation);
  const toolResult = { role: 'tool', callId: first.result.toolCalls[0].id, content: 'First result' };
  const history = [...base.messages, { role: 'assistant', content: first.result.text, toolCalls: first.result.toolCalls }, toolResult];
  const second = await settle(protocol.call({ ...base, messages: history, newMessages: [toolResult], continuation: first.continuation }));
  assert.equal(second.result.toolCalls[0].id, 'gemini-call-1');
  assert.deepEqual(requests[1].input, [
    { type: 'user_input', content: [text('Start')] }, ...nativeOutput,
    { type: 'function_result', call_id: 'same-native-id', name: 'lookup', result: [text('First result')] },
  ]);
  assert.deepEqual(first.continuation, saved);
  const next = { role: 'tool', callId: second.result.toolCalls[0].id, content: 'Second result' };
  await settle(protocol.call({ ...base, messages: [...history, { role: 'assistant', content: '', toolCalls: second.result.toolCalls }, next], newMessages: [next], continuation: second.continuation }));
  assert.equal(requests[2].input.at(-1).call_id, 'same-native-id');
  assert.ok(requests.every(request => request.store === false && request.previous_interaction_id === undefined && request.background === undefined && request.system_instruction === 'Instructions' && request.tools.length === 1));
});

test('Gemini allocates public tool IDs around historical IDs', async () => {
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => json(reply([call()], 'requires_action')) });
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-call-0', name: 'lookup', arguments: {} }] },
    { role: 'tool', callId: 'gemini-call-0', content: 'Earlier' }, { role: 'user', content: 'Next' },
  ];
  const result = await settle(protocol.call(input({ capabilities: { ...effective, streaming: false }, messages })));
  assert.equal(result.result.toolCalls[0].id, 'gemini-call-1');
});

test('Gemini fragmented SSE assembles thoughts, text and parallel tools using step.stop without a step payload', async () => {
  const events = [];
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => stream([
    { event_type: 'interaction.created', interaction: { id: 'interaction-unit', status: 'in_progress' } },
    { event_type: 'interaction.status_update', interaction_id: 'interaction-unit', status: 'in_progress' },
    start(0, { type: 'thought' }), start(1, output('Prefix ')),
    delta(0, { type: 'thought_summary', content: text('A summary🙂') }),
    delta(1, { type: 'text', text: '你好🙂' }),
    delta(1, { type: 'text_annotation_delta', annotations: [{ source: 'unit' }] }),
    delta(0, { type: 'thought_signature', signature: 'private-stream-signature' }),
    stop(0, { usage: { total_input_tokens: 100, total_output_tokens: 200 } }),
    start(2, call('native-a', {})), start(3, call('native-b', {})),
    delta(3, { type: 'arguments_delta', arguments: '{"query":' }),
    delta(2, { type: 'arguments_delta', arguments: '{' }),
    delta(2, { type: 'arguments_delta', arguments: '"query":"甲"}' }),
    delta(3, { type: 'arguments_delta', arguments: '"乙"}' }),
    stop(1), stop(3), stop(2, { usage: { total_input_tokens: 100, total_output_tokens: 200 }, step_usage: { total_input_tokens: 10 } }),
    completed('requires_action', { usage: { total_input_tokens: 7, total_output_tokens: 11, total_thought_tokens: 13, total_tokens: 31 } }), '[DONE]',
  ], { newline: '\r\n' }) });
  const result = await settle(protocol.call(input({ onEvent: event => events.push(event) })));
  assert.deepEqual(result.result, { status: 'completed', text: 'Prefix 你好🙂', toolCalls: [
    { id: 'gemini-call-0', name: 'lookup', arguments: { query: '甲' } },
    { id: 'gemini-call-1', name: 'lookup', arguments: { query: '乙' } },
  ], usage: { inputTokens: 7, outputTokens: 11, totalTokens: 31 } });
  assert.ok(events.some(event => event.type === 'reasoning-summary-delta' && event.delta === 'A summary🙂'));
  assert.equal(events.filter(event => event.type === 'tool-call-delta').length, 6);
  assert.ok(!JSON.stringify(events).includes('private-stream-signature'));
  const steps = result.continuation.input.slice(1);
  assert.deepEqual(steps[0], { type: 'thought', summary: [text('A summary🙂')], signature: 'private-stream-signature' });
  assert.deepEqual(steps[1], { type: 'model_output', content: [{ ...text('Prefix 你好🙂'), annotations: [{ source: 'unit' }] }] });
  assert.deepEqual(steps[2].arguments, { query: '甲' });
  assert.deepEqual(steps[3].arguments, { query: '乙' });
});

test('Gemini JSON and SSE produce equivalent public results and private chronological steps', async () => {
  const steps = [{ type: 'thought', summary: [text('Summary')], signature: 'signed' }, output('Hello🙂'), call('native-one', { query: 'ok' })];
  const usage = { total_input_tokens: 1, total_output_tokens: 2, total_thought_tokens: 5, total_tokens: 8 };
  const nonstream = createGeminiInteractionsProtocol({ fetch: async () => json(reply(steps, 'requires_action', usage)) });
  const streaming = createGeminiInteractionsProtocol({ fetch: async () => stream([
    start(0, { type: 'thought' }), delta(0, { type: 'thought_summary', content: text('Summary') }), delta(0, { type: 'thought_signature', signature: 'signed' }), stop(0),
    start(1, { type: 'model_output' }), delta(1, { type: 'text', text: 'Hello🙂' }), stop(1),
    start(2, call('native-one', {})), delta(2, { type: 'arguments_delta', arguments: '{"query":"ok"}' }), stop(2), completed('requires_action', { usage }),
  ], { newline: '\r' }) });
  const a = await settle(nonstream.call(input({ capabilities: { ...effective, streaming: false } })));
  const b = await settle(streaming.call(input()));
  assert.deepEqual(a, b);
});

test('Gemini incomplete output suppresses partial tool arguments and discards continuation', async () => {
  for (const status of ['incomplete', 'budget_exceeded']) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => stream([
      start(0, output('Partial')), stop(0), start(1, call('native', {})), delta(1, { type: 'arguments_delta', arguments: '{"query":' }), completed(status),
    ]) });
    const result = await settle(protocol.call(input()));
    assert.deepEqual(result.result, { status: 'incomplete', text: 'Partial', toolCalls: [] });
    assert.equal(result.continuation, undefined);
  }
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => json(reply([output('Partial'), { type: 'function_call', arguments: '{' }], 'incomplete')) });
  const result = await settle(protocol.call(input({ capabilities: { ...effective, streaming: false } })));
  assert.deepEqual(result.result.toolCalls, []);
  assert.equal(result.continuation, undefined);
});

test('Gemini completed output rejects malformed calls, unsupported modalities and nonterminal statuses', async () => {
  for (const raw of [
    reply([call('a'), call('a')]), reply([{ type: 'function_call', name: 'lookup', arguments: {} }]),
    reply([{ ...call(), id: '' }]), reply([{ ...call(), name: '' }]), reply([call('a', '{')]), reply([call('a', [])]), reply([call('a', null)]),
    reply([{ type: 'model_output', content: [{ type: 'image', data: 'not-in-scope' }] }]), reply([{ type: 'google_search_call' }]),
    reply([], 'requires_action'), reply([], 'queued'), reply([], 'in_progress'), reply([], 'unknown'),
  ]) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => json(raw) });
    await assert.rejects(settle(protocol.call(input({ capabilities: { ...effective, streaming: false } }))), { code: 'invalid-response' });
  }
  for (const raw of [reply([], 'failed'), reply([], 'cancelled'), { ...reply([]), errors: [{ code: 'unit', message: 'private-google-key' }] }]) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => json(raw) });
    await assert.rejects(settle(protocol.call(input({ capabilities: { ...effective, streaming: false } }))), error => error.code === 'provider-failure' && !error.message.includes('private-google-key'));
  }
});

test('Gemini rejects malformed or unterminated SSE and never treats DONE as a terminal result', async () => {
  for (const payload of [
    [delta(0, { type: 'text', text: 'before start' })], [start(0, output('x')), stop(0), stop(0)],
    [start(0, output('x')), completed()], [start(1, output('x')), stop(1), completed()],
    [start(0, output('x')), start(0, output('again'))], [start(0, { type: 'model_output' }), delta(0, { type: 'image', data: 'x' })],
    [start(0, call('a', {})), delta(0, { type: 'arguments_delta', arguments: '{' }), stop(0), completed('requires_action')],
    [start(0, call('a', {})), start(1, call('a', {}))], [completed('requires_action')], ['[DONE]'],
    [start(0, output('unfinished')), stop(0)], [],
  ]) {
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => stream(payload) });
    await assert.rejects(settle(protocol.call(input())), { code: 'invalid-response' });
  }
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => stream([{ event_type: 'error', error: { message: 'private-google-key' } }]) });
  await assert.rejects(settle(protocol.call(input())), error => error.code === 'provider-failure' && !error.message.includes('private-google-key'));
});

test('Gemini accepts optional full terminal steps while retaining final usage authority', async () => {
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => stream([
    start(0, call('native', {})), delta(0, { type: 'arguments_delta', arguments: '{' }), stop(0, { usage: { total_tokens: 999 } }),
    completed('requires_action', { steps: [call('native', { query: 'final' })], usage: { total_tokens: 12 } }),
  ]) });
  const result = await settle(protocol.call(input()));
  assert.deepEqual(result.result.toolCalls[0].arguments, { query: 'final' });
  assert.deepEqual(result.result.usage, { totalTokens: 12 });
});

test('Gemini options expose level and summaries while rejecting temperature, budgets and legacy fields', async () => {
  const requests = [];
  const protocol = createGeminiInteractionsProtocol({ fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return json(reply([output('ok')])); } });
  protocol.validateOptions({}, declared);
  protocol.validateOptions({ maxOutputTokens: 100, protocol: { thinkingLevel: 'minimal', thinkingSummaries: 'none' } }, declared);
  assert.deepEqual(protocol.descriptor.modelFields.map(field => field.key), ['maxOutputTokens', 'protocol.thinkingLevel', 'protocol.thinkingSummaries']);
  for (const options of [
    { temperature: 0.2 }, { maxOutputTokens: 0 }, { maxOutputTokens: 2 ** 31 }, { protocol: null },
    { protocol: { thinkingBudget: 100 } }, { protocol: { thinkingLevel: 'none' } }, { protocol: { thinkingLevel: 'xhigh' } },
    { protocol: { thinkingSummaries: 'concise' } }, { protocol: { reasoningEffort: 'low' } }, { protocol: { includeThoughts: true } },
    { protocol: { thinking_config: {} } },
  ]) assert.throws(() => protocol.validateOptions(options, declared), { code: 'invalid-config' });
  assert.throws(() => protocol.validateOptions({ protocol: { thinkingLevel: 'medium' } }, declared), { code: 'capability-unsupported' });
  assert.throws(() => protocol.validateOptions({ protocol: { thinkingSummaries: 'auto' } }, { ...declared, reasoning: { support: 'unknown' } }), { code: 'capability-unsupported' });
  assert.deepEqual(protocol.effectiveCapabilities({ ...declared, reasoning: { support: 'supported', efforts: ['none', 'low', 'high', 'xhigh'], modes: ['enabled'], budget: { min: 1, max: 10 } } }, {}), {
    ...effective, reasoning: { support: 'supported', efforts: ['low', 'high'] },
  });
  await settle(protocol.call(input({ capabilities: { ...effective, streaming: false }, tools: [] })));
  for (const key of ['generation_config', 'system_instruction', 'tools', 'previous_interaction_id', 'background']) assert.equal(requests[0][key], undefined);
});

test('Gemini discovery follows encoded page tokens without inventing capabilities, and check reads only one page', async () => {
  const requests = [];
  const protocol = createGeminiInteractionsProtocol({ fetch: async (url, init) => {
    requests.push({ url, ...init });
    return json(url.includes('pageToken=') ? { models: [{ name: 'models/gemini-two' }] } : { models: [{ name: 'models/gemini-one', displayName: 'Gemini One', thinking: true, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'token /+=' });
  } });
  assert.deepEqual(await settle(protocol.discover(input())), [{ remoteModelId: 'gemini-one', name: 'Gemini One' }, { remoteModelId: 'gemini-two', name: 'gemini-two' }]);
  assert.equal(requests[1].url, 'https://unit.invalid/v1beta/models?pageSize=1000&pageToken=token%20%2F%2B%3D');
  await settle(protocol.check(input()));
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.method === 'GET' && request.headers['x-goog-api-key'] === 'private-google-key' && request.headers.Authorization === undefined && request.body === undefined));
  const empty = createGeminiInteractionsProtocol({ fetch: async () => json({}) });
  assert.deepEqual(await settle(empty.discover(input())), []);
});

test('Gemini discovery rejects duplicate models and cursor loops', async () => {
  for (const duplicate of [true, false]) {
    let page = 0;
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => json({ models: [{ name: `models/${duplicate ? 'same' : ++page}` }], nextPageToken: 'repeated' }) });
    await assert.rejects(settle(protocol.discover(input())), { code: 'invalid-response' });
  }
});

test('Gemini paged discovery cancellation waits for the active page reader cleanup', async () => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let release;
  const cleanup = new Promise(resolve => { release = resolve; });
  let cancelled = false;
  const protocol = createGeminiInteractionsProtocol({ fetch: async url => {
    if (!url.includes('pageToken=')) return json({ models: [{ name: 'models/first' }], nextPageToken: 'second' });
    ready();
    return new Response(new ReadableStream({ cancel() { cancelled = true; return cleanup; } }));
  } });
  const operation = protocol.discover(input());
  await started;
  await Promise.resolve();
  operation.cancel();
  let done = false;
  void operation.done.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(done, false);
  release();
  await assert.rejects(operation.result, { code: 'cancelled' });
  await operation.done;
  assert.equal(done, true);
});

test('Gemini terminal result precedes cleanup while done joins cancellation and reports failures', async () => {
  for (const fails of [false, true]) {
    let release;
    const cleanup = new Promise(resolve => { release = resolve; });
    let cancelled = false;
    const protocol = createGeminiInteractionsProtocol({ fetch: async () => new Response(new ReadableStream({
      start(controller) {
        const events = [start(0, output('Finished')), stop(0), completed()];
        controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      },
      cancel() { cancelled = true; return cleanup.then(() => { if (fails) throw new Error('private-google-key'); }); },
    })) });
    const operation = protocol.call(input());
    assert.equal((await operation.result).result.text, 'Finished');
    let done = false;
    void operation.done.then(() => { done = true; }, () => {});
    await Promise.resolve();
    assert.equal(cancelled, true);
    assert.equal(done, false);
    release();
    if (fails) await assert.rejects(operation.done, error => error.code === 'cleanup-failure' && !error.message.includes('private-google-key'));
    else { await operation.done; assert.equal(done, true); }
  }
});

test('Gemini request aborts and failures keep credentials out of errors and none auth omits native headers', async () => {
  let sent;
  const noAuth = createGeminiInteractionsProtocol({ fetch: async (_url, init) => { sent = init; return json(reply([output('ok')])); } });
  const connection = input();
  await settle(noAuth.call({ ...connection, provider: { ...connection.provider, auth: 'none' }, capabilities: { ...effective, streaming: false } }));
  assert.equal(sent.headers['x-goog-api-key'], undefined);
  assert.equal(sent.headers.Authorization, undefined);
  const aborted = new AbortController();
  aborted.abort();
  let fetched = false;
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => { fetched = true; throw new Error('private-google-key'); } });
  await assert.rejects(settle(protocol.call(input({ signal: aborted.signal }))), { code: 'cancelled' });
  assert.equal(fetched, false);
  await assert.rejects(settle(protocol.call(input())), error => error.code === 'provider-failure' && !error.message.includes('private-google-key'));
});

test('Gemini component registers through Nya injection and waits for unregister effects', async () => {
  const component = createGeminiInteractionsProtocolComponent();
  const effects = [];
  let registered;
  let unregistered = false;
  component.apply({ effect: effect => effects.push(effect()) }, undefined, { 'models.protocols': { register(protocol) {
    registered = protocol;
    return { unregister: async () => { unregistered = true; } };
  } } });
  assert.equal(registered.descriptor.id, 'gemini-interactions');
  assert.deepEqual(component.inject, ['models.protocols']);
  await effects[0]();
  assert.equal(unregistered, true);
});

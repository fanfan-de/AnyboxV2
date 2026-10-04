import test from 'node:test'
import assert from 'node:assert/strict'
import { createGeminiInteractionsProtocol, createGeminiInteractionsProtocolComponent } from '../dist/protocols/gemini-interactions.js'
import { declared, jsonResponse, sse, nativeSession, run } from './native-protocol-helpers.mjs'
import { deferred, tick } from './helpers.mjs'
const text = value => ({ type: 'text', text: value }), output = value => ({ type: 'model_output', content: [text(value)] })
const thought = { type: 'thought', signature: 'private-gemini-signature', summary: [text('thought')], future: { kept: true } }, call = { type: 'function_call', id: 'native-call', name: 'lookup', arguments: { q: 'x' } }
const reply = (steps, status = 'completed') => ({ id: 'interaction-id', status, steps, usage: { total_input_tokens: 3, total_output_tokens: 4 } })
const initial = { input: [{ type: 'user_input', content: [text('你好')] }], system_instruction: 'fixed instruction', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }
for (const streaming of [false, true]) test(`Gemini preserves chronological native steps, signatures and IDs across restoration (${streaming ? 'SSE' : 'JSON'})`, async () => {
  const sent = [], steps = [thought, output('before'), call, output('after')], protocol = createGeminiInteractionsProtocol({ fetch: async (_url, init) => { sent.push({ ...init, body: JSON.parse(init.body) }); const response = reply(steps, 'requires_action'); return streaming ? sse([...steps.flatMap((step, index) => [{ event_type: 'step.start', index, step }, { event_type: 'step.stop', index }]), { event_type: 'interaction.completed', interaction: { ...response, steps: undefined } }]) : jsonResponse(response) } })
  const execution = nativeSession(protocol, { streaming, parameters: { generation_config: { max_output_tokens: 123, thinking_level: 'high', thinking_summaries: 'auto' } } }), events = []
  assert.deepEqual((await run(execution, initial, events)).steps, steps); const archive = await execution.close(), restored = nativeSession(protocol, { streaming, parameters: execution.snapshot.parameters.value, restore: { ...archive.restoreState, records: archive.records } }); await run(restored, { input: [{ type: 'function_result', call_id: 'native-call', name: 'lookup', result: [text('done')] }] })
  assert.equal(sent[0].headers['x-goog-api-key'], 'private-native-test-key'); assert.equal(sent[0].body.store, false); assert.equal(sent[0].body.previous_interaction_id, undefined); assert.deepEqual(sent[1].body.input.slice(1, 5), steps); assert.equal(sent[1].body.input.at(-1).call_id, 'native-call'); assert.equal(sent[1].body.system_instruction, 'fixed instruction'); await restored.close(); if (streaming) assert.equal(events[0].event_type, 'step.start')
})

test('Gemini fragmented SSE consumes thought, text annotation and parallel tool argument deltas', async () => {
  const events = [{ event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } }, { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig' } }, { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: text('summary') } }, { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } }, { event_type: 'step.delta', index: 1, delta: { type: 'text', text: '汉字' } }, { event_type: 'step.delta', index: 1, delta: { type: 'text_annotation_delta', annotations: [{ kind: 'citation', url: 'https://example.test' }] } }, { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { ...call, arguments: {} } }, { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"q":"x"}' } }, { event_type: 'step.stop', index: 2 }, { event_type: 'interaction.completed', interaction: { id: 'interaction', status: 'requires_action' } }]
  const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse(events, { newline: '\r\n' }) }), { streaming: true }), response = await run(execution, initial)
  assert.equal(response.steps[0].signature, 'sig'); assert.equal(response.steps[1].content[0].text, '汉字'); assert.equal(response.steps[1].content[0].annotations.length, 1); assert.deepEqual(response.steps[2].arguments, { q: 'x' }); await execution.close()
})

test('Gemini accepts current interaction lifecycle events without step indices', async () => {
  const events = [
    { event_type: 'interaction.created', interaction: { id: 'interaction', status: 'in_progress' } },
    { event_type: 'interaction.in_progress', interaction_id: 'interaction' },
    { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'native-call', name: 'lookup', arguments: {} } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"q":' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '"x"}' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.requires_action', interaction_id: 'interaction' },
    { event_type: 'interaction.completed', interaction: { id: 'interaction', status: 'requires_action' } },
  ]
  const observed = [], execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse(events) }), { streaming: true })
  try {
    const response = await run(execution, initial, observed)
    assert.equal(response.status, 'requires_action')
    assert.deepEqual(response.steps, [call])
    assert.deepEqual(observed.map(event => event.event_type), events.map(event => event.event_type))
  } finally { await execution.close() }
})

for (const tools of [false, true]) test(`Gemini store:false streams without interaction IDs commit and restore ${tools ? 'tool' : 'text'} history`, async () => {
  const requests = [], observed = [], firstSteps = [thought, tools ? { ...call, signature: 'private-tool-signature' } : output('answer')]
  const protocol = createGeminiInteractionsProtocol({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    const first = requests.length === 1, steps = first ? firstSteps : [output('continued')]
    return sse([
      { event_type: 'interaction.created', interaction: { object: 'interaction', model: 'remote' } },
      { event_type: 'interaction.status_update', status: 'in_progress' },
      ...steps.flatMap((step, index) => [{ event_type: 'step.start', index, step }, { event_type: 'step.stop', index }]),
      { event_type: 'interaction.completed', interaction: { object: 'interaction', model: 'remote', status: first && tools ? 'requires_action' : 'completed', usage: { total_tokens: 7 } } },
      '[DONE]',
    ])
  } })
  const execution = nativeSession(protocol, { streaming: true })
  let restored
  try {
    const response = await run(execution, initial, observed)
    assert.equal(response.id, undefined)
    assert.deepEqual(response.steps, firstSteps)
    const archive = await execution.close()
    assert.equal(archive.cleanup, 'succeeded')
    assert.deepEqual(archive.records.map(record => record.kind), ['request', 'response'])
    assert.deepEqual(archive.records[1].payload, response)
    restored = nativeSession(protocol, { streaming: true, restore: { ...archive.restoreState, records: archive.records } })
    const next = tools ? { input: [{ type: 'function_result', call_id: call.id, name: call.name, result: [text('done')] }] }
      : { input: [{ type: 'user_input', content: [text('Continue')] }] }
    assert.equal((await run(restored, next)).steps[0].content[0].text, 'continued')
    assert.deepEqual(requests[1].input.slice(1, 3), firstSteps)
    assert.equal(requests[0].store, false)
    assert.equal(requests[1].previous_interaction_id, undefined)
    assert.equal(observed.at(-1).event_type, 'interaction.completed')
  } finally { await execution.close(); await restored?.close() }
})

test('Gemini malformed stream diagnostics retain only the failure location and never restore partial output', async () => {
  const malformed = { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: 'private-native-test-key' },
    message: 'private-native-test-key', headers: { authorization: 'private-native-test-key' }, signature: 'private-signature' }
  const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse([malformed]) }), { streaming: true })
  await assert.rejects(run(execution, initial), error => error.code === 'invalid-response' && !('stage' in error))
  const archive = await execution.close()
  assert.equal(archive.cleanup, 'succeeded')
  assert.equal(archive.restoreState, undefined)
  assert.deepEqual(archive.records.map(record => record.kind), ['request', 'diagnostic'])
  assert.deepEqual(archive.records[1].payload, { type: 'gemini_response_diagnostic', stage: 'sse-event', event_type: 'step.delta', index: 1, delta_type: 'arguments_delta' })
  assert.doesNotMatch(JSON.stringify(archive.records), /private-native-test-key|private-signature|authorization|headers/)
})

test('Gemini status notifications never substitute for a completed interaction', async () => {
  const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse([
    { event_type: 'step.start', index: 0, step: call }, { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.requires_action', interaction_id: 'interaction' },
  ]) }), { streaming: true })
  await assert.rejects(run(execution, initial), { code: 'invalid-response' })
  const archive = await execution.close()
  assert.equal(archive.restoreState, undefined)
  assert.equal(archive.records.at(-1).payload.stage, 'sse-terminal-missing')
})

test('Gemini omitting a server interaction ID never relaxes function call ID validation', async () => {
  for (const steps of [[{ ...call, id: undefined }], [call, call]]) {
    const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse([
      ...steps.flatMap((step, index) => [{ event_type: 'step.start', index, step }, { event_type: 'step.stop', index }]),
      { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
    ]) }), { streaming: true })
    await assert.rejects(run(execution, initial), { code: 'invalid-response' })
    const archive = await execution.close()
    assert.equal(archive.restoreState, undefined)
    assert.equal(archive.records.at(-1).kind, 'diagnostic')
    assert.equal(archive.records.at(-1).payload.stage, 'sse-terminal')
  }
})
for (const status of ['incomplete', 'budget_exceeded']) test(`Gemini ${status} retains native status and unfinished tool data`, async () => {
  const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => jsonResponse(reply([{ ...call, arguments: '{unfinished' }], status)) })); const response = await run(execution, initial); assert.equal(response.status, status); assert.equal(response.steps[0].arguments, '{unfinished'); await execution.close()
})

test('Gemini unknown response fields remain intact and unsupported parameters never reach the wire', async () => {
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => jsonResponse({ ...reply([output('done')]), future: { retained: true } }) }); const execution = nativeSession(protocol); assert.deepEqual((await run(execution, initial)).future, { retained: true }); await execution.close()
  for (const parameters of [{ temperature: 1 }, { generation_config: { thinking_level: 'ultra' } }, { generation_config: { budget: 100 } }, { previous_interaction_id: 'server' }]) assert.throws(() => protocol.validateParameters(parameters, declared))
  protocol.validateParameters({}, declared)
})

test('Gemini malformed terminals, repeated steps and premature DONE are rejected', async () => {
  const responses = [sse(['[DONE]']), sse([{ event_type: 'step.start', index: 0, step: thought }, { event_type: 'step.start', index: 0, step: thought }]), jsonResponse(reply([], 'requires_action')), jsonResponse(reply([], 'unknown'))]
  for (const response of responses) { const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => response }), { streaming: response.headers.get('content-type') !== 'application/json' }); await assert.rejects(run(execution, initial)); assert.equal((await execution.close()).restoreState, undefined) }
})

test('Gemini changing system instruction after history is rejected before transport', async () => {
  let count = 0; const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => { count++; return jsonResponse(reply([output('done')])) } })); await run(execution, initial); assert.throws(() => execution.prepareExchange({ input: [], system_instruction: 'replacement' }), { code: 'invalid-config' }); assert.equal(count, 1); await execution.close()
})

test('Gemini discovery preserves encoded page tokens and check consumes one page', async () => {
  const urls = [], protocol = createGeminiInteractionsProtocol({ fetch: async url => { urls.push(url); return jsonResponse(urls.length === 1 ? { models: [{ name: 'models/first' }], nextPageToken: 'a b&c' } : { models: [{ name: 'models/second', displayName: 'Second' }] }) } })
  const input = { provider: { baseUrl: 'https://unit.invalid/v1beta', auth: 'none' }, signal: new AbortController().signal }; const operation = protocol.discover(input), result = await operation.result; await operation.done; assert.deepEqual(result.map(value => value.remoteModelId), ['first', 'second']); assert.ok(urls[1].endsWith('pageToken=a%20b%26c'))
  const check = protocol.check(input); await check.result; await check.done; assert.equal(urls.length, 3)
})

test('Gemini discovery rejects duplicate identities and cursor loops', async () => {
  const protocol = createGeminiInteractionsProtocol({ fetch: async () => jsonResponse({ models: [{ name: 'models/same' }], nextPageToken: 'again' }) }); const operation = protocol.discover({ provider: { baseUrl: 'https://unit.invalid', auth: 'none' }, signal: new AbortController().signal }); await assert.rejects(operation.result, { code: 'invalid-response' }); await operation.done
})

test('Gemini terminal result and close wait for reader cancellation, including cleanup failure', async () => {
  const entered = deferred(), release = deferred(); const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async () => sse([{ event_type: 'interaction.completed', interaction: reply([output('done')]) }], { close: false, cancel: async () => { entered.resolve(); await release.promise; throw new Error('cleanup') } }) }), { streaming: true }); const operation = execution.prepareExchange(initial).start(); await entered.promise; let settled = false; void operation.result.catch(() => { settled = true }); await tick(); assert.equal(settled, false); release.resolve(); await assert.rejects(operation.result, { code: 'cleanup-failure' }); await assert.rejects(operation.done, { code: 'cleanup-failure' }); assert.equal((await execution.close()).cleanup, 'failed')
})

test('Gemini failures are sanitized and none-auth never adds credential headers', async () => {
  let headers; const execution = nativeSession(createGeminiInteractionsProtocol({ fetch: async (_url, init) => { headers = init.headers; throw new Error('private-native-test-key') } }), { auth: 'none' }); await assert.rejects(run(execution, initial), error => error.code === 'provider-failure' && !String(error).includes('private-native-test-key')); assert.equal(headers['x-goog-api-key'], undefined); await execution.close()
})

test('Gemini component uses dependency snapshot and awaits protocol unregister', async () => {
  const { Context } = await import('@nya/core'); const root = new Context(), release = deferred(); let registered
  await root.installComponent({ name: 'registry', apply(ctx) { ctx.provide('models.protocols', { register(protocol) { registered = protocol; return { unregister: () => release.promise } } }) } }); const fiber = root.installComponent(createGeminiInteractionsProtocolComponent()); await fiber; assert.equal(registered.descriptor.id, 'gemini-interactions'); let closed = false; const closing = fiber.dispose().then(() => { closed = true }); await tick(); assert.equal(closed, false); release.resolve(); await closing; await root.fiber.dispose()
})

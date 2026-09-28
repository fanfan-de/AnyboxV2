import test from 'node:test';
import { addConnection, addConfiguration } from './helpers.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, FiberState } from '@nya/core';
import {
  createModelsStoreComponent, createModelsVaultComponent, createModelsComponent,
  createChatCompletionsProtocolComponent, createResponsesProtocolComponent,
} from '../dist/index.js';

const capabilities = {
  tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' },
  reasoning: { support: 'supported', efforts: ['low', 'high'] },
};
const tools = [{ name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t, handle) {
  const directory = await mkdtemp(join(tmpdir(), 'models-integration-'));
  const path = join(directory, 'models.sqlite');
  const failures = [];
  const server = createServer((request, response) => {
    void (async () => {
      let text = '';
      for await (const part of request) text += part.toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      await handle({ path: request.url, authorization: request.headers.authorization, body, response });
    })().catch(error => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const secretValues = new Map();
  const root = new Context();
  t.after(async () => {
    try { await root.fiber.dispose(); } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
    assert.deepEqual(failures, []);
  });
  const fibers = [
    root.installComponent(createModelsStoreComponent({ path })),
    root.installComponent(createModelsVaultComponent({ namespace: 'models-local-integration', openEntry: (_namespace, id) => ({
      getPassword: async () => secretValues.get(id),
      setPassword: async value => { secretValues.set(id, value); },
      deleteCredential: async () => secretValues.delete(id),
    }) })),
    root.installComponent(createModelsComponent()),
    root.installComponent(createChatCompletionsProtocolComponent()),
    root.installComponent(createResponsesProtocolComponent()),
  ];
  await Promise.all(fibers);
  for (const fiber of fibers) assert.equal(fiber.state, FiberState.ACTIVE);
  return { root, baseUrl, path, models: root.get('models'), settings: root.get('models.settings'), secretValues };
}
function sse(response, values) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const value of values) response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  response.end();
}
function chatChunk(delta, finish_reason = null) { return { choices: [{ index: 0, delta, finish_reason }] }; }
function responseMessage(text, phase = 'final_answer') {
  return { type: 'message', role: 'assistant', phase, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}
async function provider(settings, protocolId, baseUrl, apiKey) {
  return addConnection(settings, { name: protocolId, enabled: true, protocolId, baseUrl, auth: 'api-key', timeoutMs: 5000, apiKey });
}
async function model(settings, owner, name, defaults = {}, remoteModelId = 'shared-remote') {
  return addConfiguration(settings, { name, enabled: true, providerId: owner.id, remoteModelId, capabilities, defaults });
}

test('Real Nya components, SQLite and HTTP serve concurrent modelId executions with fixed keys/defaults and native tool continuation', { timeout: 15_000 }, async t => {
  const requests = [];
  const arrived = deferred();
  let initial = 0;
  const nativeReasoning = { type: 'reasoning', id: 'reason-one', encrypted_content: 'opaque-reasoning-signature', summary: [] };
  const f = await fixture(t, async request => {
    requests.push({ path: request.path, authorization: request.authorization, body: request.body });
    const { body, response } = request;
    const isChat = request.path === '/chat/v1/chat/completions';
    const isResponses = request.path === '/responses/v1/responses';
    assert.ok(isChat || isResponses);
    const followUp = isChat ? body.messages.some(message => message.role === 'tool') : body.input.some(item => item.type === 'function_call_output');
    const offerTool = Boolean(body.tools?.length);
    if (offerTool && !followUp) {
      initial++;
      if (initial === 2) arrived.resolve();
      await arrived.promise; // Neither request can complete until both Agents are concurrently in flight.
    }
    if (isChat) {
      if (offerTool && !followUp) sse(response, [
        chatChunk({ content: 'Chat is checking.' }),
        chatChunk({ tool_calls: [{ index: 0, id: 'chat-call', type: 'function', function: { name: 'lookup', arguments: '{"query":"chat"}' } }] }),
        chatChunk({}, 'tool_calls'), '[DONE]',
      ]);
      else sse(response, [chatChunk({ content: followUp ? 'Chat done.' : 'Configured defaults used.' }, 'stop'), '[DONE]']);
    } else {
      const output = offerTool && !followUp ? [nativeReasoning, responseMessage('Responses is checking.', 'commentary'),
        { type: 'function_call', id: 'native-call', call_id: 'responses-call', name: 'lookup', arguments: '{"query":"responses"}', status: 'completed' },
      ] : [responseMessage('Responses done.')];
      sse(response, [
        { type: 'response.output_text.delta', delta: offerTool && !followUp ? 'Responses is checking.' : 'Responses done.' },
        { type: 'response.completed', response: { id: 'response-one', object: 'response', status: 'completed', output, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
      ]);
    }
  });
  const chatProvider = await provider(f.settings, 'chat-completions', `${f.baseUrl}/chat/v1`, 'chat-key-original');
  const responsesProvider = await provider(f.settings, 'responses', `${f.baseUrl}/responses/v1`, 'responses-key-original');
  const fast = await model(f.settings, chatProvider, 'Fast', { temperature: 0.1, maxOutputTokens: 11 });
  const deep = await model(f.settings, chatProvider, 'Deep', { temperature: 0.9, maxOutputTokens: 77 });
  const responsesModel = await model(f.settings, responsesProvider, 'Reasoning', { protocol: { reasoningEffort: 'high' }, maxOutputTokens: 55 });
  assert.equal(f.models.list({ available: true }).length, 3);
  const [chat, responses, fixedDeep] = await Promise.all([
    f.models.open({ modelId: fast.id, tools, requirements: { tools: true, streaming: true } }),
    f.models.open({ modelId: responsesModel.id, tools, requirements: { tools: true, reasoning: true } }),
    f.models.open({ modelId: deep.id }),
  ]);
  const chatEvents = [], responsesEvents = [];
  // Normal callers await only result; it must release each round before the next generate().
  const [chatFirst, responsesFirst] = await Promise.all([
    chat.generate({ messages: [{ role: 'user', content: 'Find chat' }], onEvent: event => chatEvents.push(event) }).result,
    responses.generate({ messages: [{ role: 'user', content: 'Find responses' }], onEvent: event => responsesEvents.push(event) }).result,
  ]);
  assert.equal(initial, 2);
  assert.equal(chatFirst.text, 'Chat is checking.');
  assert.equal(responsesFirst.text, 'Responses is checking.');
  assert.equal(chatFirst.toolCalls[0].arguments.query, 'chat');
  assert.equal(responsesFirst.toolCalls[0].arguments.query, 'responses');
  assert.ok(chatEvents.length && responsesEvents.length);
  const changedProvider = await f.settings.setApiKey(chatProvider.id, 'chat-key-replaced', chatProvider.revision);
  const changedModel = await f.settings.updateConfiguration(fast.id, { defaults: { temperature: 0.4, maxOutputTokens: 44 } }, fast.revision);
  assert.equal(changedProvider.revision, 2);
  assert.equal(changedModel.revision, 2);
  assert.equal(chat.snapshot.providerRevision, 1);
  assert.equal(chat.snapshot.modelRevision, 1);
  assert.equal(chat.snapshot.options.temperature, 0.1);
  assert.ok(![...f.secretValues.values()].includes('chat-key-original'), 'old vault entry is reclaimed while executions retain their acquired key');
  const [chatFinal, responsesFinal] = await Promise.all([
    chat.generate({ messages: chatFirst.toolCalls.map(call => ({ role: 'tool', callId: call.id, content: 'chat result' })) }).result,
    responses.generate({ messages: responsesFirst.toolCalls.map(call => ({ role: 'tool', callId: call.id, content: 'responses result' })) }).result,
  ]);
  assert.equal(chatFinal.text, 'Chat done.');
  assert.equal(responsesFinal.text, 'Responses done.');
  const freshFast = await f.models.open({ modelId: fast.id });
  await Promise.all([
    fixedDeep.generate({ messages: [{ role: 'user', content: 'Deep answer' }] }).result,
    freshFast.generate({ messages: [{ role: 'user', content: 'Fresh fast answer' }] }).result,
  ]);
  assert.equal(freshFast.snapshot.providerRevision, 2);
  assert.equal(freshFast.snapshot.modelRevision, 2);
  const chatRequests = requests.filter(item => item.path.includes('/chat/'));
  assert.deepEqual(chatRequests.map(item => [item.body.temperature, item.body.max_completion_tokens, item.authorization]).sort((a, b) => a[0] - b[0]), [
    [0.1, 11, 'Bearer chat-key-original'], [0.1, 11, 'Bearer chat-key-original'],
    [0.4, 44, 'Bearer chat-key-replaced'], [0.9, 77, 'Bearer chat-key-original'],
  ]);
  const chatFollowUp = chatRequests.find(item => item.body.messages.some(message => message.role === 'tool'));
  assert.deepEqual(chatFollowUp.body.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(chatFollowUp.body.messages[1].tool_calls[0].id, 'chat-call');
  assert.equal(chatFollowUp.body.messages[2].tool_call_id, 'chat-call');
  const responseRequests = requests.filter(item => item.path.includes('/responses/'));
  assert.ok(responseRequests.every(item => item.authorization === 'Bearer responses-key-original' && item.body.store === false && item.body.reasoning.effort === 'high'));
  assert.deepEqual(responseRequests[1].body.input[1], nativeReasoning);
  assert.equal(responseRequests[1].body.input[2].phase, 'commentary');
  assert.equal(responseRequests[1].body.input.at(-1).call_id, 'responses-call');
  assert.equal(responseRequests[1].body.input.at(-1).type, 'function_call_output');
  const publicValues = JSON.stringify({
    providers: f.settings.connections(), providerHistory: f.settings.connectionHistory(chatProvider.id),
    models: f.models.list(), modelHistory: f.settings.configurationHistory(fast.id),
    snapshots: [chat.snapshot, responses.snapshot, fixedDeep.snapshot, freshFast.snapshot],
    replies: [chatFirst, chatFinal, responsesFirst, responsesFinal], events: [chatEvents, responsesEvents],
  });
  assert.doesNotMatch(publicValues, /chat-key-original|chat-key-replaced|responses-key-original|opaque-reasoning-signature|credentialRef/);
  for (const request of requests) assert.doesNotMatch(JSON.stringify(request.body), /chat-key-original|chat-key-replaced|responses-key-original/);
  assert.doesNotMatch((await readFile(f.path)).toString('utf8'), /chat-key-original|chat-key-replaced|responses-key-original/);
  await Promise.all([chat.close(), responses.close(), fixedDeep.close(), freshFast.close()]);
});

test('Actual fetch cancellation disconnects an open SSE response and joins resource exit', { timeout: 10_000 }, async t => {
  const disconnected = deferred();
  const firstEvent = deferred();
  const f = await fixture(t, async ({ response }) => {
    response.on('close', () => disconnected.resolve());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chatChunk({ content: 'started' }))}\n\n`);
    // Remain open until the client's abort cancels the real response stream.
  });
  const p = await provider(f.settings, 'chat-completions', `${f.baseUrl}/v1`, 'cancel-test-key');
  const m = await model(f.settings, p, 'Cancellable');
  const execution = await f.models.open({ modelId: m.id });
  const call = execution.generate({ messages: [{ role: 'user', content: 'wait' }], onEvent: event => firstEvent.resolve(event) });
  assert.equal((await firstEvent.promise).delta, 'started');
  call.cancel();
  await assert.rejects(call.result, { code: 'cancelled' });
  await call.done;
  await disconnected.promise;
  await execution.close();
});

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
  return { root, baseUrl, path, open: input => { const config = root.get('models.settings').configurations().find(value => value.id === input.modelId); const connection = root.get('models.settings').connections().find(value => value.id === config.connectionId); return root.get('models').openNative({ ...input, lease: root.get('models.protocols').acquire(connection.protocolId) }); }, models: root.get('models'), settings: root.get('models.settings'), secretValues };
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

test('Real Nya, SQLite, Vault and HTTP retain native tool history across concurrent executions and reopening', { timeout: 15_000 }, async t => {
  const requests = [], arrived = deferred(); let initial = 0;
  const reasoning = { type: 'reasoning', id: 'reason-one', encrypted_content: 'opaque-signature', summary: [] };
  const f = await fixture(t, async request => {
    requests.push({ path: request.path, authorization: request.authorization, body: request.body });
    const { body, response } = request, chat = request.path.includes('/chat/'), followUp = chat ? body.messages.some(item => item.role === 'tool') : body.input.some(item => item.type === 'function_call_output');
    if (body.tools?.length && !followUp) { initial++; if (initial === 2) arrived.resolve(); await arrived.promise; }
    if (chat) sse(response, followUp ? [chatChunk({ role: 'assistant', content: 'Chat done.' }, 'stop'), '[DONE]'] : [chatChunk({ role: 'assistant', content: 'Chat checking.' }), chatChunk({ tool_calls: [{ index: 0, id: 'chat-call', type: 'function', function: { name: 'lookup', arguments: '{"query":"chat"}' } }] }, 'tool_calls'), '[DONE]']);
    else sse(response, [{ type: 'response.completed', response: { id: 'resp', object: 'response', status: 'completed', output: followUp ? [responseMessage('Responses done.')] : [reasoning, responseMessage('checking', 'commentary'), { type: 'function_call', id: 'item', call_id: 'responses-call', name: 'lookup', arguments: '{"query":"responses"}', status: 'completed' }] } }]);
  });
  const cp = await provider(f.settings, 'chat-completions', `${f.baseUrl}/chat/v1`, 'chat-key'), rp = await provider(f.settings, 'responses', `${f.baseUrl}/responses/v1`, 'responses-key');
  const cm = await model(f.settings, cp, 'Chat', { temperature: 0.1, maxOutputTokens: 11 }), rm = await model(f.settings, rp, 'Responses', { protocol: { reasoningEffort: 'high' }, maxOutputTokens: 55 });
  const [chat, responses] = await Promise.all([f.open({ modelId: cm.id }), f.open({ modelId: rm.id })]);
  const [a, b] = await Promise.all([
    chat.prepareExchange({ messages: [{ role: 'user', content: 'Find chat' }], tools: tools.map(tool => ({ type: 'function', function: tool })) }).start().result,
    responses.prepareExchange({ input: [{ role: 'user', content: 'Find responses' }], tools: tools.map(tool => ({ type: 'function', ...tool })) }).start().result,
  ]);
  assert.equal(initial, 2); assert.equal(a.response.choices[0].message.tool_calls[0].id, 'chat-call'); assert.equal(b.response.output[2].call_id, 'responses-call');
  const changed = await f.settings.setApiKey(cp.id, 'new-chat-key', cp.revision);
  assert.equal(changed.revision, 2); assert.equal(chat.snapshot.providerRevision, 1);
  await Promise.all([
    chat.prepareExchange({ messages: [{ role: 'tool', tool_call_id: 'chat-call', content: 'chat result' }] }).start().result,
    responses.prepareExchange({ input: [{ type: 'function_call_output', call_id: 'responses-call', output: 'responses result' }] }).start().result,
  ]);
  assert.deepEqual(requests.filter(item => item.path.includes('/chat/')).map(item => item.authorization), ['Bearer chat-key', 'Bearer chat-key']);
  const responseRequests = requests.filter(item => item.path.includes('/responses/')); assert.deepEqual(responseRequests[1].body.input[1], reasoning); assert.equal(responseRequests[1].body.input[2].phase, 'commentary');
  const report = await responses.close(), restored = await f.open({ modelId: rm.id, restore: { ...report.restoreState, records: JSON.parse(JSON.stringify(report.records)) } });
  await restored.prepareExchange({ input: [{ role: 'user', content: 'Next Run' }] }).start().result;
  assert.equal(requests.at(-1).body.input[1].encrypted_content, 'opaque-signature'); assert.equal(requests.at(-1).body.input.at(-1).content, 'Next Run');
  const chatReport = await chat.close(); await assert.rejects(f.open({ modelId: cm.id, restore: { ...chatReport.restoreState, records: chatReport.records } }), { code: 'invalid-config' }); await restored.close();
  const publicValues = JSON.stringify({ connections: f.settings.connections(), histories: f.settings.connectionHistory(cp.id), models: f.models.list(), snapshots: [chat.snapshot, responses.snapshot], records: report.records });
  assert.doesNotMatch(publicValues, /chat-key|responses-key|credentialRef/); assert.doesNotMatch((await readFile(f.path)).toString('utf8'), /chat-key|responses-key/);
});

test('Actual fetch cancellation disconnects open native SSE and waits for reader exit', { timeout: 10_000 }, async t => {
  const disconnected = deferred(), firstEvent = deferred();
  const f = await fixture(t, async ({ response }) => { response.on('close', () => disconnected.resolve()); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(`data: ${JSON.stringify(chatChunk({ role: 'assistant', content: 'started' }))}\n\n`); });
  const p = await provider(f.settings, 'chat-completions', `${f.baseUrl}/v1`, 'cancel-key'), m = await model(f.settings, p, 'Cancellable'), execution = await f.open({ modelId: m.id });
  const operation = execution.prepareExchange({ messages: [{ role: 'user', content: 'wait' }] }).start(event => firstEvent.resolve(event));
  assert.equal((await firstEvent.promise).choices[0].delta.content, 'started'); operation.cancel(); await assert.rejects(operation.result, { code: 'cancelled' }); await operation.done; await disconnected.promise; await execution.close();
});

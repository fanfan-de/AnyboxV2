import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createResponsesProtocol, createAnthropicMessagesProtocol, createChatCompletionsProtocol, createGeminiInteractionsProtocol } from '@anybox/models'
import { createDeepSeekProtocol, convertLegacyDeepSeekParameters } from '../dist/web/deepseek-protocol.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHarness } from '../dist/harness.js'
import { projectProtocolRecords } from '../dist/protocol-agents/projection.js'

const factories = { responses: createResponsesProtocol, 'anthropic-messages': createAnthropicMessagesProtocol,
  'chat-completions': createChatCompletionsProtocol, 'gemini-interactions': createGeminiInteractionsProtocol,
  'deepseek-chat-completions': createDeepSeekProtocol }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function answer(protocolId, text) {
  if (protocolId === 'responses') return { id: `response-${text}`, status: 'completed', output: [
    { type: 'message', id: `message-${text}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }] }
  if (protocolId === 'anthropic-messages') return { id: `message-${text}`, type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocolId === 'gemini-interactions') return { id: `interaction-${text}`, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] }
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }
}
function toolResponse(protocolId) {
  const args = { command: 'printf native-tool-result' }
  if (protocolId === 'responses') return { status: 'completed', output: [
    { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'private-encrypted-continuation', summary: [{ type: 'summary_text', text: 'Thinking' }] },
    { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'bash', arguments: JSON.stringify(args), status: 'completed' }] }
  if (protocolId === 'anthropic-messages') return { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
    { type: 'thinking', thinking: 'Thinking', signature: 'private-thinking-signature' },
    { type: 'redacted_thinking', data: 'private-redacted-content' }, { type: 'tool_use', id: 'call-1', name: 'bash', input: args }] }
  if (protocolId === 'gemini-interactions') return { status: 'requires_action', steps: [
    { type: 'thought', signature: 'private-thought-signature', summary: [{ type: 'text', text: 'Thinking' }] },
    { type: 'function_call', id: 'call-1', name: 'bash', arguments: args }] }
  return { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Thinking',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] } }] }
}
async function host(directory, protocolId, state, { search = false } = {}) {
  const root = new Context()
  await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite'),
    legacyParameterConverters: { 'deepseek-chat-completions': convertLegacyDeepSeekParameters } }))
  await root.installComponent(createModelsVaultComponent({ namespace: 'native-app-test', openEntry(_namespace, id) {
    return { async getPassword() { return state.secrets.get(id) }, async setPassword(value) { state.secrets.set(id, value) }, async deleteCredential() { return state.secrets.delete(id) } }
  } }))
  await root.installComponent(createModelsComponent())
  root.get('models.protocols').register(factories[protocolId]({ fetch: async (_url, init) => {
    state.requests.push(JSON.parse(init.body))
    assert.ok(state.responses.length, 'unexpected provider request')
    return json(state.responses.shift())
  } }))
  const settings = root.get('models.settings')
  if (!settings.connections().length) {
    const capabilities = { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' }, webSearch: { support: search ? 'supported' : 'unknown' } }
    const provider = await settings.createProvider({ name: 'Native provider', connectionHints: { protocolIds: [protocolId] } })
    const connection = await settings.createConnection({ id: 'connection', providerDefinitionId: provider.id, name: 'Native connection', enabled: true,
      protocolId, baseUrl: 'https://native.invalid/v1', auth: 'api-key', apiKey: 'private-api-key', timeoutMs: 5000 })
    const definition = await settings.createModel({ name: 'Native model', providerId: provider.id, remoteModelId: 'native-model', capabilities,
      controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } })
    const value = protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : {}
    if (search) value.tools = protocolId === 'responses' ? [{ type: 'web_search' }] : [{ type: 'web_search_20250305', name: 'web_search' }]
    await settings.createConfiguration({ id: 'default', name: 'Native configuration', enabled: true, connectionId: connection.id, modelDefinitionId: definition.id,
      capabilities, baseline: true, parameters: { protocolId, formatVersion: 1, value } })
  }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'sessions.sqlite')))
  const harness = await createHarness(root, { agents: [{ id: 'assistant', instructions: 'Root instructions', modelId: 'default' }] })
  const project = await harness.openProject(directory)
  return { root, harness, project, settings, close: () => harness.close() }
}
async function run(f, sessionId, parentNodeId, input, key = input) {
  const accepted = await f.harness.startRun({ sessionId, parentNodeId, input, idempotencyKey: key })
  const settled = await f.harness.waitRun(accepted.id)
  assert.equal(settled.status, 'completed', JSON.stringify(settled))
  return settled
}

for (const protocolId of Object.keys(factories)) test(`${protocolId}: native tool history survives Runs, restart and isolated branches`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-native-history-'))
  const state = { secrets: new Map(), requests: [], responses: [toolResponse(protocolId), answer(protocolId, 'ROOT-ANSWER')] }
  let f = await host(directory, protocolId, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const first = await run(f, session.id, null, 'ROOT-INPUT')
    assert.match(JSON.stringify(state.requests[1]), /native-tool-result/)
    const rootRecords = await f.harness.getRunRecords(first.id)
    assert.equal(rootRecords.filter(record => record.kind === 'response').length, 2)
    assert.doesNotMatch(JSON.stringify(rootRecords), /private-api-key|Authorization|credentialRef/)
    const safeView = projectProtocolRecords(protocolId, rootRecords)
    assert.doesNotMatch(JSON.stringify(safeView), /private-(encrypted|thinking|redacted|thought)/)
    const history = await f.root.get('harness.session-runs').loadNativeHistory(session.id, first.resultNodeId)
    for (const checkpoint of [null, { ...history.checkpoint, recordFormatVersion: 99 }, { ...history.checkpoint, modelSnapshot: {} }]) {
      await assert.rejects(f.root.get('harness.protocol-agents').prepare({ runId: 'invalid-restore', sessionId: session.id, modelId: 'default',
        signal: new AbortController().signal, initialization: history.initialization, input: { schemaVersion: 1, raw: 'never', text: 'never', template: null },
        history: { ...history, checkpoint } }), { category: 'unsupported-request' })
    }
    state.responses.push(answer(protocolId, 'CHILD-ANSWER'))
    const child = await run(f, session.id, first.resultNodeId, 'CHILD-INPUT')
    assert.equal((JSON.stringify(state.requests.at(-1)).match(/CHILD-INPUT/g) ?? []).length, 1)
    assert.match(JSON.stringify(state.requests.at(-1)), /ROOT-ANSWER/)
    if (protocolId === 'responses') assert.match(JSON.stringify(state.requests.at(-1)), /private-encrypted-continuation/)
    if (protocolId === 'anthropic-messages') assert.match(JSON.stringify(state.requests.at(-1)), /private-thinking-signature/)
    if (protocolId === 'gemini-interactions') assert.match(JSON.stringify(state.requests.at(-1)), /private-thought-signature/)
    const childRecords = await f.harness.getRunRecords(child.id)
    assert.equal(childRecords.length, 2)
    assert.doesNotMatch(JSON.stringify(childRecords[0].payload), /ROOT-ANSWER|private-(encrypted|thinking|thought)/)
    await f.close()
    f = await host(directory, protocolId, state)
    state.responses.push(answer(protocolId, 'RESTART-ANSWER'))
    await run(f, session.id, child.resultNodeId, 'RESTART-INPUT')
    assert.match(JSON.stringify(state.requests.at(-1)), /CHILD-ANSWER/)
    state.responses.push(answer(protocolId, 'SIBLING-ANSWER'))
    await run(f, session.id, first.resultNodeId, 'SIBLING-INPUT')
    assert.doesNotMatch(JSON.stringify(state.requests.at(-1)), /CHILD-INPUT|CHILD-ANSWER|RESTART-INPUT|RESTART-ANSWER/)
    assert.match(JSON.stringify(state.requests.at(-1)), /ROOT-ANSWER/)
    assert.deepEqual(await f.harness.getRunRecords(first.id), rootRecords)
    const connection = f.settings.connections()[0]
    await f.settings.updateConnection(connection.id, { name: 'Renamed' }, connection.revision)
    state.responses.push(answer(protocolId, 'RENAMED-ANSWER'))
    await run(f, session.id, first.resultNodeId, 'RENAMED-INPUT')
    const renamed = f.settings.connections()[0]
    await f.settings.updateConnection(renamed.id, { baseUrl: 'https://changed.invalid/v1' }, renamed.revision)
    const before = state.requests.length
    await assert.rejects(f.harness.startRun({ sessionId: session.id, parentNodeId: first.resultNodeId, input: 'REJECT', idempotencyKey: 'scope-changed' }))
    assert.equal(state.requests.length, before)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Anthropic server search correlates across pause_turn, resumes automatically and restores ordered blocks', async () => {
  const protocolId = 'anthropic-messages', directory = mkdtempSync(join(tmpdir(), 'anybox-native-pause-'))
  const paused = { type: 'message', role: 'assistant', stop_reason: 'pause_turn', content: [
    { type: 'server_tool_use', id: 'server-search-1', name: 'web_search', input: { query: 'native search' } }] }
  const complete = { ...answer(protocolId, 'Search answer'), content: [
    { type: 'web_search_tool_result', tool_use_id: 'server-search-1', content: [{ type: 'web_search_result', url: 'https://example.com/source', title: 'Source', encrypted_content: 'private-search-data' }] },
    { type: 'text', text: 'Search answer', citations: [{ type: 'web_search_result_location', url: 'https://example.com/source', title: 'Source', cited_text: 'Search answer', encrypted_index: 'private-search-index' }] }] }
  const state = { secrets: new Map(), requests: [], responses: [paused, complete] }
  let f = await host(directory, protocolId, state, { search: true })
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const first = await run(f, session.id, null, 'Search')
    assert.equal(state.requests.length, 2)
    assert.deepEqual(state.requests[1].messages.at(-1).content, paused.content)
    assert.deepEqual(state.requests[1].tools, state.requests[0].tools)
    assert.equal((await f.harness.getRunEvents(first.id)).filter(event => event.kind === 'tool-started').length, 0)
    const records = await f.harness.getRunRecords(first.id), view = projectProtocolRecords(protocolId, records)
    assert.match(JSON.stringify(view), /https:\/\/example.com\/source/)
    assert.doesNotMatch(JSON.stringify(view), /private-search/)
    await f.close(); f = await host(directory, protocolId, state)
    state.responses.push(answer(protocolId, 'Restored search'))
    await run(f, session.id, first.resultNodeId, 'Continue')
    assert.match(JSON.stringify(state.requests.at(-1)), /private-search-data/)
    assert.equal((JSON.stringify(state.requests.at(-1)).match(/server-search-1/g) ?? []).length, 2)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Responses search records native citations while safe projection exposes clickable sources only', async () => {
  const protocolId = 'responses', directory = mkdtempSync(join(tmpdir(), 'anybox-native-search-'))
  const response = answer(protocolId, 'Source answer')
  response.output.unshift({ type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', query: 'source' } })
  response.output[1].content[0].annotations.push({ type: 'url_citation', start_index: 0, end_index: 6, url: 'https://example.com/source', title: 'Source' })
  const state = { secrets: new Map(), requests: [], responses: [response] }, f = await host(directory, protocolId, state, { search: true })
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const first = await run(f, session.id, null, 'Search')
    assert.ok(state.requests[0].tools.some(tool => tool.type === 'web_search'))
    assert.equal(state.requests[0].store, false)
    const view = projectProtocolRecords(protocolId, await f.harness.getRunRecords(first.id))
    assert.equal(view[0].blocks.find(block => block.kind === 'text').citations[0].url, 'https://example.com/source')
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('native refusal and truncation are recorded without creating resumable nodes', async () => {
  const cases = [
    ['responses', { ...answer('responses', 'partial'), status: 'incomplete' }],
    ['responses', { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'declined' }] }] }],
    ['anthropic-messages', { ...answer('anthropic-messages', 'partial'), stop_reason: 'max_tokens' }],
    ['anthropic-messages', { ...answer('anthropic-messages', 'declined'), stop_details: { type: 'refusal' } }],
    ['gemini-interactions', { ...answer('gemini-interactions', 'partial'), status: 'incomplete' }],
  ]
  for (const [protocolId, response] of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'anybox-native-refusal-'))
    const state = { secrets: new Map(), requests: [], responses: [response] }, f = await host(directory, protocolId, state)
    try {
      const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
      const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Request', idempotencyKey: 'failure' })
      const settled = await f.harness.waitRun(accepted.id)
      assert.equal(settled.status, 'failed')
      assert.equal(settled.resultNodeId, undefined)
      assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
      assert.deepEqual((await f.harness.getRunRecords(accepted.id)).find(record => record.kind === 'response').payload, response)
      assert.equal(state.requests.length, 1)
    } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
  }
})

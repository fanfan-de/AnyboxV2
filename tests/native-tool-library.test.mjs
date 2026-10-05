import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context } from '@nya/core'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createResponsesProtocol, createChatCompletionsProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol } from '@anybox/models'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'

const factories = { responses: createResponsesProtocol, 'chat-completions': createChatCompletionsProtocol,
  'anthropic-messages': createAnthropicMessagesProtocol, 'gemini-interactions': createGeminiInteractionsProtocol }
function response(protocol, calls, text = 'complete') {
  if (protocol === 'responses') return { status: 'completed', output: calls.length
    ? calls.map(({ id, name, arguments: args }) => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' }))
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] }
  if (protocol === 'anthropic-messages') return { type: 'message', role: 'assistant', stop_reason: calls.length ? 'tool_use' : 'end_turn', content: calls.length
    ? calls.map(({ id, name, arguments: input }) => ({ type: 'tool_use', id, name, input })) : [{ type: 'text', text }] }
  if (protocol === 'gemini-interactions') return { status: calls.length ? 'requires_action' : 'completed', steps: calls.length
    ? calls.map(({ id, name, arguments: args }) => ({ type: 'function_call', id, name, arguments: args })) : [{ type: 'model_output', content: [{ type: 'text', text }] }] }
  return { choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls.length ? '' : text,
    ...(calls.length ? { tool_calls: calls.map(({ id, name, arguments: args }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : {}) } }] }
}
const call = (id, name, args) => ({ id, name, arguments: args })
async function open(directory, protocolId, state, imageInput = true) {
  const root = new Context()
  await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite') }))
  await root.installComponent(createModelsVaultComponent({ namespace: 'library-test', openEntry(_namespace, id) {
    return { async getPassword() { return state.secrets.get(id) }, async setPassword(value) { state.secrets.set(id, value) }, async deleteCredential() { return state.secrets.delete(id) } }
  } }))
  await root.installComponent(createModelsComponent())
  root.get('models.protocols').register(factories[protocolId]({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body); state.requests.push(request)
    assert.ok(state.responses.length, 'unexpected provider request')
    const reply = state.responses.shift()
    return new Response(JSON.stringify(typeof reply === 'function' ? await reply(request) : reply), { headers: { 'content-type': 'application/json' } })
  } }))
  const settings = root.get('models.settings')
  if (!settings.connections().length) {
    const capabilities = { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' }, imageInput: { support: imageInput ? 'supported' : 'unsupported' } }
    const provider = await settings.createProvider({ name: 'Tools provider', connectionHints: { protocolIds: [protocolId] } })
    const connection = await settings.createConnection({ id: 'connection', providerDefinitionId: provider.id, name: 'Tools', enabled: true, protocolId,
      baseUrl: 'https://tools.invalid/v1', auth: 'api-key', apiKey: 'private-key', timeoutMs: 5000 })
    const definition = await settings.createModel({ name: 'Tools model', providerId: provider.id, remoteModelId: 'tool-model', capabilities,
      controls: { temperature: 'unknown' }, modalities: { input: ['text', ...(imageInput ? ['image'] : [])], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } })
    await settings.createConfiguration({ id: 'default', name: 'Tools', enabled: true, connectionId: connection.id, modelDefinitionId: definition.id, capabilities, baseline: true,
      parameters: { protocolId, formatVersion: 1, value: protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : {} } })
  }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  const harness = await createTestHarnessServerCore(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Use tools.' }] }, { legacyTools: false })
  const project = await harness.openProject(directory)
  return { root, harness, project, close: () => harness.close() }
}
async function start(f, session, parentNodeId = null, key = 'first') {
  const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId, input: key, idempotencyKey: key })
  return f.harness.waitRun(accepted.id)
}

for (const protocol of Object.keys(factories)) for (const imageInput of [true, false]) test(`${protocol}: mixed contracts, stdin and tool images continue from committed observations (images=${imageInput})`, { timeout: 15000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-library-'))), state = { secrets: new Map(), requests: [], responses: [] }
  let f = await open(directory, protocol, state, imageInput)
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer()
    writeFileSync(join(directory, 'image.png'), png)
    const toolIds = ['codex.exec_command', 'codex.write_stdin', 'codex.update_plan', 'claude-code.Write', 'deepseek-harness.read', 'codex.view_image']
    await f.harness.setAgentTools('assistant', { toolIds, expectedRevision: 0 })
    const session = await f.harness.createSession(f.project.id, 'assistant')
    state.responses.push(response(protocol, [
      call('exec', 'codex_exec_command', { cmd: 'printf ready; read line; printf "%s" "$line"', yield_time_ms: 0 }),
      call('plan', 'codex_update_plan', { plan: [{ step: 'inspect', status: 'in_progress' }] }),
      call('write', 'claude_code_Write', { file_path: 'new.txt', content: 'cross-source text\n' }),
      call('read', 'deepseek_harness_read', { file_path: 'new.txt' }),
      call('image', 'codex_view_image', { path: 'image.png' }),
    ]), request => {
      const wire = JSON.stringify(request)
      const match = wire.replaceAll('\\"', '"').match(/"session_id"\s*:\s*(\d+)/)
      assert.ok(match, wire)
      assert.match(wire, /cross-source text/)
      if (imageInput) assert.match(wire, new RegExp(png.toString('base64')))
      else assert.match(wire, /image-input-unavailable/)
      return response(protocol, [call('stdin', 'codex_write_stdin', { session_id: Number(match[1]), chars: 'done\n', yield_time_ms: 1000 })])
    }, response(protocol, []))
    const first = await start(f, session)
    assert.equal(first.status, 'completed', JSON.stringify(first))
    assert.equal(readFileSync(join(directory, 'new.txt'), 'utf8'), 'cross-source text\n')
    const events = await f.harness.getRunEvents(first.id)
    assert.deepEqual(events.filter(event => event.kind === 'tool-observed').map(event => event.name),
      ['codex_exec_command', 'codex_update_plan', 'claude_code_Write', 'deepseek_harness_read', 'codex_view_image', 'codex_write_stdin'])
    const records = await f.harness.getRunRecords(first.id)
    const encoded = JSON.stringify(records)
    assert.doesNotMatch(encoded, new RegExp(png.toString('base64')))
    const imageRequests = records.filter(record => record.kind === 'request' && record.resourceRefs?.length)
    assert.equal(imageRequests.length, imageInput ? 1 : 0)
    const cleanup = await f.root.get('local-storage').read(reader => reader.all("SELECT observation_json FROM harness_run_operations WHERE run_id = ? AND kind = 'operation'", [first.id]))
    assert.ok(cleanup.some(row => JSON.parse(row.observation_json ?? '{}').result?.processes), 'process final exits must be durably observed')
    const history = await f.root.get('harness.session-runs').loadNativeHistory(session.id, first.resultNodeId)
    const incompatible = structuredClone(history.initialization)
    incompatible.toolSelection.tools[0].version = '99.0.0'
    await assert.rejects(f.root.get('harness.protocol-agents').prepare({ runId: 'unsupported-tools', sessionId: session.id, modelId: 'default',
      signal: new AbortController().signal, initialization: incompatible, input: { schemaVersion: 1, raw: 'never', text: 'never', template: null },
      history: { ...history, initialization: incompatible } }), { category: 'unsupported-request' })
    await f.harness.setAgentTools('assistant', { toolIds: [], expectedRevision: 1 })
    await f.close(); f = await open(directory, protocol, state, imageInput)
    state.responses.push(response(protocol, []))
    const child = await start(f, session, first.resultNodeId, 'after-restart')
    assert.equal(child.status, 'completed', JSON.stringify(child))
    assert.match(JSON.stringify(state.requests.at(-1)), /codex_exec_command/)
    if (imageInput) assert.match(JSON.stringify(state.requests.at(-1)), new RegExp(png.toString('base64')))
    assert.deepEqual(await f.harness.getRunRecords(first.id), records)
    const empty = await f.harness.createSession(f.project.id, 'assistant')
    assert.deepEqual(empty.toolSelection.tools, [])
    state.responses.push(response(protocol, []))
    assert.equal((await start(f, empty, null, 'empty')).status, 'completed')
    assert.doesNotMatch(JSON.stringify(state.requests.at(-1)), /codex_exec_command|claude_code_Write|deepseek_harness_read/)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('unselected tool anywhere in a batch rejects before the first file mutation', async () => {
  const protocol = 'chat-completions', directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-admission-')))
  const state = { secrets: new Map(), requests: [], responses: [response(protocol, [
    call('first', 'claude_code_Write', { file_path: 'forbidden.txt', content: 'must not exist' }),
    call('second', 'deepseek_harness_write', { file_path: 'also-forbidden.txt', content: 'must not exist' }),
  ])] }
  const f = await open(directory, protocol, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(session.toolSelection.tools.length, 10)
    const finished = await start(f, session)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'invalid-tool-request')
    assert.equal(existsSync(join(directory, 'forbidden.txt')), false)
    assert.equal((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-started').length, 0)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context } from '@nya/core'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createResponsesProtocol, createChatCompletionsProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol } from '@anybox/models'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createImageAssetsComponent } from '../packages/app-harness/dist/core/image/component.js'
import { getToolById } from '../packages/app-harness/dist/core/tool/catalog.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { nodeCommand } from './helpers/native-shell.mjs'

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

function nativeToolResults(protocol, request) {
  if (protocol === 'responses') return request.input.filter(item => item.type === 'function_call_output').map(item => ({ id: item.call_id, value: JSON.parse(item.output) }))
  if (protocol === 'anthropic-messages') return request.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(item => item.type === 'tool_result').map(item => ({ id: item.tool_use_id, value: JSON.parse(item.content) })) : [])
  if (protocol === 'gemini-interactions') return request.input.filter(item => item.type === 'function_result').map(item => ({ id: item.call_id, value: JSON.parse(item.result.map(block => block.text ?? '').join('')) }))
  return request.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, value: JSON.parse(message.content) }))
}

function assertRejectedResults(protocol, request, ids) {
  const results = nativeToolResults(protocol, request).slice(-ids.length)
  assert.deepEqual(results.map(item => item.id), ids, 'each rejected native call keeps its original result linkage')
  for (const result of results) {
    assert.equal(result.value.error.code, 'invalid-tool-request')
    assert.equal(result.value.error.executed, false)
    assert.ok(result.value.error.availableTools.includes('claude_code_Read'))
    assert.equal(result.value.error.availableTools.includes('codex_update_plan'), false)
  }
  return results
}

for (const protocol of Object.keys(factories)) for (const invalid of ['unknown name', 'invalid arguments'])
  test(`${protocol}: ${invalid} receives native feedback and a corrected declared tool executes without aliases`, { timeout: 15_000 }, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-correction-')))
    writeFileSync(join(directory, 'inspect.txt'), 'Inspect the project\n')
    const bad = invalid === 'unknown name' ? call('rejected-call', 'read_file', { file_path: 'inspect.txt' })
      : call('rejected-call', 'claude_code_Write', { path: 'corrected.txt', content: 'corrected content' })
    const good = invalid === 'unknown name' ? call('corrected-call', 'claude_code_Read', bad.arguments)
      : call('corrected-call', 'claude_code_Write', { file_path: 'corrected.txt', content: 'corrected content' })
    const state = { secrets: new Map(), requests: [], responses: [response(protocol, [bad]), request => {
      const [rejected] = assertRejectedResults(protocol, request, ['rejected-call'])
      assert.equal(rejected.value.error.reason, invalid === 'unknown name' ? 'unknown-tool' : 'invalid-arguments')
      if (invalid === 'invalid arguments') assert.equal(rejected.value.error.schema.properties.file_path.type, 'string')
      assert.equal(existsSync(join(directory, 'corrected.txt')), false)
      assert.match(JSON.stringify(request), /claude_code_Read/)
      return response(protocol, [good])
    }, request => {
      assert.equal(nativeToolResults(protocol, request).at(-1).id, 'corrected-call')
      return response(protocol, [], 'Corrected successfully')
    }] }
    let f = await open(directory, protocol, state)
    try {
      const session = await f.harness.createSession(f.project.id, 'assistant')
      const finished = await start(f, session)
      assert.equal(finished.status, 'completed', JSON.stringify(finished))
      assert.equal(finished.output, 'Corrected successfully')
      const events = await f.harness.getRunEvents(finished.id)
      assert.deepEqual(events.filter(event => event.kind === 'tool-started').map(event => event.call.id), ['corrected-call'])
      assert.equal(state.requests.length, 3)
      if (invalid === 'invalid arguments') assert.equal(readFileSync(join(directory, 'corrected.txt'), 'utf8'), 'corrected content')
      const records = await f.harness.getRunRecords(finished.id)
      assert.match(JSON.stringify(records), /invalid-tool-request/)
      assert.doesNotMatch(JSON.stringify(records), /private-key|Authorization|credentialRef/)
      await f.close(); f = await open(directory, protocol, state)
      if (invalid === 'invalid arguments') writeFileSync(join(directory, 'corrected.txt'), 'Changed after the original tool')
      state.responses.push(request => {
        const restored = nativeToolResults(protocol, request).find(item => item.id === 'rejected-call')
        assert.equal(restored.value.error.code, 'invalid-tool-request')
        assert.equal(restored.value.error.executed, false)
        assert.match(JSON.stringify(request), /Corrected successfully/)
        return response(protocol, [], 'Continued after restart')
      })
      const continued = await start(f, session, finished.resultNodeId, 'after-restart')
      assert.equal(continued.status, 'completed', JSON.stringify(continued))
      assert.deepEqual(await f.harness.getRunRecords(finished.id), records)
      assert.equal((await f.harness.getRunEvents(continued.id)).some(event => event.kind === 'tool-started'), false)
      if (invalid === 'invalid arguments') assert.equal(readFileSync(join(directory, 'corrected.txt'), 'utf8'), 'Changed after the original tool')
    } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
  })

for (const protocol of Object.keys(factories)) test(`${protocol}: the fourth rejected tool batch fails without unbounded model correction`, { timeout: 15_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-correction-bound-')))
  const state = { secrets: new Map(), requests: [], responses: Array.from({ length: 4 }, (_, index) => request => {
    if (index) assertRejectedResults(protocol, request, [`rejected-${index - 1}`])
    return response(protocol, [call(`rejected-${index}`, 'read_file', { file_path: 'inspect.txt' })])
  }) }
  const f = await open(directory, protocol, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant'), finished = await start(f, session)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'invalid-tool-request')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal(state.requests.length, 4)
    assert.equal((await f.harness.getRunEvents(finished.id)).some(event => event.kind === 'tool-started'), false)
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
    assert.equal((await f.harness.getRunRecords(finished.id)).filter(record => record.kind === 'response').length, 4)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocol of Object.keys(factories)) test(`${protocol}: retired planning tools reject new calls but historical Session snapshots still execute and reload`, { timeout: 15_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-retired-tools-')))
  const calls = [
    call('old-plan', 'codex_update_plan', { plan: [{ step: 'Inspect', status: 'in_progress' }], explanation: 'Continue the original Session' }),
    call('old-claude-todo', 'claude_code_TodoWrite', { todos: [{ content: 'Verify', status: 'pending', activeForm: 'Verifying' }] }),
    call('old-deepseek-todo', 'deepseek_harness_todo_write', { todos: [{ content: 'Finish', status: 'completed' }] }),
  ]
  const state = { secrets: new Map(), requests: [], responses: [response(protocol, calls), request => {
    const rejected = assertRejectedResults(protocol, request, calls.map(call => call.id))
    assert.ok(rejected.every(result => result.value.error.reason === 'unknown-tool'))
    return response(protocol, [], 'Retired tools were not executed')
  }] }
  let f = await open(directory, protocol, state)
  try {
    const current = await f.harness.createSession(f.project.id, 'assistant')
    const rejected = await start(f, current)
    assert.equal(rejected.status, 'completed', JSON.stringify(rejected))
    assert.equal((await f.harness.getRunEvents(rejected.id)).some(event => event.kind === 'tool-started'), false)
    const toolSelection = { schemaVersion: 1, tools: ['codex.update_plan', 'claude-code.TodoWrite', 'deepseek-harness.todo_write'].map(toolId => {
      const tool = getToolById(toolId)
      return { toolId, version: tool.version, definition: tool.definition }
    }) }
    await f.root.get('local-storage').transaction(tx => tx.execute(`INSERT INTO harness_sessions
      (id, project_id, agent_id, created_at, model_id, history_mode, tool_selection_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['historical-session', f.project.id, 'assistant', 'now', 'default', 'native-local-v1', JSON.stringify(toolSelection)]))
    const historical = await f.harness.getSession('historical-session')
    state.responses.push(response(protocol, calls), request => {
      const results = nativeToolResults(protocol, request).slice(-calls.length)
      assert.deepEqual(results.map(result => result.id), calls.map(call => call.id))
      assert.deepEqual(results.map(result => result.value), [
        { status: 'updated', plan: calls[0].arguments.plan, explanation: calls[0].arguments.explanation },
        { status: 'updated', todos: calls[1].arguments.todos },
        { status: 'updated', todos: calls[2].arguments.todos },
      ])
      return response(protocol, [], 'Original tools completed')
    })
    const finished = await start(f, historical)
    assert.equal(finished.status, 'completed', JSON.stringify(finished))
    assert.deepEqual((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-observed').map(event => event.name), calls.map(call => call.name))
    const records = await f.harness.getRunRecords(finished.id)
    await f.close(); f = await open(directory, protocol, state)
    state.responses.push(response(protocol, [], 'Historical Session continued'))
    const continued = await start(f, historical, finished.resultNodeId, 'after-restart')
    assert.equal(continued.status, 'completed', JSON.stringify(continued))
    assert.deepEqual((await f.harness.getSession(historical.id)).toolSelection, toolSelection)
    assert.deepEqual(await f.harness.getRunRecords(finished.id), records)
    assert.deepEqual((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-observed').map(event => event.name), calls.map(call => call.name))
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocol of Object.keys(factories)) test(`${protocol}: successful tools do not reset the per-Run tool correction budget`, { timeout: 15_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-correction-total-')))
  writeFileSync(join(directory, 'inspect.txt'), 'Inspect the project\n')
  const responses = []
  for (let index = 0; index < 4; index++) {
    responses.push(response(protocol, [call(`rejected-${index}`, 'read_file', { file_path: 'inspect.txt' })]))
    if (index < 3) responses.push(request => {
      assertRejectedResults(protocol, request, [`rejected-${index}`])
      return response(protocol, [call(`corrected-${index}`, 'claude_code_Read', { file_path: 'inspect.txt' })])
    })
  }
  const state = { secrets: new Map(), requests: [], responses }, f = await open(directory, protocol, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant'), finished = await start(f, session)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'invalid-tool-request')
    assert.equal(state.requests.length, 7)
    assert.deepEqual((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-started').map(event => event.call.id), ['corrected-0', 'corrected-1', 'corrected-2'])
    assert.equal(finished.resultNodeId, undefined)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocol of Object.keys(factories)) for (const identity of ['duplicate', 'overlong'])
  test(`${protocol}: ${identity} tool identities remain fatal before correction or side effects`, { timeout: 15_000 }, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-identity-')))
    const calls = identity === 'duplicate' ? [call('same', 'claude_code_Write', { file_path: 'never.txt', content: 'never' }), call('same', 'claude_code_Read', { file_path: 'never.txt' })]
      : [call('x'.repeat(257), 'claude_code_Write', { file_path: 'never.txt', content: 'never' })]
    const state = { secrets: new Map(), requests: [], responses: [response(protocol, calls), response(protocol, [])] }
    const f = await open(directory, protocol, state)
    try {
      const session = await f.harness.createSession(f.project.id, 'assistant'), finished = await start(f, session)
      assert.equal(finished.status, 'failed')
      assert.equal(finished.resultNodeId, undefined)
      assert.equal(state.requests.length, 1, 'unreliable native identities cannot be answered as linked correction results')
      assert.equal((await f.harness.getRunEvents(finished.id)).some(event => event.kind === 'tool-started'), false)
      assert.equal(existsSync(join(directory, 'never.txt')), false)
    } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
  })

for (const protocol of Object.keys(factories)) for (const executionFailure of ['unavailable', 'invalid-request'])
  test(`${protocol}: an admitted ${executionFailure} execution failure is terminal and never becomes tool-request correction`, { timeout: 15_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-execution-failure-')))
  const state = { secrets: new Map(), requests: [], responses: [response(protocol, [call('accepted', 'claude_code_Write', { file_path: 'never.txt', content: 'never' })]), response(protocol, [])] }
  const f = await open(directory, protocol, state)
  try {
    let executions = 0
    f.root.get('tools.files').execute = () => {
      executions++
      writeFileSync(join(directory, 'already-written.txt'), 'The side effect happened before its result was lost')
      const error = executionFailure === 'invalid-request' ? Object.assign(new Error('executor rejected the admitted request'), { category: 'invalid-request' })
        : new Error('execution result unavailable')
      return { result: Promise.reject(error), done: Promise.resolve(), cancel() {} }
    }
    const session = await f.harness.createSession(f.project.id, 'assistant'), finished = await start(f, session)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, executionFailure === 'invalid-request' ? 'invalid-tool-request' : 'tool-unavailable')
    assert.equal(state.requests.length, 1)
    assert.equal(executions, 1)
    assert.equal(readFileSync(join(directory, 'already-written.txt'), 'utf8'), 'The side effect happened before its result was lost')
    assert.equal((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-started').length, 1)
    assert.equal(existsSync(join(directory, 'never.txt')), false)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Chat initial requests send the built-in Computer environment as system and preserve user prompt roles', async () => {
  const protocol = 'chat-completions', directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-chat-environment-')))
  const state = { secrets: new Map(), requests: [], responses: [response(protocol, [])] }
  const f = await open(directory, protocol, state)
  try {
    const context = await f.harness.createPrompt('owner', { name: 'Explicit developer context', kind: 'context', role: 'developer', content: 'Keep my chosen role.' })
    await f.harness.bindPrompt('owner', 'assistant', (await f.harness.publishPrompt('owner', context.id)).id)
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const finished = await start(f, session)
    assert.equal(finished.status, 'completed', JSON.stringify(finished))
    assert.equal(state.requests.length, 1)
    const messages = state.requests[0].messages
    const environment = messages.find(message => message.content.startsWith('Computer execution environment:\n'))
    assert.ok(environment, 'the initial wire request includes the fixed Computer environment')
    assert.equal(environment.role, 'system')
    assert.ok(environment.content.includes(`Operating system: ${process.platform}.`))
    assert.ok(environment.content.includes(`Project directory (JSON string): ${JSON.stringify(directory)}.`))
    assert.deepEqual(messages.map(message => message.role), ['system', 'developer', 'system', 'user'])
    assert.equal(messages[1].content, 'Keep my chosen role.')
    const history = await f.root.get('harness.session-runs').loadNativeHistory(session.id, finished.resultNodeId)
    const fixed = history.initialization.prompts.find(prompt => prompt.documentId === 'builtin:computer-environment')
    assert.equal(fixed.role, 'system')
    assert.equal(fixed.content, environment.content)
    assert.match(fixed.versionId, /^builtin:computer-environment:v2:/)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocol of Object.keys(factories)) for (const imageInput of [true, false]) test(`${protocol}: mixed contracts, stdin and tool images continue from committed observations (images=${imageInput})`, { timeout: 15000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-library-'))), state = { secrets: new Map(), requests: [], responses: [] }
  let f = await open(directory, protocol, state, imageInput)
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer()
    writeFileSync(join(directory, 'image.png'), png)
    const toolIds = ['codex.exec_command', 'codex.write_stdin', 'claude-code.Write', 'deepseek-harness.read', 'codex.view_image']
    await f.harness.setAgentTools('assistant', { toolIds, expectedRevision: 0 })
    const session = await f.harness.createSession(f.project.id, 'assistant')
    state.responses.push(response(protocol, [
      call('exec', 'codex_exec_command', { cmd: nodeCommand("process.stdout.write('ready'); process.stdin.once('data', bytes => { process.stdout.write(bytes.toString().trim()); process.exit(0) });"), yield_time_ms: 0 }),
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
      ['codex_exec_command', 'claude_code_Write', 'deepseek_harness_read', 'codex_view_image', 'codex_write_stdin'])
    const records = await f.harness.getRunRecords(first.id)
    const encoded = JSON.stringify(records)
    assert.doesNotMatch(encoded, new RegExp(png.toString('base64')))
    const imageRequests = records.filter(record => record.kind === 'request' && record.resourceRefs?.length)
    assert.equal(imageRequests.length, imageInput ? 1 : 0)
    const cleanup = await f.root.get('local-storage').read(reader => reader.all("SELECT observation_json FROM harness_run_operations WHERE run_id = ? AND kind = 'operation'", [first.id]))
    assert.ok(cleanup.some(row => JSON.parse(row.observation_json ?? '{}').result?.environments?.some(environment => environment.environmentId === 'computer' && environment.result.processes)), 'process final exits must be durably observed')
    const history = await f.root.get('harness.session-runs').loadNativeHistory(session.id, first.resultNodeId)
    const environment = history.initialization.prompts.find(prompt => prompt.documentId === 'builtin:computer-environment')
    assert.ok(environment, 'generic command Sessions fix their target shell environment')
    assert.ok(environment.content.includes(`Operating system: ${process.platform}.`))
    assert.ok(environment.content.includes(JSON.stringify(directory)))
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

for (const protocol of Object.keys(factories)) test(`${protocol}: unselected tool feedback rejects the complete batch before the first file mutation`, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-admission-')))
  const state = { secrets: new Map(), requests: [], responses: [response(protocol, [
    call('first', 'claude_code_Write', { file_path: 'forbidden.txt', content: 'must not exist' }),
    call('second', 'deepseek_harness_write', { file_path: 'also-forbidden.txt', content: 'must not exist' }),
  ]), request => {
    const rejected = assertRejectedResults(protocol, request, ['first', 'second'])
    assert.equal(rejected[0].value.error.reason, 'batch-rejected')
    assert.equal(rejected[1].value.error.reason, 'unknown-tool')
    assert.equal(existsSync(join(directory, 'forbidden.txt')), false)
    assert.equal(existsSync(join(directory, 'also-forbidden.txt')), false)
    return response(protocol, [], 'No rejected batch was executed')
  }] }
  const f = await open(directory, protocol, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(session.toolSelection.tools.length, 9)
    const finished = await start(f, session)
    assert.equal(finished.status, 'completed', JSON.stringify(finished))
    assert.equal(state.requests.length, 2)
    assert.equal(existsSync(join(directory, 'forbidden.txt')), false)
    assert.equal((await f.harness.getRunEvents(finished.id)).filter(event => event.kind === 'tool-started').length, 0)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

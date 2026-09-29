import { createImageAssetsComponent } from '../dist/harness/image/component.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createResponsesProtocol, createAnthropicMessagesProtocol, createChatCompletionsProtocol, createGeminiInteractionsProtocol } from '@anybox/models'
import { createDeepSeekProtocol, convertLegacyDeepSeekParameters } from '../dist/host/deepseek-protocol.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHarness } from '../dist/harness/index.js'
import { projectProtocolRecords } from '../dist/harness/protocol-agents/projection.js'

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
async function host(directory, protocolId, state, { search = false, images = false, legacy = false } = {}) {
  const root = new Context()
  await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite'),
    legacyParameterConverters: { 'deepseek-chat-completions': convertLegacyDeepSeekParameters } }))
  await root.installComponent(createModelsVaultComponent({ namespace: 'native-app-test', openEntry(_namespace, id) {
    return { async getPassword() { return state.secrets.get(id) }, async setPassword(value) { state.secrets.set(id, value) }, async deleteCredential() { return state.secrets.delete(id) } }
  } }))
  await root.installComponent(createModelsComponent())
  const protocol = factories[protocolId]({ fetch: async (_url, init) => {
    state.requests.push(JSON.parse(init.body))
    assert.ok(state.responses.length, 'unexpected provider request')
    const response = state.responses.shift()
    await state.beforeResponse?.()
    return json(response)
  } })
  root.get('models.protocols').register(legacy ? { ...protocol, descriptor: { ...protocol.descriptor, version: '2.0.0' }, recordFormatVersion: 1,
    effectiveCapabilities: (...args) => ({ ...protocol.effectiveCapabilities(...args), imageInput: false }) } : protocol)
  const settings = root.get('models.settings')
  if (!settings.connections().length) {
    const capabilities = { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'unsupported' },
      imageInput: { support: images ? 'supported' : 'unsupported' }, webSearch: { support: search ? 'supported' : 'unknown' } }
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
  await root.installComponent(createImageAssetsComponent({ directory: (join(directory, 'sessions.sqlite')) + ".images" }))
  const harness = await createHarness(root, { agents: [{ id: 'assistant', instructions: 'Root instructions', modelId: 'default' }] })
  if (legacy) {
    const registry = root.get('harness.protocol-agents'), prepare = registry.prepare.bind(registry)
    registry.prepare = async input => {
      const program = await prepare(input)
      return { ...program, binding: { ...program.binding, loopVersion: '1.0.0' } }
    }
  }
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
    await assert.rejects(f.root.get('harness.protocol-agents').prepare({ runId: 'invalid-driver-binding', sessionId: session.id, modelId: 'default',
      signal: new AbortController().signal, initialization: history.initialization, input: { schemaVersion: 1, raw: 'never', text: 'never', template: null },
      history: { ...history, binding: { ...history.binding, driverVersion: 'unknown-version' } } }), { category: 'unsupported-request' })
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

for (const images of [false, true]) test(`Anthropic server search resumes across pause_turn and restores ordered blocks (images=${images})`, async () => {
  const protocolId = 'anthropic-messages', directory = mkdtempSync(join(tmpdir(), 'anybox-native-pause-'))
  const paused = { type: 'message', role: 'assistant', stop_reason: 'pause_turn', content: [
    { type: 'server_tool_use', id: 'server-search-1', name: 'web_search', input: { query: 'native search' } }] }
  const complete = { ...answer(protocolId, 'Search answer'), content: [
    { type: 'web_search_tool_result', tool_use_id: 'server-search-1', content: [{ type: 'web_search_result', url: 'https://example.com/source', title: 'Source', encrypted_content: 'private-search-data' }] },
    { type: 'text', text: 'Search answer', citations: [{ type: 'web_search_result_location', url: 'https://example.com/source', title: 'Source', cited_text: 'Search answer', encrypted_index: 'private-search-index' }] }] }
  const state = { secrets: new Map(), requests: [], responses: [paused, complete] }
  let f = await host(directory, protocolId, state, { search: true, images })
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const picture = images ? await importPicture(f, session.id) : undefined
    const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Search', idempotencyKey: 'search', images: picture ? [{ assetId: picture.image.assetId }] : [] })
    const first = await f.harness.waitRun(accepted.id)
    assert.equal(first.status, 'completed')
    if (picture) assert.deepEqual(imageUrls(state.requests[1]), [picture.wire])
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
    if (picture) assert.deepEqual(imageUrls(state.requests.at(-1)), [picture.wire])
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

async function importPicture(f, sessionId, color = 'red') {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer()
  const call = f.harness.importImage(sessionId, (async function* () { yield bytes })())
  const image = await call.result; await call.done
  return { image, bytes, wire: `data:image/png;base64,${bytes.toString('base64')}` }
}
const requestMessages = request => request.messages ?? request.input
const imageUrls = request => requestMessages(request).flatMap(message => Array.isArray(message.content)
  ? message.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : part.type === 'input_image' ? [part.image_url]
    : part.type === 'image' ? [`data:${part.source?.media_type ?? part.mime_type};base64,${part.source?.data ?? part.data}`] : []) : [])

for (const protocolId of Object.keys(factories)) test(`${protocolId}: images persist through tools, restart, regeneration and isolated branches`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-images-history-'))
  const state = { secrets: new Map(), requests: [], responses: [toolResponse(protocolId), answer(protocolId, 'ROOT')] }
  let f = await host(directory, protocolId, state, { images: true })
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const red = await importPicture(f, session.id), blue = await importPicture(f, session.id, 'blue')
    const template = await f.harness.createPrompt('owner', { name: 'Image task', kind: 'task-template', role: 'user', content: 'Inspect:{{input}}' })
    const published = await f.harness.publishPrompt('owner', template.id)
    await f.harness.bindPrompt('owner', 'assistant', published.id)
    const input = { sessionId: session.id, parentNodeId: null, input: '$&{{input}}', images: [{ assetId: red.image.assetId }], idempotencyKey: 'root' }
    const accepted = await f.harness.startRun(input), first = await f.harness.waitRun(accepted.id)
    assert.equal(first.status, 'completed')
    assert.deepEqual(imageUrls(state.requests[0]), [red.wire])
    assert.deepEqual(imageUrls(state.requests[1]), [red.wire])
    assert.equal(requestMessages(state.requests[0]).at(-1).content[0].text, 'Inspect:$&{{input}}')
    if (protocolId.startsWith('deepseek')) assert.deepEqual(state.requests[0].thinking, { type: 'disabled' })
    const node = await f.harness.getNode(session.id, first.resultNodeId)
    assert.deepEqual(node.images.map(image => image.assetId), [red.image.assetId])
    assert.equal(node.images[0].expiresAt, undefined)
    const originalRecords = await f.harness.getRunRecords(first.id)
    assert.equal(originalRecords[0].formatVersion, 2)
    assert.equal(originalRecords[0].resourceRefs[0].id, red.image.assetId)
    assert.doesNotMatch(JSON.stringify(originalRecords), /data:image|base64/)
    const rows = await f.root.get('local-storage').read(reader => reader.all('SELECT intent_json FROM harness_run_operations'))
    assert.doesNotMatch(JSON.stringify(rows), /data:image|base64/)
    assert.equal((await f.harness.startRun(input)).id, first.id)
    await assert.rejects(f.harness.startRun({ ...input, images: [{ assetId: blue.image.assetId }] }), { code: 'idempotency-conflict' })
    const other = await f.harness.createSession(f.project.id, 'assistant', 'default')
    await assert.rejects(f.harness.startRun({ ...input, sessionId: other.id, idempotencyKey: 'foreign' }), { code: 'asset-missing' })
    state.responses.push(answer(protocolId, 'BLUE-CHILD'))
    const childInput = { ...input, parentNodeId: first.resultNodeId, input: '', images: [{ assetId: blue.image.assetId }], idempotencyKey: 'child' }
    const child = await f.harness.startRun(childInput)
    assert.equal((await f.harness.waitRun(child.id)).status, 'completed')
    assert.deepEqual(imageUrls(state.requests.at(-1)), [red.wire, blue.wire])
    await f.close(); f = await host(directory, protocolId, state)
    state.responses.push(answer(protocolId, 'SIBLING'))
    await run(f, session.id, first.resultNodeId, 'Continue original')
    assert.deepEqual(imageUrls(state.requests.at(-1)), [red.wire])
    state.responses.push(answer(protocolId, 'REGENERATED'))
    const regenerated = await f.harness.startRun({ ...input, idempotencyKey: 'regenerate' })
    assert.equal((await f.harness.waitRun(regenerated.id)).status, 'completed')
    assert.deepEqual(imageUrls(state.requests.at(-1)), [red.wire])
    const ordered = { ...input, images: [{ assetId: red.image.assetId }, { assetId: blue.image.assetId }], idempotencyKey: 'ordered' }
    state.responses.push(answer(protocolId, 'ORDERED'))
    const pair = await f.harness.startRun(ordered); await f.harness.waitRun(pair.id)
    await assert.rejects(f.harness.startRun({ ...ordered, images: [...ordered.images].reverse() }), { code: 'idempotency-conflict' })
    // Hold both transports open to prove concurrent siblings keep independent image paths.
    let release, arrivals = 0
    const gate = new Promise(resolve => { release = resolve }), start = state.requests.length
    state.beforeResponse = () => { if (++arrivals === 2) release(); return gate }
    state.responses.push(answer(protocolId, 'PARALLEL-RED'), answer(protocolId, 'PARALLEL-BLUE'))
    try {
      const siblings = await Promise.all([red, blue].map((picture, index) => f.harness.startRun({
        ...input, parentNodeId: first.resultNodeId, input: `parallel-${index}`, images: [{ assetId: picture.image.assetId }], idempotencyKey: `parallel-${index}`,
      })))
      const outcomes = await Promise.all(siblings.map(sibling => f.harness.waitRun(sibling.id)))
      assert.ok(outcomes.every(outcome => outcome.status === 'completed'))
      assert.equal(arrivals, 2)
      for (const [index, picture] of [red, blue].entries()) {
        const request = state.requests.slice(start).find(request => requestMessages(request).at(-1).content[0].text === `Inspect:parallel-${index}`)
        assert.deepEqual(imageUrls(request), [red.wire, picture.wire])
        const node = await f.harness.getNode(session.id, outcomes[index].resultNodeId)
        assert.equal(node.parentId, first.resultNodeId)
        assert.deepEqual(node.images.map(image => image.assetId), [picture.image.assetId])
      }
    } finally { release(); delete state.beforeResponse }
    assert.deepEqual(await f.harness.getRunRecords(first.id), originalRecords)
    writeFileSync(join(directory, 'sessions.sqlite.images', `${red.image.assetId}.image`), Buffer.alloc(red.bytes.length))
    const before = state.requests.length
    const corrupt = await f.harness.startRun({ ...input, idempotencyKey: 'corrupt' })
    const failed = await f.harness.waitRun(corrupt.id)
    assert.equal(failed.status, 'failed'); assert.equal(failed.resultNodeId, undefined)
    assert.equal(failed.errorCategory, 'resource-unavailable'); assert.equal(state.requests.length, before)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocolId of Object.keys(factories)) test(`${protocolId}: v1 text history gains image input without rewriting prior records`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-images-upgrade-'))
  const state = { secrets: new Map(), requests: [], responses: [answer(protocolId, 'BEFORE')] }
  let f = await host(directory, protocolId, state, { images: true, legacy: true })
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    const first = await run(f, session.id, null, 'Old text')
    assert.equal(first.modelSnapshot.capabilities.imageInput, false)
    assert.equal(first.protocolBinding.loopVersion, '1.0.0')
    assert.equal(first.protocolBinding.driverVersion, '2.0.0')
    const original = await f.harness.getRunRecords(first.id)
    assert.ok(original.every(record => record.formatVersion === 1))
    await f.close(); f = await host(directory, protocolId, state)
    const picture = await importPicture(f, session.id)
    state.responses.push(answer(protocolId, 'AFTER'))
    const next = await f.harness.startRun({ sessionId: session.id, parentNodeId: first.resultNodeId, input: '', images: [{ assetId: picture.image.assetId }], idempotencyKey: 'after' })
    assert.equal((await f.harness.waitRun(next.id)).status, 'completed')
    assert.deepEqual(imageUrls(state.requests.at(-1)), [picture.wire])
    assert.deepEqual(await f.harness.getRunRecords(first.id), original)
    const history = await f.root.get('harness.session-runs').loadNativeHistory(session.id, (await f.harness.getRun(next.id)).resultNodeId)
    assert.deepEqual([...new Set(history.records.map(record => record.formatVersion))], [1, 2])
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocolId of Object.keys(factories)) test(`${protocolId}: image capability is required before Run acceptance`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-images-capability-')), state = { secrets: new Map(), requests: [], responses: [] }
  const f = await host(directory, protocolId, state)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default'), picture = await importPicture(f, session.id)
    await assert.rejects(f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: '', images: [{ assetId: picture.image.assetId }], idempotencyKey: 'image' }), { category: 'unsupported-request' })
    assert.equal(state.requests.length, 0); assert.deepEqual(await f.harness.listRuns(session.id), [])
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocolId of ['responses', 'anthropic-messages', 'gemini-interactions']) for (const cancel of [false, true]) test(`${protocolId}: accepted images survive ${cancel ? 'cancellation' : 'failure'} without a success node`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-images-failure-'))
  const state = { secrets: new Map(), requests: [], responses: [cancel ? answer(protocolId, 'late') : { error: { message: 'failed' } }] }
  const f = await host(directory, protocolId, state, { images: true })
  let release, enter
  const entered = new Promise(resolve => { enter = resolve }), gate = new Promise(resolve => { release = resolve })
  if (cancel) state.beforeResponse = () => { enter(); return gate }
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default'), picture = await importPicture(f, session.id)
    const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: '', images: [{ assetId: picture.image.assetId }], idempotencyKey: 'image' })
    if (cancel) { await entered; await f.harness.cancelRun(accepted.id); release() }
    const settled = await f.harness.waitRun(accepted.id)
    assert.equal(settled.status, cancel ? 'cancelled' : 'failed'); assert.equal(settled.resultNodeId, undefined)
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
    const read = f.harness.getImage(session.id, picture.image.assetId)
    assert.deepEqual(Buffer.from((await read.result).bytes), picture.bytes); await read.done
    const record = (await f.harness.getRunRecords(accepted.id)).find(record => record.kind === 'request')
    assert.equal(record.resourceRefs[0].id, picture.image.assetId)
    assert.doesNotMatch(JSON.stringify(record), /base64|data:image/)
  } finally { release(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const protocolId of Object.keys(factories)) test(`${protocolId}: project file snapshots survive retry, branches and restart without rereading source`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-native-files-'))
  const state = { secrets: new Map(), requests: [], responses: [answer(protocolId, 'file-root'), answer(protocolId, 'file-child'), answer(protocolId, 'file-regenerated')] }
  let f = await host(directory, protocolId, state, { images: true })
  const joinCall = async call => { try { return await call.result } finally { await call.done } }
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    writeFileSync(join(directory, 'source.txt'), 'FILE-CONTENT-MARKER\nsecond line\n')
    const refs = await joinCall(f.harness.prepareProjectFiles(session.id, 'prepare', [{ kind: 'project-file', path: 'source.txt', range: { start: 1, end: 1 } }]))
    writeFileSync(join(directory, 'source.txt'), 'CHANGED-SOURCE-MARKER')
    const input = { sessionId: session.id, parentNodeId: null, input: '', files: refs.map(file => ({ snapshotId: file.snapshotId })), idempotencyKey: 'file-run' }
    const accepted = await f.harness.startRun(input), first = await f.harness.waitRun(accepted.id)
    assert.equal(first.status, 'completed', JSON.stringify(first)); assert.equal(first.nativeInput.schemaVersion, 3)
    assert.equal((await f.harness.startRun(input)).id, first.id)
    assert.throws(() => f.harness.startRun({ ...input, files: [] }), /input must contain/)
    const sent = JSON.stringify(state.requests[0])
    assert.match(sent, /FILE-CONTENT-MARKER/); assert.doesNotMatch(sent, /CHANGED-SOURCE|second line/)
    assert.ok(!sent.includes(directory))
    const records = await f.harness.getRunRecords(first.id)
    assert.match(JSON.stringify(records), /FILE-CONTENT-MARKER/)
    assert.equal(records.find(record => record.kind === 'request').resourceRefs?.length ?? 0, 0)
    const node = await f.harness.getNode(session.id, first.resultNodeId)
    assert.equal(node.files[0].snapshotId, refs[0].snapshotId)
    const image = await joinCall(f.harness.importImage(session.id, (async function* () { yield await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer() })()))
    const child = await f.harness.startRun({ sessionId: session.id, parentNodeId: first.resultNodeId, input: 'follow with image', images: [{ assetId: image.assetId }], idempotencyKey: 'child' })
    assert.equal((await f.harness.waitRun(child.id)).status, 'completed')
    assert.equal(JSON.stringify(state.requests[1]).split('FILE-CONTENT-MARKER').length - 1, 1)
    await f.close(); f = await host(directory, protocolId, state, { images: true })
    const restored = await joinCall(f.harness.getFileSnapshot(session.id, refs[0].snapshotId))
    assert.equal(restored.text, 'FILE-CONTENT-MARKER\n'); assert.equal(restored.file.expiresAt, undefined)
    const regenerated = await f.harness.startRun({ ...input, input: 'regenerate with text', images: [{ assetId: image.assetId }], idempotencyKey: 'regenerated' })
    assert.equal((await f.harness.waitRun(regenerated.id)).status, 'completed')
    assert.match(JSON.stringify(state.requests[2]), /FILE-CONTENT-MARKER/)
    const other = await f.harness.createSession(f.project.id, 'assistant', 'default')
    await assert.rejects(f.harness.startRun({ ...input, sessionId: other.id }), { code: 'file-missing' })
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

for (const cancel of [false, true]) test(`project files remain retained after ${cancel ? 'cancellation' : 'failure'} and template expansion never rewrites file text`, async () => {
  const protocolId = 'chat-completions', directory = mkdtempSync(join(tmpdir(), 'anybox-file-failure-'))
  const state = { secrets: new Map(), requests: [], responses: [cancel ? answer(protocolId, 'late') : { error: { message: 'failed' } }] }
  const f = await host(directory, protocolId, state)
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  if (cancel) state.beforeResponse = () => { entered(); return gate }
  try {
    const template = await f.harness.createPrompt('owner', { name: 'Task', kind: 'task-template', role: 'user', content: 'TASK:{{input}}' })
    await f.harness.bindPrompt('owner', 'assistant', (await f.harness.publishPrompt('owner', template.id)).id)
    const session = await f.harness.createSession(f.project.id, 'assistant', 'default')
    writeFileSync(join(directory, 'file'), 'literal {{input}}')
    const call = f.harness.prepareProjectFiles(session.id, 'prepare', [{ kind: 'project-file', path: 'file' }])
    const [ref] = await call.result; await call.done
    const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'question', files: [{ snapshotId: ref.snapshotId }], idempotencyKey: 'run' })
    if (cancel) { await started; await f.harness.cancelRun(accepted.id); release() }
    const settled = await f.harness.waitRun(accepted.id)
    assert.equal(settled.status, cancel ? 'cancelled' : 'failed'); assert.equal(settled.resultNodeId, undefined)
    const sent = state.requests[0].messages.at(-1).content
    assert.match(sent, /^TASK:question/); assert.match(sent, /literal \{\{input\}\}/)
    const read = f.harness.getFileSnapshot(session.id, ref.snapshotId)
    const content = await read.result; await read.done
    assert.equal(content.file.expiresAt, undefined); assert.equal(content.text, 'literal {{input}}')
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes, [])
  } finally { release(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

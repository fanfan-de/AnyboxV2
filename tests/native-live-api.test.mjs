import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@nya/core'
import {
  createModelsComponent, createModelsStoreComponent, createModelsVaultComponent, unknownCapabilities,
  createResponsesProtocol, createChatCompletionsProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol,
} from '@anybox/models'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { projectProtocolRecords } from '../dist/applications/harness/core/protocol-agents/projection.js'
import sharp from 'sharp'

// Live text/image/restart smoke; this is not live tool, search, streaming or OS Keyring acceptance.
// Nothing runs unless BOTH gates are explicit:
//   ANYBOX_NATIVE_API_TESTS=1
//   ANYBOX_NATIVE_API_PROTOCOLS=responses,chat-completions,anthropic-messages,gemini-interactions
// Select only the protocols to exercise. For EACH selected ID, uppercase it and replace '-' with '_':
//   ANYBOX_NATIVE_API_<ID>_ENDPOINT    Exact API base URL (no inferred provider/hostname/default).
//   ANYBOX_NATIVE_API_<ID>_MODEL       Exact remote model ID.
//   ANYBOX_NATIVE_API_<ID>_KEY         API key, kept only in the test's in-memory Vault.
//   ANYBOX_NATIVE_API_<ID>_PARAMETERS  Native JSON object, with an explicit positive output-token limit.
// Limit paths: Responses max_output_tokens; Chat max_completion_tokens OR max_tokens; Anthropic max_tokens;
// Gemini generation_config.max_output_tokens. No tools or reasoning controls are enabled by this smoke.
// DeepSeek uses chat-completions with explicit PARAMETERS such as {"max_tokens":128,"thinking":{"type":"disabled"}}.
// After npm run build: node --test tests/native-live-api.test.mjs
// Additionally set ANYBOX_NATIVE_API_IMAGES=1 to exercise images for selected models.
const factories = {
  responses: createResponsesProtocol,
  'chat-completions': createChatCompletionsProtocol,
  'anthropic-messages': createAnthropicMessagesProtocol,
  'gemini-interactions': createGeminiInteractionsProtocol,
}
const enabled = process.env.ANYBOX_NATIVE_API_TESTS === '1'
const selected = enabled ? new Set((process.env.ANYBOX_NATIVE_API_PROTOCOLS ?? '').split(',').map(value => value.trim()).filter(Boolean)) : new Set()
if (enabled && (!selected.size || [...selected].some(id => !Object.hasOwn(factories, id)))) {
  throw new Error('ANYBOX_NATIVE_API_PROTOCOLS must explicitly select supported protocol IDs; no live request was started.')
}

function configuration(protocolId) {
  const prefix = `ANYBOX_NATIVE_API_${protocolId.toUpperCase().replaceAll('-', '_')}`
  const required = suffix => {
    const value = process.env[`${prefix}_${suffix}`]
    if (!value?.trim()) throw new Error(`${prefix}_${suffix} is required.`)
    return value
  }
  const endpoint = required('ENDPOINT'), model = required('MODEL'), key = required('KEY')
  let url, parameters
  try { url = new URL(endpoint) } catch { throw new Error(`${prefix}_ENDPOINT must be an API base URL.`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${prefix}_ENDPOINT must not include credentials, query parameters or fragments.`)
  }
  const raw = required('PARAMETERS')
  try { parameters = JSON.parse(raw) } catch { throw new Error(`${prefix}_PARAMETERS must be a native JSON object.`) }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`${prefix}_PARAMETERS must be a native JSON object.`)
  const tokenLimit = protocolId === 'responses' ? parameters.max_output_tokens
    : protocolId === 'chat-completions' ? parameters.max_completion_tokens ?? parameters.max_tokens
      : protocolId === 'gemini-interactions' ? parameters.generation_config?.max_output_tokens : parameters.max_tokens
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1) throw new Error(`${prefix}_PARAMETERS requires an explicit positive native output-token limit.`)
  if ('tools' in parameters) throw new Error(`${prefix}_PARAMETERS cannot enable tools in this text smoke.`)
  const capabilities = { ...unknownCapabilities(), tools: { support: 'unsupported' }, streaming: { support: 'unsupported' }, webSearch: { support: 'unsupported' } }
  factories[protocolId]().validateParameters(parameters, capabilities)
  return { endpoint, model, key, parameters, capabilities }
}

async function host(directory, protocolId, config, secrets) {
  const root = new Context()
  const install = async component => {
    const fiber = root.installComponent(component)
    await fiber
    if (fiber.state !== FiberState.ACTIVE) throw new Error('Live smoke component initialization failed.')
  }
  try {
    await install(createModelsStoreComponent({ path: join(directory, 'models.sqlite') }))
    await install(createModelsVaultComponent({ namespace: 'anybox-native-live-smoke', openEntry(_namespace, id) {
      return {
        async getPassword() { return secrets.get(id) },
        async setPassword(value) { secrets.set(id, value) },
        async deleteCredential() { return secrets.delete(id) },
      }
    } }))
    await install(createModelsComponent())
    await install({ name: 'live-native-protocol', inject: ['models.protocols'], apply(ctx, _config, deps) {
      const registration = deps['models.protocols'].register(factories[protocolId]())
      ctx.effect(() => () => registration.unregister(), 'release live native protocol')
    } })
    const settings = root.get('models.settings')
    if (!settings.connections().length) {
      const provider = await settings.createProvider({ name: 'Live smoke provider', connectionHints: { protocolIds: [protocolId] } })
      const connection = await settings.createConnection({ id: 'live-connection', providerDefinitionId: provider.id, name: 'Live smoke connection', enabled: true,
        protocolId, baseUrl: config.endpoint, auth: 'api-key', apiKey: config.key, timeoutMs: 60_000 })
      const definition = await settings.createModel({ name: 'Live smoke model', providerId: provider.id, remoteModelId: config.model,
        capabilities: config.capabilities, controls: { temperature: 'unknown' }, modalities: { input: config.capabilities.imageInput.support === 'supported' ? ['text', 'image'] : ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } })
      await settings.createConfiguration({ id: 'live-model', name: 'Live smoke configuration', enabled: true, connectionId: connection.id,
        modelDefinitionId: definition.id, capabilities: config.capabilities, baseline: true,
        parameters: { protocolId, formatVersion: 1, value: config.parameters } })
    }
    await install(createLocalSqliteComponent(join(directory, 'sessions.sqlite')))
    await install(createImageAssetsComponent({ directory: (join(directory, 'sessions.sqlite')) + ".images" }))
    const harness = await createTestHarnessServerCore(root, { agents: [{ id: 'live-assistant', modelId: 'live-model', instructions: 'Follow the user exactly. Reply with the single requested word only, without punctuation or explanations.' }] })
    const project = await harness.openProject(directory)
    return { harness, project }
  } catch {
    await root.fiber.dispose()
    throw new Error('Live smoke host initialization failed; verify the explicit native configuration.')
  }
}

async function completedRun(current, protocolId, config, sessionId, parentNodeId, input, expected, idempotencyKey, images = []) {
  const accepted = await current.harness.startRun({ sessionId, parentNodeId, input, idempotencyKey, images })
  const settled = await current.harness.waitRun(accepted.id)
  assert.ok(settled.status === 'completed' && typeof settled.resultNodeId === 'string', 'Live Run must complete and create a resumable node.')
  const records = await current.harness.getRunRecords(accepted.id)
  assert.ok(records.some(record => record.kind === 'response'), 'Live Run must persist a native response.')
  assert.ok(!JSON.stringify(records).includes(config.key), 'Native records must exclude the API credential.')
  const text = projectProtocolRecords(protocolId, records).flatMap(exchange => exchange.blocks).flatMap(block => {
    if (block.type === 'responses.message') return block.content.filter(part => part.type === 'output_text').map(part => part.text)
    if (block.type === 'gemini.model_output') return block.content.map(part => part.text)
    if (block.type === 'anthropic.text' || block.type === 'chat.content') return [block.text]
    return []
  }).join('')
  // Do not include actual provider output or raw errors in test assertions/logs.
  assert.ok(text.trim() === expected, 'Live response must match the requested one-word answer.')
  assert.ok(!(await current.harness.getRunEvents(accepted.id)).some(event => event.kind === 'tool-started'), 'This smoke must not execute local tools.')
  return settled
}

for (const protocolId of Object.keys(factories)) test(`${protocolId}: opt-in live text and restart continuation smoke`, {
  skip: !selected.has(protocolId), timeout: 150_000,
}, async t => {
  const config = configuration(protocolId)
  const directory = mkdtempSync(join(tmpdir(), 'anybox-native-live-'))
  const secrets = new Map()
  let current, stage = 'initialization'
  const stop = () => { void current?.harness.close().catch(() => {}) }
  t.signal.addEventListener('abort', stop, { once: true })
  try {
    current = await host(directory, protocolId, config, secrets)
    const session = await current.harness.createSession(current.project.id, 'live-assistant', 'live-model')
    stage = 'first text Run'
    const first = await completedRun(current, protocolId, config, session.id, null, 'Remember this reference word: ORCHID. Reply with READY only.', 'READY', 'live-first')
    const originalRecords = JSON.stringify(await current.harness.getRunRecords(first.id))
    stage = 'close and reopen'
    await current.harness.close()
    current = undefined
    current = await host(directory, protocolId, config, secrets)
    assert.ok(JSON.stringify(await current.harness.getRunRecords(first.id)) === originalRecords, 'Reopening must preserve the first Run native records.')
    stage = 'explicit parent continuation'
    await completedRun(current, protocolId, config, session.id, first.resultNodeId, 'Reply with the reference word from the first user message only.', 'ORCHID', 'live-after-restart')
  } catch {
    throw new Error(`Live native text/restart smoke failed during ${stage}; provider details and credentials are intentionally omitted.`)
  } finally {
    t.signal.removeEventListener('abort', stop)
    try { await current?.harness.close() } finally { secrets.clear(); rmSync(directory, { recursive: true, force: true }) }
  }
})

for (const protocolId of Object.keys(factories)) test(`${protocolId}: opt-in live image and restart continuation smoke`, {
  skip: !selected.has(protocolId) || process.env.ANYBOX_NATIVE_API_IMAGES !== '1', timeout: 150_000,
}, async t => {
  const base = configuration(protocolId), config = { ...base, capabilities: { ...base.capabilities, imageInput: { support: 'supported' } } }
  const directory = mkdtempSync(join(tmpdir(), 'anybox-native-live-image-')), secrets = new Map()
  let current, stage = 'initialization'
  const stop = () => { void current?.harness.close().catch(() => {}) }
  t.signal.addEventListener('abort', stop, { once: true })
  try {
    current = await host(directory, protocolId, config, secrets)
    const session = await current.harness.createSession(current.project.id, 'live-assistant', 'live-model')
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const upload = current.harness.importImage(session.id, (async function* () { yield bytes })())
    const image = await upload.result; await upload.done
    stage = 'image recognition'
    const first = await completedRun(current, protocolId, config, session.id, null,
      'What is the dominant color of this image? Reply with the uppercase English color name only.', 'RED', 'live-image', [{ assetId: image.assetId }])
    const original = JSON.stringify(await current.harness.getRunRecords(first.id))
    assert.ok(!original.includes('base64') && !original.includes('data:image'), 'Image records must contain references, not wire bytes.')
    stage = 'restart'
    await current.harness.close(); current = undefined
    current = await host(directory, protocolId, config, secrets)
    stage = 'image history continuation'
    await completedRun(current, protocolId, config, session.id, first.resultNodeId,
      'What was the dominant color of the image in the first user message? Reply with the uppercase English color name only.', 'RED', 'live-image-restored')
    assert.ok(JSON.stringify(await current.harness.getRunRecords(first.id)) === original, 'Image history must remain immutable.')
  } catch { throw new Error(`Live image smoke failed during ${stage}; provider details and credentials are intentionally omitted.`) }
  finally {
    t.signal.removeEventListener('abort', stop)
    try { await current?.harness.close() } finally { secrets.clear(); rmSync(directory, { recursive: true, force: true }) }
  }
})

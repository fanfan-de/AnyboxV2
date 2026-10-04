/** Real disposable Models/Harness/Web assembly. All external traffic and credentials are in-memory mocks. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createTestHarnessServerCore } from './harness-server-core.mjs'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../../dist/applications/harness/core/image/component.js'
import { installHarnessServerModels } from '../../dist/applications/harness/server-models.js'
import { parseHarnessServerConfig } from '../../dist/applications/harness/server-config.js'
import { createDirectoryPickerComponent } from '../../dist/applications/harness/client/directory-picker.js'
import { hostHttpServiceKey } from '../../dist/host/component.js'
import { createFixtureApplicationApiComponent } from './application-api.mjs'

export const catalogModelsData = Object.freeze({
  anthropic: { id: 'anthropic', name: 'Anthropic QA', api: 'https://api.anthropic.com/v1', npm: '@ai-sdk/anthropic', doc: 'https://docs.anthropic.com', models: {
    'claude-qa': { id: 'claude-qa', name: 'Claude QA', family: 'claude', tool_call: true, streaming: true, reasoning: true, temperature: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], modalities: { input: ['text'], output: ['text'] }, limit: { context: 200_000, output: 8192 }, cost: { input: 3, output: 15 } },
    'claude-old': { id: 'claude-old', name: 'Claude Deprecated', status: 'deprecated', tool_call: false, streaming: true, reasoning: false, modalities: { input: ['text'], output: ['text'] } },
  } },
  google: { id: 'google', name: 'Google QA', api: 'https://generativelanguage.googleapis.com/v1beta', npm: '@ai-sdk/google', models: {
    'gemini-qa': { id: 'gemini-qa', name: 'Gemini QA', tool_call: true, streaming: true, reasoning: true, temperature: false,
      reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'high'] }], modalities: { input: ['text'], output: ['text'] }, limit: { context: 100_000, output: 8192 } },
    'gemini-image': { id: 'gemini-image', name: 'Gemini Image QA', type: 'image', tool_call: false, modalities: { input: ['text', 'image'], output: ['image'] } },
  } },
  unsupported: { id: 'unsupported', name: 'Unsupported QA', api: 'https://unsupported.invalid/v1', npm: '@qa/custom-sdk', models: {
    'custom-qa': { id: 'custom-qa', name: 'Custom QA', modalities: { input: ['text'], output: ['text'] } },
  } },
})
const text = value => ({ type: 'text', text: value })
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } })
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
function anthropicReply(body, number) {
  const last = body.messages.at(-1), blocks = Array.isArray(last?.content) ? last.content : []
  const hasToolResult = blocks.some(block => block.type === 'tool_result')
  const prompt = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const wantsTool = !hasToolResult && /bash|tool|工具/iu.test(prompt) && body.tools?.some(tool => tool.name === 'bash')
  const answer = hasToolResult ? 'Mock native final answer: catalog-tool-observed' : wantsTool ? 'I will run Bash.' : `Mock native answer: ${prompt}`
  const content = [text(answer), ...(wantsTool ? [{ type: 'tool_use', id: `toolu_qa_${number}`, name: 'bash', input: { command: 'printf catalog-tool-observed' } }] : [])]
  const stop_reason = wantsTool ? 'tool_use' : 'end_turn'
  const message = { id: `msg_qa_${number}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 7 } }
  if (!body.stream) return json(message)
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }]
  for (const [index, block] of content.entries()) {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? text('') : { ...block, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    events.push({ type: 'content_block_stop', index })
  }
  events.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: 'message_stop' })
  return sse(events)
}
function geminiReply(body, number) {
  const last = body.input.at(-1)
  const hasToolResult = last?.type === 'function_result'
  const prompt = last?.type === 'user_input' ? (last.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
  const wantsTool = !hasToolResult && /bash|tool|工具/iu.test(prompt) && body.tools?.some(tool => tool.name === 'bash')
  const answer = hasToolResult ? 'Mock native final answer: catalog-tool-observed' : wantsTool ? 'I will run Bash.' : `Mock native answer: ${prompt}`
  const steps = [{ type: 'model_output', content: [text(answer)] }, ...(wantsTool ? [{ type: 'function_call', id: `gemini_native_qa_${number}`, name: 'bash', arguments: { command: 'printf catalog-tool-observed' } }] : [])]
  const status = wantsTool ? 'requires_action' : 'completed'
  const usage = { total_input_tokens: 5, total_output_tokens: 7, total_tokens: 12 }
  if (!body.stream) return json({ id: `interaction_qa_${number}`, status, steps, usage })
  const events = [{ event_type: 'interaction.created', interaction: { id: `interaction_qa_${number}`, status: 'in_progress' } }]
  for (const [index, step] of steps.entries()) {
    events.push({ event_type: 'step.start', index, step: step.type === 'model_output' ? { type: 'model_output' } : { ...step, arguments: {} } })
    events.push({ event_type: 'step.delta', index, delta: step.type === 'model_output' ? { type: 'text', text: answer } : { type: 'arguments_delta', arguments: JSON.stringify(step.arguments) } })
    events.push({ event_type: 'step.stop', index })
  }
  events.push({ event_type: 'interaction.completed', interaction: { id: `interaction_qa_${number}`, status, usage } })
  return sse(events)
}

/**
 * options: catalogData, catalogFetch, protocolFetch, initialRefresh (default true),
 * seedModels/seedSession (default false), port (default 0). No fallback to real fetch/keyring.
 */
export async function startCatalogModelsHost(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-catalog-web-'))
  const projectPath = join(directory, 'project')
  await mkdir(projectPath)
  const root = new Context(), secrets = new Map(), vaultOperations = []
  const network = { catalog: [], protocol: [], generations: [], checks: [] }
  const catalogQueue = []
  let catalogData = structuredClone(options.catalogData ?? catalogModelsData), etagNumber = 1, harness, closing
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'),
    ANYBOX_MODELS_CATALOG_DATABASE: join(directory, 'models-catalog.sqlite'), ANYBOX_MODELS_NAMESPACE: 'catalog-web-qa', ANYBOX_WEB_PORT: String(options.port ?? 0) })
  const catalogFetch = async (url, init) => {
    const record = { url: String(url), method: init.method, headers: { ...init.headers }, signal: init.signal }
    network.catalog.push(record)
    const queued = catalogQueue.shift()
    if (queued) return typeof queued === 'function' ? queued(url, init, record) : queued
    if (options.catalogFetch) return options.catalogFetch(url, init, record)
    const etag = `qa-catalog-${etagNumber}`
    return init.headers['If-None-Match'] === etag ? new Response(null, { status: 304, headers: { etag } }) : json(catalogData, { etag })
  }
  const protocolFetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    const record = { url: String(url), method: init.method, headers: { ...init.headers }, body, signal: init.signal }
    network.protocol.push(record)
    const generated = init.method === 'POST' && /\/(?:messages|interactions)$/u.test(new URL(url).pathname)
    if (generated) network.generations.push(record)
    else network.checks.push(record)
    if (options.protocolFetch) return options.protocolFetch(url, init, record)
    if (!generated) {
      return record.headers['x-api-key'] !== undefined
        ? json({ data: [{ id: 'claude-qa', display_name: 'Claude QA' }], has_more: false })
        : json({ models: [{ name: 'models/gemini-qa', displayName: 'Gemini QA' }] })
    }
    return new URL(url).pathname.endsWith('/messages') ? anthropicReply(body, network.generations.length) : geminiReply(body, network.generations.length)
  }
  try {
    await installHarnessServerModels(root, config, { catalogAutoRefresh: false, catalogFetch, fetch: protocolFetch, readLegacyCredential: async () => undefined,
      openEntry(namespace, id) {
        const key = `${namespace}\0${id}`
        return {
          async getPassword() { vaultOperations.push({ kind: 'read', namespace, id }); return secrets.get(key) },
          async setPassword(value) { vaultOperations.push({ kind: 'write', namespace, id }); secrets.set(key, value) },
          async deleteCredential() { vaultOperations.push({ kind: 'delete', namespace, id }); return secrets.delete(key) },
        }
      },
    })
    if (options.initialRefresh !== false) await root.get('models.catalog').refresh()
    const seededModels = []
    if (options.seedModels) {
      for (const [providerId, protocolId, remoteModelId] of [['anthropic', 'anthropic-messages', 'claude-qa'], ['google', 'gemini-interactions', 'gemini-qa']]) {
        const settings = root.get('models.settings')
        const definition = settings.providers().find(value => value.source.kind === 'external' && value.source.sourceId === 'models.dev' && value.source.providerId === providerId)
        const connection = await settings.createConnection({ id: `qa-${providerId}`, providerDefinitionId: definition.id, name: `${providerId} QA proxy`, enabled: true, protocolId,
          baseUrl: providerId === 'anthropic' ? 'https://qa-proxy.invalid/anthropic/v1' : 'https://qa-proxy.invalid/google/v1beta', auth: 'api-key', apiKey: `qa-${providerId}-key`, timeoutMs: 30_000 })
        const model = settings.configurations(connection.id).find(value => value.remoteModelId === remoteModelId && value.baseline)
        seededModels.push(await settings.updateConfiguration(model.id, { parameters: { protocolId, formatVersion: 1, value: protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : { generation_config: { max_output_tokens: 4096 } } } }, model.revision))
      }
    }
    await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
    harness = await createTestHarnessServerCore(root, { agents: [{ id: 'assistant', instructions: 'Answer briefly. Use Bash when the user asks for a tool.' }] })
    const project = await harness.openProject(projectPath)
    await root.installComponent(createDirectoryPickerComponent({ platform: 'darwin', runDialog: async () => projectPath }))
    await root.installComponent(createFixtureApplicationApiComponent(root, harness.listAgents(), config.port))
    const web = root.get(hostHttpServiceKey)
    const session = options.seedSession ? await harness.createSession(project.id, 'assistant', seededModels[0]?.id) : undefined
    return {
      root, harness, web, project, directory, config, network, secrets, vaultOperations, seededModels, session,
      setCatalogData(data) { catalogData = structuredClone(data); etagNumber++ },
      queueCatalogResponse(responseOrFactory) { catalogQueue.push(responseOrFactory) },
      close() {
        if (!closing) closing = (async () => { try { await harness.close() } finally { await rm(directory, { recursive: true, force: true }) } })()
        return closing
      },
    }
  } catch (error) {
    try { await (harness ? harness.close() : root.fiber.dispose()) } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

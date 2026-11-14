// @ts-check
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@nya/core'
import { createModelsComponent, createModelsStoreComponent, createModelsVaultComponent,
  createChatCompletionsProtocol, unknownCapabilities } from '@anybox/models'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { installHarnessServerCore } from '@anybox/app-harness/core/index'
import { createImageAssetsComponent } from '@anybox/app-harness/core/image/component'
import { createNotesEnvironment } from './environment.mjs'

const agent = Object.freeze({ id: 'assistant', modelId: 'notes-demo-model', instructions: 'Use the tools available to you to answer the user.' })
const task = '查找 Anybox 发布检查资料，读取命中文档并列出发布前要做的事。'

/** @typedef {{role: string, content?: string | null}} Message */
/** @typedef {{messages: readonly Message[], tools?: readonly {function: {name: string}}[]}} ModelRequest */

/** A deterministic offline model transport, not a replacement Agent or tool loop. */
function offlineModel() {
  /** @type {ModelRequest[]} */
  const requests = []
  /** @param {string} text @param {{name: string, args: object} | undefined} [tool] */
  const reply = (text, tool) => ({ choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: {
    role: 'assistant', content: text,
    ...(tool ? { tool_calls: [{ id: `demo-call-${requests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}),
  } }] })
  /** @type {typeof fetch} */
  const fetchReply = async (_url, init) => {
    init?.signal?.throwIfAborted()
    if (typeof init?.body !== 'string') throw new Error('expected a native JSON model request')
    const request = /** @type {ModelRequest} */ (JSON.parse(init.body))
    requests.push(structuredClone(request))
    const names = (request.tools ?? []).map(tool => tool.function.name)
    const results = request.messages.filter(message => message.role === 'tool')
    let response
    if (!names.includes('notes_search') || !names.includes('notes_read')) response = reply('当前会话没有资料库工具。')
    else if (results.length === 0) response = reply('', { name: 'notes_search', args: { query: '发布检查' } })
    else if (results.length === 1) {
      const search = /** @type {{notes: {id: string}[]}} */ (JSON.parse(results[0].content ?? '{}'))
      if (!search.notes?.length) throw new Error('the actual notes search returned no release checklist')
      response = reply('', { name: 'notes_read', args: { id: search.notes[0].id } })
    } else {
      const note = /** @type {{content: string}} */ (JSON.parse(results.at(-1)?.content ?? '{}'))
      response = reply(note.content)
    }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
  }
  return { requests, protocol: createChatCompletionsProtocol({ fetch: fetchReply }) }
}

/** @returns {Promise<readonly import('./environment.mjs').Note[]>} */
export async function loadExampleNotes() {
  return Promise.all(['release-checklist', 'environment-guide'].map(async id => {
    const content = await readFile(new URL(`./data/${id}.md`, import.meta.url), 'utf8')
    return { id, title: content.split('\n')[0].replace(/^#\s*/, ''), content }
  }))
}

/** @param {string} directory @param {readonly import('@anybox/tool-api').ToolEnvironment[]} environments */
async function openExample(directory, environments) {
  const root = new Context(), model = offlineModel()
  try {
    await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite') }))
    await root.installComponent(createModelsVaultComponent({ namespace: 'anybox-notes-example', openEntry() {
      throw new Error('this offline example must not open system credentials')
    } }))
    await root.installComponent(createModelsComponent())
    const protocols = /** @type {import('@anybox/models').ModelsProtocolsService} */ (root.get('models.protocols'))
    protocols.register(model.protocol)
    const settings = /** @type {import('@anybox/models').ModelsSettingsService} */ (root.get('models.settings'))
    if (!settings.connections().length) {
      const capabilities = { ...unknownCapabilities(), tools: { support: /** @type {const} */ ('supported') }, streaming: { support: /** @type {const} */ ('unsupported') } }
      const provider = await settings.createProvider({ name: 'Offline notes example', connectionHints: { protocolIds: ['chat-completions'] } })
      const connection = await settings.createConnection({ id: 'notes-demo-connection', providerDefinitionId: provider.id,
        name: 'Offline', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://offline.invalid/v1', auth: 'none', timeoutMs: 1000 })
      const definition = await settings.createModel({ providerId: provider.id, name: 'Offline fixture', remoteModelId: 'offline', capabilities,
        modalities: { input: ['text'], output: ['text'] }, controls: { temperature: 'unknown' }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } })
      await settings.createConfiguration({ id: agent.modelId, name: 'Offline fixture', enabled: true, connectionId: connection.id,
        modelDefinitionId: definition.id, capabilities, baseline: true, parameters: { protocolId: 'chat-completions', formatVersion: 1, value: {} } })
    }
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))

    // This is the entire environment-specific assembly change. Agent source,
    // prompt, model drivers, native loops and RunRuntime are shared unchanged.
    const installation = await installHarnessServerCore(root, {
      agents: [{ ...agent, environmentIds: environments.map(environment => environment.environmentId) }],
      toolEnvironments: environments, localWorkerDirectory: join(directory, 'unused-computer-worker'),
    })
    return { root, api: installation.api, model, async close() {
      try { await installation.close() } finally { await root.fiber.dispose() }
    } }
  } catch (error) { await root.fiber.dispose(); throw error }
}

/** @param {Awaited<ReturnType<typeof openExample>>} host @param {string} sessionId @param {string} key */
async function run(host, sessionId, key) {
  const firstRequest = host.model.requests.length
  const accepted = await host.api.startRun({ sessionId, parentNodeId: null, input: task, idempotencyKey: key })
  const finished = await host.api.waitRun(accepted.id)
  if (finished?.status !== 'completed') throw new Error(`example Run failed: ${finished?.errorCategory}`)
  const events = await host.api.getRunEvents(accepted.id)
  const calls = (events ?? []).flatMap(event => event.kind === 'tool-started' ? [event.call.name] : [])
  return { declaredTools: (host.model.requests[firstRequest].tools ?? []).map(tool => tool.function.name), calls, answer: finished.output }
}

/** Real data and production Agent/runtime; only upstream model responses are simulated. */
export async function runNotesDemo() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-notes-example-')))
  try {
    const workspace = join(directory, 'workspace'); await mkdir(workspace)
    const before = await openExample(directory, [])
    let originalSessionId
    let withoutEnvironment
    try {
      const project = await before.api.openProject(workspace)
      const session = await before.api.createSession(project.id, agent.id)
      originalSessionId = session.id
      withoutEnvironment = await run(before, session.id, 'without-notes')
    } finally { await before.close() }

    const notes = createNotesEnvironment(await loadExampleNotes())
    const after = await openExample(directory, [notes])
    try {
      const project = await after.api.openProject(workspace)
      const fresh = await after.api.createSession(project.id, agent.id)
      const newSession = await run(after, fresh.id, 'with-notes')
      const existingSession = await run(after, originalSessionId, 'old-session-after-insertion')
      const storage = /** @type {import('@anybox/storage-sqlite/port').LocalStoragePort} */ (after.root.get('local-storage'))
      const computerOperations = await storage.read(reader => Number(reader.get('SELECT COUNT(*) AS count FROM harness_computer_operations')?.count))
      return { mode: 'offline model; real Markdown, native protocol, Agent and tools', withoutEnvironment, newSession, existingSession, computerOperations }
    } finally { await after.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await runNotesDemo(), null, 2) + '\n')
}

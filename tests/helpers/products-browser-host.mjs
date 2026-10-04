/** Disposable product/browser acceptance host. No real data, credentials or network access. */
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createHarnessServer } from '../../dist/entrypoints/harness-server-main.js'
import { createClientHost } from '../../dist/entrypoints/client-main.js'
import { harnessClientApplication } from '../../dist/applications/harness/registration.js'
import { testApplication } from './test-application.mjs'
import { parseHarnessServerConfig } from '../../dist/applications/harness/server-config.js'

const directory = await mkdtemp(join(tmpdir(), 'anybox-products-browser-'))
const secrets = new Map()
const openEntry = (namespace, id) => ({
  async getPassword() { return secrets.get(`${namespace}:${id}`) },
  async setPassword(value) { secrets.set(`${namespace}:${id}`, value) },
  async deleteCredential() { secrets.delete(`${namespace}:${id}`) },
})
const notesSource = await readFile(new URL('../fixtures/application/index.js', import.meta.url), 'utf8'), notesFile = join(directory, 'notes.js')
await writeFile(notesFile, notesSource)
const notes = testApplication()
const notesRegistration = { ...notes, assets: notes.assets.map(asset => asset.path.endsWith('/index.js') ? { ...asset, file: notesFile } : asset) }
let host, client, closing, releaseModel
let modelGate
const stop = () => closing ??= (async () => {
  await client?.close(); await host?.close(); await rm(directory, { recursive: true, force: true })
})()
try {
  const project = join(directory, 'Example'); await mkdir(project)
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'business.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite') })
  host = await createHarnessServer(config, { name: '本地测试 Agent', projects: [project], models: {
    openEntry, catalogAutoRefresh: false, readLegacyCredential: async () => 'disposable-controlled-model-key',
    catalogFetch: async () => { throw new Error('Network is disabled in product acceptance') },
    fetch: async (_input, init) => {
      if (modelGate) await new Promise((resolve, reject) => {
        const cancel = () => reject(new DOMException('cancelled', 'AbortError'))
        init.signal?.addEventListener('abort', cancel, { once: true })
        modelGate.then(() => { init.signal?.removeEventListener('abort', cancel); resolve() })
      })
      const body = JSON.parse(String(init?.body ?? '{}'))
      const content = '这是本地受控模型的测试结果。'
      if (body.stream) return new Response(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      return Response.json({ id: 'test', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })
    },
  } })
  await host.ready
  client = await createClientHost({ path: join(directory, 'client.sqlite'), applications: [harnessClientApplication({ localInstanceId: host.instance.instanceId, openEntry }), notesRegistration] })
  await client.products.open('agent')
  const issued = await host.root.get('host.access').issue('Disposable browser acceptance')
  await client.root.get('client.connections').save({ name: '本地测试 Agent', endpoint: host.url, token: issued.token })
  await client.products.disable('agent')
  process.stdout.write(JSON.stringify({ url: client.url, project }) + '\n')
  const input = createInterface({ input: process.stdin })
  input.on('line', async line => {
    if (line === 'fail-ui') { await writeFile(notesFile, 'throw new Error("Controlled interface failure")'); process.stdout.write('interface failed\n') }
    if (line === 'restore-ui') { await writeFile(notesFile, notesSource); process.stdout.write('interface restored\n') }
    if (line === 'hold-model') { modelGate = new Promise(resolve => { releaseModel = resolve }); process.stdout.write('model held\n') }
    if (line === 'release-model') { releaseModel?.(); modelGate = undefined; process.stdout.write('model released\n') }
    if (line === 'state') process.stdout.write(JSON.stringify({ products: host.products.list(), services: ['models', 'harness.prompts', 'harness.runs', 'tools.bash'].filter(key => host.root.get(key)) }) + '\n')
    if (line === 'quit') { input.close(); void stop() }
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { input.close(); void stop() })
} catch (error) { await stop(); throw error }

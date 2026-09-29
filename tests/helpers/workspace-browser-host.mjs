import { createHostAccessComponent } from '../../dist/host/access.js'
import { createClientHost } from '../../dist/host/client-main.js'
/** Local browser acceptance host. Uses disposable SQLite and a controlled model; never reads real keys/data. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createHarness } from '../../dist/harness/index.js'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../../dist/harness/image/component.js'
import { installManagedModels } from './managed-models.mjs'
import { createHarnessApiComponent, harnessApiServiceKey } from '../../dist/host/component.js'
import { controlledModels, deferred } from './controlled-models.mjs'

const directory = mkdtempSync(join(tmpdir(), 'anybox-workspace-browser-'))
const root = new Context()
let harness, client
try {
  const llm = controlledModels({ call(input) {
    const result = deferred(), done = deferred()
    const content = input.messages.filter(item => item.role === 'user').at(-1)?.content ?? ''
    const message = typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : '[图片]').join(' ')
    const timer = setTimeout(() => { result.resolve(`测试回答：${message}\n${'这是用于验证面板独立滚动的内容。\n'.repeat(16)}`); done.resolve() }, message.includes('hold') ? 60000 : 600)
    return { result: result.promise, done: done.promise, cancel() { clearTimeout(timer); result.reject(new Error('cancelled')); done.resolve() } }
  } })
  if (process.env.ANYBOX_TEST_IMAGE_INPUT === '1') {
    const protocol = llm.protocol.bind(llm)
    llm.protocol = (...args) => ({ ...protocol(...args), recordFormatVersion: 2 })
  }
  await installManagedModels(root, directory, { controlled: llm })
  if (process.env.ANYBOX_TEST_IMAGE_INPUT === '1') {
    const settings = root.get('models.settings'), model = settings.configurations().find(model => model.id === 'default')
    await settings.updateConfiguration(model.id, { capabilities: { ...model.capabilities, imageInput: { support: 'supported' } } }, model.revision)
  }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'test.sqlite')))
  await root.installComponent(createHostAccessComponent('Browser test device'))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  harness = await createHarness(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Browser acceptance model.' }] })
  const projects = []
  for (const name of ['Alpha', 'Beta']) { const path = join(directory, name); mkdirSync(path); projects.push(await harness.openProject(path)) }
  const sessions = []
  for (let i = 0; i < 5; i++) {
    const session = await harness.createSession(projects[i < 3 ? 0 : 1].id, 'assistant')
    const run = await harness.startRun({ sessionId: session.id, parentNodeId: null, input: `示例会话 ${i + 1}`, idempotencyKey: `seed-${i}` })
    await harness.waitRun(run.id)
    sessions.push(session)
  }
  await root.installComponent(createHarnessApiComponent(harness.listAgents(), 0, { authenticated: true }))
  const values = new Map(), access = root.get('host.access')
  client = await createClientHost({ path: join(directory, 'client.sqlite'), localInstanceId: access.instance.instanceId, openEntry: (_ns,id) => ({ async getPassword(){ return values.get(id) }, async setPassword(value){ values.set(id,value) }, async deleteCredential(){ return values.delete(id) } }) })
  const issued = await access.issue('browser test')
  await client.root.get('client.connections').save({ name: 'Browser test device', endpoint: root.get(harnessApiServiceKey).url, token: issued.token })
  process.stdout.write(JSON.stringify({ url: client.url, projects, sessions }) + '\n')
  let stopped = false
  const stop = async () => { if (stopped) return; stopped = true; await client.close(); await harness.close(); rmSync(directory, { recursive: true, force: true }) }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch (error) { await client?.close(); await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }); throw error }

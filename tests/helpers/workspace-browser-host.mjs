/** Local browser acceptance host. Uses disposable SQLite and a controlled model; never reads real keys/data. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createHarness } from '../../dist/harness.js'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../../dist/image/component.js'
import { installManagedModels } from './managed-models.mjs'
import { createDirectoryPickerComponent } from '../../dist/web/directory-picker.js'
import { createWebFrontendComponent, webFrontendServiceKey } from '../../dist/web/component.js'
import { controlledModels, deferred } from './controlled-models.mjs'

const directory = mkdtempSync(join(tmpdir(), 'anybox-workspace-browser-'))
const root = new Context()
let harness
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
  await root.installComponent(createDirectoryPickerComponent({ platform: 'linux' }))
  await root.installComponent(createWebFrontendComponent(harness.listAgents()))
  process.stdout.write(JSON.stringify({ url: root.get(webFrontendServiceKey).url, projects, sessions }) + '\n')
  let stopped = false
  const stop = async () => { if (stopped) return; stopped = true; await harness.close(); rmSync(directory, { recursive: true, force: true }) }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch (error) { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }); throw error }

/** Local browser acceptance host. Uses disposable SQLite and a controlled model; never reads real keys/data. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createHarness } from '../../dist/harness.js'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createApiKeyServiceComponent } from '../../dist/credentials/settings.js'
import { createDirectoryPickerComponent } from '../../dist/web/directory-picker.js'
import { createWebFrontendComponent, webFrontendServiceKey } from '../../dist/web/component.js'
import { controlledLLM, deferred } from './controlled-llm.mjs'

const directory = mkdtempSync(join(tmpdir(), 'anybox-workspace-browser-'))
const root = new Context()
let harness
try {
  const llm = controlledLLM({ call(input) {
    const result = deferred(), done = deferred()
    const message = input.messages.filter(item => item.role === 'user').at(-1)?.content ?? ''
    const timer = setTimeout(() => { result.resolve(`测试回答：${message}\n${'这是用于验证面板独立滚动的内容。\n'.repeat(16)}`); done.resolve() }, message.includes('hold') ? 60000 : 600)
    return { result: result.promise, done: done.promise, cancel() { clearTimeout(timer); result.reject(new Error('cancelled')); done.resolve() } }
  } })
  await root.installComponent(createApiKeyServiceComponent({ namespace: 'split-browser-test', definitions: [
    { id: 'test/model', label: '测试模型', category: '大语言模型' },
  ], openEntry() { let value; return { async getPassword() { return value }, async setPassword(v) { value = v }, async deleteCredential() { value = undefined } } } }))
  await root.installComponent(llm.component())
  await root.installComponent(createLocalSqliteComponent(join(directory, 'test.sqlite')))
  harness = await createHarness(root, { agents: [{ id: 'assistant', modelProfileId: 'default', instructions: 'Browser acceptance model.' }] })
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

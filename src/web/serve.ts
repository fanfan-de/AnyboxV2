import { Context } from '@nya/core'
import { createApiKeyServiceComponent } from '../credentials/settings.js'
import { createDeepSeekChatCompletionsComponent, deepSeekCredentialId } from '../llm/deepseek-chat-completions/component.js'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createHarness } from '../harness.js'
import { createWebFrontendComponent, webFrontendServiceKey } from './component.js'
import { createDirectoryPickerComponent } from './directory-picker.js'
import type { WebFrontendPort } from './component.js'

async function main(): Promise<void> {
  const root = new Context()
  try {
    await root.installComponent(createApiKeyServiceComponent({ namespace: 'anybox', definitions: [
      { id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' },
    ] }))
    await root.installComponent(createDeepSeekChatCompletionsComponent({
      version: 'web-v3',
      profiles: [{ id: 'default', model: 'deepseek-flash', temperature: 0.7, timeoutMs: 30_000 }],
    }))
    await root.installComponent(createLocalSqliteComponent('./data/harness.sqlite'))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', instructions: 'You are a helpful assistant.', modelProfileId: 'default' }],
    })
    await root.installComponent(createDirectoryPickerComponent())
    const port = process.env.ANYBOX_WEB_PORT === undefined ? 0 : Number(process.env.ANYBOX_WEB_PORT)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('ANYBOX_WEB_PORT must be a TCP port')
    await root.installComponent(createWebFrontendComponent(harness.listAgents(), port))
    const web = root.get<WebFrontendPort>(webFrontendServiceKey)
    if (!web) throw new Error('Web frontend is unavailable')
    process.stdout.write(`Anybox Web: ${web.url}\n`)
    const stop = () => {
      void harness.close().catch(error => {
        process.exitCode = 1
        process.stderr.write(`Web shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
      })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    try { await root.fiber.dispose() } catch { /* Report the startup failure first. */ }
    throw error
  }
}

main().catch(error => {
  process.exitCode = 1
  const message = error instanceof Error ? error.message : 'unknown startup error'
  process.stderr.write(`Anybox Web could not start: ${message}\n`)
})

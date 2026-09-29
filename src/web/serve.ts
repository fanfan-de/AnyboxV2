import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createImageAssetsComponent } from '../image/component.js'
import { createHarness } from '../harness.js'
import { createWebFrontendComponent, webFrontendServiceKey } from './component.js'
import { createDirectoryPickerComponent } from './directory-picker.js'
import type { WebFrontendPort } from './component.js'
import { parseWebStartupConfig } from './startup-config.js'
import { installWebModels } from './models-startup.js'

async function main(): Promise<void> {
  const config = parseWebStartupConfig(process.env)
  const root = new Context()
  try {
    const { defaultModelId } = await installWebModels(root, config)
    await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
    await root.installComponent(createImageAssetsComponent({ directory: config.imageAssetsDirectory }))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', instructions: 'You are a helpful assistant.', ...(defaultModelId ? { modelId: defaultModelId } : {}) }],
    })
    await root.installComponent(createDirectoryPickerComponent())
    await root.installComponent(createWebFrontendComponent(harness.listAgents(), config.port))
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

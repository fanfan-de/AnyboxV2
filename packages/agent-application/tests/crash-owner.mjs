import { appendFile } from 'node:fs/promises'
import { createAgentApplication } from '../dist/index.js'
import { createSQLiteState, createMockModel, createLocalTools } from '@anybox/agent-kernel'
import { configPath, definition, request, deferred } from './helpers.mjs'

const [path, effects] = process.argv.slice(2), entered = deferred()
const tool = { id: 'write', revision: 1, description: 'Record a test side effect.', inputSchema: { type: 'null' } }
const app = createAgentApplication({ configPath, logger: false, definition: { ...definition, tools: [{ id: 'write', revision: 1 }] },
  limits: { maxConcurrent: 1 }, state: () => createSQLiteState({ path }),
  model: () => createMockModel(() => ({ content: [{ type: 'tool-call', toolCallId: 'write-1', toolId: 'write', input: null }] })),
  tools: () => createLocalTools([{ definition: tool, async execute() {
    await appendFile(effects, 'effect\n')
    entered.resolve()
    // Deliberately leave a real side effect with an uncommitted result for SIGKILL recovery.
    return new Promise(() => {})
  } }]),
})
process.on('message', () => {}) // Host IPC keeps this test owner alive while idle.
try {
  await app.start()
  const firstRequest = request(await app.sessions.create())
  const first = await app.tasks.submit(firstRequest)
  await entered.promise
  const queuedRequest = request(await app.sessions.create(), 'queued')
  const queued = await app.tasks.submit(queuedRequest)
  process.send({ type: 'checkpoint', identity: app.status().agent, firstRequest, first, queuedRequest, queued })
} catch (error) {
  process.send({ type: 'failure', message: error.message })
  process.exitCode = 1
  await app.close().catch(() => {})
  process.disconnect()
}

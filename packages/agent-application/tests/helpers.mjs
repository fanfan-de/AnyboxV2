import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentApplication } from '../dist/index.js'
import { createSQLiteState, createMockModel } from '@anybox/agent-kernel'

export const configPath = fileURLToPath(new URL('../../../examples/application/config.json', import.meta.url))
export const definition = { id: 'persistent-agent', revision: 1, instructions: 'Answer briefly.',
  model: { protocolId: 'mock', providerId: 'local', modelId: 'test', configRevision: 1 } }
export const request = (session, requestKey = 'first') => ({ sessionId: session.id, expectedSessionVersion: session.version,
  requestKey, input: [{ type: 'text', text: 'hello' }] })
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-agent-app-'))
  const path = join(directory, 'agent.sqlite'), apps = [], releases = []
  t.after(async () => {
    for (const release of releases) release()
    for (const app of apps.reverse()) await app.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, path, releases, create(options = {}) {
    const app = createAgentApplication({ configPath, logger: false, definition, state: () => createSQLiteState({ path }),
      model: () => createMockModel(), ...options })
    apps.push(app); return app
  } }
}
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {})
  return { promise, resolve, reject }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const isCode = code => error => error?.error?.code === code

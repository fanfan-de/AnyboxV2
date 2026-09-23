import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApplication } from '@anybox/application'
import { createMemoryStateComponent, createMockModelComponent, createRunCoordinatorComponent } from '../dist/index.js'
import { createControlledMock } from '../dist/testing.js'
import { definition, remainsPending, text, tick } from './helpers.mjs'

test('application close drains active and queued runs on the shared root', { timeout: 5000 }, async t => {
  const app = createApplication({
    configPath: fileURLToPath(new URL('../../../examples/application/config.json', import.meta.url)), logger: false,
  })
  const mock = createControlledMock()
  let release = () => {}
  t.after(async () => { release(); await app.close() })
  await app.start()
  const state = app.context.installComponent(createMemoryStateComponent())
  const model = app.context.installComponent(createMockModelComponent(() => mock))
  const runs = app.context.installComponent(createRunCoordinatorComponent(), { maxConcurrent: 1 })
  await Promise.all([state, model, runs])
  const api = () => app.context.get('agent.kernel')
  const agent = await api().initialize({ definition })
  const start = async () => {
    const session = await api().sessions.create()
    return api().runs.start({ agentId: agent.id, agentGeneration: agent.generation,
      sessionId: session.id, expectedSessionVersion: session.version, requestKey: 'one', input: text('hello') })
  }
  const active = await start()
  const call = await mock.nextCall()
  release = call.holdCleanup().release
  const queued = await start()
  const results = [active, queued].map(run => api().runs.wait({ runId: run.runId }))
  await tick()
  const closing = app.close()
  assert.strictEqual(app.close(), closing)
  await call.cleanupStarted
  await remainsPending(closing)
  release()
  await closing
  assert.deepEqual((await Promise.all(results)).map(run => run.status), ['cancelled', 'cancelled'])
  assert.equal(mock.totalCalls, 1)
  assert.equal(mock.activeCalls, 0)
  assert.deepEqual(app.context.fiber.inspect().effects, [])
  assert.equal(app.context.get('agent.kernel'), undefined)
})

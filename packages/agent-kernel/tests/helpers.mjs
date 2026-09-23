import assert from 'node:assert/strict'
import { KernelFault } from '@anybox/agent-contracts/api'
import { Context, FiberState } from '@nya/core'
import {
  createMemoryState, createMemoryStateComponent, createMockModelComponent,
  createRunCoordinatorComponent, createHarnessComponent, createToolComponent,
} from '../dist/index.js'
import { createControlledMock } from '../dist/testing.js'

export const definition = {
  id: 'test-agent', revision: 1, instructions: 'Answer concisely.',
  model: { protocolId: 'mock', providerId: 'local', modelId: 'controlled', configRevision: 1 },
}
export const text = value => [{ type: 'text', text: value }]
export const isCode = code => error => error instanceof KernelFault && error.error.code === code
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export async function remainsPending(promise) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await tick()
  assert.equal(settled, false)
}
export async function fixture(t, options = {}) {
  const context = new Context()
  const cleanupGates = []
  const memory = options.memory ?? createMemoryState()
  const model = options.model ?? createControlledMock()
  const stateFiber = context.installComponent(createMemoryStateComponent(() => memory))
  const modelFiber = context.installComponent(createMockModelComponent(() => model))
  const toolFiber = options.tools && context.installComponent(createToolComponent(() => options.tools))
  const runFiber = context.installComponent(options.tools ? createHarnessComponent(options.factories) : createRunCoordinatorComponent(options.factories), options.config)
  t.after(async () => {
    // Release test-owned gates before awaiting the component tree, including assertion failures.
    for (const release of cleanupGates) await release()
    try { await context.fiber.dispose() }
    catch (error) { if (!options.cleanupMayFail) throw error }
  })
  await Promise.all([stateFiber, modelFiber, toolFiber, runFiber])
  assert.equal(runFiber.state, FiberState.ACTIVE)
  const kernel = context.get('agent.kernel')
  const agent = await kernel.initialize({ definition: options.definition ?? definition })
  const session = await kernel.sessions.create()
  const request = (session, input = 'hello', key = 'request-1') => ({
    agentId: agent.id, agentGeneration: agent.generation, sessionId: session.id,
    expectedSessionVersion: session.version, requestKey: key, input: text(input),
  })
  return { context, kernel, agent, session, request, memory, model, stateFiber, modelFiber, toolFiber, runFiber,
    beforeClose: release => cleanupGates.push(release) }
}

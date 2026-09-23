import { fileURLToPath } from 'node:url'
import { FiberState } from '@nya/core'
import { createApplication } from '@anybox/application'
import { MemoryStateComponent, HarnessComponent, createMockModelComponent, createToolComponent, createLocalTools } from '@anybox/agent-kernel'
import { createControlledMock } from '@anybox/agent-kernel/testing'

const app = createApplication({
  configPath: fileURLToPath(new URL('./application/config.json', import.meta.url)), logger: false,
})
const model = createControlledMock()
let toolCalls = 0, activeTools = 0
const tools = createLocalTools([{
  definition: { id: 'double', revision: 1, description: 'Double an integer.',
    inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } },
  execute(input, execution) {
    toolCalls++; activeTools++
    execution.onCleanup(() => { activeTools-- })
    return { value: input.value * 2 }
  },
}])
const api = () => {
  const service = app.context.get('agent.kernel')
  if (!service) throw new Error('agent harness is unavailable')
  return service
}
const errors = []
try {
  await app.start()
  const fibers = [
    app.context.installComponent(MemoryStateComponent),
    app.context.installComponent(createMockModelComponent(() => model)),
    app.context.installComponent(createToolComponent(() => tools)),
    app.context.installComponent(HarnessComponent),
  ]
  await Promise.all(fibers)
  for (const fiber of fibers) {
    if (fiber.state !== FiberState.ACTIVE) throw fiber.error ?? new Error('harness dependency is not active')
  }
  const agent = await api().initialize({ definition: {
    id: 'harness-demo', revision: 1, instructions: 'Use double to calculate the answer.',
    model: { protocolId: 'mock', providerId: 'local', modelId: 'demo', configRevision: 1 },
    tools: [{ id: 'double', revision: 1 }],
  } })
  const session = await api().sessions.create()
  const run = await api().runs.start({ agentId: agent.id, agentGeneration: agent.generation,
    sessionId: session.id, expectedSessionVersion: session.version, requestKey: 'double-21',
    input: [{ type: 'text', text: 'Double 21.' }] })
  ;(await model.nextCall()).respond({ content: [{ type: 'tool-call', toolCallId: 'double-1', toolId: 'double', input: { value: 21 } }] })
  const next = await model.nextCall()
  console.log('tool result in context:', next.request.continuation.at(-1).content[0].outcome)
  next.succeed('21 doubled is 42.')
  console.log('run:', (await api().runs.wait({ runId: run.runId })).status)
  const inspection = await api().runs.inspect({ runId: run.runId })
  console.log('steps:', inspection.steps.length, 'attempts:', inspection.attempts.length, 'tool calls:', toolCalls)
  console.log('events:', (await api().runs.events({ runId: run.runId })).events.map(event => `${event.seq}:${event.type}`))
} catch (error) { errors.push(error) }
finally {
  try { await app.close() } catch (error) { errors.push(error) }
  // Also closes resources if startup failed before their components were installed.
  for (const owned of [model, tools]) {
    try { await owned.close() } catch (error) { errors.push(error) }
  }
}
console.log('active resources after close:', { modelCalls: model.activeCalls, tools: activeTools })
if (errors.length === 1) throw errors[0]
if (errors.length > 1) throw new AggregateError(errors, 'harness demo failed')

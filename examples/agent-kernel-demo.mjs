import { fileURLToPath } from 'node:url'
import { FiberState } from '@nya/core'
import { createApplication } from '@anybox/application'
import {
  MemoryStateComponent, RunCoordinatorComponent, createMockModelComponent,
} from '@anybox/agent-kernel'
import { createControlledMock } from '@anybox/agent-kernel/testing'

const app = createApplication({
  configPath: fileURLToPath(new URL('./application/config.json', import.meta.url)),
  logger: false,
})
const mock = createControlledMock()
const errors = []
// 每个外部操作重新取当前服务；不保存跨组件重启的 facade。
const kernel = () => {
  const service = app.context.get('agent.kernel')
  if (!service) throw new Error('agent kernel is unavailable')
  return service
}

try {
  await app.start()
  const fibers = [
    app.context.installComponent(MemoryStateComponent),
    app.context.installComponent(createMockModelComponent(() => mock)),
    app.context.installComponent(RunCoordinatorComponent),
  ]
  await Promise.all(fibers)
  for (const fiber of fibers) {
    if (fiber.state !== FiberState.ACTIVE) throw fiber.error ?? new Error('agent component is not active')
  }
  const agent = await kernel().initialize({ definition: {
    id: 'demo', revision: 1, instructions: 'Answer with a short text response.',
    model: { protocolId: 'mock', providerId: 'local', modelId: 'demo', configRevision: 1 },
  } })
  const session = await kernel().sessions.create()
  const start = async (input, requestKey) => {
    const current = await kernel().sessions.get({ sessionId: session.id })
    return kernel().runs.start({ agentId: agent.id, agentGeneration: agent.generation,
      sessionId: session.id, expectedSessionVersion: current.version, requestKey,
      input: [{ type: 'text', text: input }] })
  }
  const first = await start('Remember: my project is AnyboxV2.', 'first')
  ;(await mock.nextCall()).succeed('I will use AnyboxV2 as the project name.')
  console.log('first:', (await kernel().runs.wait({ runId: first.runId })).status)

  const second = await start('What is my project called?', 'second')
  const secondCall = await mock.nextCall()
  console.log('second call history messages:', secondCall.request.history.length)
  secondCall.succeed('Your project is AnyboxV2.')
  await kernel().runs.wait({ runId: second.runId })
  const history = await kernel().sessions.messages({ sessionId: session.id })
  console.log('history:', history.messages.map(message => `${message.role}: ${message.content[0].text}`))

  const third = await start('Start a task that I will cancel.', 'third')
  await mock.nextCall()
  console.log('before cancel:', (await kernel().runs.get({ runId: third.runId })).status)
  await kernel().runs.cancel({ runId: third.runId, reason: 'demo cancellation' })
  console.log('after cancel:', (await kernel().runs.wait({ runId: third.runId })).status)
} catch (error) {
  errors.push(error)
} finally {
  try { await app.close() } catch (error) { errors.push(error) }
}
console.log('active model calls after close:', mock.activeCalls)
if (errors.length === 1) throw errors[0]
if (errors.length > 1) throw new AggregateError(errors, 'agent demo and close failed')

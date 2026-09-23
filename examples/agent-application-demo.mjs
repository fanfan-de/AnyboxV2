import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentApplication } from '@anybox/agent-application'
import { createSQLiteState, createMockModel } from '@anybox/agent-kernel'

const directory = await mkdtemp(join(tmpdir(), 'anybox-app-demo-'))
const path = join(directory, 'agent.sqlite')
const options = { configPath: fileURLToPath(new URL('./application/config.json', import.meta.url)), logger: false,
  definition: { id: 'persistent-demo', revision: 1, instructions: 'Answer briefly.',
    model: { protocolId: 'mock', providerId: 'local', modelId: 'demo', configRevision: 1 } },
  state: () => createSQLiteState({ path }), model: createMockModel }
const first = createAgentApplication(options), second = createAgentApplication(options)
try {
  await first.start()
  const identity = first.status().agent
  const session = await first.sessions.create()
  const request = { sessionId: session.id, expectedSessionVersion: session.version, requestKey: 'hello',
    input: [{ type: 'text', text: 'Keep this conversation after restarting.' }] }
  const accepted = await first.tasks.submit(request)
  await first.tasks.wait({ runId: accepted.runId })
  await first.close()
  await second.start()
  const restored = second.status().agent
  console.log('same Agent identity:', identity.id === restored.id)
  console.log('new process generation:', identity.generation !== restored.generation)
  console.log('restored messages:', (await second.sessions.messages({ sessionId: session.id })).messages.length)
  console.log('retry returns original task:', (await second.tasks.submit(request)).runId === accepted.runId)
  console.log('application ready:', second.status().ready)
} finally {
  const outcomes = await Promise.allSettled([first.close(), second.close()])
  await rm(directory, { recursive: true, force: true })
  const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Agent demo cleanup failed')
}

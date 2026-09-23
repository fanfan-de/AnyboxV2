import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMockModel, createLocalTools, createSQLiteState } from '@anybox/agent-kernel'
import { definition, fixture, request } from './helpers.mjs'

test('SIGKILL recovery interrupts active and queued Runs without replaying external effects', { timeout: 15000 }, async t => {
  const f = await fixture(t), effects = join(f.directory, 'effects.txt')
  const child = fork(new URL('./crash-owner.mjs', import.meta.url), [f.path, effects], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  f.releases.push(() => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const checkpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`owner did not start: ${stderr}`)), 8000)
    child.on('message', message => {
      clearTimeout(timeout)
      if (message.type === 'checkpoint') resolve(message)
      else reject(new Error(message.message))
    })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`owner exited ${code}: ${stderr}`)) })
    child.once('error', reject)
  })
  assert.equal(await readFile(effects, 'utf8'), 'effect\n')
  const exited = once(child, 'exit')
  child.kill('SIGKILL'); await exited
  let modelCalls = 0, toolCalls = 0
  const options = { definition: { ...definition, tools: [{ id: 'write', revision: 1 }] },
    model: () => createMockModel(() => { modelCalls++; return { content: [{ type: 'text', text: 'recovered context' }] } }),
    tools: () => createLocalTools([{ definition: { id: 'write', revision: 1, description: 'Record a test side effect.', inputSchema: { type: 'null' } },
      execute() { toolCalls++; return null } }]),
  }
  // An interrupted boot transaction must not partly rewrite generation, Run state or events.
  const failedBoot = f.create({ ...options, state: async () => {
    const owner = await createSQLiteState({ path: f.path })
    return { ...owner, service: { ...owner.service,
      transaction: (label, change) => owner.service.transaction(label, draft => {
        const value = change(draft)
        if (label === 'initialize') throw new Error('injected initialization commit failure')
        return value
      }),
    } }
  } })
  await assert.rejects(failedBoot.start())
  assert.equal(modelCalls, 0); assert.equal(toolCalls, 0)
  const restored = f.create(options)
  await restored.start()
  assert.equal(restored.status().agent.id, checkpoint.identity.id)
  assert.notEqual(restored.status().agent.generation, checkpoint.identity.generation)
  assert.deepEqual(new Set(restored.describe().recovery.interruptedRunIds), new Set([checkpoint.first.runId, checkpoint.queued.runId]))
  for (const receipt of [checkpoint.first, checkpoint.queued]) {
    const run = await restored.tasks.wait({ runId: receipt.runId })
    assert.equal(run.status, 'interrupted'); assert.equal(run.error.code, 'INTERRUPTED')
  }
  const inspection = await restored.tasks.inspect({ runId: checkpoint.first.runId })
  assert.equal(inspection.toolCalls[0].status, 'uncertain')
  assert.equal(inspection.toolCalls[0].outcome.error.code, 'INTERRUPTED')
  assert.equal((await restored.tasks.inspect({ runId: checkpoint.queued.runId })).attempts.length, 0)
  assert.equal(modelCalls, 0); assert.equal(toolCalls, 0)
  assert.deepEqual(await restored.tasks.submit(checkpoint.firstRequest), checkpoint.first)
  assert.deepEqual(await restored.tasks.submit(checkpoint.queuedRequest), checkpoint.queued)
  assert.equal(modelCalls, 0)
  const history = await restored.sessions.messages({ sessionId: checkpoint.firstRequest.sessionId })
  assert.equal(history.messages.at(-1).content[0].outcome.status, 'uncertain')
  const events = await restored.tasks.events({ runId: checkpoint.first.runId })
  assert.deepEqual(events.events.map(event => event.seq), events.events.map((_, index) => index + 1))
  assert.equal(events.events.at(-1).status, 'interrupted')
  const version = history.session.version
  await restored.close()
  const again = f.create(options); await again.start()
  assert.deepEqual(again.describe().recovery.interruptedRunIds, [])
  assert.equal((await again.sessions.get({ sessionId: history.session.id })).version, version)
  const next = await again.tasks.submit(request(await again.sessions.get({ sessionId: history.session.id }), 'explicit-new-task'))
  assert.equal((await again.tasks.wait({ runId: next.runId })).status, 'completed')
  assert.equal(modelCalls, 1); assert.equal(toolCalls, 0)
  assert.equal(await readFile(effects, 'utf8'), 'effect\n')
})

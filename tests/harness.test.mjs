import { createApplyPatchComponent } from '../dist/tool/apply-patch-component.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { createAgentPromptComponent } from '../dist/agent/prompt-binding-component.js'
import { llmServiceKey } from '../dist/llm/port.js'
import { createRunComponent, runServiceKey } from '../dist/run/component.js'
import { createAgentLoopComponent, agentLoopServiceKey } from '../dist/run/agent-loop-component.js'
import { createSqliteStateComponent, stateServiceKey } from '../dist/run/sqlite-state.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { createBashComponent } from '../dist/tool/bash-component.js'
import { createSessionComponent, sessionServiceKey } from '../dist/run/session-component.js'
import { createPromptComponent } from '../dist/prompt/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { controlledLLM, deferred, ids } from './helpers/controlled-llm.mjs'

const agents = [{ id: 'assistant', modelProfileId: 'default', instructions: 'Answer briefly.' }]

/** The application installs its LLM API component and SQLite before the Harness. */
async function createHostHarness({ llm, databasePath, ...options }) {
  const root = new Context()
  try {
    const api = root.installComponent(llm.component())
    const database = root.installComponent(createLocalSqliteComponent(databasePath))
    await api
    await database
    const harness = await createHarness(root, options)
    return { root, api, harness }
  } catch (error) { await root.fiber.dispose(); throw error }
}

async function createTestHarness({ llm = controlledLLM(), ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-harness-'))
  try {
    const host = await createHostHarness({ ...options, llm, databasePath: join(directory, 'harness.sqlite') })
    return {
      ...host, llm, directory,
      async close() {
        try { await host.harness.close() } finally { rmSync(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

/** Resolves once Nya can start a consumer of the named service. */
async function serviceReady(root, name) {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const probe = root.inject([name], () => ready())
  await started
  await probe.dispose()
}

const start = async harness => {
  const session = await createSession(harness)
  return await harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'one' })
}

async function createSession(harness, agentId = 'assistant') {
  const project = await harness.openProject(process.cwd())
  return harness.createSession(project.id, agentId)
}

async function createRootSession(root) {
  const project = await root.get(projectServiceKey).openProject(process.cwd())
  return root.get(sessionServiceKey).createSession(project.id, 'assistant')
}

test('Runs deduplicate requests and build explicit immutable history', async () => {
  const f = await createTestHarness({ agents, newId: ids(), now: () => '2026-09-23T00:00:00.000Z' })
  const { harness, llm } = f
  try {
    const session = await createSession(harness)
    assert.equal(session.id, 'id-2')
    const input = { sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'first' }
    const run = await harness.startRun(input)
    assert.equal(run.status, 'running')
    assert.deepEqual(run.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
    assert.equal((await harness.startRun(input)).id, run.id)
    assert.equal(llm.calls.length, 1)
    assert.deepEqual(llm.calls[0].input.plan.snapshot, run.llmSnapshot)
    assert.deepEqual(llm.calls[0].input.messages, [
      { role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Hello' },
    ])
    await assert.rejects(async () => await harness.startRun({ ...input, input: 'Different' }), /idempotency key/)

    let finished = false
    const waiting = harness.waitRun(run.id).then(value => { finished = true; return value })
    llm.calls[0].result.resolve('Hi')
    await Promise.resolve()
    assert.equal(finished, false)
    assert.equal((await harness.getRun(run.id)).status, 'running')
    llm.calls[0].done.resolve()
    const completed = await waiting
    assert.equal(completed.status, 'completed')
    assert.equal(completed.output, 'Hi')
    assert.ok(completed.resultNodeId)
    assert.deepEqual((await harness.listNodes(session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [{ input: 'Hello', output: 'Hi' }])

    const second = await harness.startRun({ sessionId: session.id, parentNodeId: completed.resultNodeId, input: 'Again', idempotencyKey: 'second' })
    assert.deepEqual(llm.calls[1].input.messages, [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Again' },
    ])
    llm.calls[1].result.resolve('Again answered')
    llm.calls[1].done.resolve()
    assert.equal((await harness.waitRun(second.id)).status, 'completed')
    assert.equal((await harness.getNodePath(session.id, (await harness.getRun(second.id)).resultNodeId)).length, 2)
  } finally {
    for (const call of llm.calls) call.done.resolve()
    await f.close()
  }
})

test('Run admission rejects LLM overrides and unknown profiles without state writes', async () => {
  const f = await createTestHarness({ agents, newId: ids() })
  try {
    const session = await createSession(f.harness)
    await assert.rejects(async () => await f.harness.startRun({
      sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'x', modelProfileId: 'other',
    }), /cannot override/)
    assert.equal(f.llm.calls.length, 0)
  } finally { await f.close() }

  const missing = await createTestHarness({ agents: [{ ...agents[0], modelProfileId: 'missing' }], newId: ids() })
  try {
    const session = await createSession(missing.harness)
    await assert.rejects(async () => await missing.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'x' }),
      /model is unavailable/)
    assert.equal(missing.llm.calls.length, 0)
    assert.deepEqual((await missing.harness.listNodes(session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [])
  } finally { await missing.close() }
  assert.deepEqual(missing.llm.events, ['disposed'])
})

test('cancelling while AgentLoop loads a persisted Run never starts a model call', async () => {
  const f = await createTestHarness({ agents })
  const release = deferred()
  try {
    const session = await createSession(f.harness)
    const state = f.root.get(stateServiceKey)
    const originalGetRun = state.getRun.bind(state)
    const loading = deferred()
    let held = false
    state.getRun = async id => {
      const value = await originalGetRun(id)
      if (!held) {
        held = true
        loading.resolve()
        await release.promise
      }
      return value
    }
    const starting = f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Race', idempotencyKey: 'race' })
    await loading.promise
    const [accepted] = await f.harness.listRuns(session.id)
    assert.equal(accepted.status, 'running')
    assert.equal((await f.harness.cancelRun(accepted.id))?.status, 'cancelling')
    release.resolve()
    assert.equal((await starting).status, 'cancelled')
    assert.equal(f.llm.calls.length, 0)
  } finally {
    release.resolve()
    await f.close()
  }
})

test('cancellation and close wait until the LLM call actually exits', async () => {
  const f = await createTestHarness({ agents, newId: ids() })
  const { harness, llm } = f
  const session = await createSession(harness)
  const run = await harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'wait' })
  const waiting = harness.waitRun(run.id)
  assert.equal((await harness.cancelRun(run.id)).status, 'cancelling')
  assert.deepEqual(llm.calls[0].cancellations, ['user-requested'])
  let closed = false
  const closing = f.close().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.equal(llm.calls[0].cancellations[0], 'user-requested')
  await assert.rejects(async () => await harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Late', idempotencyKey: 'late' }), /closing/)
  llm.calls[0].result.reject(new Error('aborted'))
  await Promise.resolve()
  assert.equal(closed, false)
  assert.deepEqual(llm.events, [])
  llm.calls[0].done.resolve()
  assert.equal((await waiting).status, 'cancelled')
  await closing
  assert.equal(closed, true)
  assert.deepEqual(llm.events, ['disposed'])
})

test('closing Harness joins its call, releases the LLM API and storage, and lets a fresh root reopen storage', async () => {
  const f = await createTestHarness({ agents })
  const { harness, llm } = f
  try {
    const run = await start(harness)
    const waiting = harness.waitRun(run.id)
    let closed = false
    const closing = harness.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.deepEqual(llm.calls[0].cancellations, ['owner-disposed'])
    assert.deepEqual(llm.events, [])
    llm.calls[0].result.reject(new Error('private abort detail'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.deepEqual(llm.events, [])
    llm.calls[0].done.resolve()
    assert.equal((await waiting).status, 'cancelled')
    await closing
    assert.deepEqual(llm.events, ['disposed'])
    assert.equal(f.root.get(llmServiceKey), undefined)
    assert.equal(f.root.get(runServiceKey), undefined)
    assert.equal(f.root.get(localStorageServiceKey), undefined)
    await assert.rejects(async () => await createSession(harness), /closing/)

    const next = controlledLLM()
    const reopened = await createHostHarness({ llm: next, agents, databasePath: join(f.directory, 'harness.sqlite') })
    try {
      const again = await start(reopened.harness)
      assert.deepEqual(again.llmSnapshot, { profileId: 'default', configVersion: 'v1' })
      next.calls[0].result.resolve('Reopened')
      next.calls[0].done.resolve()
      assert.equal((await reopened.harness.waitRun(again.id)).output, 'Reopened')
      await reopened.harness.close()
      assert.deepEqual(next.events, ['disposed'])
    } finally { await reopened.root.fiber.dispose() }
  } finally { await f.close() }
})

test('removing the LLM API component waits for the run consumer and its call', async () => {
  const root = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'anybox-harness-'))
  const llm = controlledLLM()
  const inputs = { newId: ids(), now: () => 'now' }
  const projects = root.installComponent(createProjectComponent(inputs))
  root.installComponent(createBashComponent())
  root.installComponent(createApplyPatchComponent())
  const state = root.installComponent(createSqliteStateComponent(inputs))
  const sessions = root.installComponent(createSessionComponent(inputs, agents))
  const database = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  const prompts = root.installComponent(createPromptComponent(inputs))
  const agentPrompts = root.installComponent(createAgentPromptComponent(inputs, agents, () => true))
  const api = root.installComponent(llm.component())
  const loop = root.installComponent(createAgentLoopComponent(inputs))
  const owner = root.installComponent(createRunComponent(inputs, agents))
  try {
    await Promise.all([state, database, api])
    await loop
    await sessions
    await prompts
    await agentPrompts
    await owner
    assert.equal(owner.state, FiberState.ACTIVE)
    const service = root.get(runServiceKey)
    const session = await createRootSession(root)
    const run = await service.startRun({ sessionId: session.id, parentNodeId: null, input: 'Work', idempotencyKey: 'key' })
    const waiting = service.waitRun(run.id)
    let disposed = false
    const stopping = api.dispose().then(() => { disposed = true })
    assert.equal(await llm.calls[0].cancelled.promise, 'dependency-unavailable')
    assert.equal(disposed, false)
    assert.deepEqual(llm.events, [])
    llm.calls[0].result.reject(new Error('aborted'))
    llm.calls[0].done.resolve()
    const terminal = await waiting
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'dependency-unavailable')
    await stopping
    assert.deepEqual(llm.events, ['disposed'])
    assert.equal(root.get(runServiceKey), undefined)
    assert.equal((await root.get(sessionServiceKey).getSession(session.id)).id, session.id)

    const replacement = controlledLLM({ version: 'v2' })
    await root.installComponent(replacement.component())
    await loop
    await owner
    assert.equal(owner.state, FiberState.ACTIVE)
    const current = root.get(runServiceKey)
    const next = await current.startRun({ sessionId: session.id, parentNodeId: null, input: 'Again', idempotencyKey: 'next' })
    assert.equal(next.llmSnapshot.configVersion, 'v2')
    assert.equal(replacement.calls.length, 1)
    assert.equal(llm.calls.length, 1)
    replacement.calls[0].result.resolve('new model')
    replacement.calls[0].done.resolve()
    assert.equal((await current.waitRun(next.id)).output, 'new model')
  } finally {
    for (const call of llm.calls) call.done.resolve()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replacing the LLM API component serves only new Run keys', async () => {
  const f = await createTestHarness({ agents })
  const first = f.llm
  try {
    const session = await createSession(f.harness)
    const request = { sessionId: session.id, parentNodeId: null, input: 'First', idempotencyKey: 'first' }
    const old = await f.harness.startRun(request)
    first.calls[0].result.resolve('Old')
    first.calls[0].done.resolve()
    await f.harness.waitRun(old.id)
    await f.api.dispose()
    assert.deepEqual(first.events, ['disposed'])
    const next = controlledLLM({ version: 'v2' })
    await f.root.installComponent(next.component())
    await serviceReady(f.root, runServiceKey)
    assert.deepEqual(await f.harness.startRun(request), await f.harness.getRun(old.id))
    assert.equal(next.calls.length, 0)
    const fresh = await f.harness.startRun({ ...request, idempotencyKey: 'second' })
    assert.equal(fresh.llmSnapshot.configVersion, 'v2')
    assert.equal(next.calls.length, 1)
    next.calls[0].result.resolve('New')
    next.calls[0].done.resolve()
    assert.equal((await f.harness.waitRun(fresh.id)).output, 'New')
  } finally { await f.close() }
})

test('AgentLoop owns in-flight calls while Session and Run state survive its replacement', async () => {
  const root = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'anybox-harness-'))
  const llm = controlledLLM()
  const inputs = { newId: ids(), now: () => 'now' }
  const projects = root.installComponent(createProjectComponent(inputs))
  root.installComponent(createBashComponent())
  root.installComponent(createApplyPatchComponent())
  const state = root.installComponent(createSqliteStateComponent(inputs))
  const sessions = root.installComponent(createSessionComponent(inputs, agents))
  const database = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  const prompts = root.installComponent(createPromptComponent(inputs))
  const agentPrompts = root.installComponent(createAgentPromptComponent(inputs, agents, () => true))
  const api = root.installComponent(llm.component())
  const loop = root.installComponent(createAgentLoopComponent(inputs))
  const runs = root.installComponent(createRunComponent(inputs, agents))
  try {
    await Promise.all([state, database, api])
    await prompts
    await agentPrompts
    await sessions
    await loop
    await runs
    const session = await createRootSession(root)
    const run = await root.get(runServiceKey).startRun({ sessionId: session.id, parentNodeId: null, input: 'Work', idempotencyKey: 'one' })
    const waiting = root.get(runServiceKey).waitRun(run.id)
    let stopped = false
    const stopping = loop.dispose().then(() => { stopped = true })
    assert.equal(await llm.calls[0].cancelled.promise, 'dependency-unavailable')
    assert.equal(stopped, false)
    assert.equal((await root.get(sessionServiceKey).getSession(session.id)).id, session.id)
    assert.equal(root.get(runServiceKey), undefined)
    llm.calls[0].result.reject(new Error('aborted'))
    llm.calls[0].done.resolve()
    assert.equal((await waiting).status, 'failed')
    await stopping
    assert.equal(root.get(agentLoopServiceKey), undefined)
    assert.deepEqual(llm.events, [])
    const replacement = root.installComponent(createAgentLoopComponent(inputs))
    await replacement
    await runs
    const next = await root.get(runServiceKey).startRun({ sessionId: session.id, parentNodeId: null, input: 'Next', idempotencyKey: 'two' })
    llm.calls[1].result.resolve('Done')
    llm.calls[1].done.resolve()
    assert.equal((await root.get(runServiceKey).waitRun(next.id)).status, 'completed')
  } finally {
    for (const call of llm.calls) call.done.resolve()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid input and synchronous LLM failure become explicit outcomes', async () => {
  const llm = controlledLLM({ call() { throw new Error('model unavailable') } })
  const f = await createTestHarness({ agents, llm, newId: ids() })
  try {
    await assert.rejects(async () => await createSession(f.harness, 'missing'), /unknown agent/)
    const session = await createSession(f.harness)
    await assert.rejects(async () => await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: ' ', idempotencyKey: 'x' }), /input/)
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Hello', idempotencyKey: 'x' })
    assert.equal(run.status, 'failed')
    assert.equal(run.error, 'model provider failed')
    assert.equal(run.errorCategory, 'provider-failure')
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [])
  } finally {
    await f.close()
  }
})

test('a result failure waits for cleanup before becoming terminal', async () => {
  const f = await createTestHarness({ agents, newId: ids() })
  const { harness, llm } = f
  try {
    const run = await start(harness)
    llm.calls[0].result.reject(new Error('model failed'))
    await Promise.resolve()
    assert.equal((await harness.getRun(run.id)).status, 'running')
    llm.calls[0].done.resolve()
    const terminal = await harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.error, 'model provider failed')
    assert.equal(terminal.errorCategory, 'provider-failure')
    assert.deepEqual((await harness.listNodes(run.sessionId, null)).nodes.map(({ input, output }) => ({ input, output })), [])
  } finally {
    for (const call of llm.calls) call.done.resolve()
    await f.close()
  }
})

test('an early cleanup rejection settles the run without its result and stays observable at close', async () => {
  const f = await createTestHarness({ agents, newId: ids() })
  const run = await start(f.harness)
  f.llm.calls[0].done.reject(new Error('secret transport detail'))
  await Promise.resolve()
  assert.equal((await f.harness.getRun(run.id)).status, 'running')
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error, 'model call cleanup failed')
  assert.equal(terminal.errorCategory, 'cleanup-failure')
  assert.equal(JSON.stringify(terminal).includes('secret'), false)
  await assert.rejects(f.close())
})

test('cancellation exceptions wait for done and fail cleanup safely', async () => {
  const llm = controlledLLM()
  llm.call = input => {
    const entry = { input, result: deferred(), done: deferred() }
    llm.calls.push(entry)
    return {
      result: entry.result.promise, done: entry.done.promise,
      cancel() { throw new Error('secret cancel detail') },
    }
  }
  const f = await createTestHarness({ agents, llm })
  const run = await start(f.harness)
  await f.harness.cancelRun(run.id)
  assert.equal((await f.harness.getRun(run.id)).status, 'cancelling')
  llm.calls[0].result.reject(new Error('aborted'))
  llm.calls[0].done.resolve()
  const terminal = await f.harness.waitRun(run.id)
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.errorCategory, 'cleanup-failure')
  assert.equal(JSON.stringify(terminal).includes('secret'), false)
  await assert.rejects(f.close())
})

test('Harness startup names missing services and failed startups release the application root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-harness-start-'))
  const file = join(directory, 'db.sqlite')
  try {
    const noStorageRoot = new Context()
    const noStorage = controlledLLM()
    try {
      await noStorageRoot.installComponent(noStorage.component())
      await assert.rejects(createHarness(noStorageRoot, { agents }), /waiting for local-storage/)
      assert.deepEqual(noStorage.events, ['disposed'])
      assert.equal(noStorageRoot.get(llmServiceKey), undefined)
    } finally { await noStorageRoot.fiber.dispose() }

    const noApiRoot = new Context()
    try {
      await noApiRoot.installComponent(createLocalSqliteComponent(file))
      await assert.rejects(createHarness(noApiRoot, { agents }), /waiting for llm/)
      assert.equal(noApiRoot.get(localStorageServiceKey), undefined)
    } finally { await noApiRoot.fiber.dispose() }

    const invalidRoot = new Context()
    const invalid = controlledLLM()
    try {
      await invalidRoot.installComponent(createLocalSqliteComponent(file))
      await invalidRoot.installComponent(invalid.component())
      await assert.rejects(createHarness(invalidRoot, { agents: [] }), /agents/)
      assert.deepEqual(invalid.events, ['disposed'])
      assert.equal(invalidRoot.get(localStorageServiceKey), undefined)
    } finally { await invalidRoot.fiber.dispose() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createAgentPromptComponent } from '../dist/agent/prompt-binding-component.js'
import { createHarness } from '../dist/harness.js'
import { llmServiceKey } from '../dist/llm/port.js'
import { createPromptComponent } from '../dist/prompt/component.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { agentLoopServiceKey, createAgentLoopComponent } from '../dist/run/agent-loop-component.js'
import { createRunComponent, runServiceKey } from '../dist/run/component.js'
import { createSessionComponent, sessionServiceKey } from '../dist/run/session-component.js'
import { createSqliteStateComponent, stateServiceKey } from '../dist/run/sqlite-state.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { bashServiceKey, bashToolDefinition } from '../dist/tool/bash-component.js'
import { controlledLLM, deferred } from './helpers/controlled-llm.mjs'

const agents = [{ id: 'assistant', instructions: 'Use Bash when useful.', modelProfileId: 'default' }]

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-loop-')))
  const root = new Context()
  const llm = controlledLLM()
  try {
    await root.installComponent(llm.component())
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    const harness = await createHarness(root, { agents })
    const project = await harness.openProject(directory)
    const session = await harness.createSession(project.id, 'assistant')
    return {
      directory, root, llm, harness, session,
      state: root.get(stateServiceKey),
      async close() {
        try { await harness.close() }
        finally { rmSync(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('expected tool-loop progress did not occur')
}

const request = (id, command) => ({ id, name: 'bash', arguments: { command } })

test('one Bash result is persisted, returned to the model, and followed by a final answer', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Inspect this project', idempotencyKey: 'one' })
    assert.equal(f.llm.calls[0].input.tools[0].name, 'bash')
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [request('tool-1', 'printf hello')] })
    f.llm.calls[0].done.resolve()
    await until(() => f.llm.calls.length === 2)
    const messages = f.llm.calls[1].input.messages
    assert.deepEqual(messages[2], { role: 'assistant', content: null,
      toolCalls: [request('tool-1', 'printf hello')] })
    assert.equal(messages[3].role, 'tool')
    assert.equal(messages[3].toolCallId, 'tool-1')
    assert.deepEqual(JSON.parse(messages[3].content),
      { exitCode: 0, signal: null, stdout: 'hello', stderr: '', truncated: false })
    f.llm.calls[1].result.resolve('The command printed hello.')
    f.llm.calls[1].done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'The command printed hello.')
    assert.deepEqual((await f.state.getRunEvents(run.id)).map(event => event.kind), [
      'model-started', 'model-tool-calls', 'bash-started', 'bash-observed', 'model-started', 'terminal',
    ])
    assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes.map(({ input, output }) => ({ input, output })),
      [{ input: 'Inspect this project', output: 'The command printed hello.' }])
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('a Bash batch executes serially and returns nonzero exit codes as observations', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Run both', idempotencyKey: 'batch' })
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [
      request('first', 'printf ready > first-started; while [ ! -f release ]; do sleep 0.02; done; exit 7'),
      request('second', 'printf ready > second-started; printf second'),
    ] })
    f.llm.calls[0].done.resolve()
    await until(() => existsSync(join(f.directory, 'first-started')))
    assert.equal(existsSync(join(f.directory, 'second-started')), false)
    assert.equal(f.llm.calls.length, 1)
    writeFileSync(join(f.directory, 'release'), '')
    await until(() => f.llm.calls.length === 2)
    assert.equal(existsSync(join(f.directory, 'second-started')), true)
    const toolMessages = f.llm.calls[1].input.messages.filter(message => message.role === 'tool')
    assert.deepEqual(toolMessages.map(message => message.toolCallId), ['first', 'second'])
    assert.equal(JSON.parse(toolMessages[0].content).exitCode, 7)
    assert.equal(JSON.parse(toolMessages[1].content).stdout, 'second')
    f.llm.calls[1].result.resolve('Both commands finished.')
    f.llm.calls[1].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
    assert.deepEqual((await f.state.getRunEvents(run.id)).map(event => event.kind), [
      'model-started', 'model-tool-calls', 'bash-started', 'bash-observed',
      'bash-started', 'bash-observed', 'model-started', 'terminal',
    ])
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('one invalid request rejects the complete batch before any Bash command starts', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Invalid batch', idempotencyKey: 'invalid' })
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [
      request('valid', 'printf bad > should-not-exist'),
      { id: 'invalid', name: 'other', arguments: { command: 'pwd' } },
    ] })
    f.llm.calls[0].done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'invalid-tool-request')
    assert.equal(existsSync(join(f.directory, 'should-not-exist')), false)
    assert.deepEqual((await f.state.getRunEvents(run.id)).map(event => event.kind), ['model-started', 'terminal'])
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('a Run completes multiple batches beyond the former model and Bash call limits', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Finish all steps', idempotencyKey: 'many-steps' })
    for (let step = 0; step < 6; step++) {
      f.llm.calls[step].result.resolve({ kind: 'tool-calls', calls: Array.from({ length: step === 0 ? 5 : 1 }, (_, index) =>
        request(`call-${step}-${index}`, `printf 'step-${step}-${index}'`)) })
      f.llm.calls[step].done.resolve()
      await until(() => f.llm.calls.length === step + 2)
    }
    assert.equal(f.llm.calls[6].input.messages.filter(message => message.role === 'tool').length, 10)
    f.llm.calls[6].result.resolve('All steps completed.')
    f.llm.calls[6].done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'All steps completed.')
    const execution = await f.state.getRunExecution(run.id)
    assert.equal(execution.modelCalls, 7)
    assert.equal(execution.bashCalls, 10)
    assert.equal(execution.phase, 'terminal')
    assert.equal((await f.state.getRunEvents(run.id)).filter(event => event.kind === 'bash-observed').length, 10)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('the cumulative Bash output limit stops the Run before another model call', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Large output', idempotencyKey: 'output-limit' })
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [1, 2, 3].map(number =>
      request(`call-${number}`, "printf '%*s' 65536 '' | tr ' ' a")) })
    f.llm.calls[0].done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'limit-exceeded')
    assert.equal(f.llm.calls.length, 1)
    assert.equal((await f.state.getRunEvents(run.id)).filter(event => event.kind === 'bash-observed').length, 3)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('an oversized final answer fails without adding a Session turn', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Too long', idempotencyKey: 'final-limit' })
    f.llm.calls[0].result.resolve('x'.repeat(65_537))
    f.llm.calls[0].done.resolve()
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'limit-exceeded')
    assert.deepEqual((await f.harness.listNodes(f.session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [])
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('cancelling an active Bash command waits for exit and starts no subsequent tool', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Cancel', idempotencyKey: 'cancel' })
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [
      request('first', "trap 'sleep 0.3; exit' TERM; printf ready > started; while :; do sleep 1; done"),
      request('second', 'printf bad > should-not-exist'),
    ] })
    f.llm.calls[0].done.resolve()
    await until(() => existsSync(join(f.directory, 'started')))
    await f.harness.cancelRun(run.id)
    assert.equal((await f.harness.getRun(run.id)).status, 'cancelling')
    const terminal = await f.harness.waitRun(run.id)
    assert.equal(terminal.status, 'cancelled')
    assert.equal(existsSync(join(f.directory, 'should-not-exist')), false)
    assert.equal(f.llm.calls.length, 1)
    assert.deepEqual((await f.state.getRunEvents(run.id)).map(event => event.kind), [
      'model-started', 'model-tool-calls', 'bash-started', 'bash-failed', 'terminal',
    ])
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('closing Harness waits for an active Bash command to exit', async () => {
  const f = await fixture()
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Close', idempotencyKey: 'close-bash' })
    const waiting = f.harness.waitRun(run.id)
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [
      request('tool-1', "trap 'sleep 0.25; printf stopped > stopped; exit' TERM; printf ready > started; while :; do sleep 1; done"),
    ] })
    f.llm.calls[0].done.resolve()
    await until(() => existsSync(join(f.directory, 'started')))
    let closed = false
    const closing = f.harness.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(closed, false)
    await closing
    assert.equal(closed, true)
    assert.equal(existsSync(join(f.directory, 'stopped')), true)
    assert.equal((await waiting).status, 'cancelled')
    assert.equal(f.llm.calls.length, 1)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('cancelling while the first model step starts cannot settle ahead of its call', async () => {
  const f = await fixture()
  try {
    const accepted = await f.state.acceptRun('starting-run', {
      sessionId: f.session.id, parentNodeId: null, input: 'Cancel at startup', idempotencyKey: 'starting',
    }, 'now', [], f.root.get(llmServiceKey).prepare('default'))
    assert.equal(accepted.created, true)
    const originalGetRun = f.state.getRun.bind(f.state)
    const entered = deferred()
    const release = deferred()
    let reads = 0
    f.state.getRun = async id => {
      if (id === 'starting-run' && ++reads === 2) {
        entered.resolve()
        await release.promise
      }
      return originalGetRun(id)
    }
    const loop = f.root.get(agentLoopServiceKey)
    const starting = loop.start('starting-run')
    await entered.promise
    await loop.cancel('starting-run', 'user-requested')
    assert.equal((await originalGetRun('starting-run')).status, 'cancelling')
    release.resolve()
    await starting
    assert.equal((await loop.wait('starting-run')).status, 'cancelled')
    assert.equal(f.llm.calls.length, 0)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close() }
})

test('cancelling before the first Run read finishes still reaches a terminal state', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  try {
    await f.state.acceptRun('early-cancel-run', {
      sessionId: f.session.id, parentNodeId: null, input: 'Cancel before read', idempotencyKey: 'early-cancel',
    }, 'now', [], f.root.get(llmServiceKey).prepare('default'))
    const originalGetRun = f.state.getRun.bind(f.state)
    let held = false
    f.state.getRun = async id => {
      if (id === 'early-cancel-run' && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return originalGetRun(id)
    }
    const loop = f.root.get(agentLoopServiceKey)
    const starting = loop.start('early-cancel-run')
    await entered.promise
    await loop.cancel('early-cancel-run', 'user-requested')
    assert.equal((await originalGetRun('early-cancel-run')).status, 'cancelling')
    release.resolve()
    assert.equal((await starting).status, 'cancelled')
    assert.equal((await loop.wait('early-cancel-run')).status, 'cancelled')
    assert.equal(f.llm.calls.length, 0)
  } finally {
    release.resolve()
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
  }
})

async function stateHost(file) {
  const root = new Context()
  const inputs = { now: () => '2026-09-26T00:00:00.000Z', newId: () => 'project-1' }
  try {
    await root.installComponent(createLocalSqliteComponent(file))
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createSqliteStateComponent(inputs))
    return { root, state: root.get(stateServiceKey), projects: root.get(projectServiceKey) }
  } catch (error) { await root.fiber.dispose(); throw error }
}

test('a persisted Bash intent becomes interrupted on restart and is never replayed', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-recovery-')))
  const file = join(directory, 'state.sqlite')
  let first
  let second
  try {
    first = await stateHost(file)
    const project = await first.projects.openProject(directory)
    const session = await first.state.createSession('session-1', project.id, 'assistant', 'now')
    const accepted = await first.state.acceptRun('run-1', {
      sessionId: session.id, parentNodeId: null, input: 'Maybe execute', idempotencyKey: 'once',
    }, 'now', [], { snapshot: { profileId: 'default', configVersion: 'v1' } })
    assert.equal(accepted.created, true)
    await first.state.recordRunEvent('run-1', { kind: 'model-started' }, 'now')
    await first.state.recordRunEvent('run-1',
      { kind: 'model-tool-calls', calls: [request('tool-1', 'printf duplicate >> marker')] }, 'now')
    await first.state.recordRunEvent('run-1',
      { kind: 'bash-started', call: request('tool-1', 'printf duplicate >> marker') }, 'now')
    // The process might have performed this side effect before losing its result.
    writeFileSync(join(directory, 'marker'), 'already-executed')
    await first.root.fiber.dispose()
    second = await stateHost(file)
    assert.equal((await second.state.getRun('run-1')).status, 'interrupted')
    assert.equal((await second.state.getRunExecution('run-1')).phase, 'terminal')
    assert.deepEqual((await second.state.getRunEvents('run-1')).map(event => event.kind), [
      'model-started', 'model-tool-calls', 'bash-started', 'interrupted',
    ])
    assert.equal((await import('node:fs')).readFileSync(join(directory, 'marker'), 'utf8'), 'already-executed')
    assert.equal((await second.state.findAcceptedRun({ sessionId: session.id, parentNodeId: null,
      input: 'Maybe execute', idempotencyKey: 'once' })).id, 'run-1')
  } finally {
    await second?.root.fiber.dispose()
    await first?.root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Run state migration preserves legacy completed Runs and interrupts old in-flight Runs', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-migration-')))
  const root = new Context()
  const inputs = { now: () => '2026-09-26T00:00:00.000Z', newId: () => 'project-1' }
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createProjectComponent(inputs))
    const project = await root.get(projectServiceKey).openProject(directory)
    const db = root.get(localStorageServiceKey)
    await db.migrate('run-state', [{ version: 1, up(tx) {
      tx.execute(`CREATE TABLE harness_sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES harness_projects(id),
        agent_id TEXT NOT NULL, created_at TEXT NOT NULL, turns_json TEXT NOT NULL
      )`)
      tx.execute('CREATE INDEX harness_sessions_project ON harness_sessions(project_id, created_at, id)')
      tx.execute(`CREATE TABLE harness_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES harness_sessions(id),
        idempotency_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        prompts_json TEXT NOT NULL, llm_snapshot_json TEXT NOT NULL,
        output TEXT, error TEXT, error_category TEXT, UNIQUE(session_id, idempotency_key)
      )`)
      tx.execute('CREATE INDEX harness_runs_session ON harness_runs(session_id, created_at, id)')
    } }])
    await db.transaction(tx => {
      tx.execute('INSERT INTO harness_sessions VALUES (?, ?, ?, ?, ?)',
        ['session-1', project.id, 'assistant', 'old', '[{"input":"Saved","output":"Answer"}]'])
      const sql = `INSERT INTO harness_runs (id, session_id, idempotency_key, input, status,
        created_at, updated_at, prompts_json, llm_snapshot_json, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      const snapshot = '{"profileId":"default","configVersion":"v1"}'
      tx.execute(sql, ['completed-1', 'session-1', 'completed', 'Saved', 'completed', 'old', 'old', '[]', snapshot, 'Answer'])
      tx.execute(sql, ['running-1', 'session-1', 'running', 'Pending', 'running', 'old', 'old', '[]', snapshot, null])
    })
    await root.installComponent(createSqliteStateComponent(inputs))
    const state = root.get(stateServiceKey)
    assert.equal((await state.getRun('completed-1')).output, 'Answer')
    assert.equal((await state.getRunExecution('completed-1')).phase, 'terminal')
    assert.deepEqual(await state.getRunEvents('completed-1'), [])
    assert.equal((await state.getRun('running-1')).status, 'interrupted')
    assert.deepEqual((await state.getRunEvents('running-1')).map(event => event.kind), ['interrupted'])
  } finally { await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

test('revoking Bash waits for its done and prevents another model step', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-revoke-')))
  const root = new Context()
  const llm = controlledLLM()
  const bashCalls = []
  const inputs = { now: () => 'now', newId: (() => { let id = 0; return () => `id-${++id}` })() }
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createSqliteStateComponent(inputs))
    await root.installComponent(createSessionComponent(inputs, agents))
    await root.installComponent(createPromptComponent(inputs))
    await root.installComponent(createAgentPromptComponent(inputs, agents, () => true))
    await root.installComponent(llm.component())
    const bashFiber = root.installComponent({
      name: 'controlled-bash',
      inject: [projectServiceKey],
      apply(ctx) {
        ctx.provide(bashServiceKey, {
          definition: bashToolDefinition,
          execute(input) {
            const result = deferred()
            const done = deferred()
            const cancelled = deferred()
            const entry = { input, result, done, cancelled }
            bashCalls.push(entry)
            return { result: result.promise, done: done.promise,
              cancel(reason) { cancelled.resolve(reason) } }
          },
        })
      },
    })
    await bashFiber
    await root.installComponent(createAgentLoopComponent(inputs))
    await root.installComponent(createRunComponent(inputs, agents))
    const project = await root.get(projectServiceKey).openProject(directory)
    const session = await root.get(sessionServiceKey).createSession(project.id, 'assistant')
    const runs = root.get(runServiceKey)
    const run = await runs.startRun({ sessionId: session.id, parentNodeId: null, input: 'Use Bash', idempotencyKey: 'one' })
    const waiting = runs.waitRun(run.id)
    llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [request('tool-1', 'printf hello')] })
    llm.calls[0].done.resolve()
    await until(() => bashCalls.length === 1)
    bashCalls[0].result.resolve({ exitCode: 0, signal: null, stdout: 'hello', stderr: '', truncated: false })
    await Promise.resolve()
    assert.equal(llm.calls.length, 1)
    assert.equal((await root.get(stateServiceKey).getRun(run.id)).status, 'running')
    let disposed = false
    const stopping = bashFiber.dispose().then(() => { disposed = true })
    assert.equal(await bashCalls[0].cancelled.promise, 'dependency-unavailable')
    assert.equal(disposed, false)
    bashCalls[0].done.resolve()
    const terminal = await waiting
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'dependency-unavailable')
    await stopping
    assert.equal(llm.calls.length, 1)
  } finally {
    for (const call of llm.calls) call.done.resolve()
    for (const call of bashCalls) call.done.resolve()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

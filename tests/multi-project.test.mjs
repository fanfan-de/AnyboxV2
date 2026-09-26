import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { controlledLLM } from './helpers/controlled-llm.mjs'

const agents = [{ id: 'assistant', instructions: 'Shared instructions.', modelProfileId: 'default' }]

async function host(file) {
  const root = new Context()
  const llm = controlledLLM()
  try {
    await root.installComponent(llm.component())
    await root.installComponent(createLocalSqliteComponent(file))
    const harness = await createHarness(root, { agents })
    return { harness, llm }
  } catch (error) { await root.fiber.dispose(); throw error }
}

function finish(call, output) {
  call.result.resolve(output)
  call.done.resolve()
}

test('projects identify canonical directories and isolate sessions while allowing concurrent Runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-projects-'))
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  mkdirSync(a)
  mkdirSync(b)
  symlinkSync(a, join(directory, 'alias'))
  const f = await host(join(directory, 'state.sqlite'))
  try {
    await assert.rejects(f.harness.openProject('relative'), /absolute/)
    await assert.rejects(f.harness.openProject(join(directory, 'missing')), /unavailable/)
    const first = await f.harness.openProject(a)
    assert.equal((await f.harness.openProject(join(directory, 'alias'))).id, first.id)
    const second = await f.harness.openProject(b)
    assert.equal((await f.harness.listProjects()).length, 2)
    const [a1, a2, b1] = await Promise.all([
      f.harness.createSession(first.id, 'assistant'),
      f.harness.createSession(first.id, 'assistant'),
      f.harness.createSession(second.id, 'assistant'),
    ])
    assert.equal(a1.projectId, first.id)
    assert.deepEqual((await f.harness.listSessions(first.id)).map(item => item.id).sort(), [a1.id, a2.id].sort())
    assert.deepEqual((await f.harness.listSessions(second.id)).map(item => item.id), [b1.id])
    const [one, two, three] = await Promise.all([
      f.harness.startRun({ sessionId: a1.id, parentNodeId: null, input: 'One', idempotencyKey: 'one' }),
      f.harness.startRun({ sessionId: a2.id, parentNodeId: null, input: 'Two', idempotencyKey: 'one' }),
      f.harness.startRun({ sessionId: b1.id, parentNodeId: null, input: 'Three', idempotencyKey: 'one' }),
    ])
    assert.equal(f.llm.calls.length, 3)
    assert.equal((await f.harness.startRun({ sessionId: a1.id, parentNodeId: null, input: 'One', idempotencyKey: 'one' })).id, one.id)
    for (const [index, run] of [one, two, three].entries()) {
      const call = f.llm.calls.find(item => item.input.messages.at(-1)?.content === run.input)
      assert.ok(call)
      finish(call, `Answer ${index}`)
      assert.equal((await f.harness.waitRun(run.id))?.status, 'completed')
    }
    assert.deepEqual((await f.harness.listRuns(a1.id)).map(item => item.id), [one.id])
    assert.deepEqual((await f.harness.listNodes(a1.id, null)).nodes.map(({ input, output }) => ({ input, output })), [{ input: 'One', output: 'Answer 0' }])
  } finally {
    for (const call of f.llm.calls) finish(call, 'Test cleanup')
    await f.harness.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('persistent history survives restart and unavailable directories do not hide it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-project-reopen-'))
  const projectPath = join(directory, 'workspace')
  mkdirSync(projectPath)
  const file = join(directory, 'state.sqlite')
  let f = await host(file)
  try {
    const project = await f.harness.openProject(projectPath)
    const session = await f.harness.createSession(project.id, 'assistant')
    const accepted = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Persist', idempotencyKey: 'same' })
    finish(f.llm.calls[0], 'Saved')
    await f.harness.waitRun(accepted.id)
    await f.harness.close()
    f = await host(file)
    assert.equal((await f.harness.getProject(project.id))?.id, project.id)
    assert.deepEqual((await f.harness.listNodes(session.id, null)).nodes.map(({ input, output }) => ({ input, output })), [{ input: 'Persist', output: 'Saved' }])
    assert.equal((await f.harness.listRuns(session.id))[0].id, accepted.id)
    rmSync(projectPath, { recursive: true })
    assert.equal((await f.harness.getProject(project.id))?.available, false)
    assert.equal((await f.harness.listSessions(project.id))[0].id, session.id)
    assert.equal((await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Persist', idempotencyKey: 'same' })).id, accepted.id)
    await assert.rejects(f.harness.createSession(project.id, 'assistant'), /unavailable/)
    await assert.rejects(f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'New', idempotencyKey: 'new' }), /unavailable/)
  } finally { await f.harness.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('a new process settles an abandoned Run as interrupted without replaying it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-project-crash-'))
  const file = join(directory, 'state.sqlite')
  const script = `
    import { Context } from '@nya/core'
    import { createHarness } from './dist/harness.js'
    import { createLocalSqliteComponent } from './dist/storage/sqlite.js'
    import { controlledLLM } from './tests/helpers/controlled-llm.mjs'
    const root = new Context()
    await root.installComponent(controlledLLM().component())
    await root.installComponent(createLocalSqliteComponent(process.argv[1]))
    const harness = await createHarness(root, { agents: [{ id: 'assistant', instructions: 'Shared instructions.', modelProfileId: 'default' }] })
    const project = await harness.openProject(process.cwd())
    const session = await harness.createSession(project.id, 'assistant')
    const run = await harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Maybe executed', idempotencyKey: 'original' })
    process.stdout.write(JSON.stringify({ projectId: project.id, sessionId: session.id, parentNodeId: null, runId: run.id }))
    process.exit(17)
  `
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(child.status, 17, child.stderr)
    const ids = JSON.parse(child.stdout)
    // The child has exited; its file lock is stale rather than owned by a live process.
    rmSync(`${file}.lock`, { recursive: true, force: true })
    const f = await host(file)
    try {
      assert.equal((await f.harness.getRun(ids.runId))?.status, 'interrupted')
      assert.equal(f.llm.calls.length, 0)
      const replay = await f.harness.startRun({ sessionId: ids.sessionId, parentNodeId: null, input: 'Maybe executed', idempotencyKey: 'original' })
      assert.equal(replay.id, ids.runId)
      assert.equal(replay.status, 'interrupted')
      const next = await f.harness.startRun({ sessionId: ids.sessionId, parentNodeId: null, input: 'New attempt', idempotencyKey: 'next' })
      assert.equal(f.llm.calls.length, 1)
      finish(f.llm.calls[0], 'Done')
      assert.equal((await f.harness.waitRun(next.id))?.status, 'completed')
    } finally { await f.harness.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('global Prompt bindings apply to every project while accepted snapshots stay fixed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-project-prompt-'))
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  mkdirSync(a)
  mkdirSync(b)
  const f = await host(join(directory, 'state.sqlite'))
  try {
    const projectA = await f.harness.openProject(a)
    const projectB = await f.harness.openProject(b)
    const sessionA = await f.harness.createSession(projectA.id, 'assistant')
    const sessionB = await f.harness.createSession(projectB.id, 'assistant')
    const document = await f.harness.createPrompt('alice', {
      name: 'Global', kind: 'agent-instruction', role: 'system', content: 'First.',
    })
    const firstVersion = await f.harness.publishPrompt('alice', document.id)
    await f.harness.bindPrompt('alice', 'assistant', firstVersion.id)
    const first = await f.harness.startRun({ sessionId: sessionA.id, parentNodeId: null, input: 'A', idempotencyKey: 'a' })
    await f.harness.editPrompt('alice', document.id, 1, { content: 'Second.' })
    const secondVersion = await f.harness.publishPrompt('alice', document.id)
    await f.harness.bindPrompt('alice', 'assistant', secondVersion.id)
    const second = await f.harness.startRun({ sessionId: sessionB.id, parentNodeId: null, input: 'B', idempotencyKey: 'b' })
    assert.deepEqual(f.llm.calls.map(call => call.input.messages[0].content), ['First.', 'Second.'])
    assert.deepEqual(first.promptVersionIds, [firstVersion.id])
    assert.deepEqual(second.promptVersionIds, [secondVersion.id])
    finish(f.llm.calls[0], 'A done')
    finish(f.llm.calls[1], 'B done')
    await Promise.all([f.harness.waitRun(first.id), f.harness.waitRun(second.id)])
  } finally { await f.harness.close(); rmSync(directory, { recursive: true, force: true }) }
})

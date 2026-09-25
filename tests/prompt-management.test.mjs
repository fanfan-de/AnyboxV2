import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { createAgentComponent } from '../dist/agent/component.js'
import { agentPromptServiceKey, createAgentPromptComponent } from '../dist/agent/prompt-binding-component.js'
import { createRunComponent, runServiceKey } from '../dist/run/component.js'
import { createAgentLoopComponent } from '../dist/run/agent-loop-component.js'
import { createSqliteStateComponent } from '../dist/run/sqlite-state.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { createSessionComponent, sessionServiceKey } from '../dist/run/session-component.js'
import { createPromptComponent, promptServiceKey } from '../dist/prompt/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { controlledLLM, ids } from './helpers/controlled-llm.mjs'

/** The application installs its LLM API component and SQLite before the Harness. */
async function createHostHarness({ llm, databasePath, ...options }) {
  const root = new Context()
  try {
    const provider = root.installComponent(llm.component())
    const database = root.installComponent(createLocalSqliteComponent(databasePath))
    await provider
    await database
    return await createHarness(root, options)
  } catch (error) { await root.fiber.dispose(); throw error }
}

async function createTestHarness(options) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  try {
    const harness = await createHostHarness({ ...options, databasePath: join(directory, 'harness.sqlite') })
    return {
      ...harness,
      async close() {
        try { await harness.close() } finally { rmSync(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

const agents = [{ id: 'assistant', modelProfileId: 'default', instructions: 'Default instruction.' }]

async function createSession(harness, agentId = 'assistant') {
  const project = await harness.openProject(process.cwd())
  return harness.createSession(project.id, agentId)
}

async function createRootSession(root) {
  const project = await root.get(projectServiceKey).openProject(process.cwd())
  return root.get(sessionServiceKey).createSession(project.id, 'assistant')
}

test('editing and activating a prompt changes new runs while accepted runs keep their snapshot', async () => {
  const llm = controlledLLM()
  const harness = await createTestHarness({ agents, llm, newId: ids(), now: () => 'now' })
  try {
    const firstSession = await createSession(harness)
    const first = await harness.startRun({ sessionId: firstSession.id, input: 'First', idempotencyKey: 'first' })
    const document = await harness.createPrompt('alice', {
      name: 'Custom', kind: 'agent-instruction', role: 'system', content: 'Draft instruction.',
    })
    const draft = await harness.editPrompt('alice', document.id, 1, { content: 'Published instruction.' })
    assert.equal(draft.draft.revision, 2)
    const version = await harness.publishPrompt('alice', document.id)
    assert.equal(harness.getPromptVersions('alice', document.id).length, 1)
    assert.equal(harness.getAgentPrompts('alice', 'assistant')[0].content, 'Default instruction.')
    await harness.bindPrompt('alice', 'assistant', version.id)

    const secondSession = await createSession(harness)
    const secondInput = { sessionId: secondSession.id, input: 'Second', idempotencyKey: 'second' }
    const second = await harness.startRun(secondInput)
    assert.deepEqual(llm.calls[0].input.messages[0], { role: 'system', content: 'Default instruction.' })
    assert.deepEqual(llm.calls[1].input.messages[0], { role: 'system', content: 'Published instruction.' })
    assert.notDeepEqual(first.promptVersionIds, second.promptVersionIds)
    assert.equal(JSON.stringify(await harness.getRun(second.id)).includes('Published instruction.'), false)

    const revised = await harness.editPrompt('alice', document.id, 2, { content: 'Later instruction.' })
    await assert.rejects(harness.editPrompt('alice', document.id, 2, { content: 'Lost edit.' }), /revision conflict/)
    await assert.rejects(harness.editPrompt('alice', document.id, 3, { content: null }), /content must be non-empty/)
    assert.equal(revised.draft.revision, 3)
    const later = await harness.publishPrompt('alice', document.id)
    await harness.bindPrompt('alice', 'assistant', later.id)
    assert.equal((await harness.startRun(secondInput)).id, second.id)
    assert.equal(llm.calls.length, 2)

    for (const call of llm.calls) { call.result.resolve('Answer'); call.done.resolve() }
    assert.equal((await harness.waitRun(first.id)).status, 'completed')
    assert.equal((await harness.waitRun(second.id)).status, 'completed')
    assert.deepEqual(first.promptVersionIds, (await harness.getRun(first.id)).promptVersionIds)

    const thirdSession = await createSession(harness)
    const third = await harness.startRun({ sessionId: thirdSession.id, input: 'Third', idempotencyKey: 'third' })
    assert.deepEqual(llm.calls[2].input.messages[0], { role: 'system', content: 'Later instruction.' })
    llm.calls[2].result.resolve('Done')
    llm.calls[2].done.resolve()
    assert.equal((await harness.waitRun(third.id)).status, 'completed')
  } finally {
    for (const call of llm.calls) { call.result.reject(new Error('closed')); call.done.resolve() }
    await harness.close()
  }
})

test('prompt kinds and roles compose into structured model messages', async () => {
  const llm = controlledLLM()
  const harness = await createTestHarness({ agents, llm, newId: ids() })
  try {
    for (const input of [
      { name: 'Instruction', kind: 'agent-instruction', role: 'developer', content: 'Follow team policy.' },
      { name: 'Context', kind: 'context', role: 'user', content: 'Reference data.' },
      { name: 'Task', kind: 'task-template', role: 'user', content: 'Please answer: {{input}}' },
    ]) {
      const document = await harness.createPrompt('alice', input)
      const version = await harness.publishPrompt('alice', document.id)
      await harness.bindPrompt('alice', 'assistant', version.id)
    }
    const session = await createSession(harness)
    const run = await harness.startRun({ sessionId: session.id, input: 'What happened?', idempotencyKey: 'one' })
    assert.deepEqual(llm.calls[0].input.messages, [
      { role: 'developer', content: 'Follow team policy.' },
      { role: 'user', content: 'Reference data.' },
      { role: 'user', content: 'Please answer: What happened?' },
    ])
    assert.equal(run.promptVersionIds.length, 3)
    llm.calls[0].result.resolve('Answered')
    llm.calls[0].done.resolve()
    await harness.waitRun(run.id)
    await assert.rejects(harness.createPrompt('alice', {
      name: 'Bad', kind: 'task-template', role: 'system', content: '{{input}}',
    }), /not allowed/)
    await assert.rejects(harness.createPrompt('alice', {
      name: 'Bad', kind: 'task-template', role: 'user', content: '{{input}} {{input}}',
    }), /exactly once/)
  } finally {
    for (const call of llm.calls) { call.result.reject(new Error('closed')); call.done.resolve() }
    await harness.close()
  }
})

test('a new Harness restores prompts and the active binding from local storage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const databasePath = join(directory, 'harness.sqlite')
  let first
  let second
  try {
    first = await createHostHarness({
      agents, databasePath, llm: controlledLLM({ call() { throw new Error('unused') } }), newId: ids(),
    })
    const document = await first.createPrompt('alice', {
      name: 'Saved instruction', kind: 'agent-instruction', role: 'system', content: 'Persisted instruction.',
    })
    const version = await first.publishPrompt('alice', document.id)
    await first.bindPrompt('alice', 'assistant', version.id)
    await first.close()

    const llm = controlledLLM()
    second = await createHostHarness({ agents, databasePath, llm })
    assert.equal(second.getPrompt('alice', document.id).draft.content, 'Persisted instruction.')
    assert.equal(second.getPromptVersions('alice', document.id)[0].id, version.id)
    const session = await createSession(second)
    const run = await second.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: 'one' })
    assert.deepEqual(llm.calls[0].input.messages[0], {
      role: 'system', content: 'Persisted instruction.',
    })
    llm.calls[0].result.resolve('Hi')
    llm.calls[0].done.resolve()
    assert.equal((await second.waitRun(run.id)).status, 'completed')
  } finally {
    await second?.close()
    await first?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent publish and edit preserve version history in SQLite and the live projection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const databasePath = join(directory, 'harness.sqlite')
  let first
  let second
  try {
    first = await createHostHarness({
      agents, databasePath, llm: controlledLLM({ call() { throw new Error('unused') } }), newId: ids(),
    })
    const document = await first.createPrompt('alice', {
      name: 'Concurrent', kind: 'agent-instruction', role: 'system', content: 'First draft.',
    })
    const publishing = first.publishPrompt('alice', document.id)
    const editing = first.editPrompt('alice', document.id, 1, { content: 'Second draft.' })
    const [version, edited] = await Promise.all([publishing, editing])
    assert.deepEqual(edited.versionIds, [version.id])
    assert.equal(edited.publishedDraftRevision, 1)
    assert.equal(edited.draft.revision, 2)
    await assert.rejects(first.editPrompt('alice', document.id, 1, { content: 'Lost edit.' }), /revision conflict/)
    await first.close()

    second = await createHostHarness({ agents, databasePath, llm: controlledLLM({ call() { throw new Error('unused') } }) })
    assert.deepEqual(second.getPrompt('alice', document.id), edited)
    assert.deepEqual(second.getPromptVersions('alice', document.id).map(item => item.id), [version.id])
  } finally {
    await second?.close()
    await first?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a legacy Prompt JSON file imports once into SQLite without changing the source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const legacyPromptStorePath = join(directory, 'prompts.json')
  const databasePath = join(directory, 'harness.sqlite')
  const fixture = new URL('./fixtures/legacy-prompts-v1.json', import.meta.url)
  let first
  let second
  try {
    copyFileSync(fixture, legacyPromptStorePath)

    first = await createHostHarness({
      agents, databasePath, legacyPromptStorePath,
      llm: controlledLLM({ call() { throw new Error('unused') } }),
    })
    assert.equal(first.getPrompt('alice', 'old-document').draft.content, 'Old instruction.')
    assert.equal(first.getAgentPrompts('alice', 'assistant')[0].versionId, 'old-version')
    await first.close()

    second = await createHostHarness({
      agents, databasePath, legacyPromptStorePath,
      llm: controlledLLM({ call() { throw new Error('unused') } }),
    })
    assert.deepEqual(second.getPromptVersions('alice', 'old-document').map(item => item.id), ['old-version'])
    assert.equal(second.getAgentPrompts('alice', 'assistant')[0].versionId, 'old-version')
    assert.equal(readFileSync(legacyPromptStorePath, 'utf8'), readFileSync(fixture, 'utf8'))
  } finally {
    await second?.close()
    await first?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ownership and agent management permissions protect prompt editing and binding', async () => {
  const harness = await createTestHarness({
    agents, llm: controlledLLM({ call() { throw new Error('unused') } }), newId: ids(),
    canManageAgent: actorId => actorId === 'alice',
  })
  try {
    const bob = await harness.createPrompt('bob', {
      name: 'Private', kind: 'context', role: 'user', content: 'Bob secret.',
    })
    assert.throws(() => harness.getPrompt('alice', bob.id), /access denied/)
    assert.equal(harness.listPrompts('alice').length, 0)
    await assert.rejects(harness.editPrompt('alice', bob.id, 1, { content: 'Stolen.' }), /access denied/)
    await assert.rejects(harness.publishPrompt('alice', bob.id), /access denied/)
    const version = await harness.publishPrompt('bob', bob.id)
    await assert.rejects(harness.bindPrompt('bob', 'assistant', version.id), /configuration access denied/)
    await assert.rejects(harness.bindPrompt('alice', 'assistant', version.id), /prompt access denied/)
    assert.equal(harness.getAgentPrompts('alice', 'assistant')[0].content, 'Default instruction.')
    assert.equal(harness.getPrompt('bob', bob.id).draft.content, 'Bob secret.')
  } finally {
    await harness.close()
  }
})

test('Prompt stays available when Agent is removed and accepted binding writes finish', async () => {
  const root = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const inputs = { newId: ids(), now: () => 'now' }
  const databaseFiber = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  const agentFiber = root.installComponent(createAgentComponent(agents))
  const promptFiber = root.installComponent(createPromptComponent(inputs))
  const agentPromptFiber = root.installComponent(createAgentPromptComponent(inputs, () => true))
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const inside = new Promise(resolve => { entered = resolve })
  try {
    await Promise.all([databaseFiber, agentFiber])
    await promptFiber
    await agentPromptFiber
    const prompts = root.get(promptServiceKey)
    const document = await prompts.createPrompt('alice', {
      name: 'Shared instruction', kind: 'agent-instruction', role: 'system', content: 'Selected instruction.',
    })
    const version = await prompts.publishPrompt('alice', document.id)
    const blocker = root.get(localStorageServiceKey).transaction(async () => { entered(); await gate })
    await inside
    const binding = root.get(agentPromptServiceKey).bindPrompt('alice', 'assistant', version.id)
    let removed = false
    const removing = agentFiber.dispose().then(() => { removed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(removed, false)
    assert.deepEqual(root.get(promptServiceKey).getPrompt('alice', document.id).versionIds, [version.id])
    release()
    await Promise.all([blocker, binding, removing])
    assert.equal(root.get(agentPromptServiceKey), undefined)
    assert.deepEqual(root.get(promptServiceKey).getPrompt('alice', document.id).versionIds, [version.id])

    const replacement = root.installComponent(createAgentComponent(agents))
    await replacement
    await agentPromptFiber
    assert.equal(root.get(agentPromptServiceKey).getAgentPrompts('alice', 'assistant')[0].versionId, version.id)
  } finally {
    release?.()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('removing the prompt component cancels and joins dependent runs', async () => {
  const root = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const llm = controlledLLM()
  const inputs = { newId: ids(), now: () => 'now' }
  const agentsFiber = root.installComponent(createAgentComponent(agents))
  const projectsFiber = root.installComponent(createProjectComponent(inputs))
  const stateFiber = root.installComponent(createSqliteStateComponent(inputs))
  const sessionFiber = root.installComponent(createSessionComponent(inputs))
  const databaseFiber = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  const promptFiber = root.installComponent(createPromptComponent(inputs))
  const agentPromptFiber = root.installComponent(createAgentPromptComponent(inputs, () => true))
  const llmFiber = root.installComponent(llm.component())
  const loopFiber = root.installComponent(createAgentLoopComponent(inputs))
  const runsFiber = root.installComponent(createRunComponent(inputs))
  try {
    await Promise.all([agentsFiber, stateFiber, databaseFiber, llmFiber])
    await loopFiber
    await sessionFiber
    await promptFiber
    await agentPromptFiber
    await runsFiber
    const prompts = root.get(promptServiceKey)
    const document = await prompts.createPrompt('alice', {
      name: 'Owned instruction', kind: 'agent-instruction', role: 'system', content: 'Selected instruction.',
    })
    const version = await prompts.publishPrompt('alice', document.id)
    await root.get(agentPromptServiceKey).bindPrompt('alice', 'assistant', version.id)
    const runs = root.get(runServiceKey)
    const session = await createRootSession(root)
    const run = await runs.startRun({ sessionId: session.id, input: 'Work', idempotencyKey: 'one' })
    const waiting = runs.waitRun(run.id)
    let disposed = false
    const stopping = promptFiber.dispose().then(() => { disposed = true })
    assert.equal(await llm.calls[0].cancelled.promise, 'dependency-unavailable')
    assert.equal(disposed, false)
    llm.calls[0].result.reject(new Error('aborted'))
    llm.calls[0].done.resolve()
    assert.equal((await waiting).status, 'failed')
    await stopping
    assert.equal(root.get(runServiceKey), undefined)
    const replacement = root.installComponent(createPromptComponent(inputs))
    await replacement
    await agentPromptFiber
    await llmFiber
    await loopFiber
    await runsFiber
    const current = root.get(runServiceKey)
    const nextSession = await createRootSession(root)
    const next = await current.startRun({
      sessionId: nextSession.id, input: 'Next', idempotencyKey: 'next',
    })
    assert.equal(llm.calls.length, 2)
    assert.deepEqual(llm.calls[1].input.messages[0], { role: 'system', content: 'Selected instruction.' })
    llm.calls[1].result.resolve('Done')
    llm.calls[1].done.resolve()
    assert.equal((await current.waitRun(next.id)).status, 'completed')
  } finally {
    for (const call of llm.calls) { call.result.reject(new Error('closed')); call.done.resolve() }
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

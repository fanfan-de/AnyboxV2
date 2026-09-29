import { createImageAssetsComponent } from '../dist/image/component.js'
import { imageAssetsServiceKey } from '../dist/image/port.js'
import { installTestProtocolAgents, prepareTestProgram, registerNativeRun, completeNativeRun } from './helpers/native-records.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createSessionComponent } from '../dist/session/component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../dist/session/port.js'
import { createProjectComponent, projectServiceKey } from '../dist/project/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createPromptComponent } from '../dist/prompt/component.js'
import { createAgentPromptComponent } from '../dist/agent/prompt-binding-component.js'
import { createRunRuntimeComponent } from '../dist/run/runtime-component.js'
import { createRunComponent, runServiceKey } from '../dist/run/component.js'
import { createBashComponent } from '../dist/tool/bash-component.js'
import { createApplyPatchComponent } from '../dist/tool/apply-patch-component.js'
import { modelsServiceKey } from '@anybox/models'
import { controlledModels, deferred, ids } from './helpers/controlled-models.mjs'

const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Answer briefly.' }]

async function fixture(execution = false, imagePort) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-session-'))
  const root = new Context()
  const inputs = { newId: ids(), now: () => '2026-09-27T00:00:00Z' }
  const llm = controlledModels()
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await root.installComponent(imagePort ? { name: 'test-session-images', apply(ctx) { ctx.provide(imageAssetsServiceKey, imagePort) } }
      : createImageAssetsComponent({ directory: (join(directory, 'harness.sqlite')) + ".images" }))
    await root.installComponent(createProjectComponent(inputs))
    const sessionFiber = root.installComponent(createSessionComponent(inputs, agents))
    await sessionFiber
    if (execution) {
      await root.installComponent(llm.component())
      await root.installComponent(createPromptComponent(inputs))
      await root.installComponent(createAgentPromptComponent(inputs, agents, () => true))
      await root.installComponent(createBashComponent())
      await root.installComponent(createApplyPatchComponent())
      await root.installComponent(createRunRuntimeComponent(inputs))
      await installTestProtocolAgents(root)
      await root.installComponent(createRunComponent(inputs, agents))
    }
    const project = await root.get(projectServiceKey).openProject(directory)
    return {
      root, inputs, llm, project, sessionFiber,
      async close() {
        for (const call of llm.calls) { call.result.resolve('Finished'); call.done.resolve() }
        try { await root.fiber.dispose() }
        finally { rmSync(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

async function ready(root, service) {
  const started = deferred()
  const probe = root.inject([service], () => { started.resolve() })
  await started.promise
  await probe.dispose()
}

test('Session image done failure terminates a permanently pending result and never hangs shutdown', { timeout: 5000 }, async () => {
  const entered = deferred(), exited = deferred(), cancelled = deferred()
  let cancellations = 0
  const f = await fixture(false, { importImage() {
    entered.resolve()
    return { result: new Promise(() => {}), done: exited.promise, cancel() { cancellations++; cancelled.resolve() } }
  } })
  try {
    const sessions = f.root.get(sessionServiceKey)
    const session = await sessions.createSession(f.project.id, 'assistant')
    const call = sessions.importImage(session.id, { async *[Symbol.asyncIterator]() {} })
    await entered.promise
    const result = assert.rejects(call.result, { code: 'asset-cleanup-failed' })
    const done = assert.rejects(call.done, { code: 'asset-cleanup-failed' })
    exited.reject(new Error('reader failed during cleanup'))
    await cancelled.promise
    await Promise.all([result, done])
    assert.equal(cancellations, 1)
    await f.sessionFiber.dispose()
    await assert.rejects(sessions.getSession(session.id), /closing/)
  } finally { exited.resolve(); await f.close() }
})

test('Session image result failure cancels once and waits for actual done before result and shutdown', { timeout: 5000 }, async () => {
  const entered = deferred(), output = deferred(), exited = deferred(), cancelled = deferred()
  let cancellations = 0
  const f = await fixture(false, { importImage() {
    entered.resolve()
    return { result: output.promise, done: exited.promise, cancel() { cancellations++; cancelled.resolve() } }
  } })
  try {
    const sessions = f.root.get(sessionServiceKey)
    const session = await sessions.createSession(f.project.id, 'assistant')
    const call = sessions.importImage(session.id, { async *[Symbol.asyncIterator]() {} })
    await entered.promise
    const failure = new Error('image import failed')
    let settled = false, stopped = false
    const result = assert.rejects(call.result, error => error === failure).then(() => { settled = true })
    output.reject(failure)
    await cancelled.promise
    const stopping = f.sessionFiber.dispose().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false); assert.equal(stopped, false); assert.equal(cancellations, 1)
    exited.resolve()
    await Promise.all([result, call.done, stopping])
    assert.equal(settled, true); assert.equal(stopped, true); assert.equal(cancellations, 1)
  } finally { output.resolve(); exited.resolve(); await f.close() }
})

test('Session shutdown joins accepted creation through project validation and restores its facts', { timeout: 5000 }, async () => {
  const f = await fixture()
  const release = deferred()
  try {
    const sessions = f.root.get(sessionServiceKey)
    const records = f.root.get(sessionRunServiceKey)
    const projects = f.root.get(projectServiceKey)
    const requireAvailable = projects.requireAvailable.bind(projects)
    const entered = deferred()
    projects.requireAvailable = async id => {
      entered.resolve()
      await release.promise
      return requireAvailable(id)
    }
    const creating = sessions.createSession(f.project.id, 'assistant')
    await entered.promise
    let stopped = false
    const stopping = f.sessionFiber.dispose().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    assert.equal(f.root.get(sessionServiceKey), undefined)
    assert.equal(f.root.get(sessionRunServiceKey), undefined)
    await assert.rejects(sessions.getSession('missing'), /closing/)
    await assert.rejects(records.getRun('missing'), /closing/)
    release.resolve()
    const session = await creating
    await stopping
    await f.root.installComponent(createSessionComponent(f.inputs, agents))
    assert.deepEqual(await f.root.get(sessionServiceKey).getSession(session.id), session)
    assert.deepEqual(await f.root.get(sessionServiceKey).listRuns(session.id), [])
    assert.equal(f.root.get(modelsServiceKey), undefined)
  } finally { release.resolve(); await f.close() }
})

test('Session revocation joins executing consumers and a new owner preserves conversation and Run records', { timeout: 5000 }, async () => {
  const f = await fixture(true)
  try {
    const sessions = f.root.get(sessionServiceKey)
    const records = f.root.get(sessionRunServiceKey)
    const runs = f.root.get(runServiceKey)
    const model = f.root.get(modelsServiceKey)
    const storage = f.root.get(localStorageServiceKey)
    const session = await sessions.createSession(f.project.id, 'assistant')
    const first = await runs.startRun({ sessionId: session.id, parentNodeId: null, input: 'First', idempotencyKey: 'first' })
    f.llm.calls[0].result.resolve('Saved answer')
    f.llm.calls[0].done.resolve()
    const completed = await runs.waitRun(first.id)
    const second = await runs.startRun({ sessionId: session.id, parentNodeId: completed.resultNodeId, input: 'In flight', idempotencyKey: 'second' })
    const waiting = runs.waitRun(second.id)
    let stopped = false
    const stopping = f.sessionFiber.dispose().then(() => { stopped = true })
    await f.llm.calls[1].cancelled.promise
    assert.equal(stopped, false)
    assert.equal(f.root.get(runServiceKey), undefined)
    // The old dependency snapshot remains usable until its execution consumers finish cleanup.
    assert.equal((await records.getRun(second.id)).status, 'running')
    f.llm.calls[1].result.reject(new Error('aborted'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    f.llm.calls[1].done.resolve()
    const interrupted = await waiting
    assert.equal(interrupted.status, 'failed')
    assert.equal(interrupted.errorCategory, 'dependency-unavailable')
    await stopping
    await assert.rejects(sessions.getSession(session.id), /closing/)
    assert.equal(f.root.get(modelsServiceKey), model)
    assert.equal(f.root.get(localStorageServiceKey), storage)
    assert.deepEqual(f.llm.events, [])

    await f.root.installComponent(createSessionComponent(f.inputs, agents))
    await ready(f.root, runServiceKey)
    const current = f.root.get(sessionServiceKey)
    assert.notEqual(current, sessions)
    assert.deepEqual(await current.getSession(session.id), { ...session, protocolId: 'chat-completions' })
    assert.deepEqual(await current.getRun(second.id), interrupted)
    assert.equal((await current.getRunEvents(second.id)).at(-1).status, 'failed')
    assert.deepEqual((await current.getNodePath(session.id, completed.resultNodeId)).map(node => node.output), ['Saved answer'])
    const next = await f.root.get(runServiceKey).startRun({ sessionId: session.id, parentNodeId: completed.resultNodeId, input: 'Continue', idempotencyKey: 'third' })
    assert.deepEqual(f.llm.calls[2].input.messages.map(message => message.content), ['Answer briefly.', 'First', 'Saved answer', 'Continue'])
    f.llm.calls[2].result.resolve('Continued')
    f.llm.calls[2].done.resolve()
    assert.equal((await f.root.get(runServiceKey).waitRun(next.id)).status, 'completed')
  } finally { await f.close() }
})

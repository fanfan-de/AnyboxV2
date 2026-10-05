import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createProjectComponent, projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../dist/applications/harness/core/session/port.js'
import { createPromptComponent } from '../dist/applications/harness/core/prompt/component.js'
import { createAgentPromptComponent } from '../dist/applications/harness/core/agent/prompt-binding-component.js'
import { createBashComponent } from '../dist/applications/harness/core/tool/bash-component.js'
import { createApplyPatchComponent } from '../dist/applications/harness/core/tool/apply-patch-component.js'
import { createFileToolsComponent } from '../dist/applications/harness/core/tool/files-component.js'
import { createProcessToolsComponent } from '../dist/applications/harness/core/tool/process-component.js'
import { createRunRuntimeComponent } from '../dist/applications/harness/core/run/runtime-component.js'
import { createRunComponent, runServiceKey } from '../dist/applications/harness/core/run/component.js'
import { controlledModels, ids } from './helpers/controlled-models.mjs'
import { installTestProtocolAgents } from './helpers/native-records.mjs'

async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('the expected revocation state was not reached')
}

test('process dependency revocation joins the next model call and yielded process before durable settlement', { timeout: 15000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-process-revoke-')))
  const root = new Context(), llm = controlledModels()
  const inputs = { now: () => '2026-10-04T00:00:00.000Z', newId: ids() }
  const agents = [{ id: 'assistant', instructions: 'Use the selected tools.', modelId: 'default' }]
  let stopping
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
    await root.installComponent(createProjectComponent(inputs))
    await root.installComponent(createProjectFilesComponent(inputs))
    await root.installComponent(createSessionComponent(inputs, agents))
    await root.installComponent(createPromptComponent(inputs))
    await root.installComponent(createAgentPromptComponent(inputs, agents, () => true))
    await root.installComponent(llm.component())
    await root.installComponent(createBashComponent())
    await root.installComponent(createApplyPatchComponent())
    const processFiber = root.installComponent(createProcessToolsComponent({ terminationGraceMs: 1000 }))
    await processFiber
    await root.installComponent(createFileToolsComponent())
    await root.installComponent(createRunRuntimeComponent(inputs))
    await installTestProtocolAgents(root)
    await root.installComponent(createRunComponent(inputs, agents))

    const project = await root.get(projectServiceKey).openProject(directory)
    const sessions = root.get(sessionServiceKey), records = root.get(sessionRunServiceKey)
    await sessions.setAgentTools('assistant', { toolIds: ['codex.exec_command', 'codex.write_stdin'], expectedRevision: 0 })
    const session = await sessions.createSession(project.id, 'assistant')
    const runs = root.get(runServiceKey)
    const run = await runs.startRun({ sessionId: session.id, parentNodeId: null, input: 'Keep a process running.', idempotencyKey: 'revoke' })
    let settled = false
    const waiting = runs.waitRun(run.id).then(value => { settled = true; return value })
    llm.calls[0].result.resolve({ status: 'completed', text: '', toolCalls: [{ id: 'process', name: 'codex_exec_command', arguments: {
      cmd: "printf '%s' $$ > pid; trap 'printf stopping > stopping; sleep 0.25; printf stopped > stopped; exit' TERM; printf ready > started; while :; do sleep 1; done",
      login: false, yield_time_ms: 20,
    } }] })
    llm.calls[0].done.resolve()
    await until(() => llm.calls.length === 2 && existsSync(join(directory, 'started')))
    const observed = (await sessions.getRunEvents(run.id)).find(event => event.kind === 'tool-observed')
    assert.equal(observed.name, 'codex_exec_command')
    assert.equal(typeof observed.result.session_id, 'number')
    const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'))
    process.kill(pid, 0)

    let disposed = false
    stopping = processFiber.dispose().then(() => { disposed = true })
    await llm.calls[1].cancelled.promise
    assert.equal(disposed, false, 'dependency disposal must join the model actual-exit barrier')
    assert.equal(settled, false)
    assert.equal((await records.getRun(run.id)).status, 'running')

    llm.calls[1].done.resolve()
    await until(() => existsSync(join(directory, 'stopping')))
    assert.equal(disposed, false, 'model exit alone must not complete process dependency disposal')
    assert.equal(settled, false, 'Run settlement must still wait for the yielded process')
    assert.equal(existsSync(join(directory, 'stopped')), false)
    const terminal = await waiting
    await stopping
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.errorCategory, 'dependency-unavailable')
    assert.equal(terminal.resultNodeId, undefined)
    assert.equal(existsSync(join(directory, 'stopped')), true)
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    assert.equal(llm.calls.length, 2, 'revocation must not admit a further model exchange')
    assert.deepEqual((await sessions.listNodes(session.id, null)).nodes, [])

    const cleanup = await root.get(localStorageServiceKey).read(reader => reader.all(
      "SELECT intent_json, observation_json FROM harness_run_operations WHERE run_id = ? AND kind = 'operation'", [run.id]))
    const final = cleanup.find(row => JSON.parse(row.intent_json).kind === 'tool-process-cleanup')
    assert.ok(final, 'a yielded process requires a durable final cleanup operation')
    const result = JSON.parse(final.observation_json)
    assert.equal(result.kind, 'value')
    assert.equal(result.result.cleanup, 'completed')
    assert.equal(result.result.processes[0].session_id, observed.result.session_id)
    assert.equal(result.result.processes[0].terminated, true)
    assert.equal(result.result.processes[0].exit_code, 0)
    assert.equal(result.result.processes[0].signal, null)
  } finally {
    for (const call of llm.calls) call.done.resolve()
    try { if (stopping) await stopping; await root.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

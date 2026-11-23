import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { controlledModels, modelSnapshot } from '../../../tests/helpers/controlled-models.mjs'
import { installHarnessServerCore } from '../dist/core/index.js'
import { createImageAssetsComponent } from '../dist/core/image/component.js'

test('Personal Agent recovery requires the accepted Run environment access even for a saved tool-free response', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-agent-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const agentIds = ['legacy', 'authorized']
  const agents = agentIds.map(id => ({ id, instructions: 'Reply briefly.', modelId: 'default', environmentIds: [] }))

  async function open(models) {
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(join(directory, 'execution.sqlite')))
      await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
      await root.installComponent(models.component())
      const { api } = await installHarnessServerCore(root, { agents, localWorkerDirectory: join(directory, 'computer-worker') })
      return { api, root, close: () => root.fiber.dispose() }
    } catch (error) {
      await root.fiber.dispose()
      throw error
    }
  }

  const first = await open(controlledModels())
  try {
    const project = await first.api.openProject(directory)
    const records = first.root.get('personal-agent.session-runs')
    for (const agentId of agentIds) {
      const session = await first.api.openContinuousSession(project.id, agentId)
      const id = `run-${agentId}`, exchange = `${id}:exchange`
      const input = { sessionId: session.id, projectId: project.id, parentNodeId: null, input: 'Hello', idempotencyKey: id }
      const at = new Date().toISOString()
      await records.registerRun(id, input, at, [], modelSnapshot(), {
        access: { agentId, functions: [] }, selectionVersion: session.environmentSelection.version,
        binding: { protocolId: 'chat-completions', generationId: 'fixture', driverVersion: 'v1',
          loopVersion: '1.0.0', recordFormatVersion: 1, viewSchemaVersion: 1 },
        initialization: { schemaVersion: 3, toolContractVersion: 'tool-environments-v1', prompts: [], tools: [],
          toolEnvironments: session.toolEnvironments, toolSelection: session.toolSelection },
        input: { schemaVersion: 1, raw: input.input, text: input.input, template: null }, parentContextRef: null,
      })
      const request = { id: `${id}:request`, exchangeId: exchange, kind: 'request', formatVersion: 1,
        payload: { messages: [{ role: 'user', content: input.input }] } }
      const response = { id: `${id}:response`, exchangeId: exchange, kind: 'response', formatVersion: 1,
        payload: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Saved response.' } }] } }
      await records.startOperation(id, { id: exchange, kind: 'model', intent: {}, records: [request] }, at, 1)
      await records.observeOperation(id, exchange, { kind: 'value', records: [request, response],
        protocolCursor: { schemaVersion: 1, protocolId: 'chat-completions', exchangeId: exchange } }, at, 1)
    }
    // The older writer saved the response and cursor without an environment authorization row.
    await first.root.get('local-storage').transaction(tx => tx.execute('DELETE FROM harness_run_environment_access WHERE run_id = ?', ['run-legacy']))
    assert.equal((await records.listRunResumes()).length, 2)
  } finally {
    await first.close()
  }

  const models = controlledModels()
  const restarted = await open(models)
  try {
    const legacy = await restarted.api.waitRun('run-legacy')
    assert.equal(legacy.status, 'failed')
    assert.equal(legacy.errorCategory, 'dependency-unavailable')
    assert.equal(legacy.resultNodeId, undefined)
    const authorized = await restarted.api.waitRun('run-authorized')
    assert.equal(authorized.status, 'completed')
    assert.equal(authorized.output, 'Saved response.')
    assert.equal(models.opens.length, 1, 'only the authorized Run restores model execution')
    assert.equal(models.calls.length, 0, 'recovery never replays the committed model exchange')
  } finally {
    await restarted.close()
  }
})

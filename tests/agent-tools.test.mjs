import { installComputerServices, installComputerWorkerStub } from './helpers/computer-services.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createImageAssetsComponent } from '../packages/app-harness/dist/core/image/component.js'
import { createProjectComponent } from '../packages/app-harness/dist/core/project/component.js'
import { createProjectFilesComponent } from '../packages/app-harness/dist/core/project-files/component.js'
import { createSessionComponent } from '../packages/app-harness/dist/core/session/component.js'
import { createToolSelection, defaultToolIds, legacyToolSelection } from '../packages/app-harness/dist/core/tool/catalog.js'
import { createToolEnvironmentRegistry } from '../packages/app-harness/dist/core/tool-environments/registry.js'
import { deferred, ids } from './helpers/controlled-models.mjs'
import { registerNativeRun } from './helpers/native-records.mjs'
import sharp from 'sharp'

const agents = [{ id: 'assistant', instructions: 'Assist.' }, { id: 'reviewer', instructions: 'Review.' }]
async function open(directory, options = {}) {
  const root = new Context(), inputs = { newId: ids(), now: () => 'now' }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await installComputerWorkerStub(root)
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  const { worker } = await installComputerServices(root, inputs)
  await root.installComponent(createSessionComponent(inputs, options.agents ?? agents, options.environments))
  const sessions = root.get('harness.sessions'), project = await root.get('harness.projects').openProject(directory)
  return { root, sessions, project, worker, db: root.get('local-storage'), close: () => root.fiber.dispose() }
}
async function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-agent-tools-')), f = await open(directory, options)
  t.after(async () => { try { await f.close() } finally { rmSync(directory, { recursive: true, force: true }) } })
  return { ...f, directory }
}

const noteTool = Object.freeze({ toolId: 'notes.lookup', version: '1', definition: {
  name: 'notes_lookup', description: 'Look up a note.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
} })
const noteEnvironment = (tools = [noteTool], version = '1') => ({ environmentId: 'notes', version, tools,
  openScope() { throw new Error('Session creation must not acquire an environment scope') } })

test('inserted environments supply Session tools and their immutable snapshots survive later environment changes', async t => {
  const configuredAgents = [{ id: 'assistant', instructions: 'Assist.', environmentIds: ['notes'] }]
  const environments = createToolEnvironmentRegistry([noteEnvironment()])
  const f = await fixture(t, { agents: configuredAgents, environments })
  const original = await f.sessions.createSession(f.project.id, 'assistant')
  assert.deepEqual(original.toolSelection.tools, [noteTool])
  assert.deepEqual(original.toolEnvironments, { schemaVersion: 1, environments: [{ environmentId: 'notes', version: '1', tools: [noteTool] }] })
  await f.sessions.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
  assert.deepEqual((await f.sessions.createSession(f.project.id, 'assistant')).toolSelection.tools, [noteTool], 'Computer filtering does not remove tools supplied by another environment')
  await assert.rejects(f.db.transaction(tx => tx.execute('UPDATE harness_sessions SET tool_environments_json = ? WHERE id = ?', ['{}', original.id])), { code: 'operation-failed' })
  await f.close()
  const changedTool = { ...noteTool, version: '2', definition: { ...noteTool.definition, description: 'New note lookup.' } }
  const changed = createToolEnvironmentRegistry([noteEnvironment([changedTool], '2')])
  const restarted = await open(f.directory, { agents: configuredAgents, environments: changed })
  try {
    const retained = await restarted.sessions.getSession(original.id)
    assert.deepEqual(retained.toolEnvironments, original.toolEnvironments)
    assert.deepEqual(retained.toolSelection, original.toolSelection)
    assert.deepEqual((await restarted.sessions.createSession(f.project.id, 'assistant')).toolSelection.tools, [changedTool])
    assert.throws(() => changed.validate(retained.toolEnvironments), /unavailable/)
  } finally { await restarted.close() }
})

test('an explicit empty environment selection creates tool-free Sessions and does not acquire a Computer environment', async t => {
  const f = await fixture(t, { agents: [{ id: 'assistant', instructions: 'Assist.', environmentIds: [] }], environments: createToolEnvironmentRegistry([]) })
  const session = await f.sessions.createSession(f.project.id, 'assistant')
  assert.deepEqual(session.toolSelection, { schemaVersion: 1, tools: [] })
  assert.deepEqual(session.toolEnvironments, { schemaVersion: 1, environments: [] })
})

test('custom environment operations use the Session ledger without creating Computer operations or accepting a downgraded initialization', async t => {
  const f = await fixture(t, { agents: [{ id: 'assistant', instructions: 'Assist.', environmentIds: ['notes'] }], environments: createToolEnvironmentRegistry([noteEnvironment()]) })
  const session = await f.sessions.createSession(f.project.id, 'assistant'), records = f.root.get('harness.session-runs')
  const input = { sessionId: session.id, input: 'look up', parentNodeId: null, idempotencyKey: 'custom' }
  const initialization = { schemaVersion: 3, prompts: [], toolContractVersion: 'tool-environments-v1', toolSelection: session.toolSelection,
    toolEnvironments: session.toolEnvironments, tools: session.toolSelection.tools.map(tool => tool.definition) }
  await assert.rejects(registerNativeRun(records, 'downgrade', input, 'now', [], undefined,
    { schemaVersion: 2, prompts: [], toolContractVersion: 'tool-library-v1', toolSelection: session.toolSelection, tools: initialization.tools }), { code: 'history-incompatible' })
  await registerNativeRun(records, 'custom-run', input, 'now', [], undefined, initialization)
  await records.startOperation('custom-run', { id: 'lookup', kind: 'tool', intent: {}, tool: { id: 'call', name: 'notes_lookup', arguments: { key: 'a' } } }, 'now')
  await records.observeOperation('custom-run', 'lookup', { kind: 'value', tool: { name: 'notes_lookup', result: { text: 'a note' } } }, 'now')
  const operation = await records.getRunOperation('custom-run', 'lookup')
  assert.deepEqual(operation.observation.tool.result, { text: 'a note' })
  assert.equal((await f.sessions.getRunEvents('custom-run')).find(event => event.kind === 'tool-observed').name, 'notes_lookup')
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT operation_id FROM harness_computer_operations')), [])
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT run_id FROM harness_computer_scopes')), [])
})

test('legacy Sessions retain their existing tools when an environment registry is later inserted', async t => {
  const f = await fixture(t)
  const original = await f.sessions.createSession(f.project.id, 'assistant')
  assert.equal(original.toolEnvironments, undefined)
  await f.close()
  const restarted = await open(f.directory, { agents: [{ id: 'assistant', instructions: 'Assist.', environmentIds: ['notes'] }], environments: createToolEnvironmentRegistry([noteEnvironment()]) })
  try {
    const old = await restarted.sessions.getSession(original.id)
    assert.equal(old.toolEnvironments, undefined)
    assert.deepEqual(old.toolSelection, original.toolSelection)
    assert.deepEqual((await restarted.sessions.createSession(f.project.id, 'assistant')).toolSelection.tools, [noteTool])
  } finally { await restarted.close() }
})

test('Agent choices copy exact mixed-source tool definitions into new Sessions and preserve empty selection', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.sessions.getAgentTools('assistant'), { agentId: 'assistant', toolIds: defaultToolIds, revision: 0 })
  const original = await f.sessions.createSession(f.project.id, 'assistant')
  const toolIds = ['claude-code.Read', 'deepseek-harness.edit', 'codex.view_image']
  const saved = await f.sessions.setAgentTools('assistant', { toolIds, expectedRevision: 0 })
  assert.equal(saved.revision, 1)
  const mixed = await f.sessions.createSession(f.project.id, 'assistant')
  assert.deepEqual(mixed.toolSelection, createToolSelection(toolIds))
  assert.deepEqual((await f.sessions.getSession(original.id)).toolSelection, createToolSelection())
  assert.equal((await f.sessions.getAgentTools('reviewer')).revision, 0)
  await f.sessions.setAgentTools('assistant', { toolIds: [], expectedRevision: saved.revision })
  assert.deepEqual((await f.sessions.createSession(f.project.id, 'assistant')).toolSelection.tools, [])
  assert.equal(mixed.protocolId, null)
  await assert.rejects(f.db.transaction(tx => tx.execute('UPDATE harness_sessions SET tool_selection_json = ? WHERE id = ?', ['{}', mixed.id])), { code: 'operation-failed' })
})

test('Agent tool CAS rejects stale edits, invalid tools and incomplete process pairs without altering saved selection', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([
    f.sessions.setAgentTools('assistant', { toolIds: ['claude-code.Read'], expectedRevision: 0 }),
    f.sessions.setAgentTools('assistant', { toolIds: ['deepseek-harness.read'], expectedRevision: 0 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'agent-tools-conflict')
  const saved = await f.sessions.getAgentTools('assistant')
  for (const toolIds of [['unknown.tool'], ['codex.exec_command'], ['codex.update_plan'], ['claude-code.TodoWrite'], ['deepseek-harness.todo_write']]) {
    await assert.rejects(f.sessions.setAgentTools('assistant', { toolIds, expectedRevision: saved.revision }), TypeError)
  }
  await assert.rejects(f.sessions.setAgentTools('unknown-agent', { toolIds: [], expectedRevision: 0 }))
  assert.deepEqual(await f.sessions.getAgentTools('assistant'), saved)
})

test('stored retired Agent choices are omitted from new Sessions without resetting their CAS revision', async t => {
  const f = await fixture(t)
  await f.db.transaction(tx => tx.execute('INSERT INTO harness_agent_tool_settings (agent_id, tool_ids_json, revision) VALUES (?, ?, ?)',
    ['assistant', JSON.stringify(['codex.update_plan', 'claude-code.Read', 'claude-code.TodoWrite', 'deepseek-harness.todo_write']), 4]))
  assert.deepEqual(await f.sessions.getAgentTools('assistant'), { agentId: 'assistant', toolIds: ['claude-code.Read'], revision: 4 })
  const session = await f.sessions.createSession(f.project.id, 'assistant')
  assert.deepEqual(session.toolSelection, createToolSelection(['claude-code.Read']))
  await assert.rejects(f.sessions.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 }), { code: 'agent-tools-conflict' })
  assert.equal((await f.sessions.setAgentTools('assistant', { toolIds: ['claude-code.Read'], expectedRevision: 4 })).revision, 5)
})

test('Session creation reads the latest Agent selection inside its creation transaction and restart preserves it', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const projects = f.root.get('harness.projects'), requireAvailable = projects.requireAvailable.bind(projects)
  projects.requireAvailable = async id => { entered.resolve(); await release.promise; return requireAvailable(id) }
  const creating = f.sessions.createSession(f.project.id, 'assistant')
  await entered.promise
  const saved = await f.sessions.setAgentTools('assistant', { toolIds: ['deepseek-harness.read'], expectedRevision: 0 })
  release.resolve()
  const session = await creating
  projects.requireAvailable = requireAvailable
  assert.deepEqual(session.toolSelection, createToolSelection(saved.toolIds))
  await f.close()
  const restarted = await open(f.directory)
  try {
    assert.deepEqual(await restarted.sessions.getAgentTools('assistant'), saved)
    assert.deepEqual((await restarted.sessions.getSession(session.id)).toolSelection, session.toolSelection)
  } finally { await restarted.close() }
})

test('Agent tool writes are joined during shutdown and the old Session service rejects new writes', { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), transaction = f.db.transaction.bind(f.db)
  f.db.transaction = async work => { entered.resolve(); await release.promise; return transaction(work) }
  const saving = f.sessions.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
  await entered.promise
  let exited = false
  const closing = f.close().then(() => { exited = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exited, false)
  await assert.rejects(f.sessions.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 }), /closing/)
  release.resolve(); await saving; await closing
  assert.equal(exited, true)
})

test('tool-read images are retained atomically with their observation and can appear in later native request records', async t => {
  const f = await fixture(t), session = await f.sessions.createSession(f.project.id, 'assistant')
  const records = f.root.get('harness.session-runs'), images = f.root.get('harness.image-assets')
  const picture = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer()
  const importing = images.importImage({ scopeId: session.id, bytes: (async function* () { yield picture })() })
  const { expiresAt, ...image } = await importing.result; await importing.done
  await registerNativeRun(records, 'run', { sessionId: session.id, input: 'image', parentNodeId: null, idempotencyKey: 'image' }, 'now', [], undefined,
    { schemaVersion: 2, prompts: [], toolContractVersion: 'tool-library-v1', toolSelection: session.toolSelection,
      tools: session.toolSelection.tools.map(tool => tool.definition) })
  await records.startOperation('run', { id: 'tool', kind: 'tool', intent: {}, tool: { id: 'tool-call', name: 'codex_view_image', arguments: { path: 'image.png' } } }, 'now')
  f.worker.setExecution('run', {
    execute(request, binding) {
      assert.equal(binding.projectId, f.project.id)
      return { result: Promise.resolve({ name: request.name, result: { path: 'image.png' }, images: [image] }),
        done: Promise.resolve(), cancel() {} }
    },
    hasProcesses: () => false,
    close: () => ({ result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }),
  })
  const scope = f.root.get('harness.computer-operations').openRun({ runId: 'run' })
  const reading = scope.execute('tool'); await reading.result; await reading.done
  await assert.rejects(records.observeOperation('run', 'tool', { kind: 'value', tool: { name: 'codex_view_image', result: {}, images: [{ ...image, sha256: 'invalid' }] } }, 'now'))
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions').map(row => ({ ...row }))), [{ asset_id: image.assetId, owner_key: 'computer-operation:tool' }])
  await records.observeOperation('run', 'tool', { kind: 'value', tool: { name: 'codex_view_image', result: { path: 'image.png' }, images: [image] } }, 'now')
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions ORDER BY owner_key').map(row => ({ ...row }))), [
    { asset_id: image.assetId, owner_key: 'computer-operation:tool' }, { asset_id: image.assetId, owner_key: 'run-tool:run:tool' },
  ])
  const ref = { id: image.assetId, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mediaType }
  await records.startOperation('run', { id: 'model', kind: 'model', intent: {}, records: [{ id: 'next-request', exchangeId: 'model', kind: 'request', formatVersion: 2, payload: { input: [] }, resourceRefs: [ref] }] }, 'now')
  await records.observeOperation('run', 'model', { kind: 'value', result: { process: 'closed' } }, 'now')
  assert.deepEqual((await f.sessions.getRunRecords('run')).find(record => record.id === 'next-request').resourceRefs, [ref])
  const closing = scope.close(); await closing.result; await closing.done
})

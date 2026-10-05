import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { createToolSelection, defaultToolIds, legacyToolSelection } from '../dist/applications/harness/core/tool/catalog.js'
import { deferred, ids } from './helpers/controlled-models.mjs'
import { registerNativeRun } from './helpers/native-records.mjs'
import sharp from 'sharp'

const agents = [{ id: 'assistant', instructions: 'Assist.' }, { id: 'reviewer', instructions: 'Review.' }]
async function open(directory) {
  const root = new Context(), inputs = { newId: ids(), now: () => 'now' }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(createProjectComponent(inputs))
  await root.installComponent(createProjectFilesComponent(inputs))
  await root.installComponent(createSessionComponent(inputs, agents))
  const sessions = root.get('harness.sessions'), project = await root.get('harness.projects').openProject(directory)
  return { root, sessions, project, db: root.get('local-storage'), close: () => root.fiber.dispose() }
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-agent-tools-')), f = await open(directory)
  t.after(async () => { try { await f.close() } finally { rmSync(directory, { recursive: true, force: true }) } })
  return { ...f, directory }
}

test('Agent choices copy exact mixed-source tool definitions into new Sessions and preserve empty selection', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.sessions.getAgentTools('assistant'), { agentId: 'assistant', toolIds: defaultToolIds, revision: 0 })
  const original = await f.sessions.createSession(f.project.id, 'assistant')
  const toolIds = ['claude-code.Read', 'deepseek-harness.edit', 'codex.update_plan']
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
  for (const toolIds of [['unknown.tool'], ['codex.exec_command']]) {
    await assert.rejects(f.sessions.setAgentTools('assistant', { toolIds, expectedRevision: saved.revision }), TypeError)
  }
  await assert.rejects(f.sessions.setAgentTools('unknown-agent', { toolIds: [], expectedRevision: 0 }))
  assert.deepEqual(await f.sessions.getAgentTools('assistant'), saved)
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
  await registerNativeRun(records, 'run', { sessionId: session.id, input: 'image', parentNodeId: null, idempotencyKey: 'image' }, 'now')
  await records.startOperation('run', { id: 'tool', kind: 'tool', intent: {}, tool: { id: 'tool-call', name: 'codex_view_image', arguments: { path: 'image.png' } } }, 'now')
  await assert.rejects(records.observeOperation('run', 'tool', { kind: 'value', tool: { name: 'codex_view_image', result: {}, images: [{ ...image, sha256: 'invalid' }] } }, 'now'))
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions')), [])
  await records.observeOperation('run', 'tool', { kind: 'value', tool: { name: 'codex_view_image', result: { path: 'image.png' }, images: [image] } }, 'now')
  assert.deepEqual(await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions').map(row => ({ ...row }))), [{ asset_id: image.assetId, owner_key: 'run-tool:run:tool' }])
  const ref = { id: image.assetId, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mediaType }
  await records.startOperation('run', { id: 'model', kind: 'model', intent: {}, records: [{ id: 'next-request', exchangeId: 'model', kind: 'request', formatVersion: 2, payload: { input: [] }, resourceRefs: [ref] }] }, 'now')
  await records.observeOperation('run', 'model', { kind: 'value', result: { process: 'closed' } }, 'now')
  assert.deepEqual((await f.sessions.getRunRecords('run')).find(record => record.id === 'next-request').resourceRefs, [ref])
})

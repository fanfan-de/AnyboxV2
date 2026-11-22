import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createProjectComponent } from '../packages/app-harness/dist/core/project/component.js'
import { createWorkspacesComponent } from '../packages/app-harness/dist/core/workspace/component.js'
import { createUnitAttachmentsComponent } from '../packages/app-harness/dist/core/unit/component.js'
import { allowedProxyPath } from '../packages/app-harness/dist/client/gateway.js'
import { deferred } from './helpers/controlled-models.mjs'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'

const inputs = { now: () => new Date().toISOString(), newId: randomUUID }
const scope = { kind: 'computer', projects: 'all', tools: 'all' }
async function fixture(t, query, seed) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-project-members-')), root = new Context()
  t.after(async () => { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const db = root.get('local-storage')
  if (seed) await seed(db)
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [{ unitKind: 'computer', unitId: 'dev' }] }))
  const queries = []
  await root.installComponent(createProjectComponent(inputs, { enableWorkspaceAttachments: true,
    async computerQuery(attachmentId, input) {
      queries.push({ attachmentId, input })
      if (query) await query(attachmentId, input)
      return { kind: 'stat', directory: true, canonical: input.path }
    },
  }))
  await root.installComponent(createWorkspacesComponent(inputs))
  const units = root.get('harness.unit-attachments'), projects = root.get('harness.projects')
  const project = await projects.openProject(directory)
  const code = await units.createAttachCode({ unitKind: 'computer', scope })
  const { attachment } = await units.attach({ code: code.code, unitKind: 'computer', unitId: 'deploy', contractVersion: '1', ceiling: scope })
  const add = { computerAttachmentId: attachment.attachmentId, path: '/srv/app', name: 'Staging', requestId: 'add', expectedRevision: 1 }
  return { root, directory, db, project, projects, units, queries, add, workspaces: root.get('harness.workspaces') }
}

test('project workspace management preserves intent, revisions and exact membership across concurrent edits', async t => {
  const { projects, project, db, queries, add, units } = await fixture(t)
  const one = await projects.listProjectWorkspaces(project.id)
  assert.equal(one.revision, 1); assert.deepEqual(one.workspaces.map(m => m.id), [project.id])
  const [two, replay] = await Promise.all([projects.addProjectWorkspace(project.id, add), projects.addProjectWorkspace(project.id, add)])
  assert.deepEqual(two, replay)
  const [primary, remote] = two.workspaces
  assert.equal(primary.primary, true); assert.equal(remote.path, '/srv/app'); assert.equal(remote.primary, false)
  assert.equal((await projects.getProject(project.id)).workspaceCount, 2)
  const renamed = await projects.renameProjectWorkspace(project.id, remote.id, { requestId: 'rename', expectedRevision: 2, name: 'Test' })
  assert.deepEqual(renamed.workspaces[1], { ...remote, name: 'Test' }); assert.equal(renamed.revision, 3)
  assert.deepEqual(await projects.addProjectWorkspace(project.id, add), two, 'retry obtains the original receipt')
  await assert.rejects(projects.addProjectWorkspace(project.id, { ...add, name: 'Other intent' }), { code: 'project-workspace-request-conflict' })
  await assert.rejects(projects.addProjectWorkspace(project.id, { ...add, requestId: 'stale' }), { code: 'project-workspace-conflict' })
  assert.ok(queries.length <= 2, 'replaying a committed request does not query the worker')
  await assert.rejects(projects.addProjectWorkspace(project.id, { ...add, expectedRevision: 3, requestId: 'duplicate' }), { code: 'project-workspace-duplicate' })
  await assert.rejects(projects.removeProjectWorkspace(project.id, primary.id, { requestId: 'primary', expectedRevision: 3 }), { code: 'project-workspace-primary' })
  const pinned = await db.read(tx => projects.selectWorkspacesIn(tx, project.id, [remote.id], 3))
  assert.deepEqual(pinned, renamed.workspaces)
  await assert.rejects(db.read(tx => projects.selectWorkspacesIn(tx, project.id, [remote.id], 2)), { code: 'project-workspace-conflict' })
  await db.transaction(tx => projects.retainWorkspacesIn(tx, 'run', project.id, pinned))
  const remove = { requestId: 'remove', expectedRevision: 3 }
  await assert.rejects(projects.removeProjectWorkspace(project.id, remote.id, remove), { code: 'project-workspace-in-use' })
  await db.transaction(tx => projects.releaseWorkspacesIn(tx, 'run'))
  assert.deepEqual((await projects.removeProjectWorkspace(project.id, remote.id, remove)).workspaces, [primary])
  assert.equal((await units.get(add.computerAttachmentId)).state, 'approved')
  const again = await projects.addProjectWorkspace(project.id, { ...add, expectedRevision: 4, requestId: 'again' })
  assert.notEqual(again.workspaces[1].id, remote.id)
  await assert.rejects(projects.resolveWorkspaces(project.id, pinned), { code: 'project-workspace-unavailable' })
})

test('revoking an attachment before the remote directory check returns vetoes the project edit', async t => {
  const entered = deferred(), done = deferred()
  const { projects, project, units, add } = await fixture(t, async () => { entered.resolve(); await done.promise })
  const addition = projects.addProjectWorkspace(project.id, add)
  await entered.promise
  await units.revoke(add.computerAttachmentId); done.resolve()
  await assert.rejects(addition, { code: 'unit-attachment-mismatch' })
  assert.equal((await projects.listProjectWorkspaces(project.id)).revision, 1)
})

test('a secondary placement uses its own pinned path and preserves cleanup evidence after retirement', async t => {
  const { projects, project, db, workspaces, add } = await fixture(t)
  const { workspaces: [main, secondary] } = await projects.addProjectWorkspace(project.id, add)
  const reserve = (m, id) => db.transaction(tx => workspaces.reserveIn(tx, { projectId: project.id, scopeId: id, reservationId: id,
    projectWorkspaceId: m.id, projectWorkspaceRevision: m.revision, computerAttachmentId: m.computerAttachmentId }))
  const a = await reserve(main, 'scope-a'), b = await reserve(secondary, 'scope-b')
  assert.notEqual(a.workspaceId, b.workspaceId)
  const instance = { computerId: 'unit:deploy', computerInstanceId: 'scope-b-computer', instanceGeneration: 1, providerId: 'unit', status: 'ready' }
  const prepare = workspaces.prepare({ reservationId: 'scope-b', instance })
  const ready = await prepare.result; await prepare.done
  assert.equal(ready.path, '/srv/app'); assert.equal(ready.projectId, project.id)
  const binding = await db.transaction(tx => workspaces.bindIn(tx, { reservationId: 'scope-b', prepared: ready }))
  await projects.removeProjectWorkspace(project.id, secondary.id, { requestId: 'remove', expectedRevision: 2 })
  await assert.rejects(db.read(tx => workspaces.requireBindingIn(tx, binding)), { code: 'workspace-binding-conflict' })
  assert.deepEqual(await workspaces.getBinding('scope-b'), binding)
  await db.transaction(tx => workspaces.releaseIn(tx, 'scope-b', 'scope-b'))
})

test('upgrading old remote and local projects preserves prior workspace reservations and exact bindings', async t => {
  const f = await fixture(t, undefined, async db => {
    await db.migrate('projects', [{ version: 1, up() {} }, { version: 2, up(tx) {
      tx.execute('CREATE TABLE harness_projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, computer_attachment_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(path,computer_attachment_id))')
      tx.execute("INSERT INTO harness_projects VALUES ('old','/srv/old','remote-old','Old','before'), ('main','/srv/old','local:computer','Main','before')")
    } }])
    await db.migrate('workspaces', [{ version: 1, up(tx) {
      tx.execute('CREATE TABLE harness_workspaces (workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, pinned_path TEXT, mode TEXT, revision INTEGER, workspace_epoch INTEGER, created_at TEXT)')
      tx.execute('CREATE TABLE harness_workspace_reservations (reservation_id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES harness_workspaces(workspace_id), scope_id TEXT, created_at TEXT, released_at TEXT)')
      tx.execute('CREATE TABLE harness_workspace_bindings (binding_id TEXT PRIMARY KEY, reservation_id TEXT UNIQUE REFERENCES harness_workspace_reservations(reservation_id), computer_id TEXT, computer_instance_id TEXT, instance_generation INTEGER, workspace_epoch INTEGER, revision INTEGER, local_path TEXT, prepared_at TEXT)')
      tx.execute("INSERT INTO harness_workspaces VALUES ('w','old','/srv/old','pinned-local',0,1,'before')")
      tx.execute("INSERT INTO harness_workspace_reservations VALUES ('r','w','old-run','before',NULL)")
      tx.execute("INSERT INTO harness_workspace_bindings VALUES ('b','r','old-computer','old-instance',3,1,0,'/srv/old','before')")
    } }])
  })
  for (const [id, unit] of [['old', 'remote-old'], ['main', 'local:computer']]) {
    const config = await f.projects.listProjectWorkspaces(id)
    assert.deepEqual(config.workspaces.map(member => [member.id, member.primary, member.computerAttachmentId]), [[id, true, unit]])
  }
  assert.equal((await f.workspaces.getForProject('old')).workspaceId, 'w')
  const binding = await f.workspaces.getBinding('r')
  assert.equal(binding.projectId, 'old'); assert.equal(binding.bindingId, 'b')
  assert.equal(binding.computerInstanceId, 'old-instance'); assert.equal(binding.path, '/srv/old')
  assert.deepEqual(await f.db.read(tx => f.workspaces.requireBindingIn(tx, binding)), binding)
  assert.deepEqual(await f.db.read(tx => tx.all('PRAGMA foreign_key_check')), [])
})

test('normal Harness HTTP routes and client allowlist expose only the supported project edits', async t => {
  const { projects, project, add } = await fixture(t)
  const server = await startHarnessServerHttp(projects)
  t.after(() => server.close())
  async function request(path, body) {
    const response = await fetch(server.url + '/api/v1' + path, { method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify(body) } : {}) })
    return { code: response.status, data: await response.json() }
  }
  const path = `/projects/${project.id}/workspaces`
  assert.equal((await request(path)).data.revision, 1)
  assert.equal(allowedProxyPath('GET', path), true); assert.equal(allowedProxyPath('POST', path), true)
  const result = await request(path, add)
  assert.equal(result.code, 200)
  const nested = path + '/' + result.data.workspaces[1].id
  assert.equal((await request(nested + '/rename', { name: 'Remote', expectedRevision: 2, requestId: 'rename' })).data.revision, 3)
  assert.equal((await request(nested + '/remove', { expectedRevision: 3, requestId: 'remove' })).data.revision, 4)
  assert.equal(allowedProxyPath('POST', nested + '/remove'), true); assert.equal(allowedProxyPath('POST', nested + '/rename'), true)
  assert.equal(allowedProxyPath('POST', nested + '/rebind'), false)
})

test('the Session workspace limit counts its automatically included primary', async t => {
  const { db, projects, project } = await fixture(t)
  const ids = Array.from({ length: 32 }, (_, index) => 'member-' + index)
  await db.transaction(tx => {
    for (const id of ids) tx.execute(
      'INSERT INTO harness_project_workspaces(id,project_id,name,is_primary,attachment_id,path) VALUES (?,?,?,0,?,?)',
      [id, project.id, id, id, '/srv/' + id])
  })
  const select = input => db.read(tx => projects.selectWorkspacesIn(tx, project.id, input, 1))
  assert.equal((await select(ids.slice(1))).length, 32)
  await assert.rejects(select(ids), { code: 'project-workspace-invalid', status: 400 })
})

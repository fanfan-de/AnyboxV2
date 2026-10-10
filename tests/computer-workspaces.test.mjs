import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createWorkspacesComponent } from '../dist/applications/harness/core/workspace/component.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'

const instance = Object.freeze({ computerId: 'local:project', computerInstanceId: 'instance', instanceGeneration: 1,
  providerId: 'local', providerRef: 'local-host', platform: process.platform, architecture: process.arch,
  activatedAt: 'now', status: 'ready' })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function joinCall(call) { try { return await call.result } finally { await call.done } }

async function fixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'anybox-workspaces-'))
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  const project = Object.freeze({ id: 'project', path: directory, name: 'project', createdAt: 'now', available: true })
  const counts = { checks: 0 }
  root.provide('harness.projects', { getIn: (_tx, id) => id === project.id ? project : undefined,
    requireAvailable: async id => { counts.checks++; assert.equal(id, project.id); return options.requireAvailable ? options.requireAvailable(project) : project } })
  let id = 0
  await root.installComponent(createWorkspacesComponent({ now: () => 'now', newId: () => `workspace-${++id}` }))
  const workspaces = root.get('harness.workspaces'), db = root.get('local-storage')
  const close = () => root.fiber.dispose()
  t.after(async () => { await close(); if (!options.directory) await rm(directory, { recursive: true, force: true }) })
  const reserve = (reservationId = 'scope', scopeId = 'run') => db.transaction(tx => workspaces.reserveIn(tx,
    { reservationId, scopeId, projectId: project.id }))
  const prepare = (reservationId = 'scope', selected = instance) => joinCall(workspaces.prepare({ reservationId, instance: selected }))
  const bind = (prepared, reservationId = prepared.reservationId) => db.transaction(tx => workspaces.bindIn(tx, { reservationId, prepared }))
  return { root, directory, project, counts, workspaces, db, close, reserve, prepare, bind }
}

test('workspaces stay lazy and register pinned-local identity only in the explicit reservation transaction', async t => {
  const f = await fixture(t)
  assert.equal(await f.workspaces.getForProject(f.project.id), undefined)
  assert.equal(f.counts.checks, 0)
  await assert.rejects(f.db.transaction(tx => {
    f.workspaces.reserveIn(tx, { reservationId: 'rolled-back', scopeId: 'run', projectId: 'project' })
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await f.workspaces.getForProject(f.project.id), undefined)
  const first = await f.reserve(), repeated = await f.reserve()
  assert.deepEqual(repeated, first)
  assert.deepEqual(await f.workspaces.get(first.workspaceId), {
    workspaceId: first.workspaceId, projectId: 'project', mode: 'pinned-local', revision: 0, workspaceEpoch: 1, createdAt: 'now',
  })
  assert.equal(await f.workspaces.getBinding(first.reservationId), undefined)
  assert.equal(f.counts.checks, 0)
  await assert.rejects(f.reserve('scope', 'other-run'), { code: 'workspace-reservation-conflict' })
  await assert.rejects(f.db.transaction(tx => f.workspaces.reserveIn(tx,
    { reservationId: 'missing', scopeId: 'run', projectId: 'missing' })), { code: 'workspace-missing' })
})

test('an existing project maps to a workspace without changing its canonical path or checking availability during reservation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-existing-project-'))
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent({ now: () => 'now', newId: () => 'existing-project' }))
  const project = await root.get('harness.projects').openProject(directory)
  await root.installComponent(createWorkspacesComponent({ now: () => 'now', newId: () => 'workspace' }))
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const workspaces = root.get('harness.workspaces'), db = root.get('local-storage')
  await db.transaction(tx => workspaces.reserveIn(tx, { reservationId: 'run', scopeId: 'run', projectId: project.id }))
  const prepared = await joinCall(workspaces.prepare({ reservationId: 'run', instance }))
  assert.equal(prepared.path, project.path)
  assert.equal(prepared.projectId, project.id)
  assert.equal(prepared.workspaceEpoch, 1)
})

test('binding and companion resource pins roll back together and a preparation receipt can be retried', async t => {
  const f = await fixture(t)
  await f.reserve()
  const prepared = await f.prepare()
  assert.equal(f.counts.checks, 1)
  await f.db.transaction(tx => tx.execute('CREATE TABLE test_pins (id TEXT PRIMARY KEY)'))
  await assert.rejects(f.db.transaction(tx => {
    f.workspaces.bindIn(tx, { reservationId: 'scope', prepared })
    tx.execute('INSERT INTO test_pins (id) VALUES (?)', ['pin'])
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await f.workspaces.getBinding('scope'), undefined)
  assert.equal(await f.db.read(reader => reader.get('SELECT COUNT(*) AS count FROM test_pins').count), 0)
  const bound = await f.db.transaction(tx => {
    const binding = f.workspaces.bindIn(tx, { reservationId: 'scope', prepared })
    tx.execute('INSERT INTO test_pins (id) VALUES (?)', ['pin'])
    return binding
  })
  assert.equal(bound.path, f.project.path)
  assert.deepEqual(await f.bind(prepared), bound)
  assert.deepEqual(await f.workspaces.getBinding('scope'), bound)
  assert.equal('preparationId' in bound, false)
})

test('binding receipts are trusted and scope, instance generation and workspace epoch are fenced', async t => {
  const f = await fixture(t)
  await f.reserve()
  const prepared = await f.prepare()
  await assert.rejects(f.bind({ ...prepared }), { code: 'workspace-stale-preparation' })
  const bound = await f.bind(prepared)
  const ref = { reservationId: bound.reservationId, scopeId: bound.scopeId, computerInstanceId: bound.computerInstanceId,
    instanceGeneration: bound.instanceGeneration, workspaceEpoch: bound.workspaceEpoch }
  assert.deepEqual(await f.db.read(tx => f.workspaces.requireBindingIn(tx, ref)), bound)
  for (const changed of [{ scopeId: 'other' }, { computerInstanceId: 'other' }, { instanceGeneration: 2 }, { workspaceEpoch: 2 }]) {
    await assert.rejects(f.db.read(tx => f.workspaces.requireBindingIn(tx, { ...ref, ...changed })), { code: 'workspace-binding-conflict' })
  }
  await assert.rejects(f.prepare('scope', { ...instance, computerInstanceId: 'other', instanceGeneration: 2 }), { code: 'workspace-binding-conflict' })
  await assert.rejects(f.prepare('scope', { ...instance, providerId: 'remote' }), { code: 'workspace-unavailable' })
  await assert.rejects(f.bind({ ...prepared, path: join(f.directory, 'different') }), { code: 'workspace-binding-conflict' })
})

test('shared local directories support distinct concurrent Run scopes without an exclusive writer lease', async t => {
  const f = await fixture(t)
  const a = await f.reserve('reservation-a', 'run-a'), b = await f.reserve('reservation-b', 'run-b')
  assert.equal(a.workspaceId, b.workspaceId)
  const [preparedA, preparedB] = await Promise.all([f.prepare(a.reservationId), f.prepare(b.reservationId)])
  const [bindingA, bindingB] = await Promise.all([f.bind(preparedA), f.bind(preparedB)])
  assert.equal(bindingA.path, bindingB.path)
  assert.equal(bindingA.workspaceEpoch, bindingB.workspaceEpoch)
  assert.notEqual(bindingA.bindingId, bindingB.bindingId)
  await f.db.transaction(tx => f.workspaces.releaseIn(tx, a.reservationId, a.scopeId))
  assert.deepEqual(await f.workspaces.getBinding(b.reservationId), bindingB)
  await assert.rejects(f.prepare(a.reservationId), { code: 'workspace-released' })
})

test('scope release is owner-checked, atomic, idempotent and does not remove stable workspace facts', async t => {
  const f = await fixture(t)
  const reserved = await f.reserve(), prepared = await f.prepare(), bound = await f.bind(prepared)
  const ref = { reservationId: 'scope', scopeId: 'run', computerInstanceId: 'instance', instanceGeneration: 1, workspaceEpoch: 1 }
  await assert.rejects(f.db.transaction(tx => f.workspaces.releaseIn(tx, 'scope', 'other')), { code: 'workspace-reservation-conflict' })
  await assert.rejects(f.db.transaction(tx => { f.workspaces.releaseIn(tx, 'scope', 'run'); throw new Error('rollback') }), /rollback/)
  assert.deepEqual(await f.db.read(tx => f.workspaces.requireBindingIn(tx, ref)), bound)
  await f.db.transaction(tx => f.workspaces.releaseIn(tx, 'scope', 'run'))
  await f.db.transaction(tx => f.workspaces.releaseIn(tx, 'scope', 'run'))
  await assert.rejects(f.db.read(tx => f.workspaces.requireBindingIn(tx, ref)), { code: 'workspace-released' })
  await assert.rejects(f.reserve(), { code: 'workspace-released' })
  assert.equal((await f.workspaces.getForProject('project')).workspaceId, reserved.workspaceId)
  assert.deepEqual(await f.workspaces.getBinding('scope'), bound)
})

test('workspace identity and original placement survive component reconstruction without re-preparing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-workspaces-restart-'))
  const fixtureHooks = { after() {} }
  const first = await fixture(fixtureHooks, { directory })
  const reserved = await first.reserve(), prepared = await first.prepare(), bound = await first.bind(prepared)
  await first.close()
  const second = await fixture(fixtureHooks, { directory })
  t.after(async () => { await second.close(); await first.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await second.workspaces.getForProject('project')).workspaceId, reserved.workspaceId)
  assert.deepEqual(await second.workspaces.getBinding('scope'), bound)
  assert.equal(second.counts.checks, 0)
  assert.deepEqual(await second.reserve(), reserved)
})

test('component close cancels preparation and waits for the underlying directory check to actually exit', async t => {
  const entered = deferred(), leave = deferred()
  const f = await fixture(t, { requireAvailable: async project => { entered.resolve(); await leave.promise; return project } })
  await f.reserve()
  const call = f.workspaces.prepare({ reservationId: 'scope', instance })
  await entered.promise
  let exited = false
  const closing = f.close().then(() => { exited = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exited, false)
  leave.resolve()
  await assert.rejects(call.result, { code: 'workspace-cancelled' })
  await call.done
  await closing
  assert.equal(exited, true)
  assert.throws(() => f.workspaces.prepare({ reservationId: 'scope', instance }), { code: 'workspace-unavailable' })
})

test('cancelling a preparation observation still waits for actual local preparation exit', async t => {
  const entered = deferred(), leave = deferred()
  const f = await fixture(t, { requireAvailable: async project => { entered.resolve(); await leave.promise; return project } })
  await f.reserve()
  const call = f.workspaces.prepare({ reservationId: 'scope', instance })
  await entered.promise
  let exited = false
  call.done.then(() => { exited = true })
  call.cancel('requested')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exited, false)
  leave.resolve()
  await assert.rejects(call.result, { code: 'workspace-cancelled' })
  await call.done
  assert.equal(exited, true)
  assert.equal(await f.workspaces.getBinding('scope'), undefined)
})

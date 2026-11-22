import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { openExecutionEnvironmentManager } from '../dist/index.js'
import { createRunTargetScopeAuthority } from '../dist/run-authority.js'

const read = { environmentId: 'computer', targetId: 'attachment-a:epoch-1', toolId: 'files.read', version: '1' }
const search = { environmentId: 'notes', targetId: 'corpus-1', toolId: 'notes.search', version: '1' }
const change = (tools, expectedRevision, requestId) => ({ agentId: 'agent', expectedRevision, requestId, tools })
const instant = (_signal) => ({ result: Promise.resolve('ok'), done: Promise.resolve() })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes,no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-environment-auth-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'business.sqlite')
}
async function open(t, file, adapt = value => value) {
  const root = new Context()
  const component = root.installComponent(createLocalSqliteComponent(file))
  await component
  assert.equal(component.state, FiberState.ACTIVE)
  const store = root.get('local-storage')
  let manager
  try { manager = await openExecutionEnvironmentManager(adapt(store)) }
  catch (error) { await root.fiber.dispose(); throw error }
  t.after(async () => { await manager.close(); await root.fiber.dispose() })
  return { store, manager, root }
}

test('idempotent operator grants keep exact generations across additive edits and isolate agents and target identities', async t => {
  const { manager, store } = await open(t, temporary(t))
  const initial = await store.transaction(tx => manager.seedIn(tx,'agent',[read]))
  assert.equal(initial.revision, 1)
  await manager.set(change([read,search],1,'add'))
  const current = await manager.get('agent')
  assert.equal(current.grants.find(grant => grant.tool.toolId === read.toolId).generation, initial.grants[0].generation)
  assert.equal(await manager.run('agent',initial.grants,'op-1',instant),'ok')
  await assert.rejects(manager.run('agent',initial.grants,'op-1',instant), { code: 'environment-operation-already-admitted' })
  await assert.rejects(manager.run('agent',[{...initial.grants[0],tool:{...read,targetId:'attachment-b:epoch-3'}}],'op-2',instant), { code: 'environment-authorization-changed' })
  await assert.rejects(manager.run('next',initial.grants,'op-3',instant), { code: 'environment-authorization-changed' })
  assert.deepEqual(await manager.set(change([search,read],1,'add')),await manager.observe('add'))
  await assert.rejects(manager.set(change([],1,'add')), { code: 'environment-request-conflict' })
  await assert.rejects(manager.set(change([],1,'stale')), { code: 'environment-revision-conflict' })
  await manager.set(change([],2,'deny'))
  await store.transaction(tx => manager.seedIn(tx,'agent',[read]))
  assert.deepEqual((await manager.get('agent')).grants,[])
  await manager.set(change([read],3,'regrant'))
  await assert.rejects(manager.run('agent',initial.grants,'old-run',instant), { code: 'environment-authorization-changed' })
  assert.equal(await manager.run('agent',(await manager.get('agent')).grants,'new-run',instant),'ok')
  await assert.rejects(openExecutionEnvironmentManager(store), { code: 'environment-owner-active' })
})

test('revocation closes new sends immediately and waits actual resource exit, even after the tool returned a result', async t => {
  const { manager } = await open(t, temporary(t))
  await manager.set(change([read],0,'grant'))
  const { grants } = await manager.get('agent')
  const started = deferred(), exit = deferred()
  let cancelled = false, completed = false
  const work = manager.run('agent',grants,'tool-call', signal => {
    signal.addEventListener('abort', () => { cancelled = true }, {once:true})
    started.resolve()
    return {result:Promise.resolve('result'),done:exit.promise}
  }).then(() => { completed = true })
  await started.promise
  assert.equal((await manager.set(change([],1,'revoke'))).state, 'draining')
  assert.equal(cancelled,true)
  assert.equal(completed,false)
  await assert.rejects(manager.set(change([read],2,'too-early')),{ code:'environment-cleanup-pending' })
  await assert.rejects(manager.run('agent',grants,'new',instant), { code:'environment-authorization-changed' })
  exit.resolve()
  await work
  assert.equal((await manager.observe('revoke')).state, 'completed')
  assert.equal((await manager.set(change([],1,'revoke'))).state, 'completed')
})

test('if the withdrawal write fails, the current authority fails closed until the same change commits', async t => {
  let inject = false
  const { manager } = await open(t, temporary(t), db => ({ ...db, transaction: (work, signal) => db.transaction(async tx => {
    const value = await work(tx)
    if (inject) { inject = false; throw new Error('injected before commit') }
    return value
  },signal) }))
  await manager.set(change([read],0,'grant'))
  const { grants } = await manager.get('agent')
  inject = true
  await assert.rejects(manager.set(change([],1,'withdraw')), /injected/)
  await assert.rejects(manager.run('agent',grants,'new',instant), { code: 'environment-authority-unavailable' })
  await assert.rejects(manager.set(change([read],1,'open-again')), { code: 'environment-authority-unavailable' })
  assert.equal(await manager.observe('withdraw'),undefined)
  assert.equal((await manager.set(change([],1,'withdraw'))).state,'completed')
})

test('a failed done retains the original target and requires exit evidence before the same target is opened again', async t => {
  const { manager } = await open(t,temporary(t))
  await manager.set(change([read],0,'allow'))
  const { grants } = await manager.get('agent')
  await assert.rejects(manager.run('agent',grants,'unknown',() => ({result:new Promise(() => {}),done:Promise.reject(new Error('lost exit'))})), /lost exit/)
  await assert.rejects(manager.run('agent',grants,'next',instant),{code:'environment-exit-unknown'})
  assert.equal((await manager.set(change([],1,'withdraw'))).state,'exit-unknown')
  assert.deepEqual(await manager.pendingChanges('agent'), [await manager.observe('withdraw')])
  assert.deepEqual(await manager.pendingChanges('other-agent'), [])
  assert.equal(await manager.reconcile('agent','unknown',async original => { assert.deepEqual(original,grants); return false }),false)
  assert.equal((await manager.observe('withdraw')).state,'exit-unknown')
  assert.equal(await manager.reconcile('agent','unknown',async original => { assert.deepEqual(original,grants); return true }),true)
  assert.equal((await manager.observe('withdraw')).state,'completed')
  assert.deepEqual(await manager.pendingChanges('agent'), [])
})

for (const point of ['reserved','sent','started','revoked']) {
  test('reopens the durable fence after owner process dies at ' + point, async t => {
    const file = temporary(t)
    const child = fork(new URL('./fixtures/crash-owner.mjs',import.meta.url),[file,point],{stdio:['ignore','ignore','inherit','ipc']})
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const first = await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(([code])=>{throw new Error('fixture exited with '+code)})])
    assert.equal(first,point)
    const exited = once(child,'exit')
    child.kill('SIGKILL')
    await exited
    const { manager } = await open(t,file)
    const { grants } = await manager.get('agent')
    const status = point==='revoked' ? await manager.observe('withdraw') : await manager.set(change([],1,'withdraw'))
    assert.equal(status.state, point==='reserved' ? 'completed' : 'exit-unknown')
    assert.equal(await manager.reconcile('agent','call',async () => false), point==='reserved')
    if (point !== 'revoked') {
      await assert.rejects(manager.run('agent',grants,'call',instant))
    }
    assert.equal(await manager.reconcile('agent','call',async original => {
      assert.equal(original[0].tool.targetId,read.targetId)
      assert.equal(original[0].generation,1)
      return true
    }),true)
    assert.equal((await manager.observe('withdraw')).state,'completed')
  })
}

test('a closing owner cannot send a paused reservation even if its durable send marker already committed', async t => {
  const atBoundary = deferred(), resume = deferred()
  const { manager,store } = await open(t,temporary(t),db => ({...db, async transaction(work,signal) {
    let markedSent = false
    const value = await db.transaction(tx => work({...tx, execute(sql,args) {
      if (sql.includes("UPDATE environment_admissions SET state='sent' WHERE")) markedSent = true
      return tx.execute(sql,args)
    }}),signal)
    if (markedSent) { atBoundary.resolve(); await resume.promise }
    return value
  }}))
  await manager.set(change([read],0,'grant'))
  let sends = 0
  const work = manager.run('agent',(await manager.get('agent')).grants,'paused',signal => { sends++; return instant(signal) })
  await atBoundary.promise
  const closed = manager.close()
  resume.resolve()
  await assert.rejects(work,{code:'environment-unavailable'})
  await closed
  assert.equal(sends,0)
  const successor = await openExecutionEnvironmentManager(store)
  try {
    assert.equal((await successor.set(change([],1,'revoke'))).state,'completed')
  } finally { await successor.close() }
})

test('only the original resource-owning Run scope can be reattached; a late observation cannot close its replacement', async t => {
  const file = temporary(t), scope = JSON.stringify(['run-a', 'scope'])
  const child = fork(new URL('./fixtures/crash-owner.mjs', import.meta.url), [file, 'started', scope, 'scope'], {stdio:['ignore','ignore','inherit','ipc']})
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  assert.equal((await once(child, 'message'))[0], 'started')
  const exited = once(child, 'exit')
  child.kill('SIGKILL'); await exited
  const { manager } = await open(t, file), { grants } = await manager.get('agent')
  const observed = deferred(), late = deferred(), attached = deferred(), realExit = deferred()
  const stale = manager.reconcile('agent', scope, async () => { observed.resolve(); await late.promise; return true })
  await observed.promise
  await assert.rejects(manager.resumeScope('agent', grants, JSON.stringify(['run-a','tool']), instant), {code:'environment-invalid-scope'})
  await assert.rejects(manager.resumeScope('agent', [], scope, instant), {code:'environment-authorization-changed'})
  await assert.rejects(manager.resumeScope('agent', grants, JSON.stringify(['run-b','scope']), instant), {code:'environment-no-original-scope'})
  const resumed = manager.resumeScope('agent', grants, scope, signal => {
    attached.resolve(signal)
    return { result: realExit.promise, done: realExit.promise }
  })
  const signal = await attached.promise
  late.resolve()
  assert.equal(await stale, false)
  await assert.rejects(manager.resumeScope('agent', grants, scope, instant), {code:'environment-scope-unavailable'})
  assert.equal((await manager.set(change([],1,'withdraw-scope'))).state, 'draining')
  assert.equal(signal.aborted, true)
  realExit.resolve()
  await resumed
  assert.equal((await manager.observe('withdraw-scope')).state, 'completed')
})

test('only acquired target scopes hold grants and a revoked target can prove exit independently', async t => {
  const { manager } = await open(t, temporary(t))
  await manager.set(change([read, search], 0, 'grant'))
  const { grants } = await manager.get('agent')
  const access = { agentId: 'agent', functions: grants.map(grant => ({ name: grant.tool.toolId, grant })) }
  let cancelled = false
  const scopes = createRunTargetScopeAuthority(manager, access, 'mixed-run', () => { cancelled = true })
  assert.deepEqual(await scopes.lifecycles(), { legacy: false, targets: [] })
  await scopes.acquire(read)
  assert.deepEqual(await scopes.lifecycles(), { legacy: false, targets: [{ environmentId: read.environmentId, targetId: read.targetId }] })
  assert.deepEqual(await manager.outstandingTargetScopeRunIds(), ['mixed-run'])
  assert.equal((await manager.set(change([search], 1, 'revoke-computer'))).state, 'draining')
  assert.equal(cancelled, true)
  await scopes.finishPending()
  assert.equal((await manager.observe('revoke-computer')).state, 'exit-unknown')
  const cleanup = createRunTargetScopeAuthority(manager, access, 'mixed-run', () => {})
  await cleanup.lifecycles()
  await assert.rejects(cleanup.adopt(read), { code: 'environment-authorization-changed' })
  assert.equal(await manager.run('agent', grants.filter(grant => grant.tool.environmentId === search.environmentId), 'unrelated-tool', instant), 'ok')
  await cleanup.closed(read, true)
  assert.equal((await manager.observe('revoke-computer')).state, 'completed')
  assert.deepEqual(await manager.outstandingTargetScopeRunIds(), [])
})

test('a later authority can reuse an exited target scope but cannot reuse a previous tool operation', async t => {
  const file = temporary(t)
  const original = await open(t, file)
  await original.manager.set(change([read], 0, 'grant'))
  const { grants } = await original.manager.get('agent')
  const access = { agentId: 'agent', functions: grants.map(grant => ({ name: grant.tool.toolId, grant })) }
  const firstScope = createRunTargetScopeAuthority(original.manager, access, 'continued-run', () => {})
  await firstScope.acquire(read)
  assert.equal(await original.manager.run('agent', grants, 'original-tool', instant), 'ok')
  await firstScope.closed(read, true)
  await original.manager.close()
  await original.root.fiber.dispose()
  const { manager } = await open(t, file)
  const nextScope = createRunTargetScopeAuthority(manager, access, 'continued-run', () => {})
  await nextScope.acquire(read)
  try {
    await assert.rejects(manager.run('agent', grants, 'original-tool', instant), { code: 'environment-operation-already-admitted' })
    assert.equal(await manager.run('agent', grants, 'next-tool', instant), 'ok')
  } finally { await nextScope.closed(read, true) }
})

for (const kind of ['model', 'hosted', 'provider']) {
  test('a crashed ' + kind + ' send keeps its receipt and exact revocation status', async t => {
    const file = temporary(t), operation = JSON.stringify(['run-a','model','exchange'])
    const child = fork(new URL('./fixtures/crash-owner.mjs', import.meta.url), [file,'started',operation,kind], {stdio:['ignore','ignore','inherit','ipc']})
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    assert.equal((await once(child,'message'))[0], 'started')
    const gone = once(child,'exit')
    child.kill('SIGKILL'); await gone
    const { manager } = await open(t, file), { grants } = await manager.get('agent')
    await assert.rejects(manager.runModel('agent',grants,operation,instant), {code:'environment-operation-already-admitted'})
    if (kind === 'model') await manager.run('agent',grants,'new-function',instant)
    else await assert.rejects(manager.run('agent',grants,'new-function',instant), {code:'environment-exit-unknown'})
    const withdrawn = await manager.set(change([],1,'withdraw'))
    assert.equal(withdrawn.state, 'exit-unknown')
    assert.equal(withdrawn.unknownCount, 1)
    await assert.rejects(manager.set(change(grants.map(g => g.tool),2,'new-grant')), {code:'environment-cleanup-pending'})
  })
}

test('an older layout-2 manager cannot replace the owner of a layout-3 authority or reconcile its admissions', async t => {
  const root = new Context(), file = temporary(t)
  await root.installComponent(createLocalSqliteComponent(file))
  t.after(() => root.fiber.dispose())
  const store = root.get('local-storage')
  const current = await openExecutionEnvironmentManager(store, { layout: 3, applicationId: 'writer' })
  await current.close()
  const recorded = () => store.read(reader => ({
    owner: reader.get('SELECT owner FROM environment_authority').owner,
    revision: reader.get('SELECT revision FROM storage_layout_fence').revision,
  }))
  const before = await recorded()
  await assert.rejects(openExecutionEnvironmentManager(store), { code: 'schema-version' })
  assert.deepEqual(await recorded(), before)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectSessionIndex, projectSidebar } from '../dist/applications/harness/web/workspace-client.js'
import { scopedId } from '../dist/applications/harness/web/harness-client.js'
import { deferred } from './helpers/controlled-models.mjs'

function fixture() {
  const calls = [], changes = []
  const index = createProjectSessionIndex((url, body, signal) => {
    const response = deferred()
    calls.push({ url, body, signal, response })
    return response.promise
  }, id => changes.push(id))
  return { index, calls, changes }
}

const session = (projectId, id) => ({ id, projectId, agentId: 'assistant', createdAt: '0' })

test('project session reads run independently and keep each result under its project', async () => {
  const f = fixture()
  const a = f.index.load('project/a'), b = f.index.load('project-b')
  assert.deepEqual(f.calls.map(call => call.url), ['/projects/project%2Fa/sessions', '/projects/project-b/sessions'])
  assert.ok(f.calls.every(call => !call.signal.aborted))
  assert.equal(f.index.get('project/a').loading, true)
  assert.equal(f.index.get('project-b').loading, true)

  const bSessions = [session('project-b', 'session-b')]
  f.calls[1].response.resolve(bSessions)
  await b
  assert.deepEqual(f.index.get('project-b'), { sessions: bSessions, loading: false })
  assert.deepEqual(f.index.get('project/a'), { sessions: [], loading: true })
  assert.equal(f.calls[0].signal.aborted, false)

  const aSessions = [session('project/a', 'session-a')]
  f.calls[0].response.resolve(aSessions)
  await a
  assert.deepEqual(f.index.get('project/a'), { sessions: aSessions, loading: false })
  assert.deepEqual(f.index.get('project-b'), { sessions: bSessions, loading: false })
  f.index.dispose()
})

test('refresh aborts an earlier project read and ignores its late result', async () => {
  const f = fixture()
  const oldRead = f.index.load('project-a')
  const freshRead = f.index.load('project-a')
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.calls[1].signal.aborted, false)

  const currentSessions = [session('project-a', 'new-session')]
  f.calls[1].response.resolve(currentSessions)
  await freshRead
  const changes = [...f.changes]
  // A transport can still resolve after observing an abort.
  f.calls[0].response.resolve([session('project-a', 'old-session')])
  await oldRead
  assert.deepEqual(f.index.get('project-a'), { sessions: currentSessions, loading: false })
  assert.deepEqual(f.changes, changes)
  f.index.dispose()
})

test('disposing cancels every pending project read and suppresses late updates and new reads', async () => {
  const f = fixture()
  const a = f.index.load('project-a'), b = f.index.load('project-b')
  const beforeA = f.index.get('project-a'), beforeB = f.index.get('project-b')
  const changes = [...f.changes]
  f.index.dispose()
  assert.ok(f.calls.every(call => call.signal.aborted))

  f.calls[0].response.resolve([session('project-a', 'late-session')])
  f.calls[1].response.reject(new Error('aborted'))
  await Promise.all([a, b])
  await f.index.load('project-c')
  assert.equal(f.index.get('project-a'), beforeA)
  assert.equal(f.index.get('project-b'), beforeB)
  assert.equal(f.index.get('project-c'), undefined)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.changes, changes)
})

test('a failed project refresh preserves sessions and can retry while another project succeeds', async () => {
  const f = fixture()
  const oldSessions = [session('project-a', 'existing-session')]
  const initial = f.index.load('project-a')
  f.calls[0].response.resolve(oldSessions)
  await initial

  const failing = f.index.load('project-a'), other = f.index.load('project-b')
  const error = new Error('project unavailable')
  f.calls[1].response.reject(error)
  await failing
  assert.deepEqual(f.index.get('project-a'), { sessions: oldSessions, loading: false, error })
  assert.equal(f.calls[2].signal.aborted, false)

  const retry = f.index.load('project-a')
  assert.deepEqual(f.index.get('project-a'), { sessions: oldSessions, loading: true })
  const otherSessions = [session('project-b', 'other-session')]
  f.calls[2].response.resolve(otherSessions)
  await other
  assert.deepEqual(f.index.get('project-b'), { sessions: otherSessions, loading: false })

  const newSessions = [...oldSessions, session('project-a', 'new-session')]
  f.calls[3].response.resolve(newSessions)
  await retry
  assert.deepEqual(f.index.get('project-a'), { sessions: newSessions, loading: false })
  assert.deepEqual(f.index.get('project-b'), { sessions: otherSessions, loading: false })
  f.index.dispose()
})

const localInstance = '11111111-1111-1111-1111-111111111111'
const remoteInstance = '22222222-2222-2222-2222-222222222222'
const offlineInstance = '33333333-3333-3333-3333-333333333333'
const project = (instanceId, id, extra = {}) => ({
  id: scopedId(instanceId, id), instanceId, name: '同名项目', path: `/projects/${id}`, ...extra,
})

test('switching execution device filters same-named projects and selects a project for its new session', () => {
  const remote = Object.freeze(project(remoteInstance, 'same-id'))
  const local = Object.freeze(project(localInstance, 'same-id'))
  const localSecond = Object.freeze(project(localInstance, 'another-id'))
  const allProjects = Object.freeze([remote, local, localSecond])

  const initial = projectSidebar(allProjects, remoteInstance, remote.id, true)
  assert.deepEqual(initial, { projects: [remote], selectedProjectId: remote.id })

  const switched = projectSidebar(allProjects, localInstance, initial.selectedProjectId, true)
  assert.deepEqual(switched, { projects: [local, localSecond], selectedProjectId: local.id })
  const selected = projectSidebar(allProjects, localInstance, localSecond.id, true)
  assert.equal(selected.selectedProjectId, localSecond.id)

  const switchedBack = projectSidebar(allProjects, remoteInstance, selected.selectedProjectId, true)
  assert.deepEqual(switchedBack, initial)
  assert.deepEqual(allProjects, [remote, local, localSecond], 'foreign projects stay available to existing cross-device panes')
  assert.notEqual(switched.projects, allProjects)
})

test('scoped project identity filters retained snapshots without explicit device metadata', () => {
  const remote = { id: scopedId(remoteInstance, 'same-id'), name: '同名项目', path: '/remote/project' }
  const local = { id: scopedId(localInstance, 'same-id'), name: '同名项目', path: '/local/project' }
  const legacy = { id: 'unscoped-project', name: '旧项目', path: '/legacy/project' }

  assert.deepEqual(projectSidebar([remote, local, legacy], localInstance, remote.id, true), {
    projects: [local], selectedProjectId: local.id,
  })
})

test('a saved project waits for its selected device snapshot and resolves missing only after aggregation settles', () => {
  const remote = project(remoteInstance, 'remote-project')
  const firstLocal = project(localInstance, 'first-local')
  const savedLocal = project(localInstance, 'saved-local')
  const partial = [remote, firstLocal]

  assert.deepEqual(projectSidebar(partial, localInstance, savedLocal.id, false), {
    projects: [firstLocal], selectedProjectId: savedLocal.id,
  })
  assert.deepEqual(projectSidebar([...partial, savedLocal], localInstance, savedLocal.id, false), {
    projects: [firstLocal, savedLocal], selectedProjectId: savedLocal.id,
  })
  assert.deepEqual(projectSidebar(partial, localInstance, savedLocal.id, true), {
    projects: [firstLocal], selectedProjectId: firstLocal.id,
  })

  const foreignPending = scopedId(remoteInstance, 'not-returned-yet')
  assert.deepEqual(projectSidebar(partial, localInstance, foreignPending, false), {
    projects: [firstLocal], selectedProjectId: firstLocal.id,
  }, 'a slow foreign device cannot postpone selection on the selected device')
})

test('offline placeholders belong to their device and an empty device never falls back to another device project', () => {
  const remote = project(remoteInstance, 'remote-project')
  const local = project(localInstance, 'local-project')
  const unavailable = project(offlineInstance, 'retained-project', {
    name: '暂不可用的项目', path: '', available: false,
  })
  const allProjects = [remote, unavailable, local]

  assert.deepEqual(projectSidebar(allProjects, localInstance, unavailable.id, true), {
    projects: [local], selectedProjectId: local.id,
  })
  assert.deepEqual(projectSidebar(allProjects, offlineInstance, unavailable.id, true), {
    projects: [unavailable], selectedProjectId: unavailable.id,
  })
  assert.deepEqual(projectSidebar([remote, local], offlineInstance, remote.id, true), {
    projects: [], selectedProjectId: null,
  })
  assert.deepEqual(projectSidebar([remote], localInstance, null, false), {
    projects: [], selectedProjectId: null,
  })
})

test('legacy single-device workspaces keep unscoped project selection when no device is supplied', () => {
  const first = { id: 'first-project', name: '第一个项目', path: '/projects/first' }
  const preferred = { id: 'preferred-project', name: '选中的项目', path: '/projects/preferred' }

  assert.deepEqual(projectSidebar([first, preferred], undefined, preferred.id, true), {
    projects: [first, preferred], selectedProjectId: preferred.id,
  })
  assert.deepEqual(projectSidebar([first], undefined, preferred.id, false), {
    projects: [first], selectedProjectId: preferred.id,
  })
  assert.deepEqual(projectSidebar([first], undefined, preferred.id, true), {
    projects: [first], selectedProjectId: first.id,
  })
})

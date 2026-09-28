import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectSessionIndex } from '../dist/web/workspace-client.js'
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

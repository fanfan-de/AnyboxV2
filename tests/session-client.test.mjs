import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingStore, createSessionController, pendingKey } from '../dist/web/session-client.js'
import { deferred } from './helpers/controlled-llm.mjs'

function fixture() {
  const storage = new Map(), timers = new Map(), calls = [], rows = new Map(), nodes = new Map(), positions = new Map()
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  const pending = createPendingStore(store)
  let next = 0, hidden = false, interceptor
  const api = async (url, body, signal) => {
    calls.push({ url, body, signal })
    if (interceptor) { const reply = interceptor(url, body, signal); if (reply !== undefined) return reply }
    const parts = url.split('?')[0].split('/').map(decodeURIComponent)
    const sessionId = parts[2]
    if (parts[1] === 'sessions') {
      if (parts.length === 3) return { id: sessionId, projectId: `p-${sessionId}`, agentId: 'assistant', createdAt: '0' }
      if (parts[3] === 'nodes') {
        if (parts[5] === 'path') {
          const path = []; let node = nodes.get(parts[4])
          while (node) { path.unshift(node); node = nodes.get(node.parentId) }
          return path
        }
        const parent = new URL(`http://local${url}`).searchParams.get('parentNodeId')
        return { nodes: [...nodes.values()].filter(node => node.sessionId === sessionId && node.parentId === (parent === 'root' ? null : parent)) }
      }
      if (parts[4] === 'by-key') {
        const run = [...rows.values()].find(run => run.sessionId === sessionId && run.key === parts[5])
        if (!run) throw Object.assign(new Error('not found'), { status: 404, code: 'not-found' })
        return { ...run }
      }
      if (body) {
        let run = [...rows.values()].find(run => run.sessionId === sessionId && run.key === body.idempotencyKey)
        if (!run) { run = { id: `r-${++next}`, sessionId, input: body.input, history: { kind: 'tree', parentNodeId: body.parentNodeId }, key: body.idempotencyKey, status: 'running', revision: 1, createdAt: String(next).padStart(4, '0') }; rows.set(run.id, run) }
        return { ...run }
      }
      return [...rows.values()].filter(run => run.sessionId === sessionId).map(run => ({ ...run }))
    }
    if (parts[1] === 'runs') {
      if (parts[3] === 'events') return []
      const run = rows.get(parts[2])
      if (parts[3] === 'cancel') { run.status = 'cancelled'; run.revision++ }
      return { ...run }
    }
    throw new Error(url)
  }
  const make = id => createSessionController({ sessionId: id, projectId: `p-${id}` }, {
    api, pending, messageFor: e => e.message, newId: () => `key-${++next}`,
    hidden: () => hidden, schedule: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id },
    clear: id => timers.delete(id), missing: () => assert.fail('unexpected missing'),
    savePosition: p => positions.set(id, p),
  })
  const load = async controller => { controller.attach(() => {}); await controller.refresh(); await Promise.resolve() }
  const finish = (id, status = 'completed') => {
    const run = rows.get(id); run.status = status; run.revision++
    if (status === 'completed') {
      run.resultNodeId = `node-${id}`; run.output = `answer ${run.input}`
      nodes.set(run.resultNodeId, { id: run.resultNodeId, sessionId: run.sessionId, parentId: run.history.parentNodeId, input: run.input, output: run.output, sourceRunId: id })
    }
  }
  return { make, load, finish, storage, store, timers, calls, rows, nodes, positions, pending,
    intercept: fn => { interceptor = fn }, hide: () => { hidden = true } }
}

test('cross-project controllers submit/cancel independently and closing only aborts reads/timers', async () => {
  const f = fixture(), a = f.make('a'), b = f.make('b')
  await Promise.all([f.load(a), f.load(b)])
  a.setDraft('first'); b.setDraft('second')
  await Promise.all([a.submit(), b.submit()])
  const ar = a.snapshot().runs[0], br = b.snapshot().runs[0]
  assert.equal(ar.sessionId, 'a'); assert.equal(br.sessionId, 'b')
  await a.cancel(ar.id)
  assert.equal(f.rows.get(ar.id).status, 'cancelled'); assert.equal(f.rows.get(br.id).status, 'running')
  a.detach(); b.detach()
  assert.equal(f.timers.size, 0)
  assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 1)
})

test('a detached late read cannot publish or overwrite a newly attached generation', async () => {
  const f = fixture(), delayed = deferred(), a = f.make('a')
  let publications = 0
  f.intercept(url => url === '/sessions/a' ? delayed.promise : undefined)
  a.attach(() => publications++)
  const old = a.refresh()
  await Promise.resolve()
  a.detach()
  assert.equal(f.calls[0].signal.aborted, true)
  delayed.resolve({ id: 'a', projectId: 'p-a', agentId: 'obsolete' })
  await old
  assert.equal(publications, 0)
  assert.equal(a.snapshot().session, undefined)
  f.intercept(undefined)
  await f.load(a)
  assert.equal(a.snapshot().session.agentId, 'assistant')
  a.detach()
})

test('accepted runs release submission state; out-of-order completion never guesses a new parent', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setDraft('one'); await a.submit()
  const first = a.snapshot().runs[0]
  assert.equal(a.snapshot().pending, undefined)
  a.setDraft('two'); await a.submit()
  const second = a.snapshot().runs[1]
  assert.equal(first.history.parentNodeId, null); assert.equal(second.history.parentNodeId, null)
  await a.navigate(null)
  a.setDraft('keep this draft')
  f.finish(second.id); f.finish(first.id)
  await a.refresh()
  assert.equal(a.snapshot().position.viewNodeId, null)
  assert.equal(a.snapshot().draft, 'keep this draft')
  await a.navigate(second.id.replace('r-', 'node-r-'))
  a.setDraft('child'); await a.submit()
  assert.equal(a.snapshot().runs.at(-1).history.parentNodeId, `node-${second.id}`)
  a.detach()
})

test('explicitly followed submission navigates on completion and drafts belong to their parent', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setDraft('one'); await a.submit()
  const run = a.snapshot().runs[0]
  f.finish(run.id); await a.refresh()
  assert.equal(a.snapshot().position.viewNodeId, `node-${run.id}`)
  assert.equal(a.snapshot().draft, '')
  a.setDraft('child draft')
  await a.navigate(null)
  a.setDraft('root draft')
  await a.navigate(`node-${run.id}`)
  assert.equal(a.snapshot().draft, 'child draft')
  a.detach()
})

test('lost response recovers by key without changing ancestry or duplicating the run', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  const response = deferred()
  f.intercept((url, body) => {
    if (body && url === '/sessions/a/runs') {
      f.rows.set('accepted', { id: 'accepted', sessionId: 'a', input: body.input, key: body.idempotencyKey, history: { kind: 'tree', parentNodeId: body.parentNodeId }, status: 'running', revision: 1, createdAt: '0' })
      return response.promise
    }
  })
  a.setDraft('once'); const submit = a.submit(); a.detach()
  response.reject(new Error('lost response')); await submit
  assert.equal(f.pending.get('a').parentNodeId, null)
  f.intercept(undefined)
  const restored = f.make('a'); await f.load(restored)
  assert.equal(f.rows.size, 1); assert.equal(f.pending.get('a'), undefined)
  assert.equal(f.calls.filter(call => call.body && call.url === '/sessions/a/runs').length, 1)
  restored.detach()
})

test('pending store supports old records, rejects broken entries and preserves other sessions', async () => {
  const f = fixture()
  f.storage.set(pendingKey, JSON.stringify({ a: { sessionId: 'a', input: 'legacy', idempotencyKey: 'old' }, b: { bad: true } }))
  const store = createPendingStore(f.store)
  assert.equal(store.get('a').parentNodeId, undefined); assert.equal(store.get('b'), undefined)
  store.set('b', { sessionId: 'b', input: 'new', idempotencyKey: 'new', parentNodeId: null })
  store.set('a', undefined)
  assert.equal(store.get('b').input, 'new')
  const failing = createPendingStore({ getItem: () => null, setItem: () => { throw new Error('blocked') } })
  assert.throws(() => failing.set('x', { sessionId: 'x' }), /blocked/)
  assert.equal(failing.get('x'), undefined)
})

test('unknown legacy pending restores input for explicit confirmation, never posts automatically', async () => {
  const f = fixture()
  f.pending.set('a', { sessionId: 'a', input: 'legacy input', idempotencyKey: 'old' })
  const a = f.make('a'); await f.load(a)
  assert.equal(a.snapshot().draft, 'legacy input')
  assert.match(a.snapshot().notice, /选定对话位置/)
  assert.equal(f.calls.some(call => call.body), false)
  a.detach()
})

test('refresh merges monotone run revisions and visibility slows the single timer', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setDraft('one'); await a.submit()
  const run = a.snapshot().runs[0]
  f.finish(run.id); await a.refresh()
  f.intercept(url => url === '/sessions/a/runs' ? [{ ...run, status: 'running', revision: 1 }] : undefined)
  f.hide(); await a.refresh()
  assert.equal(a.snapshot().runs[0].status, 'completed')
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].ms, 5000)
  a.detach()
})

test('a successful POST settles its original session after close and does not notify the detached view', async () => {
  const f = fixture(), a = f.make('a'), b = f.make('b'), accepted = deferred()
  await Promise.all([f.load(a), f.load(b)])
  f.intercept((url, body) => url === '/sessions/a/runs' && body ? accepted.promise : undefined)
  a.setDraft('in flight'); const submission = a.submit()
  const key = f.pending.get('a').idempotencyKey
  a.detach()
  b.setDraft('independent'); await b.submit()
  accepted.resolve({ id: 'late-run', sessionId: 'a', input: 'in flight', history: { kind: 'tree', parentNodeId: null }, revision: 1, status: 'running', createdAt: '1' })
  await submission
  assert.equal(f.pending.get('a'), undefined)
  assert.equal(a.snapshot().position.follow, undefined)
  assert.equal(a.snapshot().runs[0].id, 'late-run')
  assert.equal(b.snapshot().runs.length, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 0)
  assert.equal(f.calls.find(call => call.body?.idempotencyKey === key).url, '/sessions/a/runs')
  b.detach()
})

test('a failed durable pending write prevents a POST and preserves the draft', async () => {
  const pending = createPendingStore({ getItem: () => null, setItem() { throw new Error('quota') } })
  const calls = []
  const a = createSessionController({ sessionId: 'a', projectId: 'p' }, {
    pending, api: async (url, body) => {
      calls.push({ url, body })
      if (url === '/sessions/a') return { id: 'a', projectId: 'p' }
      if (url.includes('/nodes?')) return { nodes: [] }
      return []
    }, messageFor: String, newId: () => 'key', hidden: () => false,
    schedule: () => 1, clear() {}, missing() {},
  })
  a.attach(() => {}); await a.refresh()
  a.setDraft('keep me'); await a.submit()
  assert.equal(calls.some(call => call.body), false)
  assert.equal(a.snapshot().draft, 'keep me')
  assert.match(a.snapshot().notice, /无法保存/)
  a.detach()
})

test('typing while a followed run is active stops automatic navigation when it completes', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setDraft('one'); await a.submit()
  const run = a.snapshot().runs[0]
  a.setDraft('new unsent input')
  f.finish(run.id); await a.refresh()
  assert.equal(a.snapshot().position.viewNodeId, null)
  assert.equal(a.snapshot().draft, 'new unsent input')
  assert.equal(a.snapshot().position.follow, undefined)
  a.detach()
})

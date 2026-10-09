import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingStore, createSessionController, pendingKey } from '../dist/applications/harness/web/session-client.js'
import { createDraftStore, draftFromInput } from '../dist/applications/harness/web/draft-client.js'
import { deferred } from './helpers/controlled-models.mjs'

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
      if (parts.length === 3) return { id: sessionId, projectId: `p-${sessionId}`, agentId: 'assistant', createdAt: '0', modelId: null, historyMode: 'native-local-v1', protocolId: 'chat-completions' }
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
  const make = (id, extra = {}) => createSessionController({ sessionId: id, projectId: `p-${id}` }, {
    api, pending, messageFor: e => e.message, newId: () => `key-${++next}`,
    hidden: () => hidden, schedule: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id },
    clear: id => timers.delete(id), missing: () => assert.fail('unexpected missing'),
    savePosition: p => positions.set(id, p), ...extra,
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
    intercept: fn => { interceptor = fn }, hide: () => { hidden = true }, show: () => { hidden = false } }
}

const recordedTraceRun = (id, parentNodeId = null) => ({ id, sessionId: 'a', input: `Input ${id}`, status: 'completed', revision: 1,
  createdAt: '2026-10-02T01:00:00.000Z', updatedAt: '2026-10-02T01:00:10.000Z', history: { kind: 'tree', parentNodeId },
  protocolBinding: { protocolId: 'chat-completions' } })
const recordedTraceView = (id, text = 'Recorded model output') => ({ envelopeVersion: 1, viewSchemaVersion: 2,
  protocolId: 'chat-completions', sessionId: 'a', runId: id, viewRevision: 1, status: 'committed',
  exchanges: [{ id: 'exchange', blocks: [{ id: 'text', type: 'chat.content', text }] }] })
const flushReads = () => new Promise(resolve => setImmediate(resolve))
const seedTraceRuns = (f, ids) => ids.forEach((id, index) => f.rows.set(id, { ...recordedTraceRun(id, 'other-parent'), createdAt: `2026-10-02T01:00:0${index}.000Z` }))

test('SSE incompatibility shows an upgrade notice once without refreshing or replacing safe history', async t => {
  const f = fixture(), a = f.make('a')
  let emissions = 0; a.attach(() => { emissions++ }); await a.refresh(); await flushReads(); t.after(() => a.dispose())
  a.protocolView(recordedTraceView('history', 'Safe committed history'))
  emissions = 0
  const reads = f.calls.length
  a.incompatibleView('future-run')
  assert.match(a.snapshot().notice, /协议展示版本不兼容.*客户端一起升级/)
  assert.equal(a.snapshot().views.get('history').exchanges[0].blocks[0].text, 'Safe committed history')
  a.incompatibleView('future-run'); a.incompatibleView('another-run')
  assert.equal(emissions, 1); assert.equal(f.calls.length, reads)
  a.detach(); a.incompatibleView('after-detach')
  assert.equal(emissions, 1); assert.equal(f.calls.length, reads)
})

test('visible and searchable history share two read slots across event and view requests', async t => {
  const f = fixture(), waiting = new Map(), arrivals = [], a = f.make('a')
  seedTraceRuns(f, ['one', 'two', 'three', 'four'])
  await f.load(a); t.after(() => a.dispose())
  let inFlight = 0, maximum = 0
  f.intercept(url => {
    if (!/^\/runs\/[^/]+\/(events|view)/.test(url)) return undefined
    const delayed = deferred(); arrivals.push(url); waiting.set(url, delayed)
    inFlight++; maximum = Math.max(maximum, inFlight)
    return delayed.promise.finally(() => { inFlight-- })
  })
  a.setViewMode('runs'); a.setTraceViewport(['one']); a.setTraceSearch('output')
  await flushReads()
  assert.equal(arrivals.length, 2)
  assert.equal(a.snapshot().traceLoading.pending, 4)
  waiting.get('/runs/one/events?afterSeq=0').resolve([]); await flushReads()
  assert.equal(arrivals.at(-1), '/runs/one/view')
  assert.equal(inFlight, 2, 'a view cannot create a third request alongside event reads')
  waiting.get('/runs/one/view').resolve(recordedTraceView('one')); await flushReads()
  assert.equal(arrivals.at(-1), '/runs/three/events?afterSeq=0')
  assert.equal(a.snapshot().traceLoading.loaded, 1)
  a.setTraceSearch(''); a.setTraceViewport([])
  for (const [url, delayed] of waiting) if (!url.includes('/one/')) delayed.resolve(url.endsWith('/view') ? recordedTraceView(url.split('/')[2]) : [])
  await flushReads()
  assert.equal(arrivals.some(url => url.includes('/four/')), false, 'clearing search removes history work that has not started')
  assert.equal(maximum, 2)
  assert.equal(a.snapshot().views.has('one'), true, 'clearing search retains committed cached content')
})

test('focusing a queued run takes priority over remaining search history', async t => {
  const f = fixture(), waiting = new Map(), arrivals = [], a = f.make('a')
  seedTraceRuns(f, ['one', 'two', 'three', 'focus'])
  await f.load(a); t.after(() => a.dispose())
  f.intercept(url => {
    if (url.includes('/events?')) { const delayed = deferred(); waiting.set(url.split('/')[2], delayed); arrivals.push(url.split('/')[2]); return delayed.promise }
    if (url.endsWith('/view')) return recordedTraceView(url.split('/')[2])
  })
  a.setViewMode('runs'); a.setTraceSearch('text'); await flushReads()
  assert.deepEqual(arrivals, ['one', 'two'])
  a.focusRun('focus')
  waiting.get('one').resolve([]); await flushReads()
  assert.deepEqual(arrivals, ['one', 'two', 'focus'])
  a.setTraceSearch('')
  waiting.get('two').resolve([]); waiting.get('focus').resolve([]); await flushReads()
  assert.equal(arrivals.includes('three'), false)
})

test('terminal history and committed SSE views are cached across polls and detach/attach', async t => {
  const f = fixture(), a = f.make('a')
  f.rows.set('history', recordedTraceRun('history', 'other-parent'))
  f.intercept(url => url.endsWith('/history/view') ? recordedTraceView('history') : undefined)
  await f.load(a); t.after(() => a.dispose())
  a.protocolView(recordedTraceView('history', 'Committed SSE output'))
  a.setTraceViewport(['history']); a.setViewMode('runs'); await flushReads()
  assert.equal(a.snapshot().traceLoading.loaded, 1)
  const readCount = () => f.calls.filter(call => call.url.startsWith('/runs/history/')).length
  const before = readCount()
  assert.equal(f.calls.some(call => call.url === '/runs/history/view'), false, 'a committed SSE projection satisfies the view read')
  await a.refresh(); await a.refresh()
  assert.equal(readCount(), before)
  a.detach(); await f.load(a); await flushReads()
  assert.equal(readCount(), before, 'reattaching keeps terminal event and projection caches')
  assert.equal(a.snapshot().views.get('history').status, 'committed')
})

test('a terminal transition discards provisional frames, reads final events, and then stops rereading', async t => {
  const f = fixture(), a = f.make('a'), eventCalls = []
  const run = { ...recordedTraceRun('live'), status: 'running' }; f.rows.set(run.id, run)
  let final = false
  f.intercept(url => {
    if (url.startsWith('/runs/live/events?')) {
      eventCalls.push(url)
      return final ? [{ seq: 1, kind: 'operation-started' }, { seq: 2, kind: 'run-completed' }] : [{ seq: 1, kind: 'operation-started' }]
    }
    if (url === '/runs/live/view') return { ...recordedTraceView('live', final ? 'final output' : 'partial output'), status: final ? 'committed' : 'provisional' }
  })
  await f.load(a); t.after(() => a.dispose())
  a.protocolView({ ...recordedTraceView('live', 'SSE provisional'), viewRevision: 2, status: 'provisional' })
  assert.equal(a.snapshot().views.get('live').status, 'provisional')
  run.status = 'completed'; run.revision = 2; final = true
  await a.refresh(); await flushReads()
  assert.equal(a.snapshot().views.get('live').status, 'committed')
  assert.equal(a.snapshot().views.get('live').exchanges[0].blocks[0].text, 'final output')
  assert.deepEqual(a.snapshot().events.get('live').map(event => event.seq), [1, 2], 'incremental reads do not duplicate a repeated event')
  assert.match(eventCalls.at(-1), /afterSeq=1$/)
  const count = eventCalls.length; await a.refresh()
  assert.equal(eventCalls.length, count)
  a.protocolView({ ...recordedTraceView('live', 'late stale SSE'), viewRevision: 99, status: 'provisional' })
  assert.equal(a.snapshot().views.get('live').exchanges[0].blocks[0].text, 'final output')
})

test('failed history remains distinguishable from unloaded history and supports explicit retry', async t => {
  const f = fixture(), a = f.make('a')
  seedTraceRuns(f, ['failed', 'unloaded'])
  await f.load(a); t.after(() => a.dispose())
  f.intercept(url => url === '/runs/failed/view' ? Promise.reject(new Error('Device temporarily offline')) : undefined)
  a.setViewMode('runs'); a.setTraceViewport(['failed']); await flushReads()
  assert.equal(a.snapshot().traceLoading.states.get('failed'), 'failed')
  assert.equal(a.snapshot().traceLoading.states.get('unloaded'), 'unloaded')
  assert.equal(a.snapshot().traceLoading.failed, 1)
  assert.equal(a.snapshot().traceLoading.errors.get('failed'), 'Device temporarily offline')
  const eventCalls = f.calls.filter(call => call.url.startsWith('/runs/failed/events?')).length
  f.intercept(url => url === '/runs/failed/view' ? recordedTraceView('failed') : undefined)
  a.retryTrace('failed'); await flushReads()
  assert.equal(a.snapshot().traceLoading.states.get('failed'), 'loaded')
  assert.equal(a.snapshot().traceLoading.errors.has('failed'), false)
  assert.equal(f.calls.filter(call => call.url.startsWith('/runs/failed/events?')).length, eventCalls, 'retry retains already-loaded durable events')
})

test('detach cancels search reads and its queued history without cancelling any run', async t => {
  const f = fixture(), a = f.make('a'), delayed = deferred()
  seedTraceRuns(f, ['one', 'two', 'three'])
  await f.load(a); t.after(() => a.dispose())
  f.intercept(url => url.includes('/events?') ? delayed.promise : undefined)
  a.setViewMode('runs'); a.setTraceSearch('search'); await flushReads()
  const requests = f.calls.filter(call => call.url.includes('/events?'))
  assert.equal(requests.length, 2)
  a.detach()
  assert.equal(requests.every(request => request.signal.aborted), true)
  delayed.resolve([{ seq: 1, kind: 'run-completed' }]); await flushReads()
  assert.equal(a.snapshot().events.size, 0)
  assert.equal(f.calls.some(call => call.url.includes('/runs/three/')), false)
  assert.equal(f.calls.some(call => call.url.endsWith('/cancel')), false)
})

test('hidden panels stop queued history and resume the retained search when visible', async t => {
  const f = fixture(), a = f.make('a'), delayed = deferred()
  seedTraceRuns(f, ['one', 'two', 'three', 'four'])
  await f.load(a); t.after(() => a.dispose())
  f.intercept(url => url.includes('/events?') ? delayed.promise : url.endsWith('/view') ? recordedTraceView(url.split('/')[2]) : undefined)
  a.setViewMode('runs'); a.setTraceSearch('search'); await flushReads()
  assert.equal(f.calls.filter(call => call.url.includes('/events?')).length, 2)
  f.hide(); await a.refresh()
  delayed.resolve([]); await flushReads()
  assert.equal(f.calls.filter(call => call.url.includes('/events?')).length, 2)
  assert.equal(f.calls.some(call => call.url.endsWith('/view')), false, 'hidden history does not admit the next view read')
  assert.equal(a.snapshot().traceLoading.pending, 4)
  f.show(); await a.refresh(); await flushReads()
  assert.equal(a.snapshot().traceLoading.loaded, 4)
})

test('a failed trace read still follows a successful Run result and keeps its display error visible', async t => {
  const f = fixture(), a = f.make('a'); await f.load(a); t.after(() => a.dispose())
  a.setDraft('follow this result'); await a.submit(); await flushReads()
  const run = a.snapshot().runs[0]
  a.protocolView({ ...recordedTraceView(run.id, 'partial output'), status: 'provisional' })
  f.rows.get(run.id).protocolBinding = { protocolId: 'chat-completions' }
  f.intercept(url => url === `/runs/${run.id}/view` ? Promise.reject(new Error('Trace temporarily unavailable')) : undefined)
  f.finish(run.id)
  await a.refresh(); await flushReads()
  assert.equal(a.snapshot().position.viewNodeId, `node-${run.id}`)
  assert.equal(a.snapshot().path.at(-1).sourceRunId, run.id)
  assert.equal(a.snapshot().path.at(-1).output, `answer ${run.input}`)
  assert.equal(a.snapshot().views.has(run.id), false, 'saved output replaces a provisional frame when the final projection fails')
  assert.equal(a.snapshot().traceLoading.states.get(run.id), 'failed')
  assert.equal(a.snapshot().traceLoading.errors.get(run.id), 'Trace temporarily unavailable')
  assert.equal(a.snapshot().loading, false)
})

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

test('followed completion retains the visible frame until result path and children commit together', async t => {
  const f = fixture(), parent = { id: 'parent', sessionId: 'a', parentId: null, input: 'previous', output: 'previous answer' }
  f.nodes.set(parent.id, parent)
  const a = f.make('a', { position: { viewNodeId: parent.id } }), emissions = []
  a.attach(() => { const state = a.snapshot(); emissions.push({ nodeId: state.position.viewNodeId,
    path: state.path.map(node => node.id), loading: state.loading, text: state.views.get(state.runs.at(-1)?.id)?.exchanges[0].blocks[0].text }) })
  await a.refresh(); await flushReads(); t.after(() => a.dispose())
  a.setDraft('next'); await a.submit(); await flushReads()
  const run = a.snapshot().runs.at(-1), follow = a.snapshot().position.follow
  f.rows.get(run.id).protocolBinding = { protocolId: 'chat-completions' }
  a.protocolView({ ...recordedTraceView(run.id, 'partial answer'), status: 'provisional', viewRevision: 10 })
  const view = deferred(), path = deferred(), page = deferred(), enteredView = deferred(), enteredPath = deferred(), enteredPage = deferred()
  f.intercept(url => {
    if (url === `/runs/${run.id}/view`) { enteredView.resolve(); return view.promise }
    if (url === `/sessions/a/nodes/node-${run.id}/path`) { enteredPath.resolve(); return path.promise }
    if (url === `/sessions/a/nodes?parentNodeId=node-${run.id}`) { enteredPage.resolve(); return page.promise }
  })
  emissions.length = 0
  f.finish(run.id)
  const refresh = a.refresh(); await enteredView.promise
  assert.equal(a.snapshot().views.get(run.id).exchanges[0].blocks[0].text, 'partial answer')
  a.protocolView({ ...recordedTraceView(run.id, 'late provisional'), status: 'provisional', viewRevision: 99 })
  assert.equal(a.snapshot().views.get(run.id).exchanges[0].blocks[0].text, 'partial answer')
  view.resolve(recordedTraceView(run.id, 'final answer')); await enteredPath.promise
  assert.deepEqual(a.snapshot().path, [parent])
  assert.equal(a.snapshot().position.viewNodeId, parent.id)
  assert.equal(a.snapshot().position.follow, follow)
  assert.equal(a.snapshot().loading, false)
  const result = f.nodes.get(`node-${run.id}`), child = { id: 'child', sessionId: 'a', parentId: result.id, input: 'child', output: 'child answer' }
  path.resolve([parent, result]); await enteredPage.promise
  assert.deepEqual(a.snapshot().path, [parent], 'the new path cannot appear under the old position while its children are pending')
  a.setViewMode('runs')
  page.resolve({ nodes: [child], nextCursor: 'next' }); await refresh
  assert.equal(a.snapshot().position.viewNodeId, result.id)
  assert.equal(a.snapshot().position.viewMode, 'runs')
  assert.equal(a.snapshot().position.follow, undefined)
  assert.deepEqual(a.snapshot().path, [parent, result])
  assert.deepEqual(a.snapshot().children, [child])
  assert.equal(a.snapshot().moreChildren, true)
  assert.ok(emissions.length)
  for (const state of emissions) {
    assert.equal(state.loading, false, 'completion never enters the empty loading screen')
    assert.equal(state.path.at(-1), state.nodeId, 'each render has content for its displayed position')
    assert.ok(['partial answer', 'final answer'].includes(state.text), 'a visible answer survives every completion render')
  }
})

test('failed result location reads preserve the current answer and follow for retry', async t => {
  const f = fixture(), a = f.make('a'); await f.load(a); t.after(() => a.dispose())
  a.setDraft('keep visible'); await a.submit(); await flushReads()
  const run = a.snapshot().runs[0], follow = a.snapshot().position.follow
  a.protocolView({ ...recordedTraceView(run.id, 'partial answer'), status: 'provisional' })
  f.finish(run.id)
  for (const failedUrl of [`/sessions/a/nodes/node-${run.id}/path`, `/sessions/a/nodes?parentNodeId=node-${run.id}`]) {
    f.intercept(url => url === failedUrl ? Promise.reject(new Error('Result temporarily unavailable')) : undefined)
    await a.refresh()
    assert.equal(a.snapshot().position.viewNodeId, null)
    assert.equal(a.snapshot().position.follow, follow)
    assert.deepEqual(a.snapshot().path, [])
    assert.equal(a.snapshot().views.get(run.id).exchanges[0].blocks[0].text, 'partial answer')
    assert.equal(a.snapshot().loading, false)
    assert.equal(a.snapshot().notice, 'Result temporarily unavailable')
  }
  f.intercept(() => undefined); await a.refresh()
  assert.equal(a.snapshot().position.viewNodeId, `node-${run.id}`)
  assert.equal(a.snapshot().path.at(-1).output, `answer ${run.input}`)
  assert.equal(a.snapshot().views.has(run.id), false)
  assert.equal(a.snapshot().notice, '')
})

test('completion deferred by concurrent branch paging follows immediately after paging exits', async t => {
  const f = fixture(), a = f.make('a')
  f.intercept(url => url === '/sessions/a/nodes?parentNodeId=root' ? { nodes: [], nextCursor: 'next' } : undefined)
  await f.load(a); t.after(() => a.dispose())
  a.setDraft('one'); await a.submit(); await flushReads()
  const run = a.snapshot().runs[0], path = deferred(), page = deferred(), enteredPath = deferred(), enteredPage = deferred()
  f.finish(run.id)
  f.intercept(url => {
    if (url === '/sessions/a/nodes/root/path') { enteredPath.resolve(); return path.promise }
    if (url === '/sessions/a/nodes?parentNodeId=root&cursor=next') { enteredPage.resolve(); return page.promise }
  })
  const refresh = a.refresh(); await enteredPath.promise
  const paging = a.moreChildren(); await enteredPage.promise
  path.resolve([]); await refresh
  assert.equal(a.snapshot().position.viewNodeId, null)
  assert.ok(a.snapshot().position.follow)
  page.resolve({ nodes: [] }); await paging; await flushReads()
  assert.equal(a.snapshot().position.viewNodeId, `node-${run.id}`, 'paging completion resumes follow without waiting for the calibration timer')
  assert.equal(a.snapshot().position.follow, undefined)
})

test('user actions during a result read prevent a late automatic position change', async t => {
  for (const action of ['text', 'image', 'file', 'navigate', 'focus', 'detach']) {
    await t.test(action, async t => {
      const f = fixture(), upload = deferred(), a = f.make('a', { uploadImage: () => upload.promise })
      await f.load(a); t.after(() => { upload.resolve(imageRef('new-image')); a.dispose() })
      a.setDraft('one'); await a.submit(); await flushReads()
      const run = a.snapshot().runs[0], path = deferred(), entered = deferred()
      f.finish(run.id)
      f.intercept(url => {
        if (url === `/sessions/a/nodes/node-${run.id}/path`) { entered.resolve(); return path.promise }
      })
      const refresh = a.refresh(); await entered.promise
      const request = f.calls.find(call => call.url === `/sessions/a/nodes/node-${run.id}/path`)
      if (action === 'text') a.setDraft('new draft')
      if (action === 'image') a.addImages([{ name: 'new.png', type: 'image/png', size: 100 }])
      if (action === 'file') a.setFiles([{ id: 'new-file', selection: { kind: 'project-file', path: 'next.txt' } }])
      if (action === 'navigate') await a.navigate(null)
      if (action === 'focus') a.focusRun(run.id)
      if (action === 'detach') { a.detach(); assert.equal(request.signal.aborted, true) }
      path.resolve([f.nodes.get(`node-${run.id}`)]); await refresh
      assert.equal(a.snapshot().position.viewNodeId, null)
      assert.equal(a.snapshot().position.follow, undefined)
      assert.deepEqual(a.snapshot().path, [])
      assert.equal(f.calls.some(call => call.url === `/sessions/a/nodes?parentNodeId=node-${run.id}`), false, 'stale follow does not start another read')
      assert.equal(f.calls.some(call => call.url.endsWith('/cancel')), false)
      if (action === 'text') assert.equal(a.snapshot().draft, 'new draft')
      if (action === 'image') assert.equal(a.snapshot().images[0].name, 'new.png')
      if (action === 'file') assert.equal(a.snapshot().files[0].id, 'new-file')
    })
  }
})

test('controllers restore a supported view mode and default old or invalid modes to dialogue', () => {
  for (const [viewMode, expected] of [[undefined, 'dialogue'], ['unknown', 'dialogue'], ['dialogue', 'dialogue'], ['runs', 'runs']]) {
    const f = fixture(), a = f.make('a', { position: { viewNodeId: 'parent', viewMode, focusedRunId: 'run' } })
    assert.deepEqual(a.snapshot().position, { viewNodeId: 'parent', viewMode: expected, focusedRunId: 'run' })
    a.dispose()
  }
  const f = fixture(), a = f.make('a')
  assert.deepEqual(a.snapshot().position, { viewNodeId: null, viewMode: 'dialogue' })
  a.dispose()
})

test('switching views preserves the branch, attachments and follow while an in-flight path read settles', async () => {
  const f = fixture(), drafts = createDraftStore(), entered = deferred(), path = deferred()
  const parent = { id: 'parent', sessionId: 'a', parentId: null, input: 'previous input', output: 'previous answer' }
  const follow = { runId: 'active', parentNodeId: parent.id }
  f.nodes.set(parent.id, parent)
  f.rows.set('active', { id: 'active', sessionId: 'a', input: 'working', history: { kind: 'tree', parentNodeId: parent.id }, status: 'running', revision: 1, createdAt: '0' })
  drafts.set('a', parent.id, draftFromInput('branch draft', [imageRef('photo')], [fileRef]))
  drafts.set('a', null, draftFromInput('root draft'))
  f.intercept(url => {
    if (url === '/sessions/a/nodes/parent/path') { entered.resolve(); return path.promise }
  })
  const a = f.make('a', { drafts, position: { viewNodeId: parent.id, focusedRunId: 'active', follow } })
  let notifications = 0
  a.attach(() => notifications++)
  const refresh = a.refresh(); await entered.promise
  const before = a.snapshot(), callCount = f.calls.length, priorNotifications = notifications
  const request = f.calls.find(call => call.url === '/sessions/a/nodes/parent/path')
  a.setViewMode('runs')
  assert.deepEqual(a.snapshot().position, { ...before.position, viewMode: 'runs' })
  assert.equal(a.snapshot().draft, before.draft)
  assert.deepEqual(a.snapshot().images, before.images)
  assert.deepEqual(a.snapshot().files, before.files)
  assert.equal(a.snapshot().pending, before.pending)
  assert.equal(f.positions.get('a').viewMode, 'runs')
  assert.equal(notifications, priorNotifications + 1)
  assert.equal(f.calls.length, callCount)
  assert.equal(request.signal.aborted, false)
  path.resolve([parent]); await refresh
  assert.deepEqual(a.snapshot().path, [parent])
  assert.deepEqual(a.snapshot().position.follow, follow)
  a.setViewMode('dialogue'); a.setViewMode('runs')
  await a.navigate(null)
  assert.equal(a.snapshot().position.viewMode, 'runs')
  assert.equal(a.snapshot().draft, 'root draft')
  await a.navigate(parent.id)
  assert.equal(a.snapshot().position.viewMode, 'runs')
  assert.equal(a.snapshot().draft, 'branch draft')
  assert.deepEqual(a.snapshot().images, before.images)
  assert.deepEqual(a.snapshot().files, before.files)
  a.dispose()
})

test('followed success advances the conversation in the background without changing the selected runs view', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setDraft('one'); await a.submit()
  const run = a.snapshot().runs[0], follow = a.snapshot().position.follow
  a.setViewMode('runs')
  assert.deepEqual(a.snapshot().position.follow, follow)
  f.finish(run.id); await a.refresh()
  assert.equal(a.snapshot().position.viewNodeId, `node-${run.id}`)
  assert.equal(a.snapshot().position.viewMode, 'runs')
  assert.equal(a.snapshot().position.follow, undefined)
  assert.equal(a.snapshot().path.at(-1).sourceRunId, run.id)
  assert.equal(f.positions.get('a').viewMode, 'runs')
  a.dispose()
})

test('failed, cancelled and interrupted runs keep the records view and report failure without creating a node', async () => {
  for (const [status, message] of [['failed', /本次运行失败：provider failed/], ['cancelled', /本次运行已取消/], ['interrupted', /本次运行意外中断/]]) {
    const f = fixture(), a = f.make('a'); await f.load(a)
    a.setDraft('one'); await a.submit()
    const run = a.snapshot().runs[0]
    a.setViewMode('runs')
    if (status === 'failed') f.rows.get(run.id).error = 'provider failed'
    f.finish(run.id, status); await a.refresh()
    assert.equal(a.snapshot().runs[0].status, status)
    assert.equal(a.snapshot().runs[0].resultNodeId, undefined)
    assert.deepEqual(a.snapshot().position, { viewNodeId: null, viewMode: 'runs', focusedRunId: run.id, follow: undefined })
    assert.deepEqual(a.snapshot().path, [])
    assert.deepEqual(a.snapshot().children, [])
    assert.equal(f.nodes.size, 0)
    assert.match(a.snapshot().notice, message)
    a.dispose()
  }
})

test('a missing restored node falls back to the root while preserving the records view', async () => {
  const f = fixture(), a = f.make('a', { position: { viewNodeId: 'missing', viewMode: 'runs' } })
  f.intercept(url => url === '/sessions/a/nodes/missing/path'
    ? Promise.reject(Object.assign(new Error('not found'), { status: 404, code: 'not-found' })) : undefined)
  await f.load(a)
  assert.deepEqual(a.snapshot().position, { viewNodeId: null, viewMode: 'runs' })
  assert.equal(f.positions.get('a').viewMode, 'runs')
  assert.match(a.snapshot().notice, /原查看节点不存在/)
  a.dispose()
})

test('expanding a completed run outside the selected branch loads its events and safe model view immediately', async t => {
  const f = fixture(), eventsEntered = deferred(), events = deferred(), viewEntered = deferred(), view = deferred(), shown = deferred()
  const selected = { id: 'selected-node', sessionId: 'a', parentId: null, input: 'Selected input', output: 'Selected answer', sourceRunId: 'selected-run' }
  f.nodes.set(selected.id, selected)
  f.rows.set('other-branch', recordedTraceRun('other-branch', 'another-parent'))
  f.intercept(url => {
    if (url.startsWith('/runs/other-branch/events?')) { eventsEntered.resolve(); return events.promise }
    if (url === '/runs/other-branch/view') { viewEntered.resolve(); return view.promise }
  })
  const a = f.make('a', { position: { viewNodeId: selected.id, viewMode: 'runs' } })
  t.after(() => a.dispose())
  a.attach(() => { if (a.snapshot().views.has('other-branch')) shown.resolve() }); await a.refresh()
  assert.equal(f.calls.some(call => call.url.startsWith('/runs/other-branch/')), false)
  const position = { ...a.snapshot().position }, sessionReads = f.calls.filter(call => call.url === '/sessions/a').length
  a.toggleTrace('other-branch')
  assert.equal(a.snapshot().expanded.has('other-branch'), true)
  await eventsEntered.promise
  assert.equal(f.calls.some(call => call.url === '/runs/other-branch/view'), false)
  const recordedEvents = [{ kind: 'operation-started', operationId: 'exchange', operationKind: 'model', seq: 1, at: '2026-10-02T01:00:01.000Z' }]
  events.resolve(recordedEvents); await viewEntered.promise
  const unsafeExtra = { ...recordedTraceView('other-branch'), credential: 'private-key', continuation: 'private-continuation' }
  unsafeExtra.exchanges[0].blocks[0].nativeReasoning = 'private-reasoning'
  view.resolve(unsafeExtra); await shown.promise
  assert.deepEqual(a.snapshot().events.get('other-branch'), recordedEvents)
  assert.deepEqual(a.snapshot().views.get('other-branch'), recordedTraceView('other-branch'))
  assert.deepEqual(a.snapshot().position, position)
  assert.deepEqual(a.snapshot().path, [selected])
  assert.equal(f.calls.filter(call => call.url === '/sessions/a').length, sessionReads, 'opening a trace does not wait for polling')
  const viewReads = f.calls.filter(call => call.url === '/runs/other-branch/view').length
  f.intercept(url => url.startsWith('/runs/other-branch/events?') ? [] : undefined)
  a.toggleTrace('other-branch'); a.toggleTrace('other-branch')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.filter(call => call.url === '/runs/other-branch/view').length, viewReads, 'a committed cached projection is reused')
  assert.equal(a.snapshot().expanded.has('other-branch'), true)
})

test('view cache eviction retains an expanded off-branch trace until the user closes it', async t => {
  const f = fixture(), a = f.make('a')
  t.after(() => a.dispose())
  f.rows.set('expanded', recordedTraceRun('expanded', 'another-parent'))
  for (let index = 0; index < 65; index++) f.rows.set(`cached-${index}`, recordedTraceRun(`cached-${index}`, 'another-parent'))
  await f.load(a)
  a.protocolView(recordedTraceView('expanded')); a.toggleTrace('expanded')
  await new Promise(resolve => setImmediate(resolve))
  for (let index = 0; index < 65; index++) a.protocolView(recordedTraceView(`cached-${index}`))
  assert.equal(a.snapshot().views.size, 64)
  assert.equal(a.snapshot().views.has('expanded'), true)
  assert.equal(a.snapshot().views.has('cached-0'), false)
  assert.equal(a.snapshot().views.has('cached-64'), true)
  assert.deepEqual(a.snapshot().path, [])
  a.toggleTrace('expanded'); a.protocolView(recordedTraceView('newest'))
  assert.equal(a.snapshot().views.size, 64)
  assert.equal(a.snapshot().views.has('expanded'), false, 'closed off-branch history becomes eligible for eviction')
  assert.equal(a.snapshot().views.has('newest'), true)
})

test('closing a panel aborts an in-flight trace view read and prevents its late publication', async t => {
  const f = fixture(), entered = deferred(), delayed = deferred()
  f.rows.set('history', recordedTraceRun('history', 'another-parent'))
  f.intercept(url => {
    if (url === '/runs/history/view') { entered.resolve(); return delayed.promise }
  })
  const a = f.make('a'); t.after(() => a.dispose())
  let publications = 0
  a.attach(() => publications++); await a.refresh()
  a.toggleTrace('history'); await entered.promise
  const request = f.calls.find(call => call.url === '/runs/history/view')
  assert.equal(request.signal.aborted, false)
  a.detach()
  const before = publications
  assert.equal(request.signal.aborted, true)
  delayed.resolve(recordedTraceView('history'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.snapshot().views.size, 0)
  assert.equal(publications, before)
  assert.equal(f.calls.some(call => call.url.endsWith('/cancel')), false)
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

test('refresh merges monotone run revisions and uses one fallback timer', async () => {
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

test('live changes use a calibration timer and retain notifications during an in-flight refresh', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setLive(true)
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [30000])
  const first = deferred(), entered = deferred()
  let listing = 0
  f.intercept(url => {
    if (url === '/sessions/a/runs' && ++listing === 1) { entered.resolve(); return first.promise }
  })
  const refresh = a.refresh(); await entered.promise
  f.rows.set('new', { id: 'new', sessionId: 'a', revision: 2, status: 'running', createdAt: '0' })
  a.notifyChange(); a.notifyChange()
  first.resolve([])
  await refresh
  assert.equal(listing, 2)
  assert.equal(a.snapshot().runs[0].id, 'new')
  a.setLive(false)
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [5000])
  a.detach(); a.notifyChange()
  assert.equal(f.timers.size, 0)
})

test('notifications while POST is pending refresh after settlement and discover the committed result node', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setLive(true)
  const response = deferred()
  f.intercept((url, body) => {
    if (url === '/sessions/a/runs' && body) {
      f.rows.set('new', { id: 'new', sessionId: 'a', input: body.input, history: { kind: 'tree', parentNodeId: null },
        key: body.idempotencyKey, revision: 0, status: 'running', createdAt: '0' })
      return response.promise
    }
  })
  a.setDraft('new run'); const posting = a.submit()
  const before = f.calls.length
  a.notifyChange(); a.notifyChange()
  assert.equal(f.calls.length, before)
  const accepted = { ...f.rows.get('new') }
  f.finish('new')
  response.resolve(accepted)
  await posting
  await a.refresh()
  assert.equal(a.snapshot().runs[0].status, 'completed')
  assert.equal(a.snapshot().position.viewNodeId, 'node-new')
  a.detach()
})

test('a live notification received by a hidden view is reconciled when the view refreshes', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  a.setLive(true); f.hide()
  const before = f.calls.length
  f.rows.set('background', { id: 'background', sessionId: 'a', revision: 4, status: 'completed', createdAt: '0' })
  a.notifyChange()
  assert.equal(f.calls.length, before)
  await a.refresh()
  assert.equal(a.snapshot().runs[0].id, 'background')
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [30000])
  a.detach()
})

test('a notification during node navigation schedules a fresh node query after navigation settles', async () => {
  const f = fixture(), a = f.make('a'); await f.load(a)
  const page = deferred(), entered = deferred()
  let first = true
  f.intercept(url => {
    if (first && url === '/sessions/a/nodes?parentNodeId=root') { first = false; entered.resolve(); return page.promise }
  })
  const navigation = a.navigate(null); await entered.promise
  f.nodes.set('new-node', { id: 'new-node', sessionId: 'a', parentId: null, input: 'hello', output: 'done' })
  a.notifyChange(); await a.refresh()
  page.resolve({ nodes: [] }); await navigation; await a.refresh()
  assert.equal(a.snapshot().children[0].id, 'new-node')
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
      if (url === '/sessions/a') return { id: 'a', projectId: 'p', historyMode: 'native-local-v1', protocolId: 'chat-completions' }
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

const imageRef = id => ({ assetId: id, sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 4, width: 2, height: 2, expiresAt: '2030-01-01T00:00:00.000Z' })

test('image-only submission persists pending v2 and sends only ordered asset IDs', async () => {
  const f = fixture(), drafts = createDraftStore(f.store), images = [imageRef('second'), imageRef('first')]
  drafts.set('a', null, draftFromInput('', images))
  let persisted
  f.intercept((url, body) => {
    if (url.endsWith('/images/renew')) { persisted = f.pending.get('a'); return { valid: images, invalid: [] } }
  })
  const a = f.make('a', { drafts }); await f.load(a); await a.submit()
  assert.equal(persisted.schemaVersion, 3)
  assert.deepEqual(persisted.images, images)
  const submitted = f.calls.find(call => call.url === '/sessions/a/runs' && call.body)
  assert.equal(submitted.body.input, '')
  assert.deepEqual(submitted.body.images, [{ assetId: 'second' }, { assetId: 'first' }])
  assert.equal(a.snapshot().images.length, 0)
  a.dispose()
})

test('edited siblings and regenerated nodes preserve images and reject expired refs without a Run POST', async () => {
  const f = fixture(), drafts = createDraftStore(), images = [imageRef('photo')]
  const a = f.make('a', { drafts }); await f.load(a)
  await a.navigate(null, 'edited', images)
  assert.equal(a.snapshot().images[0].image.assetId, 'photo')
  f.intercept(url => url.endsWith('/images/renew') ? { valid: [], invalid: ['photo'] } : undefined)
  await a.submit()
  assert.equal(f.calls.some(call => call.url === '/sessions/a/runs' && call.body), false)
  assert.equal(a.snapshot().images[0].status, 'expired')
  assert.equal(a.snapshot().draft, 'edited')
  f.intercept(url => url.endsWith('/images/renew') ? { valid: images, invalid: [] } : undefined)
  await a.regenerate({ id: 'old', sessionId: 'a', parentId: null, input: 'original', images, output: 'answer', sourceRunId: 'old-run' })
  const posted = f.calls.find(call => call.url === '/sessions/a/runs' && call.body)
  assert.equal(posted.body.input, 'original')
  assert.deepEqual(posted.body.images, [{ assetId: 'photo' }])
  a.dispose()
})

test('unknown or malformed pending image schemas restore visibly and never post automatically', async () => {
  for (const input of [
    { schemaVersion: 99, images: [imageRef('photo')] },
    { schemaVersion: 2, images: [{ assetId: 'lost-metadata' }] },
  ]) {
    const f = fixture()
    f.storage.set(pendingKey, JSON.stringify({ a: { sessionId: 'a', input: 'keep text', idempotencyKey: 'key', parentNodeId: null, ...input } }))
    const a = f.make('a', { pending: createPendingStore(f.store) }); await f.load(a)
    assert.equal(a.snapshot().draft, 'keep text')
    assert.ok(a.snapshot().images.length)
    assert.equal(f.calls.some(call => call.url === '/sessions/a/runs' && call.body), false)
    a.dispose()
  }
})

test('accepted image pending is recovered before changed model capabilities or expired draft checks', async () => {
  const f = fixture(), image = { ...imageRef('expired'), expiresAt: '2000-01-01T00:00:00.000Z' }
  f.pending.set('a', { schemaVersion: 2, sessionId: 'a', parentNodeId: null, input: '', images: [image], idempotencyKey: 'accepted-key', modelId: 'deleted' })
  f.rows.set('accepted', { id: 'accepted', sessionId: 'a', key: 'accepted-key', history: { kind: 'tree', parentNodeId: null }, input: '', images: [image], status: 'failed', revision: 2, createdAt: '0' })
  const a = f.make('a', { models: () => [] }); await f.load(a)
  assert.equal(a.snapshot().runs[0].id, 'accepted')
  assert.equal(f.pending.get('a'), undefined)
  assert.equal(f.calls.some(call => call.body), false)
  a.dispose()
})

test('unaccepted image pending with changed capabilities or protocol restores its original parent draft and unlocks edits', async () => {
  for (const model of [
    { parameters: { protocolId: 'chat-completions' }, effectiveCapabilities: { imageInput: false } },
    { parameters: { protocolId: 'anthropic-messages' }, effectiveCapabilities: { imageInput: true } },
  ]) {
    const f = fixture(), drafts = createDraftStore(), images = [imageRef('pending-photo')]
    drafts.set('a', 'original-parent', draftFromInput('new unsent text', [imageRef('new-photo')]))
    drafts.set('a', null, draftFromInput('other branch'))
    f.pending.set('a', { schemaVersion: 2, sessionId: 'a', parentNodeId: 'original-parent', input: 'original text', images, idempotencyKey: 'unaccepted', modelId: 'model' })
    const a = f.make('a', { drafts, models: () => [{ id: 'model', ...model }] }); await f.load(a)
    assert.equal(f.pending.get('a'), undefined)
    assert.equal(a.snapshot().draft, 'other branch')
    assert.deepEqual(drafts.get('a', 'original-parent').images.map(value => value.image.assetId), ['pending-photo', 'new-photo'])
    assert.equal(drafts.get('a', 'original-parent').text, 'original text\n\nnew unsent text')
    assert.equal(f.calls.some(call => call.body), false)
    assert.ok(f.calls.some(call => call.url.endsWith('/runs/by-key/unaccepted')))
    assert.match(a.snapshot().notice, /恢复到原对话位置/)
    assert.match(a.snapshot().notice, /新草稿也已同时保留/)
    await a.navigate('original-parent')
    a.removeImage('pending-photo')
    assert.deepEqual(a.snapshot().images.map(value => value.image.assetId), ['new-photo'])
    a.dispose()
  }
})

test('merged pending drafts retain more than eight images across reload and block oversized sends', async () => {
  const f = fixture(), drafts = createDraftStore(f.store)
  const images = Array.from({ length: 8 }, (_, index) => imageRef(`pending-${index}`))
  drafts.set('a', null, draftFromInput('new text', [imageRef('new-photo')]))
  f.pending.set('a', { schemaVersion: 2, sessionId: 'a', parentNodeId: null, input: 'original text', images, idempotencyKey: 'unaccepted', modelId: 'model' })
  const a = f.make('a', { drafts, models: () => [{ id: 'model', parameters: { protocolId: 'chat-completions' }, effectiveCapabilities: { imageInput: false } }] })
  await f.load(a)
  assert.equal(a.snapshot().images.length, 9)
  assert.equal(f.pending.get('a'), undefined)
  a.dispose()
  const restored = f.make('a', { drafts: createDraftStore(f.store) }); await f.load(restored)
  assert.equal(restored.snapshot().images.length, 9)
  assert.equal(restored.snapshot().draft, 'original text\n\nnew text')
  await restored.submit()
  assert.equal(f.calls.some(call => call.body), false)
  assert.match(restored.snapshot().notice, /删减图片/)
  assert.equal(restored.snapshot().images.length, 9)
  // Total bytes are checked independently of the image count.
  await restored.navigate(null, 'large originals', [0, 1, 2].map(index => ({ ...imageRef(`large-${index}`), byteLength: 8 * 1024 * 1024 })))
  await restored.submit()
  assert.equal(f.calls.some(call => call.body), false)
  assert.match(restored.snapshot().notice, /删减图片/)
  restored.dispose()
})

const fileRef = { snapshotId: 'snapshot', projectId: 'p-a', path: 'src/example.ts', actualRange: { start: 1, end: 1 }, byteLength: 4,
  sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z' }

test('sidebar references commit text and files together and remove only the exact captured mention', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  controller.setDraft('read @src then explain')
  const seen = []; controller.attach(() => seen.push([controller.snapshot().draft, controller.snapshot().files.length]))
  await controller.refresh(); seen.length = 0
  assert.equal(controller.applyFileReference({ sessionId: 'a', parentNodeId: null,
    item: { id: 'one', selection: { kind: 'project-file', path: 'src/example.ts' } }, mention: { start: 5, end: 9, text: '@src' } }), true)
  assert.deepEqual(seen, [['read  then explain', 1]])
  controller.setDraft('a changed input')
  assert.equal(controller.applyFileReference({ sessionId: 'a', parentNodeId: null,
    item: { id: 'two', selection: { kind: 'project-file', path: 'other.ts' } }, mention: { start: 5, end: 9, text: '@src' } }), true)
  assert.equal(controller.snapshot().draft, 'a changed input')
  assert.match(controller.snapshot().notice, /原 @ 文本已保留/)
  controller.dispose()
})

test('sidebar draft edits reject changed parent, removed chips and changed selections without replacing snapshots', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  const original = { id: 'original', selection: { kind: 'snapshot', snapshotId: 'snapshot' }, file: fileRef }
  controller.setFiles([original])
  const update = { sessionId: 'a', parentNodeId: null, expectedItem: original, item: { id: 'original', selection: { kind: 'project-file', path: 'src/example.ts' } } }
  assert.equal(controller.applyFileReference({ ...update, sessionId: 'other' }), false)
  assert.equal(controller.applyFileReference({ ...update, parentNodeId: 'other-parent' }), false)
  assert.equal(controller.snapshot().files[0].selection.kind, 'snapshot')
  controller.setFiles([]); assert.equal(controller.applyFileReference(update), false)
  controller.setFiles([{ ...original, selection: { kind: 'project-file', path: 'changed.ts' }, file: undefined }])
  assert.equal(controller.applyFileReference(update), false)
  controller.setFiles([{ ...original, file: { ...fileRef, expiresAt: '2099-01-01T00:00:00.000Z' } }])
  assert.equal(controller.applyFileReference(update), true, 'lease renewal does not change the original reference identity')
  assert.deepEqual(controller.snapshot().files, [update.item])
  controller.dispose()
})

test('sidebar references refuse loading, pending, duplicates, the file limit and read-only sessions', async () => {
  const f = fixture(), controller = f.make('a'), input = { sessionId: 'a', parentNodeId: null, item: { id: 'new', selection: { kind: 'project-file', path: 'new.ts' } } }
  assert.equal(controller.applyFileReference(input), false)
  await f.load(controller)
  controller.setFiles([{ ...input.item, id: 'existing' }]); assert.equal(controller.applyFileReference(input), false)
  controller.setFiles(Array.from({ length: 8 }, (_, index) => ({ id: `file-${index}`, selection: { kind: 'project-file', path: `file-${index}.ts` } })))
  assert.equal(controller.applyFileReference(input), false)
  controller.setFiles([])
  f.pending.set('a', { schemaVersion: 3, sessionId: 'a', parentNodeId: null, input: 'waiting', idempotencyKey: 'held' })
  assert.equal(controller.applyFileReference(input), false); f.pending.set('a', undefined)
  f.intercept(url => url === '/sessions/a' ? { id: 'a', projectId: 'p-a', historyMode: 'dialogue-v1', agentId: 'assistant', modelId: null } : undefined)
  await controller.refresh(); assert.equal(controller.applyFileReference(input), false)
  assert.deepEqual(controller.snapshot().files, [])
  controller.dispose()
})

test('file-only input persists a preparation key before reading and retries a lost preparation response', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  let attempts = 0, key
  f.intercept((url, body) => {
    if (url.endsWith('/project-files/prepare')) {
      const saved = f.pending.get('a')
      assert.equal(saved.preparationKey, body.preparationKey)
      assert.deepEqual(saved.fileSelections, body.selections)
      if (!attempts++) { key = body.preparationKey; return Promise.reject(new Error('response lost')) }
      assert.equal(body.preparationKey, key); return [fileRef]
    }
    if (url.endsWith('/project-files/renew')) return { valid: [fileRef], invalid: [] }
    if (url.endsWith('/runs') && body) assert.equal(f.pending.get('a').files[0].snapshotId, 'snapshot')
  })
  controller.setFiles([{ id: 'draft', selection: { kind: 'project-file', path: 'src/example.ts' } }])
  await controller.submit()
  assert.equal(f.calls.filter(call => call.url.endsWith('/runs') && call.body).length, 0)
  assert.equal(f.pending.get('a').preparationKey, key)
  await controller.submit()
  const sent = f.calls.find(call => call.url.endsWith('/runs') && call.body)
  assert.equal(sent.body.input, ''); assert.deepEqual(sent.body.files, [{ snapshotId: 'snapshot' }]); assert.equal(attempts, 2)
  assert.equal(f.pending.get('a'), undefined); controller.dispose()
})

test('lost Run response reuses saved snapshots without preparing current files again', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  let failed = false
  f.intercept((url, body) => {
    if (url.endsWith('/project-files/prepare')) return [fileRef]
    if (url.endsWith('/project-files/renew')) return { valid: [fileRef], invalid: [] }
    if (url.endsWith('/runs') && body && !failed) { failed = true; return Promise.reject(new Error('network')) }
  })
  controller.setFiles([{ id: 'draft', selection: { kind: 'project-file', path: 'src/example.ts' } }])
  await controller.submit(); assert.equal(f.pending.get('a').files[0].snapshotId, 'snapshot')
  await controller.submit()
  assert.equal(f.calls.filter(call => call.url.endsWith('/project-files/prepare')).length, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/runs') && call.body).length, 2)
  controller.dispose()
})

test('file preparation errors restore the original branch draft without dropping references', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  f.intercept(url => url.endsWith('/project-files/prepare') ? Promise.reject(Object.assign(new Error('file missing'), { status: 404, code: 'file-missing' })) : undefined)
  controller.setDraft('question'); controller.setFiles([{ id: 'draft', selection: { kind: 'project-file', path: 'gone.txt' } }])
  await controller.submit()
  assert.equal(controller.snapshot().draft, 'question'); assert.equal(controller.snapshot().files[0].selection.path, 'gone.txt')
  assert.equal(f.pending.get('a'), undefined); assert.equal(f.rows.size, 0); controller.dispose()
})

test('history editing and regeneration keep immutable snapshot IDs', async () => {
  const f = fixture(), controller = f.make('a'); await f.load(controller)
  const node = { id: 'node', sessionId: 'a', parentId: null, input: 'question', images: [], files: [fileRef], output: 'answer', sourceRunId: 'old' }
  f.intercept(url => url.endsWith('/project-files/renew') ? { valid: [fileRef], invalid: [] } : undefined)
  await controller.navigate(null, node.input, [], node.files)
  assert.deepEqual(controller.snapshot().files[0].selection, { kind: 'snapshot', snapshotId: 'snapshot' })
  await controller.regenerate(node)
  assert.equal(f.calls.filter(call => call.url.endsWith('/project-files/prepare')).length, 0)
  assert.deepEqual(f.calls.find(call => call.url.endsWith('/runs') && call.body).body.files, [{ snapshotId: 'snapshot' }])
  controller.dispose()
})

test('malformed persisted file references remain visible and cannot become text-only submissions', async () => {
  const f = fixture()
  f.store.setItem(pendingKey, JSON.stringify({ a: { schemaVersion: 3, sessionId: 'a', parentNodeId: null, input: 'question', idempotencyKey: 'bad', files: [{ snapshotId: 'missing-metadata' }] } }))
  const pending = createPendingStore(f.store), controller = f.make('a', { pending })
  await f.load(controller)
  assert.ok(controller.snapshot().files[0].error)
  await controller.submit(); assert.equal(f.calls.filter(call => call.url.endsWith('/runs') && call.body).length, 0)
  controller.dispose()
})

test('archived controllers preserve drafts, reject edits, and recover unaccepted pending without posting', async () => {
  const f = fixture(), drafts = createDraftStore(), seen = []
  const a = f.make('a', { drafts, archived: ref => seen.push(ref) })
  await f.load(a)
  a.setDraft('newer draft')
  f.pending.set('a', { schemaVersion: 3, sessionId: 'a', input: 'uncertain input', parentNodeId: null, idempotencyKey: 'unknown' })
  let archivedAt = '2026-09-29T00:00:00Z'
  f.intercept(url => url === '/sessions/a' ? { id: 'a', projectId: 'p-a', modelId: null, protocolId: 'chat-completions', historyMode: 'native-local-v1', archivedAt } : undefined)
  await a.refresh()
  assert.equal(seen.length, 1)
  assert.equal(f.pending.get('a'), undefined)
  assert.equal(a.snapshot().draft, 'uncertain input\n\nnewer draft')
  const before = a.snapshot().draft
  a.setDraft('overwrite'); a.setFiles([{ id: 'file', selection: { kind: 'project-file', path: 'secret' } }])
  await a.navigate(null, 'edit')
  await a.regenerate({ id: 'old', sessionId: 'a', parentId: null, input: 'regenerate' })
  await a.submit(); await a.setModel('default')
  assert.equal(a.snapshot().draft, before)
  assert.deepEqual(a.snapshot().files, [])
  assert.equal(f.calls.filter(call => call.body).length, 0)
  await a.refresh(); assert.equal(seen.length, 1)
  a.detach(); await f.load(a); assert.equal(seen.length, 1) // explicit opening of archive stays open
  archivedAt = null
  await a.refresh(); a.setDraft('after restore'); await a.submit()
  assert.equal(f.calls.filter(call => call.body).length, 1)
  a.dispose()
})

test('archived refresh reconciles an accepted unknown submission before closing its pane', async () => {
  const f = fixture(), a = f.make('a')
  await f.load(a); a.setDraft('accepted'); await a.submit()
  const run = a.snapshot().runs[0]; f.finish(run.id)
  f.pending.set('a', { schemaVersion: 3, sessionId: 'a', input: 'accepted', parentNodeId: null, idempotencyKey: f.rows.get(run.id).key })
  f.intercept(url => url === '/sessions/a' ? { id: 'a', projectId: 'p-a', protocolId: 'chat-completions', historyMode: 'native-local-v1', archivedAt: 'now' } : undefined)
  const posts = f.calls.filter(call => call.body).length
  await a.refresh()
  assert.equal(f.pending.get('a'), undefined)
  assert.equal(a.snapshot().draft, '')
  assert.equal(a.snapshot().runs[0].status, 'completed')
  assert.equal(f.calls.filter(call => call.body).length, posts)
  a.dispose()
})

test('archive pending recovery keeps invalid attachment markers and leaves uncertainty on lookup failure', async () => {
  const f = fixture(), a = f.make('a')
  const submission = { schemaVersion: 3, sessionId: 'a', input: 'uncertain', parentNodeId: null, idempotencyKey: 'k', invalidImages: true, invalidFiles: true }
  f.pending.set('a', submission)
  let offline = true
  f.intercept(url => {
    if (url === '/sessions/a') return { id: 'a', projectId: 'p-a', archivedAt: 'now', historyMode: 'native-local-v1' }
    if (offline && url.includes('/by-key/')) return Promise.reject(new Error('offline'))
  })
  await f.load(a)
  assert.equal(f.pending.get('a'), submission)
  assert.equal(f.calls.some(call => call.body), false)
  offline = false; await a.refresh()
  assert.equal(f.pending.get('a'), undefined)
  assert.equal(a.snapshot().draft, 'uncertain')
  assert.equal(a.snapshot().images[0].status, 'failed')
  assert.ok(a.snapshot().files[0].error)
  a.dispose()
})

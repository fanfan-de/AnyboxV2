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

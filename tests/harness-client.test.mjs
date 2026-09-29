import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarnessClient, scopedId, splitScopedId, connectionResourceURL, mapResourceIds } from '../dist/client/harness-client.js'
import { migrateLegacyState } from '../dist/client/legacy-state.js'
import { emptyWorkspace, splitSession, openSession, panes, restoreWorkspace } from '../dist/client/workspace-layout.js'
import { createPendingStore } from '../dist/client/session-client.js'
import { createDraftStore } from '../dist/client/draft-client.js'
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const connections = [{ id: 'a', name: 'Laptop', instanceId: a }, { id: 'b', name: 'Server', instanceId: b }]
const store = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) } }

test('same resource IDs are scoped across projects, archives, models, files, images, commands and fixed settings clients', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options }); const path = url.split('/v1')[1]
    return Response.json(path === '/projects' ? [{ id: 'same', name: 'project', available: true }] : path === '/models' ? [{ id: 'same' }] : path === '/sessions/archived' ? [{ id: 'same', projectId: 'same' }] : { id: 'same', assetId: 'same', snapshotId: 'same', text: 'same' })
  })
  const api = createHarnessClient(connections, 'a')
  for (const path of ['/projects', '/models', '/sessions/archived']) {
    const values = await api(path); assert.equal(values[0].id, scopedId(a, 'same')); assert.equal(values[1].id, scopedId(b, 'same'))
  }
  const result = await api(`/sessions/${encodeURIComponent(scopedId(b, 'same'))}/runs`, { parentNodeId: scopedId(b, 'same'), modelId: scopedId(b, 'same'), input: scopedId(a, 'literal text'), images: [{ assetId: scopedId(b, 'same') }], files: [{ snapshotId: scopedId(b, 'same') }] })
  assert.equal(calls.at(-1).url, '/api/connections/b/v1/sessions/same/runs')
  const body = JSON.parse(calls.at(-1).options.body)
  assert.equal(body.input, scopedId(a, 'literal text')); assert.equal(body.modelId, 'same'); assert.equal(body.images[0].assetId, 'same'); assert.equal(body.files[0].snapshotId, 'same')
  assert.equal(result.assetId, scopedId(b, 'same'))
  assert.equal(connectionResourceURL(scopedId(b, 'same'), `/sessions/${scopedId(b, 'same')}/images/${scopedId(a, 'image')}/content`), '/unavailable-resource')
  const count = calls.length
  await assert.rejects(api(`/sessions/${scopedId(b, 'same')}/runs`, { modelId: scopedId(a, 'same') }), { code: 'cross-instance-input' })
  await assert.rejects(api('/sessions/legacy/runs', { input: 'never to selected instance' }), { code: 'instance-unavailable' })
  assert.equal(calls.length, count)
  assert.equal(connectionResourceURL(scopedId(b, 'same'), `/sessions/${scopedId(b, 'same')}/images/${scopedId(b, 'image')}/content`), '/api/connections/b/v1/sessions/same/images/image/content')
  await api.forConnection('b')('/models')
  assert.equal(calls.at(-1).url, '/api/connections/b/v1/models')
  api.dispose(); await assert.rejects(api('/projects'), /client-disposed/)
})

test('four panes and persistent pending/drafts with equal server IDs retain separate ownership', () => {
  let layout = openSession(emptyWorkspace, { projectId: scopedId(a, 'p'), sessionId: scopedId(a, 's') })
  for (const [instance, session] of [[b, 's'], [a, 't'], [b, 't']]) layout = splitSession(layout, { projectId: scopedId(instance, 'p'), sessionId: scopedId(instance, session) }, layout.activePaneId, 'right', `${instance}-${session}`)
  const all = panes(restoreWorkspace(JSON.parse(JSON.stringify(layout))).root)
  assert.equal(all.length, 4); assert.equal(new Set(all.map(p => p.sessionId)).size, 4)
  const storage = store(), pending = createPendingStore(storage), drafts = createDraftStore(storage)
  for (const instance of [a, b]) {
    const sessionId = scopedId(instance, 's')
    pending.set(sessionId, { sessionId, input: instance, idempotencyKey: 'same', parentNodeId: null, schemaVersion: 3 })
    drafts.set(sessionId, scopedId(instance, 'node'), { text: instance, images: [], files: [] })
  }
  assert.equal(createPendingStore(storage).get(scopedId(a, 's')).input, a)
  assert.equal(createPendingStore(storage).get(scopedId(b, 's')).input, b)
  assert.equal(createDraftStore(storage).get(scopedId(b, 's'), scopedId(b, 'node')).text, b)
})

test('legacy state stays untouched until launcher identity and remote session ownership are confirmed', async () => {
  const storage = store(), layout = openSession(emptyWorkspace, { projectId: 'p', sessionId: 's' })
  const old = JSON.stringify(layout)
  storage.setItem('anybox.web.workspace.v1', old)
  storage.setItem('anybox.web.v2.pending', JSON.stringify({ s: { sessionId: 's', input: 'hello', idempotencyKey: 'do-not-change', schemaVersion: 3, parentNodeId: null } }))
  assert.equal(await migrateLegacyState(storage, undefined, async () => { throw new Error('must not call') }), 'pending')
  assert.equal(storage.getItem('anybox.web.workspace.v2'), null)
  assert.equal(await migrateLegacyState(storage, a, async () => false), 'pending')
  assert.equal(await migrateLegacyState(storage, a, async (id, project) => id === 's' && project === 'p'), 'migrated')
  const pending = createPendingStore(storage).get(scopedId(a, 's'))
  assert.equal(pending.idempotencyKey, 'do-not-change'); assert.equal(pending.input, 'hello')
  assert.equal(panes(JSON.parse(storage.getItem('anybox.web.workspace.v2')).root)[0].sessionId, scopedId(a, 's'))
  assert.equal(storage.getItem('anybox.web.workspace.v1'), old)
})

test('disposal aborts pending reads and an offline endpoint does not erase another instance', async t => {
  let hang = false, aborted = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/a/')) throw new Error('offline')
    if (!hang) return Response.json([{ id: 'same' }])
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }))
  })
  const api = createHarnessClient(connections)
  assert.deepEqual((await api('/projects')).map(p => p.id), [scopedId(b, 'same')])
  assert.equal(api.errors.get('a'), 'connection-unavailable')
  hang = true
  const read = api(`/sessions/${scopedId(b, 's')}`)
  api.dispose(); await assert.rejects(read); assert.equal(aborted, true)
  assert.deepEqual(mapResourceIds({ parameters: { id: 'native' }, input: 'id', modelId: 'm' }, id => scopedId(a, id)), { parameters: { id: 'native' }, input: 'id', modelId: scopedId(a, 'm') })
  assert.equal(splitScopedId('unqualified'), undefined)
})

test('healthy list updates are observable before a stalled device responds; late reads cannot replace newer cache', async t => {
  const pending = []
  t.mock.method(globalThis, 'fetch', async (url, options) => url.includes('/a/') ? Response.json([{ id: 'healthy', available: true }]) : new Promise(resolve => pending.push(resolve)))
  const api = createHarnessClient(connections), snapshots = []
  const off = api.subscribeList('/projects', values => snapshots.push(values))
  const first = api('/projects'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshots[0].map(value => value.id), [scopedId(a, 'healthy')])
  const second = api('/projects'); await new Promise(resolve => setImmediate(resolve))
  pending[1](Response.json([{ id: 'new', available: true }]))
  await second
  pending[0](Response.json([{ id: 'old', available: true }]))
  await first
  assert.ok(snapshots.at(-1).some(value => value.id === scopedId(b, 'new')))
  assert.ok(!snapshots.at(-1).some(value => value.id === scopedId(b, 'old')))
  off(); api.dispose()
})

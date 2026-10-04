import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarnessClient, scopedId, splitScopedId, connectionResourceURL, mapResourceIds } from '../dist/applications/harness/web/harness-client.js'
import { migrateLegacyState } from '../dist/applications/harness/web/legacy-state.js'
import { emptyWorkspace, splitSession, openSession, panes, restoreWorkspace, waitForProjectSnapshot } from '../dist/applications/harness/web/workspace-layout.js'
import { createPendingStore } from '../dist/applications/harness/web/session-client.js'
import { createDraftStore } from '../dist/applications/harness/web/draft-client.js'
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const connections = [{ id: 'a', name: 'Laptop', instanceId: a, revision: 1 }, { id: 'b', name: 'Server', instanceId: b, revision: 1 }]
const store = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) } }

test('session default model IDs remain scoped to their execution device while fixed settings clients use local IDs', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ agentId: 'assistant', modelId: 'chosen', fallbackModelId: 'startup', effectiveModelId: 'chosen', revision: 2 })
  })
  const api = createHarnessClient(connections, 'a')
  try {
    const defaults = await api(`/agents/${encodeURIComponent(scopedId(b, 'assistant'))}/session-defaults`)
    assert.deepEqual(defaults, { agentId: scopedId(b, 'assistant'), modelId: scopedId(b, 'chosen'),
      fallbackModelId: scopedId(b, 'startup'), effectiveModelId: scopedId(b, 'chosen'), revision: 2 })
    assert.equal(calls.at(-1).url, '/api/connections/b/v1/agents/assistant/session-defaults')
    await api(`/agents/${encodeURIComponent(scopedId(b, 'assistant'))}/session-defaults`, { modelId: scopedId(b, 'chosen'), expectedRevision: 2 })
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { modelId: 'chosen', expectedRevision: 2 })
    const count = calls.length
    await assert.rejects(api(`/agents/${encodeURIComponent(scopedId(b, 'assistant'))}/session-defaults`,
      { modelId: scopedId(a, 'chosen'), expectedRevision: 2 }), { code: 'cross-instance-input' })
    assert.equal(calls.length, count)
    assert.equal((await api.forConnection('b')('/agents/assistant/session-defaults')).effectiveModelId, 'chosen')
    assert.deepEqual(mapResourceIds({ modelId: null, fallbackModelId: null, effectiveModelId: null }, id => scopedId(a, id)),
      { modelId: null, fallbackModelId: null, effectiveModelId: null })
  } finally { await api.dispose() }
})

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
  const resource = new URL(connectionResourceURL(scopedId(b, 'same'), `/sessions/${scopedId(b, 'same')}/images/${scopedId(b, 'image')}/content`), 'http://local')
  assert.equal(resource.pathname, '/api/connections/b/v1/sessions/same/images/image/content')
  assert.equal(resource.searchParams.get('__anyboxProductId'), 'agent')
  assert.equal(resource.searchParams.get('__anyboxInstanceId'), b)
  assert.equal(resource.searchParams.get('__anyboxConnectionRevision'), '1')
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

test('incompatible stream views keep session and Run identities scoped to the notifying device', async t => {
  const streams = new Map(), incompatible = [], refreshed = [], views = []
  t.mock.method(globalThis, 'fetch', async url => new Response(new ReadableStream({
    start(controller) { streams.set(url.includes('/a/') ? 'a' : 'b', controller) },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const api = createHarnessClient(connections), changes = api.changes({
    refresh: id => refreshed.push(id), view: snapshot => views.push(snapshot), connected() {},
    incompatibleView: (...ids) => incompatible.push(ids),
  })
  t.after(async () => { for (const controller of streams.values()) controller.close(); changes.dispose(); await api.dispose() })
  changes.update([scopedId(a, 'same'), scopedId(b, 'same')])
  await new Promise(resolve => setImmediate(resolve))
  const send = (device, version, runId = 'run', sessionId = 'same') => streams.get(device).enqueue(new TextEncoder().encode(
    `event: protocol-view\ndata: ${JSON.stringify({ sessionId, runId, snapshot: { envelopeVersion: 1, viewSchemaVersion: version, sessionId, runId } })}\n\n`))
  send('a', 1); send('a', 99); send('a', 1, 'outside', 'not-subscribed'); send('b', 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(incompatible, [[scopedId(a, 'same'), scopedId(a, 'run')], [scopedId(b, 'same'), scopedId(b, 'run')]])
  assert.deepEqual(refreshed, []); assert.deepEqual(views, [])
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

test('project selection captures connection identity and revision for browse, native pick and registration', async t => {
  const calls = [], targets = connections.map((connection, index) => ({ ...connection, revision: index + 4 }))
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    if (url === '/api/client/v1/local') return Response.json({ instanceId: a, picker: true })
    if (url.endsWith('/pick')) return Response.json({ path: '/same/path' })
    if (url.endsWith('/projects')) return Response.json({ id: 'same', name: 'project', path: '/same/path', available: true })
    return Response.json({ instanceId: b, apiVersion: 1, capabilities: ['projects.browse'] })
  })
  const api = createHarnessClient(targets, 'b'), bound = api.directoryTarget()
  assert.equal(bound.connection.instanceId, b)
  targets[1].revision = 99; targets[1].instanceId = a
  await bound.api('/instance')
  await bound.api('/projects/directories/browse', { action: 'open', path: '/same/path' })
  const project = await bound.register('/same/path', new AbortController().signal)
  assert.equal(project.id, scopedId(b, 'same')); assert.equal(project.harnessName, 'Server')
  assert.equal(await bound.nativeAvailable(new AbortController().signal), false)
  for (const call of calls.filter(call => call.url.startsWith('/api/connections/b/'))) {
    assert.equal(call.options.headers['X-Anybox-Expected-Instance-Id'], b)
    assert.equal(call.options.headers['X-Anybox-Connection-Revision'], '5')
  }
  const local = api.directoryTarget('a')
  assert.equal(await local.nativeAvailable(new AbortController().signal), true)
  assert.equal(await local.pickNative(new AbortController().signal), '/same/path')
  assert.equal(calls.at(-1).url, '/api/client/v1/connections/a/pick')
  assert.equal(calls.at(-1).options.headers['X-Anybox-Expected-Instance-Id'], a)
  assert.equal(calls.at(-1).options.headers['X-Anybox-Connection-Revision'], '4')
  assert.equal(Object.isFrozen(bound.connection), true)
  api.dispose()
})

test('a selected inactive or missing device never redirects new work to another active device', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ id: 'run', sessionId: 'session' })
  })
  for (const selectedId of ['b', 'removed-connection']) {
    const api = createHarnessClient([connections[0]], selectedId)
    try {
      assert.equal(api.directoryTarget(), undefined, 'new-project selection must stay unavailable')
      assert.equal(api.directoryTarget('a').connection.instanceId, a, 'an explicit healthy-device choice is still usable')
      const count = calls.length
      await assert.rejects(api('/projects', { path: '/workspace' }), { code: 'instance-unavailable' })
      assert.equal(calls.length, count, 'no registration may reach the other active device')
      const result = await api(`/sessions/${scopedId(a, 'session')}/runs`, { parentNodeId: null, input: 'Continue the healthy conversation' })
      assert.equal(result.id, scopedId(a, 'run'))
      assert.equal(calls.at(-1).url, '/api/connections/a/v1/sessions/session/runs')
      assert.equal(calls.at(-1).options.headers['X-Anybox-Expected-Instance-Id'], a)
    } finally { await api.dispose() }
  }
  const unselected = createHarnessClient([connections[0]])
  try { assert.equal(unselected.directoryTarget().connection.instanceId, a) }
  finally { await unselected.dispose() }
})

test('partial device lists preserve a pending project route while healthy projects remain usable', async t => {
  let finishB
  t.mock.method(globalThis, 'fetch', async url => url.includes('/a/')
    ? Response.json([{ id: 'same', available: true }])
    : new Promise(resolve => { finishB = resolve }))
  const api = createHarnessClient(connections), target = scopedId(b, 'same'), snapshots = [], routed = []
  const receive = (values, settled) => {
    snapshots.push(values)
    if (!waitForProjectSnapshot(target, values, settled)) routed.push(values.find(project => project.id === target)?.id ?? 'missing')
  }
  const unsubscribe = api.subscribeList('/projects', values => receive(values, false))
  const loading = api('/projects'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshots.at(-1).map(project => project.id), [scopedId(a, 'same')])
  assert.equal(waitForProjectSnapshot(scopedId(a, 'same'), snapshots.at(-1), false), false, 'healthy project can be opened without waiting for every device')
  assert.equal(waitForProjectSnapshot(null, snapshots.at(-1), false), false, 'a new workspace has no pending selection')
  assert.deepEqual(routed, [], 'the other device is still loading, not missing')
  finishB(Response.json([{ id: 'same', available: true }]))
  receive(await loading, true)
  assert.ok(routed.length > 0); assert.ok(routed.every(id => id === target))
  assert.equal(waitForProjectSnapshot(scopedId(b, 'absent'), snapshots.at(-1), false), true)
  assert.equal(waitForProjectSnapshot(scopedId(b, 'absent'), snapshots.at(-1), true), false, 'only a settled aggregate may resolve an absent target')
  unsubscribe(); api.dispose()
})

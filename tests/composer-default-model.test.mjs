import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingStore, createSessionController } from '../packages/app-harness/dist/web/session-client.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t, { scoped = false, session: initialSession = {}, defaults: initialDefaults = {} } = {}) {
  const identify = id => scoped ? `h:00000000-0000-0000-0000-000000000001:${id}` : id
  const calls = [], timers = new Map(), storage = new Map()
  const sessionId = identify('session'), agentId = identify('assistant'), first = identify('first'), second = identify('second')
  const sessionPath = `/sessions/${encodeURIComponent(sessionId)}`
  const defaultsPath = `/agents/${encodeURIComponent(agentId)}/session-defaults`
  let next = 0, interceptor
  let session = { id: sessionId, projectId: identify('project'), agentId, modelId: first,
    protocolId: null, historyMode: 'native-local-v1', archivedAt: null, ...initialSession }
  let saved = { agentId, modelId: first, fallbackModelId: null, revision: 7, ...initialDefaults }
  const defaults = () => ({ ...saved, effectiveModelId: saved.modelId ?? saved.fallbackModelId })
  const models = [first, second].map(id => ({ id, name: id, available: true,
    parameters: { protocolId: 'responses', formatVersion: 1, value: {} }, effectiveCapabilities: { tools: true } }))
  const pending = createPendingStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) })
  const controller = createSessionController({ sessionId, projectId: session.projectId }, {
    api: async (path, body, signal) => {
      calls.push({ path, body, signal })
      if (interceptor) {
        const result = interceptor(path, body, signal)
        if (result !== undefined) return result
      }
      if (path === sessionPath) return { ...session }
      if (path === `${sessionPath}/model`) { session = { ...session, modelId: body.modelId }; return { ...session } }
      if (path === `${sessionPath}/runs`) return []
      if (path.startsWith(`${sessionPath}/nodes?`)) return { nodes: [] }
      if (path.endsWith('/path')) return []
      if (path === defaultsPath) {
        if (body !== undefined) {
          assert.equal(body.expectedRevision, saved.revision)
          saved = { ...saved, modelId: body.modelId, revision: saved.revision + 1 }
        }
        return defaults()
      }
      throw new Error(`Unexpected request ${path}`)
    },
    pending, models: () => models, messageFor: error => error.message, newId: () => `id-${++next}`,
    hidden: () => false, schedule: callback => { const id = ++next; timers.set(id, callback); return id },
    clear: id => timers.delete(id), missing: () => assert.fail('unexpected missing Session'),
  })
  t.after(() => controller.dispose())
  return {
    controller, calls, models, first, second, agentId, sessionPath, defaultsPath,
    load: async () => { controller.attach(() => {}); await controller.refresh(); await settle() },
    defaultsCalls: () => calls.filter(call => call.path === defaultsPath),
    writes: () => calls.filter(call => call.body !== undefined),
    intercept: fn => { interceptor = fn },
    setSession: patch => { session = { ...session, ...patch }; return { ...session } },
    setDefaults: patch => { saved = { ...saved, ...patch }; return defaults() },
  }
}

test('a single Composer model selection only changes the current Session', async t => {
  const f = fixture(t); await f.load()
  await f.controller.setModel(f.second)
  assert.equal(f.controller.snapshot().session.modelId, f.second)
  assert.deepEqual(f.writes().map(({ path, body }) => ({ path, body })), [
    { path: `${f.sessionPath}/model`, body: { modelId: f.second } },
  ])
  assert.equal(f.defaultsCalls().length, 0)
})

test('double-clicking waits for the first click to confirm selection and ignores duplicate saves', async t => {
  const f = fixture(t), selected = deferred(); await f.load()
  f.intercept((path, body) => path === `${f.sessionPath}/model` ? selected.promise : undefined)
  const selecting = f.controller.setModel(f.second)
  const saving = f.controller.setDefaultModel(f.second)
  await f.controller.setDefaultModel(f.second)
  await settle()
  assert.equal(f.controller.snapshot().savingDefaultModel, true)
  assert.equal(f.defaultsCalls().length, 0, 'defaults are not changed before Session selection succeeds')
  selected.resolve(f.setSession({ modelId: f.second }))
  await selecting; await saving
  assert.deepEqual(f.defaultsCalls().map(({ body }) => body), [undefined, { modelId: f.second, expectedRevision: 7 }])
  assert.equal(f.controller.snapshot().defaultModelId, f.second)
  assert.equal(f.controller.snapshot().savingDefaultModel, false)
})

test('setting a default directly selects the model before saving the Agent preference', async t => {
  const f = fixture(t); await f.load()
  await f.controller.setDefaultModel(f.second)
  assert.deepEqual(f.writes().map(({ path, body }) => ({ path, body })), [
    { path: `${f.sessionPath}/model`, body: { modelId: f.second } },
    { path: f.defaultsPath, body: { modelId: f.second, expectedRevision: 7 } },
  ])
  assert.equal(f.controller.snapshot().session.modelId, f.second)
})

test('a failed first-click selection cannot become the new Session default', async t => {
  const f = fixture(t), selected = deferred(); await f.load()
  f.intercept(path => path === `${f.sessionPath}/model` ? selected.promise : undefined)
  const selecting = f.controller.setModel(f.second), saving = f.controller.setDefaultModel(f.second)
  selected.reject(new Error('selection failed'))
  await selecting; await saving
  assert.equal(f.controller.snapshot().session.modelId, f.first)
  assert.equal(f.defaultsCalls().length, 0)
  assert.equal(f.writes().length, 1)
  assert.equal(f.controller.snapshot().savingDefaultModel, false)
})

test('default writes retain the scoped execution device, Agent, model and fresh revision', async t => {
  const f = fixture(t, { scoped: true, defaults: { revision: 21 } }); await f.load()
  await f.controller.setDefaultModel(f.second)
  const calls = f.defaultsCalls()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, `/agents/${encodeURIComponent(f.agentId)}/session-defaults`)
  assert.deepEqual(calls[1].body, { modelId: f.second, expectedRevision: 21 })
  assert.equal(f.controller.snapshot().defaultModelId, f.second)
})

test('opening the picker reads the effective default without changing the current selection', async t => {
  const f = fixture(t, { defaults: { modelId: null, fallbackModelId: 'second' } }); await f.load()
  await f.controller.refreshDefaultModel()
  assert.equal(f.controller.snapshot().defaultModelId, f.second)
  assert.equal(f.controller.snapshot().session.modelId, f.first)
  assert.equal(f.writes().length, 0)
  f.setDefaults({ modelId: f.first, revision: 8 })
  await f.controller.refreshDefaultModel()
  assert.equal(f.controller.snapshot().defaultModelId, f.first, 'reopening observes a change made through another page')
})

test('an already effective default is confirmed without writing another revision', async t => {
  const f = fixture(t, { defaults: { modelId: null, fallbackModelId: 'first' } }); await f.load()
  await f.controller.setDefaultModel(f.first)
  assert.equal(f.defaultsCalls().length, 1)
  assert.equal(f.writes().length, 0)
  assert.equal(f.controller.snapshot().defaultModelId, f.first)
})

test('unavailable models and read-only Sessions cannot update defaults', async t => {
  for (const mode of ['unavailable', 'archived', 'legacy']) {
    await t.test(mode, async t => {
      const f = fixture(t, { session: mode === 'archived' ? { archivedAt: '2026-11-15' }
        : mode === 'legacy' ? { historyMode: 'dialogue-v1' } : {} })
      if (mode === 'unavailable') f.models[1].available = false
      await f.load(); await f.controller.setDefaultModel(f.second)
      assert.equal(f.writes().length, 0)
      assert.equal(f.defaultsCalls().length, 0)
      assert.equal(f.controller.snapshot().session.modelId, f.first)
    })
  }
})

test('a defaults read failure cannot issue a write or claim success', async t => {
  const f = fixture(t); await f.load()
  f.intercept(path => path === f.defaultsPath ? Promise.reject(new Error('defaults offline')) : undefined)
  await f.controller.setDefaultModel(f.first)
  assert.equal(f.defaultsCalls().length, 1)
  assert.equal(f.writes().length, 0)
  assert.match(f.controller.snapshot().notice, /defaults offline/)
  assert.equal(f.controller.snapshot().savingDefaultModel, false)
})

test('a concurrent defaults conflict is reported without replaying the write', async t => {
  const f = fixture(t, { session: { modelId: 'second' } }); await f.load()
  f.intercept((path, body) => path === f.defaultsPath && body !== undefined
    ? Promise.reject(Object.assign(new Error('conflict'), { code: 'session-defaults-conflict', status: 409 })) : undefined)
  await f.controller.setDefaultModel(f.second); await settle()
  assert.equal(f.defaultsCalls().filter(call => call.body !== undefined).length, 1)
  assert.notEqual(f.controller.snapshot().defaultModelId, f.second)
  assert.equal(f.controller.snapshot().session.modelId, f.second)
  assert.ok(f.controller.snapshot().notice)
  assert.equal(f.controller.snapshot().savingDefaultModel, false)
})

test('an unknown write result is only observed by a later explicit attempt', async t => {
  const f = fixture(t, { session: { modelId: 'second' } }); await f.load()
  f.intercept((path, body) => {
    if (path !== f.defaultsPath || body === undefined) return undefined
    f.setDefaults({ modelId: body.modelId, revision: 8 })
    return Promise.reject(new Error('connection lost'))
  })
  await f.controller.setDefaultModel(f.second); await settle()
  assert.equal(f.defaultsCalls().filter(call => call.body !== undefined).length, 1)
  assert.match(f.controller.snapshot().notice, /connection lost/)
  f.intercept(undefined)
  await f.controller.setDefaultModel(f.second)
  assert.equal(f.defaultsCalls().filter(call => call.body !== undefined).length, 1, 'the later attempt observes the committed default instead of replaying it')
  assert.equal(f.controller.snapshot().defaultModelId, f.second)
})

test('detaching during the defaults read prevents a later default write', async t => {
  const f = fixture(t), reading = deferred(); await f.load()
  f.intercept(path => path === f.defaultsPath ? reading.promise : undefined)
  const saving = f.controller.setDefaultModel(f.first); await settle()
  assert.equal(f.defaultsCalls().length, 1)
  f.controller.detach()
  reading.resolve({ agentId: f.agentId, modelId: f.second, fallbackModelId: null, effectiveModelId: f.second, revision: 7 })
  await saving
  assert.equal(f.writes().length, 0)
})

test('detaching does not cancel an already submitted default write', async t => {
  const f = fixture(t, { session: { modelId: 'second' } }), written = deferred(); await f.load()
  f.intercept((path, body) => path === f.defaultsPath && body !== undefined ? written.promise : undefined)
  const saving = f.controller.setDefaultModel(f.second); await settle()
  const write = f.defaultsCalls().find(call => call.body !== undefined)
  assert.ok(write)
  f.controller.detach()
  assert.notEqual(write.signal?.aborted, true)
  written.resolve(f.setDefaults({ modelId: f.second, revision: 8 }))
  await saving
  assert.equal(f.defaultsCalls().filter(call => call.body !== undefined).length, 1)
})

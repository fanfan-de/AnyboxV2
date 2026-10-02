import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingStore, createSessionController } from '../dist/applications/harness/web/session-client.js'

function fixture() {
  const storage = new Map(), writes = [], timers = new Map(), runs = [], views = new Map()
  const pending = createPendingStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) })
  let session = { id: 's', projectId: 'p', agentId: 'a', modelId: null, protocolId: null, historyMode: 'native-local-v1' }, fail = false, sequence = 0
  const models = ['a', 'b'].map(id => ({ id, parameters: { protocolId: 'responses', formatVersion: 1, value: {} }, available: true, effectiveCapabilities: { tools: true } }))
  const controller = createSessionController({ sessionId: 's', projectId: 'p' }, {
    api: async (path, body) => {
      if (body) writes.push({ path, body })
      if (path === '/sessions/s') return { ...session }
      if (path === '/sessions/s/model') { session = { ...session, modelId: body.modelId }; return { ...session } }
      if (path.endsWith('/path')) return []
      if (path.includes('/nodes?')) return { nodes: [] }
      if (path.includes('/events?')) return []
      if (path.endsWith('/view')) return views.get(path.split('/')[2])
      if (path.includes('/runs/by-key/')) throw Object.assign(new Error('not found'), { status: 404, code: 'not-found' })
      if (path === '/sessions/s/runs') {
        if (!body) return runs.map(value => ({ ...value }))
        if (fail) throw new Error('offline')
        const run = { id: 'r', sessionId: 's', input: body.input, status: 'running', revision: 1, createdAt: '1', history: { kind: 'tree', parentNodeId: null } }
        runs.push(run); return { ...run }
      }
      throw new Error(path)
    }, pending, models: () => models, messageFor: error => error.message, newId: () => `k${++sequence}`,
    hidden: () => false, schedule: callback => { const id = ++sequence; timers.set(id, callback); return id }, clear: id => timers.delete(id), missing: () => assert.fail('missing'),
  })
  return { controller, pending, writes, runs, models, views, load: async () => { controller.attach(() => {}); await controller.refresh() },
    setServerModel: value => { session = { ...session, modelId: value } }, setSession: value => { session = { ...session, ...value } }, setFail: value => { fail = value } }
}

test('model selection persists per session and pending retries keep the original selected model', async () => {
  const f = fixture(); await f.load()
  f.controller.setDraft('hello'); await f.controller.submit()
  assert.equal(f.writes.length, 0)
  assert.match(f.controller.snapshot().notice, /模型/)
  await f.controller.setModel('a'); await f.controller.refresh()
  assert.equal(f.controller.snapshot().session.modelId, 'a')
  f.setFail(true); await f.controller.submit()
  assert.equal(f.pending.get('s').modelId, 'a')
  await f.controller.setModel('b')
  assert.equal(f.writes.filter(value => value.path.endsWith('/model')).length, 1)
  f.controller.detach(); f.setServerModel('b'); f.setFail(false); await f.load()
  const retry = f.writes.filter(value => value.path.endsWith('/runs')).at(-1)
  assert.equal(retry.body.modelId, 'a')
  assert.equal(f.pending.get('s'), undefined)
  f.controller.detach()
})

test('unaccepted older pending submissions require an explicit model selection before resending', async () => {
  const f = fixture()
  f.pending.set('s', { sessionId: 's', input: 'legacy draft', idempotencyKey: 'old', parentNodeId: null })
  await f.load()
  assert.equal(f.writes.length, 0)
  assert.equal(f.pending.get('s'), undefined)
  assert.equal(f.controller.snapshot().draft, 'legacy draft')
  f.controller.detach()
})

test('provisional model text is bounded, never persisted, and cleared by terminal reconciliation', async () => {
  const f = fixture(); await f.load(); await f.controller.setModel('a'); await f.controller.refresh()
  f.controller.setDraft('hello'); await f.controller.submit(); await f.controller.refresh()
  f.controller.protocolView({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses', sessionId: 's', runId: 'r', viewRevision: 1, status: 'provisional', exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: 'x'.repeat(65_536) }] }] })
  assert.equal(f.controller.snapshot().views.get('r').exchanges[0].blocks[0].text.length, 65_536)
  assert.equal(f.pending.get('s'), undefined)
  f.runs[0].status = 'failed'; f.runs[0].revision++
  await f.controller.refresh()
  assert.equal(f.controller.snapshot().views.size, 0)
  assert.match(f.controller.snapshot().notice, /运行失败/)
  f.controller.protocolView({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses', sessionId: 's', runId: 'r', viewRevision: 2, status: 'provisional', exchanges: [] })
  assert.equal(f.controller.snapshot().views.size, 0)
  f.controller.detach()
})


test('a model without effective tools can be selected and submitted for a text-only Run', async () => {
  const f = fixture(); f.models[0].effectiveCapabilities.tools = false
  await f.load(); await f.controller.setModel('a'); await f.controller.refresh()
  f.controller.setDraft('text only'); await f.controller.submit()
  assert.equal(f.writes.find(value => value.path.endsWith('/runs')).body.modelId, 'a')
  assert.equal(f.controller.snapshot().runs.length, 1)
  f.controller.detach()
})


test('legacy Sessions are read only and unaccepted legacy pending inputs never become native runs', async () => {
  const f = fixture()
  f.setSession({ historyMode: 'dialogue-v1', modelId: 'a' })
  f.pending.set('s', { sessionId: 's', input: 'Saved old input', parentNodeId: null, modelId: 'a', idempotencyKey: 'old' })
  await f.load()
  assert.equal(f.controller.snapshot().draft, 'Saved old input')
  await f.controller.setModel('b')
  await f.controller.submit()
  await f.controller.regenerate({ id: 'n', sessionId: 's', parentId: null, input: 'again' })
  assert.equal(f.writes.length, 0)
  assert.match(f.controller.snapshot().notice, /仅供查看/)
  f.controller.detach()
})

test('bound native Session rejects another protocol while retaining its draft', async () => {
  const f = fixture()
  f.setSession({ protocolId: 'responses', modelId: 'a' })
  f.models[1].parameters = { protocolId: 'anthropic-messages', formatVersion: 1, value: { max_tokens: 4096 } }
  await f.load()
  f.controller.setDraft('retain this')
  await f.controller.setModel('b')
  assert.equal(f.writes.length, 0)
  assert.equal(f.controller.snapshot().session.modelId, 'a')
  assert.equal(f.controller.snapshot().draft, 'retain this')
  assert.match(f.controller.snapshot().notice, /固定协议/)
  f.controller.detach()
})

test('reconnect queries a complete active projection and terminal facts reject late frames', async () => {
  const f = fixture()
  await f.load(); await f.controller.setModel('a'); await f.controller.refresh()
  f.controller.setDraft('hello'); await f.controller.submit(); await f.controller.refresh()
  f.runs[0].protocolBinding = { protocolId: 'responses', viewSchemaVersion: 1 }
  const initial = { envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses', sessionId: 's', runId: 'r', viewRevision: 1, status: 'provisional', exchanges: [{ id: 'first', blocks: [{ id: 'text', kind: 'text', text: 'Beginning' }] }] }
  f.controller.protocolView(initial)
  f.controller.setLive(false)
  const recovered = { ...initial, viewRevision: 8, exchanges: [...initial.exchanges, { id: 'second', blocks: [{ id: 'text', kind: 'text', text: 'Recovered later exchange' }] }] }
  f.views.set('r', recovered)
  f.controller.setLive(true); await f.controller.refresh()
  assert.deepEqual(f.controller.snapshot().views.get('r'), recovered)
  f.controller.protocolView(initial)
  assert.equal(f.controller.snapshot().views.get('r').viewRevision, 8)
  f.runs[0].status = 'completed'; f.runs[0].revision++
  const committed = { ...recovered, status: 'committed', viewRevision: 2 }
  f.views.set('r', committed); await f.controller.refresh()
  assert.deepEqual(f.controller.snapshot().views.get('r'), committed)
  f.controller.protocolView({ ...recovered, viewRevision: 99 })
  assert.equal(f.controller.snapshot().views.get('r').status, 'committed')
  f.controller.detach()
})

test('unknown Web protocols cannot be selected, submitted, regenerated or decoded', async () => {
  const f = fixture()
  f.models[0].parameters.protocolId = 'new-provider-protocol'
  await f.load(); await f.controller.setModel('a')
  assert.equal(f.writes.length, 0)
  assert.match(f.controller.snapshot().notice, /输入组件尚不可用/)
  f.setSession({ modelId: 'a', protocolId: 'new-provider-protocol' }); await f.controller.refresh()
  f.controller.setDraft('Keep {{input}} literally')
  await f.controller.submit()
  await f.controller.regenerate({ id: 'n', sessionId: 's', parentId: null, input: 'retry' })
  assert.equal(f.controller.snapshot().draft, 'Keep {{input}} literally')
  assert.equal(f.pending.get('s'), undefined)
  assert.equal(f.writes.length, 0)
  f.controller.protocolView({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'new-provider-protocol', sessionId: 's', runId: 'r', viewRevision: 1, status: 'provisional', exchanges: [] })
  assert.equal(f.controller.snapshot().views.size, 0)
  assert.match(f.controller.snapshot().notice, /展示组件尚不可用/)
  f.controller.detach()
})

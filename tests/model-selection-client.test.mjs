import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingStore, createSessionController } from '../dist/web/session-client.js'

function fixture() {
  const storage = new Map(), writes = [], timers = new Map(), runs = []
  const pending = createPendingStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) })
  let session = { id: 's', projectId: 'p', agentId: 'a', modelId: null }, fail = false, sequence = 0
  const models = ['a', 'b'].map(id => ({ id, available: true, effectiveCapabilities: { tools: true } }))
  const controller = createSessionController({ sessionId: 's', projectId: 'p' }, {
    api: async (path, body) => {
      if (body) writes.push({ path, body })
      if (path === '/sessions/s') return { ...session }
      if (path === '/sessions/s/model') { session = { ...session, modelId: body.modelId }; return { ...session } }
      if (path.endsWith('/path')) return []
      if (path.includes('/nodes?')) return { nodes: [] }
      if (path.includes('/events?')) return []
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
  return { controller, pending, writes, runs, models, load: async () => { controller.attach(() => {}); await controller.refresh() },
    setServerModel: value => { session = { ...session, modelId: value } }, setFail: value => { fail = value } }
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
  f.controller.modelProgress('r', { type: 'text-delta', delta: 'x'.repeat(80_000) })
  assert.equal(f.controller.snapshot().progress.get('r').length, 65_536)
  assert.equal(f.pending.get('s'), undefined)
  f.runs[0].status = 'failed'; f.runs[0].revision++
  await f.controller.refresh()
  assert.equal(f.controller.snapshot().progress.size, 0)
  assert.match(f.controller.snapshot().notice, /运行失败/)
  f.controller.modelProgress('r', { type: 'text-delta', delta: 'late' })
  assert.equal(f.controller.snapshot().progress.size, 0)
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

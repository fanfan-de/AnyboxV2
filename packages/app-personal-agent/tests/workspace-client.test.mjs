import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDraftStore, continuousDraftKey } from '../dist/web/draft-client.js'
import { createPendingStore, createSessionController } from '../dist/web/session-client.js'

test('a pending send from an old directory is observed before moving to an Agent workspace', async t => {
  for (const accepted of [false, true]) await t.test(accepted ? 'accepted' : 'unaccepted', async () => {
    const values = new Map(), calls = []
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
    const pending = createPendingStore(storage), drafts = createDraftStore(storage)
    pending.set('session', {
      sessionId: 'session', projectId: 'old-directory', schemaVersion: 3, parentNodeId: null,
      modelId: 'model', idempotencyKey: 'pending', input: 'Previous message', preparationKey: 'prepare',
      fileSelections: [{ kind: 'project-file', path: 'notes.txt' }],
    })
    const workspace = 'agent-directory'
    drafts.set('session', continuousDraftKey(workspace), { text: 'Current draft', files: [], images: [] })
    const controller = createSessionController({ sessionId: 'session', projectId: workspace }, {
      continuous: true, pending, drafts, messageFor: error => error.message, newId: () => 'unused',
      hidden: () => false, schedule: () => undefined, clear: () => {}, missing: () => assert.fail('unexpected missing session'),
      async api(url, body) {
        calls.push({ url, body })
        if (url === '/sessions/session') return { id: 'session', continuous: true, headNodeId: null }
        if (url === '/sessions/session/runs' || url === '/sessions/session/nodes/root/path') return []
        if (url === '/sessions/session/runs/by-key/pending') {
          if (accepted) return { sessionId: 'session', id: 'run', status: 'completed', revision: 1, createdAt: '0', history: { kind: 'tree', parentNodeId: null } }
          throw Object.assign(new Error('not found'), { status: 404, code: 'not-found' })
        }
        throw new Error(`unexpected request ${url}`)
      },
    })
    try {
      controller.attach(() => {})
      await controller.refresh()
      assert.equal(calls.filter(({ url }) => url.endsWith('/runs/by-key/pending')).length, 1)
      assert.ok(calls.every(({ body }) => body === undefined), 'the previous send must not be replayed')
      assert.equal(createPendingStore(storage).get('session'), undefined)
      const restored = createDraftStore(storage).get('session', continuousDraftKey(workspace))
      assert.equal(restored.text, accepted ? 'Current draft' : 'Previous message\n\nCurrent draft')
      assert.equal(controller.snapshot().runs.some(run => run.id === 'run'), accepted)
      if (!accepted) {
        assert.equal(restored.files[0].selection, undefined)
        assert.match(restored.files[0].error, /notes\.txt.*重新引用/)
      }
    } finally { controller.dispose() }
  })
})

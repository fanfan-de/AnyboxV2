import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDraftStore, continuousDraftKey } from '../dist/web/draft-client.js'
import { mapResourceIds, scopedId } from '../dist/web/harness-client.js'
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
        if (url === '/sessions/session/history') return { headNodeId: null, nodes: [], subchains: [], runs: [] }
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

test('continuous history keeps loaded older pages and submits from the current head across subchains', async () => {
  const sessionId = 'session', projectId = 'agent-directory'
  const calls = []
  const sessionPath = '/sessions/' + sessionId
  const node = sequence => ({
    sessionId, id: String(sequence), parentId: sequence > 1 ? String(sequence - 1) : null,
    input: 'Message ' + sequence, output: 'Answer ' + sequence, images: [], files: [],
    sourceRunId: 'run-' + sequence, subchainId: sequence > 6 ? 'later' : 'original',
  })
  const run = value => ({
    sessionId, projectId, id: value.sourceRunId, input: value.input, output: value.output, status: 'completed',
    createdAt: value.id.padStart(2, '0'), revision: 1, resultNodeId: value.id, history: { kind: 'tree', parentNodeId: value.parentId },
  })
  const page = (headNodeId, sequence, nextCursor) => {
    const nodes = sequence.map(node)
    return { headNodeId, nodes, subchains: [], runs: nodes.map(run), nextCursor }
  }
  const newestDownload = new Map([
    [sessionPath + '/history?before=cursor%2F4%2B', page('5', [2, 3], 'cursor2')],
    [sessionPath + '/history?before=cursor9', page('10', [7, 8], 'cursor7')],
  ])
  let newest = page('5', [4, 5], 'cursor/4+')
  const controller = createSessionController({ sessionId, projectId, continuous: true }, {
    continuous: true,
    pending: createPendingStore({ getItem: () => null, setItem() {} }),
    messageFor: error => error.message, newId: () => 'current-send',
    hidden: () => false, schedule: () => undefined, clear: () => {}, missing: () => assert.fail('unexpected missing session'),
    async api(url, body) {
      calls.push({ url, body })
      if (url === sessionPath) return { id: sessionId, projectId, continuous: true, headNodeId: 'stale', modelId: 'model', protocolId: 'chat-completions', archivedAt: null }
      if (url === sessionPath + '/history') return newest
      if (newestDownload.has(url)) return newestDownload.get(url)
      if (url === sessionPath + '/runs' && body) return {
        sessionId, projectId, id: 'new-run', status: 'running', createdAt: '11', input: body.input, revision: 0,
        history: { kind: 'tree', parentNodeId: body.parentNodeId },
      }
      if (url.startsWith('/runs/') && url.includes('/events?')) return []
      throw new Error('unexpected request ' + url)
    },
  })
  const displayed = () => controller.snapshot().path.map(value => value.id)
  const cursors = () => controller.snapshot().olderHistory.map(value => value.cursor)
  try {
    controller.attach(() => {})
    await controller.refresh()
    assert.deepEqual(displayed(), ['4', '5'])
    assert.equal(controller.snapshot().position.viewNodeId, '5')
    await Promise.all([controller.moreHistory('cursor/4+'), controller.moreHistory('cursor/4+')])
    assert.equal(calls.filter(({ url }) => url.includes('before=cursor%2F4%2B')).length, 1)
    assert.deepEqual(displayed(), ['2', '3', '4', '5'])
    assert.deepEqual(cursors(), ['cursor2'])

    newest = page('6', [5, 6], 'cursor5')
    await controller.refresh()
    assert.deepEqual(displayed(), ['2', '3', '4', '5', '6'])
    assert.deepEqual(cursors(), ['cursor2'])

    newest = page('10', [9, 10], 'cursor9')
    await controller.refresh()
    assert.deepEqual(displayed(), ['2', '3', '4', '5', '6', '9', '10'])
    assert.deepEqual(cursors(), ['cursor9', 'cursor2'])
    await controller.moreHistory('cursor9')
    assert.deepEqual(displayed(), ['2', '3', '4', '5', '6', '7', '8', '9', '10'])
    assert.deepEqual(cursors(), ['cursor2'])
    assert.deepEqual(controller.snapshot().runs.map(value => value.resultNodeId), displayed())
    assert.equal(controller.snapshot().position.viewNodeId, '10')

    await controller.navigate('2')
    controller.setDraft('Continue after browsing earlier history.')
    await controller.submit()
    const submission = calls.find(({ url, body }) => url === sessionPath + '/runs' && body)
    assert.equal(submission?.body.parentNodeId, '10')
    assert.equal(submission?.body.projectId, projectId)
    assert.ok(calls.every(({ url, body }) => body || (url !== sessionPath + '/runs' && !url.includes('/nodes/'))))
  } finally { controller.dispose() }
})

test('continuous history scopes node and subchain references while keeping the page cursor opaque', () => {
  const instanceId = '12345678-abcd-4321-acde-123456789abc'
  const scoped = id => scopedId(instanceId, id)
  assert.deepEqual(mapResourceIds({
    headNodeId: 'node-b',
    nodes: [{ id: 'node-b', sessionId: 'session', parentId: 'node-a', subchainId: 'chain-b', sourceRunId: 'run' }],
    runs: [{ id: 'run', resultNodeId: 'node-b', history: { kind: 'tree', parentNodeId: 'node-a' } }],
    subchains: [{ id: 'chain-b', parentId: 'chain-a', anchorNodeId: 'node-a' }],
    nextCursor: 'node-b',
  }, scoped), {
    headNodeId: scoped('node-b'),
    nodes: [{ id: scoped('node-b'), sessionId: scoped('session'), parentId: scoped('node-a'), subchainId: scoped('chain-b'), sourceRunId: scoped('run') }],
    runs: [{ id: scoped('run'), resultNodeId: scoped('node-b'), history: { kind: 'tree', parentNodeId: scoped('node-a') } }],
    subchains: [{ id: scoped('chain-b'), parentId: scoped('chain-a'), anchorNodeId: scoped('node-a') }],
    nextCursor: 'node-b',
  })
})

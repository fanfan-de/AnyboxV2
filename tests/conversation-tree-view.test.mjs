import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationNodeLabel, conversationTree } from '../dist/applications/harness/web/conversation-tree.js'

const session = { id: 'session', historyMode: 'native-local-v1' }
const run = (id, parentNodeId = null, extra = {}) => ({
  id, sessionId: session.id, input: `Input ${id}`, output: `Output ${id}`, status: 'completed',
  resultNodeId: `node-${id}`, history: { kind: 'tree', parentNodeId }, createdAt: '2026-10-04T00:00:00.000Z', ...extra,
})
const node = (id, parentId = null, extra = {}) => ({
  id, sessionId: session.id, parentId, input: `Input ${id}`, output: `Output ${id}`, sourceRunId: null, ...extra,
})
const snapshot = (runs = [], extra = {}) => ({ session, runs, path: [], children: [], ...extra })
const ids = values => values?.map(value => value.id) ?? []

test('native Runs expose all branches and multiple roots using explicit parent relationships', () => {
  const tree = conversationTree(snapshot([
    run('later', null, { createdAt: '2026-10-04T00:01:00.000Z' }),
    run('root'), run('b', 'node-root'), run('a', 'node-root'), run('grandchild', 'node-a'),
  ]))
  assert.deepEqual(ids(tree.children.get(null)), ['node-root', 'node-later'])
  assert.deepEqual(ids(tree.children.get('node-root')), ['node-a', 'node-b'])
  assert.deepEqual(ids(tree.children.get('node-a')), ['node-grandchild'])
  assert.equal(tree.nodes.get('node-a').sourceRunId, 'a')
})

test('queried path and children override Run projections and mark the selected path', () => {
  const root = node('node-root', null, { input: 'Saved root', sourceRunId: 'root' })
  const child = node('node-child', root.id, { input: 'Saved child', sourceRunId: 'child', images: [{ assetId: 'image' }] })
  const tree = conversationTree(snapshot([run('root'), run('child', null)], { path: [root], children: [child] }))
  assert.equal(tree.nodes.get(root.id), root)
  assert.equal(tree.nodes.get(child.id), child)
  assert.deepEqual(ids(tree.children.get(null)), [root.id])
  assert.deepEqual(ids(tree.children.get(root.id)), [child.id])
  assert.deepEqual([...tree.pathIds], [root.id])
})

test('failed and active Runs stay separate from successful nodes and foreign sessions are ignored', () => {
  const tree = conversationTree(snapshot([
    run('root'), ...['failed', 'cancelled', 'interrupted'].map(status => run(status, 'node-root', { status })),
    run('running', 'node-root', { status: 'running' }), run('cancelling', 'node-root', { status: 'cancelling' }),
    run('active-root', null, { status: 'running' }), run('no-node', 'node-root', { resultNodeId: undefined }),
    run('unknown', null, { history: { kind: 'legacy-unknown' } }),
    run('unknown-active', null, { status: 'running', history: { kind: 'legacy-unknown' } }),
    run('foreign', null, { sessionId: 'other' }), run('foreign-active', null, { sessionId: 'other', status: 'running' }),
  ], { children: [node('foreign-node', null, { sessionId: 'other' })] }))
  assert.deepEqual([...tree.nodes.keys()], ['node-root'])
  assert.deepEqual(ids(tree.activeRuns.get('node-root')), ['cancelling', 'running'])
  assert.deepEqual(ids(tree.activeRuns.get(null)), ['active-root'])
})

test('edits and regenerated results with the same input remain distinct versions', () => {
  const tree = conversationTree(snapshot([
    run('root'), run('version-2', 'node-root', { input: 'Same input', output: 'Second output' }),
    run('version-1', 'node-root', { input: 'Same input', output: 'First output' }),
  ]))
  assert.deepEqual(ids(tree.children.get('node-root')), ['node-version-1', 'node-version-2'])
  assert.equal(tree.nodes.get('node-version-1').output, 'First output')
  assert.equal(tree.nodes.get('node-version-2').output, 'Second output')
})

test('missing parents and cycles remain unattached and traversal reaches only valid roots', () => {
  const tree = conversationTree(snapshot([
    run('root'), run('orphan', 'missing'), run('orphan-child', 'node-orphan'),
    run('cycle-a', 'node-cycle-b'), run('cycle-b', 'node-cycle-a'), run('cycle-child', 'node-cycle-b'),
    run('self', 'node-self'), run('valid-child', 'node-root'),
  ]))
  assert.deepEqual(ids(tree.children.get(null)), ['node-root'])
  assert.deepEqual(ids(tree.children.get('node-root')), ['node-valid-child'])
  for (const parent of ['missing', 'node-orphan', 'node-cycle-a', 'node-cycle-b', 'node-self']) {
    assert.equal(tree.children.has(parent), false)
  }
  assert.equal(tree.nodes.has('node-orphan'), true)
  assert.equal(tree.nodes.has('node-cycle-a'), true)
})

test('legacy sessions do not infer nodes from Runs and show only queried node facts', () => {
  const root = node('saved-root'), child = node('saved-child', root.id)
  const tree = conversationTree(snapshot([run('unqueried')], {
    session: { ...session, historyMode: 'dialogue-v1' }, path: [root], children: [child],
  }))
  assert.deepEqual([...tree.nodes.keys()], [root.id, child.id])
  assert.deepEqual(ids(tree.children.get(null)), [root.id])
  assert.deepEqual(ids(tree.children.get(root.id)), [child.id])
  assert.equal(tree.nodes.has('node-unqueried'), false)
})

test('labels normalize whitespace and explain attachment-only inputs', () => {
  assert.equal(conversationNodeLabel(node('text', null, { input: '\n A\t  sentence \r\n here ' })), 'A sentence here')
  assert.equal(conversationNodeLabel(node('empty', null, { input: ' \n\t ' })), '无文本输入')
  assert.equal(conversationNodeLabel(node('file', null, { input: '', files: [{}] })), '1 个文件')
  assert.equal(conversationNodeLabel(node('image', null, { input: '', images: [{}, {}] })), '2 张图片')
  assert.equal(conversationNodeLabel(node('both', null, { input: '', files: [{}, {}], images: [{}] })), '2 个文件 · 1 张图片')
})

test('a snapshot without its Session does not display leftover nodes or Runs', () => {
  const tree = conversationTree(snapshot([run('root')], { session: undefined, path: [node('old')] }))
  assert.equal(tree.nodes.size, 0)
  assert.equal(tree.children.size, 0)
  assert.equal(tree.activeRuns.size, 0)
  assert.equal(tree.pathIds.size, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closePane, emptyWorkspace, fitRatios, fits, minimumSize, openSession, panes, parseRoute,
  ratioBounds, resizeSplit, restoreWorkspace, sessionHash, splitSession } from '../dist/web/workspace-layout.js'

const ref = (sessionId, projectId = 'project') => ({ sessionId, projectId })
const one = () => openSession(emptyWorkspace, ref('a'))

test('split in every direction; moving a cross-project pane never duplicates it', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const state = splitSession(one(), ref('b', 'second-project'), 'a', edge, 'split')
    assert.equal(state.root.axis, ['left', 'right'].includes(edge) ? 'horizontal' : 'vertical')
    assert.equal(state.root.first.id, ['left', 'top'].includes(edge) ? 'b' : 'a')
    const moved = splitSession(state, ref('b', 'second-project'), 'a', 'bottom', 'moved')
    assert.deepEqual(panes(moved.root).map(item => item.sessionId), ['a', 'b'])
    assert.equal(moved.root.axis, 'vertical')
    assert.equal(moved.root.second.projectId, 'second-project')
    assert.equal(splitSession(moved, ref('b'), 'b', 'left', 'bad'), moved)
  }
})

test('four panes may move/replace/focus at the limit, and closing collapses nested splits', () => {
  let state = one()
  for (const [id, target] of [['b', 'a'], ['c', 'b'], ['d', 'a']]) state = splitSession(state, ref(id), target, 'bottom', `split-${id}`)
  assert.equal(panes(state.root).length, 4)
  assert.equal(splitSession(state, ref('e'), 'a', 'right', 'fifth'), state)
  const focused = openSession(state, ref('b'))
  assert.equal(focused.root, state.root)
  assert.equal(focused.activePaneId, 'b')
  state = openSession(focused, ref('e'))
  assert.deepEqual(new Set(panes(state.root).map(item => item.id)), new Set(['a', 'c', 'd', 'e']))
  state = splitSession(state, ref('a'), 'c', 'right', 'move-a')
  assert.equal(panes(state.root).length, 4)
  for (const item of [...panes(state.root)]) state = closePane(state, item.id)
  assert.equal(state.root, null)
  assert.equal(state.activePaneId, null)
})

test('recursive minimum sizes, ratio clamping and compact fallback preserve a valid tree', () => {
  let state = splitSession(one(), ref('b'), 'a', 'right', 'columns')
  state = splitSession(state, ref('c'), 'b', 'bottom', 'rows')
  assert.deepEqual(minimumSize(state.root), { width: 648, height: 528 })
  assert.equal(fits(state.root, { width: 647, height: 900 }), false)
  const size = { width: 1000, height: 700 }
  const [low, high] = ratioBounds(state.root, size)
  assert.equal(resizeSplit(state.root, 'columns', 0, size).ratio, low)
  assert.equal(resizeSplit(state.root, 'columns', 1, size).ratio, high)
  const clamped = fitRatios({ ...state.root, ratio: 0.95 }, { width: 648, height: 528 })
  assert.equal(clamped.ratio, 0.5)
  assert.equal(clamped.second.ratio, 0.5)
  assert.equal(state.root.ratio, 0.5)
})

test('layout recovery drops broken and duplicate leaves and normalizes selection and ratio', () => {
  const state = splitSession(one(), ref('b'), 'a', 'right', 'columns')
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(state))), state)
  assert.deepEqual(restoreWorkspace({ version: 99 }), emptyWorkspace)
  const broken = { ...state, activePaneId: 'missing', root: { ...state.root, ratio: NaN,
    second: { ...state.root.second, projectId: null } } }
  assert.deepEqual(panes(restoreWorkspace(broken).root).map(item => item.id), ['a'])
  assert.equal(restoreWorkspace(broken).activePaneId, 'a')
  const duplicate = { ...state, root: { ...state.root, second: { ...state.root.second, sessionId: 'a' } } }
  assert.equal(panes(restoreWorkspace(duplicate).root).length, 1)
})

test('existing project/session links round-trip escaped IDs and reject malformed hashes', () => {
  const target = ref('session/中文', 'project one')
  assert.deepEqual(parseRoute(sessionHash(target)), target)
  assert.deepEqual(parseRoute('#/projects/project'), { projectId: 'project' })
  assert.equal(parseRoute('#/projects/%xx'), undefined)
  assert.equal(parseRoute('#/projects/p/sessions/s/extra'), undefined)
})

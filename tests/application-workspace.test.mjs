import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readApplicationWorkspace, applicationHash, parseApplicationHash, closeApplicationView } from '../dist/host/web/application-workspace.js'
import { verifyDefaultWebAssets } from '../scripts/verify-web-assets.mjs'

test('workspace restores existing positions and app-local routes, skips malformed records and deduplicates applications', () => {
  const value = readApplicationWorkspace(JSON.stringify({ tabs: [{ id: 'notes', route: 'draft/1' }, { id: 'agent', route: 'workspace/host/a' }, { id: 'notes', route: 'bad' }, { id: '../escape', route: '' }], activeId: 'agent' }))
  assert.deepEqual(value, { tabs: [{ id: 'notes', route: 'draft/1' }, { id: 'agent', route: 'workspace/host/a' }], activeId: 'agent' })
  assert.deepEqual(readApplicationWorkspace('{broken'), { tabs: [], activeId: null })
  assert.equal(readApplicationWorkspace('{"tabs":[],"activeId":"missing"}').activeId, null)
  assert.deepEqual(parseApplicationHash(applicationHash('agent', 'workspace/project%2Fkey')), { id: 'agent', route: 'workspace/project%2Fkey' })
  assert.equal(parseApplicationHash('#/apps/a%2Fb/data'), undefined)
  assert.equal(parseApplicationHash('#/apps'), undefined)
})
test('closing an active application view chooses the next then previous; closing a background view leaves the active app unchanged', () => {
  const state = { tabs: ['a', 'b', 'c'].map(id => ({ id, route: '' })), activeId: 'b' }
  assert.equal(closeApplicationView(state, 'b').activeId, 'c')
  assert.equal(closeApplicationView({ ...state, activeId: 'c' }, 'c').activeId, 'b')
  assert.equal(closeApplicationView(state, 'a').activeId, 'b')
  assert.equal(closeApplicationView({ tabs: [state.tabs[0]], activeId: 'a' }, 'a').activeId, null)
})
test('every registered production browser entry and its emitted dependency exists in the exact asset map', async () => {
  await verifyDefaultWebAssets('.')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProductActivity } from '../packages/host/dist/applications/activity.js'
import { createDesktopApplicationLifecycle } from '../packages/host/dist/desktop/worker-runtime.js'

test('desktop status includes every application guard and a status probe releases protection without cancellation', async () => {
  const activity = createProductActivity(), paused = new Set()
  let busy = 'claude-agent', cancelled = false
  for (const id of ['agent', 'claude-agent', 'notes']) activity.registerGuard(id, () => {
    if (busy === id) return undefined
    paused.add(id); return () => paused.delete(id)
  })
  const desktop = createDesktopApplicationLifecycle(() => activity, () => ['agent', 'claude-agent', 'notes'])
  assert.deepEqual(desktop.inspect(), { busy: true }); assert.deepEqual([...paused], [])
  assert.deepEqual(await desktop.inspectForQuit(), { busy: true }); assert.deepEqual([...paused], [])
  busy = 'notes'; assert.deepEqual(desktop.inspect(), { busy: true }); assert.deepEqual([...paused], [])
  busy = undefined
  const observer = activity.enter('notes', { blocking: false, cancel() { cancelled = true } })
  assert.deepEqual(desktop.inspect(), { busy: false }); assert.deepEqual([...paused], []); assert.equal(cancelled, false)
  const accepted = activity.enter('claude-agent'); accepted.release()
  assert.deepEqual(await desktop.inspectForQuit(), { busy: false })
  assert.deepEqual([...paused], ['agent', 'claude-agent', 'notes']); assert.equal(cancelled, false)
  for (const id of paused) assert.throws(() => activity.enter(id), { code: 'product-unavailable' })
  assert.deepEqual(desktop.inspect(), { busy: false })
  assert.deepEqual(await desktop.inspectForQuit(), { busy: false })
  desktop.releaseQuit(); desktop.releaseQuit(); assert.deepEqual([...paused], [])
  const resumed = activity.enter('notes'); resumed.release(); observer.release()
})

test('desktop lifecycle observes current activity and application IDs rather than retaining restarted services', () => {
  let activity = createProductActivity(), ids = ['notes']
  const desktop = createDesktopApplicationLifecycle(() => activity, () => ids)
  const outside = activity.enter('other')
  assert.deepEqual(desktop.inspect(), { busy: false })
  ids = ['notes', 'other']; assert.deepEqual(desktop.inspect(), { busy: true }); outside.release()
  activity = createProductActivity()
  const current = activity.enter('notes'); assert.deepEqual(desktop.inspect(), { busy: true }); current.release()
  assert.deepEqual(desktop.inspect(), { busy: false })
})

test('desktop inspection preserves cleanup failures instead of reporting busy or permitting quit', async () => {
  const activity = createProductActivity()
  activity.registerGuard('notes', () => () => { throw new Error('guard release failed') })
  const desktop = createDesktopApplicationLifecycle(() => activity, () => ['notes'])
  assert.throws(() => desktop.inspect(), { phase: 'cleanup' })
  assert.deepEqual(await desktop.inspectForQuit(), { busy: false })
  assert.throws(() => desktop.releaseQuit(), { phase: 'cleanup' })
  activity.stop()
  await assert.rejects(desktop.inspectForQuit(), { code: 'service-unavailable' })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createImageUploads, createImageLeaseKeeper, imageURL } from '../dist/client/image-client.js'
import { createDraftStore, draftFromInput, draftsKey } from '../dist/client/draft-client.js'
import { createPendingStore } from '../dist/client/session-client.js'
import { imageLimits } from '../dist/harness/image/limits.js'
import { deferred } from './helpers/controlled-models.mjs'

const ref = id => ({ assetId: id, sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 4, width: 2, height: 2, expiresAt: '2030-01-01T00:00:00.000Z' })
const turn = () => new Promise(resolve => setImmediate(resolve))
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } }

test('image queue preserves selection order, bounds concurrency and waits for cancelled slots to exit', async () => {
  const drafts = createDraftStore(), calls = [], errors = []
  let next = 0
  const queue = createImageUploads({ sessionId: 's', drafts, newId: () => `slot-${++next}`, changed() {}, error: error => errors.push(error),
    upload(file, signal) { const task = deferred(); calls.push({ file, signal, ...task }); return task.promise } })
  const files = ['one', 'two', 'three', 'four'].map(name => new File(['data'], name, { type: 'image/png' }))
  queue.add(null, files)
  assert.equal(calls.length, 2)
  calls[1].resolve(ref('two')); await turn()
  assert.equal(calls.length, 3)
  queue.remove(null, 'slot-1')
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls.length, 3, 'cancel does not release concurrency before the upload exits')
  calls[0].reject(new Error('aborted')); await turn()
  assert.equal(calls.length, 4)
  calls[3].resolve(ref('four')); calls[2].resolve(ref('three')); await turn()
  assert.deepEqual(drafts.get('s', null).images.map(item => item.image.assetId), ['two', 'three', 'four'])
  assert.deepEqual(errors, [])
  queue.dispose()
})

test('image upload rejects count, byte limits and unsupported types without changing a draft', () => {
  const drafts = createDraftStore(), errors = []
  const queue = createImageUploads({ sessionId: 's', drafts, newId: () => 'slot', changed() {}, error: error => errors.push(error), upload() { assert.fail('must not upload') } })
  queue.add(null, Array.from({ length: 9 }, () => new File(['x'], 'x.png', { type: 'image/png' })))
  queue.add(null, [new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })])
  queue.add(null, [{ name: 'huge.png', type: 'image/png', size: imageLimits.maxBytes + 1 }])
  assert.equal(errors.length, 3)
  assert.equal(drafts.get('s', null).images.length, 0)
  queue.dispose()
})

test('draft persistence keeps references by parent and restores interrupted uploads as visible failures', () => {
  const store = storage(), drafts = createDraftStore(store)
  drafts.set('s', null, draftFromInput('root', [ref('root-image')]))
  drafts.set('s', 'node', { text: 'branch', images: [{ id: 'slot', name: 'Screenshot', byteLength: 20, status: 'uploading' }] })
  const restored = createDraftStore(store)
  assert.equal(restored.get('s', null).images[0].image.assetId, 'root-image')
  assert.equal(restored.get('s', 'node').images[0].status, 'failed')
  assert.equal(restored.get('s', 'node').text, 'branch')
  assert.doesNotMatch(store.getItem(draftsKey), /base64|blob:/)
  assert.equal(imageURL('a/b', '../file'), '/api/v1/sessions/a%2Fb/images/..%2Ffile/content')
})

test('workspace lease keeper renews detached parent drafts and pending images in bounded batches', async () => {
  const drafts = createDraftStore(), pending = createPendingStore(storage()), calls = [], timers = new Map()
  for (let i = 0; i < 10; i++) drafts.set('s', `node-${i}`, draftFromInput(`draft ${i}`, [ref(`image-${i}`)]))
  pending.set('other', { schemaVersion: 2, sessionId: 'other', input: '', images: [ref('pending')], parentNodeId: null, idempotencyKey: 'k' })
  let changed = 0
  const keeper = createImageLeaseKeeper({ drafts, pending, schedule(fn, ms) { timers.set(1, { fn, ms }); return 1 }, clear: id => timers.delete(id),
    changed() { changed++ }, error: assert.fail,
    async api(path, body) { calls.push({ path, body }); return { valid: body.assetIds.filter(id => id !== 'image-0').map(ref), invalid: body.assetIds.filter(id => id === 'image-0') } },
  })
  await keeper.refresh()
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(call => call.body.assetIds.length), [8, 2, 1])
  assert.equal(drafts.get('s', 'node-0').images[0].status, 'expired')
  assert.equal(timers.get(1).ms, imageLimits.renewIntervalMs)
  assert.equal(changed, 1)
  keeper.dispose(); assert.equal(timers.size, 0)
})

test('disposed image queue aborts uploads without reviving restored drafts', async () => {
  const drafts = createDraftStore(), task = deferred()
  let signal
  const queue = createImageUploads({ sessionId: 's', drafts, newId: () => 'slot', changed() {}, error: assert.fail,
    upload(_file, value) { signal = value; return task.promise } })
  queue.add(null, [new File(['x'], 'x.png', { type: 'image/png' })])
  queue.dispose(); assert.equal(signal.aborted, true)
  task.resolve(ref('late')); await turn()
  assert.equal(drafts.get('s', null).images[0].image, undefined)
})

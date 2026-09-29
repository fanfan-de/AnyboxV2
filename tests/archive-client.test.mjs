import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArchiveIndex } from '../dist/web/archive-client.js'
import { deferred } from './helpers/controlled-models.mjs'

test('archive refresh ignores stale responses, retains failures for retry, and joins disposal by aborting reads', async () => {
  const calls = []; let updates = 0
  const index = createArchiveIndex((url, body, signal) => {
    const job = deferred(); calls.push({ url, signal, job }); return job.promise
  }, () => { updates++ })
  const first = index.load(), second = index.load()
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].url, '/sessions/archived')
  calls[1].job.resolve([{ id: 'fresh' }]); await second
  calls[0].job.resolve([{ id: 'old' }]); await first
  assert.deepEqual(index.snapshot().sessions, [{ id: 'fresh' }])
  const failing = index.load(), error = new Error('offline')
  calls[2].job.reject(error); await failing
  assert.equal(index.snapshot().error, error)
  assert.deepEqual(index.snapshot().sessions, [{ id: 'fresh' }])
  const retry = index.load(); calls[3].job.resolve([]); await retry
  assert.equal(index.snapshot().error, undefined)
  assert.deepEqual(index.snapshot().sessions, [])
  const last = index.load(), count = updates
  index.dispose(); assert.equal(calls[4].signal.aborted, true)
  calls[4].job.resolve([{ id: 'late' }]); await last
  assert.equal(updates, count)
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { openRunChangeStream } from '../dist/web/run-change-stream.js'

function response() {
  return Object.assign(new EventEmitter(), {
    frames: [], destroyed: false, writable: true,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(frame) { this.frames.push(frame); return this.writable },
    destroy() { this.destroyed = true; this.emit('close') },
  })
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('SSE coalesces per Session, filters subscriptions and bounds buffering under backpressure', async () => {
  const res = response(); res.writable = false
  const stream = openRunChangeStream(res, new Set(['a', 'b', 'c', 'd']))
  try {
    assert.match(res.frames[0], /event: ready/)
    for (let i = 0; i < 1000; i++) {
      for (const id of ['a', 'b', 'c', 'd', 'unsubscribed']) stream.publish({ sessionId: id, runId: `r-${i}`, revision: i })
    }
    await tick()
    assert.equal(res.frames.length, 1)
    res.writable = true; res.emit('drain'); await tick()
    assert.equal(res.frames.length, 5)
    for (const frame of res.frames.slice(1)) {
      assert.match(frame, /"revision":999/)
      assert.doesNotMatch(frame, /unsubscribed/)
    }
    res.writable = false
    stream.publish({ sessionId: 'a', runId: 'final', revision: 1000 }); await tick()
    stream.close(); await stream.done
    assert.equal(res.destroyed, true)
    assert.deepEqual(res.eventNames(), [])
    stream.publish({ sessionId: 'a', runId: 'late', revision: 1001 }); await tick()
    assert.equal(res.frames.length, 6)
  } finally { stream.close(); await stream.done }
})

test('a disconnected SSE response releases pending sends, heartbeat and listeners', async () => {
  const res = response(), stream = openRunChangeStream(res, new Set(['a']))
  stream.publish({ sessionId: 'a', runId: 'r', revision: 1 })
  res.destroy(); await stream.done; await tick()
  assert.equal(res.frames.length, 1)
  assert.deepEqual(res.eventNames(), [])
})

test('SSE closes a stalled connection after the drain deadline and cancels its heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const res = response(); res.writable = false
  const stream = openRunChangeStream(res, new Set(['a']))
  t.mock.timers.tick(15_000)
  await stream.done
  assert.equal(res.destroyed, true)
  t.mock.timers.tick(30_000)
  assert.equal(res.frames.length, 1)
  assert.deepEqual(res.eventNames(), [])
})

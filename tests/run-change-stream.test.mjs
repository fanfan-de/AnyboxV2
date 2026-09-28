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

test('replacement views coalesce by Run under backpressure and retain independent sessions', async () => {
  const res = response(); res.writable = false
  const stream = openRunChangeStream(res, new Set(['a', 'b']))
  const publish = (sessionId, runId, viewRevision) => stream.publishProtocolView({ sessionId, runId,
    snapshot: { envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses', sessionId, runId, viewRevision,
      status: 'provisional', exchanges: [{ id: 'e', blocks: [{ id: 'text', kind: 'text', text: 'x'.repeat(20_000) }] }] } })
  try {
    for (let revision = 0; revision < 1000; revision++) publish('a', 'run-a', revision)
    publish('b', 'run-b', 7)
    publish('outside', 'not-subscribed', 1)
    assert.equal(res.destroyed, false)
    res.writable = true; res.emit('drain'); await tick()
    const frames = res.frames.filter(frame => frame.includes('event: protocol-view'))
    assert.equal(frames.length, 2)
    assert.match(frames[0], /"viewRevision":999/)
    assert.match(frames[1], /"viewRevision":7/)
    res.writable = false; publish('a', 'run-a', 1000); await tick()
    for (let index = 0; index < 20 && !res.destroyed; index++) publish('a', `other-${index}`, 1)
    assert.equal(res.destroyed, true, 'independent queued snapshots still have a total byte bound')
    await stream.done
  } finally { stream.close(); await stream.done }
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

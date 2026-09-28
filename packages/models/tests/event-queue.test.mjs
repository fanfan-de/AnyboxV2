import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelEventQueue } from '../dist/event-queue.js'
import { fixture } from './helpers.mjs'

test('a stalled frontend overflows its bounded subscription without blocking model completion', async () => {
  const f = await fixture()
  try {
    await f.add()
    const execution = await f.models.open({ modelId: 'model' })
    const queue = createModelEventQueue({ capacity: 2 })
    f.protocols[0].next(call => {
      for (let i = 0; i < 500; i++) call.input.onEvent({ type: 'text-delta', delta: 'progress' })
      call.succeed()
    })
    const result = await execution.generate({ messages: [{ role: 'user', content: 'go' }], onEvent: queue.onEvent }).result
    assert.equal(result.status, 'completed')
    assert.equal(queue.status, 'overflow')
    assert.equal(queue.buffered, 0)
    assert.equal((await queue.events.next()).done, true)
    await execution.close()
  } finally { await f.close() }
})

test('event queue forwards in order, bounds bytes, and releases pending readers on close', async () => {
  const queue = createModelEventQueue({ capacity: 3, maxBufferedBytes: 200 })
  const pending = queue.events.next()
  queue.onEvent({ type: 'text-delta', delta: 'one' })
  assert.equal((await pending).value.delta, 'one')
  queue.onEvent({ type: 'text-delta', delta: 'two' })
  assert.equal((await queue.events.next()).value.delta, 'two')
  queue.onEvent({ type: 'text-delta', delta: 'x'.repeat(201) })
  assert.equal(queue.status, 'overflow')
  const another = createModelEventQueue()
  const reader = another.events.next()
  another.close(); another.close()
  assert.equal((await reader).done, true)
})

test('leaving an event iterator closes it without retaining more events', async () => {
  const queue = createModelEventQueue()
  queue.onEvent({ type: 'text-delta', delta: 'one' })
  queue.onEvent({ type: 'text-delta', delta: 'two' })
  for await (const event of queue.events) { assert.equal(event.delta, 'one'); break }
  assert.equal(queue.status, 'closed')
  assert.equal(queue.buffered, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockModel } from '../dist/index.js'
import { definition, deferred, remainsPending, text, isCode } from './helpers.mjs'

const request = { runId: 'run', attemptId: 'attempt', model: definition.model,
  instructions: '', history: [], input: text('hello'), maxOutputBytes: 1024 }

test('model result and cleanup have separate completion and all cleanups are attempted', async () => {
  const gate = deferred()
  const order = []
  const owned = createMockModel((_request, { onCleanup }) => {
    onCleanup(() => { order.push('first') })
    onCleanup(async () => { await gate.promise; order.push('second'); throw new Error('cleanup rejected') })
    return { content: text('answer') }
  })
  const call = owned.service.call(request)
  assert.deepEqual(await call.result, { content: text('answer') })
  await remainsPending(call.done)
  gate.resolve()
  await assert.rejects(call.done, /cleanup rejected/)
  assert.deepEqual(order, ['second', 'first'])
  const close = owned.close()
  assert.strictEqual(owned.close(), close)
  await assert.rejects(close, /cleanup rejected/)
  assert.throws(() => owned.service.call(request), isCode('CLOSED'))
})

test('mock rejects non-mock protocols and business failure does not imply cleanup failure', async () => {
  const owned = createMockModel(() => { throw new Error('business error') })
  assert.throws(() => owned.service.call({ ...request, model: { ...request.model, protocolId: 'unsupported' } }), isCode('CAPABILITY_UNAVAILABLE'))
  const call = owned.service.call(request)
  await assert.rejects(call.result, /business error/)
  await call.done
  await owned.close()
})

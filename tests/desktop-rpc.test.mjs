import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPrivateRpc, rpcFailure } from '../dist/desktop/rpc.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function peers() {
  let left, right
  left = createPrivateRpc(message => right.receive(message))
  right = createPrivateRpc(message => left.receive(message))
  return { left, right }
}

test('private RPC cancellation waits for handler actual exit before settling the caller and drain', { timeout: 5_000 }, async t => {
  const { left, right } = peers(), entered = deferred(), cancelling = deferred(), exited = deferred()
  t.after(() => { exited.resolve(); left.disconnect(); right.disconnect() })
  right.handle('controlled', async (_value, signal) => {
    signal.addEventListener('abort', cancelling.resolve, { once: true })
    entered.resolve(); await exited.promise; return 'finished'
  })
  const controller = new AbortController()
  let settled = false, drained = false
  const call = left.call('controlled', undefined, controller.signal)
  const rejected = assert.rejects(call, { code: 'cancelled' }).then(() => { settled = true })
  await entered.promise; controller.abort(); await cancelling.promise
  const draining = right.drain().then(() => { drained = true })
  await tick(); assert.equal(settled, false); assert.equal(drained, false)
  exited.resolve(); await rejected; await draining
})

test('disconnect unblocks callers, aborts accepted handlers and drain still joins their exit', { timeout: 5_000 }, async t => {
  const { left, right } = peers(), entered = deferred(), cancelling = deferred(), exited = deferred()
  t.after(() => { exited.resolve(); left.disconnect(); right.disconnect() })
  right.handle('controlled', async (_value, signal) => {
    signal.addEventListener('abort', cancelling.resolve, { once: true })
    entered.resolve(); await exited.promise
  })
  const rejected = assert.rejects(left.call('controlled'), { code: 'worker-unavailable' })
  await entered.promise; left.disconnect(); right.disconnect()
  await rejected; await cancelling.promise
  let drained = false
  const draining = right.drain().then(() => { drained = true })
  await tick(); assert.equal(drained, false)
  await assert.rejects(left.call('controlled'), { code: 'worker-unavailable' })
  exited.resolve(); await draining
})

test('private RPC sanitizes handler failures and already aborted calls never dispatch', { timeout: 5_000 }, async t => {
  const { left, right } = peers()
  t.after(() => { left.disconnect(); right.disconnect() })
  let handled = 0
  right.handle('known', () => { throw rpcFailure('known-operation-failure') })
  right.handle('native', () => { throw Object.assign(new Error('secret native message'), { code: 'ERR_NATIVE_SECRET' }) })
  right.handle('controlled', () => { handled++; return 'ok' })
  await assert.rejects(left.call('known'), { code: 'known-operation-failure' })
  await assert.rejects(left.call('native'), error => error.code === 'operation-failed' && !error.message.includes('secret'))
  await assert.rejects(left.call('missing'), { code: 'unsupported-operation' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(left.call('controlled', undefined, controller.signal), { code: 'cancelled' })
  assert.equal(handled, 0)
})

test('private RPC rejects a failed initial send without retaining a pending caller', { timeout: 5_000 }, async () => {
  const rpc = createPrivateRpc(() => { throw new Error('transport gone') })
  await assert.rejects(rpc.call('missing'), { code: 'worker-unavailable' })
  rpc.disconnect(); await rpc.drain()
})

test('a failed response send disconnects pending callers and still drains accepted handler cleanup', { timeout: 5_000 }, async t => {
  const entered = deferred(), cancelling = deferred(), exited = deferred()
  const rpc = createPrivateRpc(message => { if (message.type === 'response') throw new Error('transport gone') })
  t.after(() => { exited.resolve(); rpc.disconnect() })
  rpc.handle('complete', () => 'done')
  rpc.handle('controlled', async (_value, signal) => {
    signal.addEventListener('abort', cancelling.resolve, { once: true })
    entered.resolve(); await exited.promise
  })
  const rejected = assert.rejects(rpc.call('outgoing'), { code: 'worker-unavailable' })
  rpc.receive({ type: 'request', id: 20, method: 'controlled' }); await entered.promise
  rpc.receive({ type: 'request', id: 21, method: 'complete' })
  await rejected; await cancelling.promise
  let drained = false
  const draining = rpc.drain().then(() => { drained = true })
  await tick(); assert.equal(drained, false)
  exited.resolve(); await draining
})

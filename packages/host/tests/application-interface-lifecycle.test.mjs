import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApplicationInterfaceLifecycle } from '../dist/web/application-lifecycle.js'
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

test('interface preparation freezes before waiting and checks all same-process interfaces', async () => {
  const exit = deferred(), calls = []
  const lifecycle = createApplicationInterfaceLifecycle({ freeze: value => calls.push(['freeze', value]), save: () => calls.push(['save']), settle: () => exit.promise,
    interfaces: () => [1, 2].map(id => ({ canClose() { calls.push(['guard', id]); return true }, async dispose() { calls.push(['dispose', id]) } })) })
  const preparing = lifecycle.prepare(); assert.deepEqual(calls, [['freeze', true]])
  exit.resolve(); const lease = await preparing
  assert.deepEqual(calls, [['freeze', true], ['guard', 1], ['guard', 2]])
  await lease.disposeForRestart()
  assert.deepEqual(calls.slice(3), [['guard', 1], ['guard', 2], ['save'], ['dispose', 1], ['dispose', 2]])
  assert.equal(lifecycle.frozen, true)
  lease.release(); assert.equal(lifecycle.frozen, false)
})

test('an unsaved draft releases the whole intact workspace and performs no disposal', async () => {
  const calls = []
  const lifecycle = createApplicationInterfaceLifecycle({ freeze: value => calls.push(value), save() { throw Error('must not save') }, settle: async () => {},
    interfaces: () => [{ canClose: () => false, async dispose() { throw Error('must not dispose') } }] })
  await assert.rejects(lifecycle.prepare(), { code: 'application-interface-blocked' })
  assert.deepEqual(calls, [true, false]); assert.equal(lifecycle.frozen, false)
})

test('a second draft check after backend freeze rejects before any interface is disposed', async () => {
  let allowed = true, disposals = 0
  const lifecycle = createApplicationInterfaceLifecycle({ freeze() {}, save() {}, settle: async () => {}, interfaces: () => [{ canClose: () => allowed, async dispose() { disposals++ } }] })
  const lease = await lifecycle.prepare(); allowed = false
  await assert.rejects(lease.disposeForRestart(), { code: 'application-interface-blocked' })
  assert.equal(disposals, 0); assert.equal(lifecycle.frozen, false)
})

test('disposal joins all actual exits and cleanup failure retains the protection fence', async () => {
  const exit = deferred(); let exited = false
  const lifecycle = createApplicationInterfaceLifecycle({ freeze() {}, save() {}, settle: async () => {}, interfaces: () => [
    { canClose: () => true, async dispose() { throw Error('cleanup uncertain') } },
    { canClose: () => true, async dispose() { await exit.promise; exited = true } },
  ] })
  const lease = await lifecycle.prepare(); let returned = false
  const closing = lease.disposeForRestart().then(() => {}, error => { returned = true; assert.equal(error.code, 'application-interface-cleanup-failed') })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false)
  exit.resolve(); await closing; assert.equal(exited, true); lease.release(); assert.equal(lifecycle.frozen, true)
})

test('only one interface preparation can own the lifetime fence', async () => {
  const lifecycle = createApplicationInterfaceLifecycle({ freeze() {}, save() {}, settle: async () => {}, interfaces: () => [] })
  const lease = await lifecycle.prepare(); await assert.rejects(lifecycle.prepare(), { code: 'application-interface-busy' })
  lease.release(); const next = await lifecycle.prepare(); next.release()
  await assert.rejects(next.disposeForRestart(), { code: 'application-interface-lease-released' })
})

test('a release request during accepted disposal waits for actual exit before reopening interface controls', async () => {
  const exit = deferred(), lifecycle = createApplicationInterfaceLifecycle({ freeze() {}, save() {}, settle: async () => {}, interfaces: () => [{ canClose: () => true, dispose: () => exit.promise }] })
  const lease = await lifecycle.prepare(), disposal = lease.disposeForRestart(); lease.release(); assert.equal(lifecycle.frozen, true)
  exit.resolve(); await disposal; assert.equal(lifecycle.frozen, false)
})

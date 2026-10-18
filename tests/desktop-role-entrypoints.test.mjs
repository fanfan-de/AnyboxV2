import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateRpc } from '../packages/host/dist/desktop/rpc.js'
import { installDesktopWorkerRpc } from '../packages/host/dist/desktop/worker-runtime.js'
import { startDesktopClient } from '../packages/distribution/dist/entrypoints/desktop-client.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function rpcPair() {
  const main = createPrivateRpc(message => queueMicrotask(() => worker.receive(message)))
  const worker = createPrivateRpc(message => queueMicrotask(() => main.receive(message)))
  return { main, worker }
}

test('the desktop client entry opens and restores its application without requesting a local service or creating execution data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-desktop-client-only-'))
  const { main, worker } = rpcPair(), calls = []
  main.handle('local.get', () => { calls.push('get'); return undefined })
  for (const method of ['local.start', 'local.issue', 'local.reconcile']) main.handle(method, () => { calls.push(method); throw new Error('Unexpected local mutation') })
  let role
  t.after(async () => { await role?.close(); await rm(directory, { recursive: true, force: true }) })
  for (let pass = 0; pass < 2; pass++) {
    role = await startDesktopClient({ kind: 'client', userData: directory, namespace: 'anybox.test.client-only', transportSecret: 'private-test-transport' }, worker)
    const url = role.ready.url, headers = { 'X-Anybox-Desktop-Transport': 'private-test-transport', Origin: url, 'Content-Type': 'application/json' }
    const open = await fetch(`${url}/api/client/v1/products/agent/open`, { method: 'POST', headers, body: '{}' })
    assert.equal(open.status, 200, await open.text())
    await tick()
    for (let read = 0; read < 3; read++) {
      const value = await (await fetch(`${url}/api/client/v1/local`, { headers })).json()
      assert.deepEqual(value.status, { enabled: true, state: 'disabled', instanceId: null, connectionId: null })
    }
    assert.ok(calls.every(method => method === 'get'))
    assert.ok((await readdir(join(directory, 'data'))).every(name => name.startsWith('client.sqlite')))
    await role.close()
  }
  assert.equal(calls.length, 2, 'one read-only bootstrap per client generation')
})

test('a role entry rejects the wrong role and shutdown joins an already accepted startup and actual close', async () => {
  const { main, worker } = rpcPair(), started = deferred(), startExit = deferred(), closeExit = deferred()
  let starts = 0, prepares = 0, closes = 0, exits = 0
  installDesktopWorkerRpc(worker, 'client', async () => {
    starts++; started.resolve(); await startExit.promise
    return { ready: { url: 'http://127.0.0.1:1' }, async prepareClose() { prepares++ }, async close() { closes++; await closeExit.promise } }
  }, () => { exits++ })
  const options = { kind: 'client', userData: 'isolated', namespace: 'test', transportSecret: 'test' }
  await assert.rejects(main.call('start', { ...options, kind: 'execution' }), { code: 'invalid-startup' })
  assert.equal(starts, 0)
  const start = main.call('start', options); await started.promise
  await assert.rejects(main.call('start', options), { code: 'already-started' })
  const preparing = main.call('prepareClose'), closing = main.call('close')
  await tick(); assert.equal(prepares, 0); assert.equal(closes, 0); assert.equal(exits, 0)
  startExit.resolve(); await start; await preparing
  assert.equal(prepares, 1); assert.equal(closes, 1); assert.equal(exits, 0)
  await assert.rejects(main.call('start', options), { code: 'service-unavailable' })
  closeExit.resolve(); await closing; await tick()
  assert.equal(exits, 1)
})

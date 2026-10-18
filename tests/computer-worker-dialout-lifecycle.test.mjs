import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@nya/core'
import fs from 'node:fs/promises'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectLocalComputerWorker } from '../packages/app-harness/dist/core/computer/worker-client.js'
import { openComputerWorker } from '../packages/app-harness/dist/core/computer/worker-server.js'
import { createWorkerDialoutComponent, workerDialoutServiceKey } from '../packages/app-harness/dist/core/computer/worker-dialout.js'
import { computerWorkerServiceKey } from '../packages/app-harness/dist/core/computer/worker-port.js'
import { workerAttachmentsServiceKey } from '../packages/app-harness/dist/core/computer/worker-attachments.js'
import { imageAssetsServiceKey } from '../packages/app-harness/dist/core/image/port.js'
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return {promise, resolve} }
const within = async (promise, ms = 1_000) => {
  let timer
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
  finally { clearTimeout(timer) }
}
test('dialout disposal cancels and joins an accepted attach request before releasing its dependencies', { timeout: 5_000 }, async () => {
  const root = new Context(), entered = deferred(), abortObserved = deferred(), releaseCleanup = deferred()
  let requestExited = false, rootClosed = false
  const send = async (_url, init) => {
    entered.resolve()
    await new Promise(resolve => { init.signal.addEventListener('abort', () => { abortObserved.resolve(); resolve() }, { once: true }) })
    // Model a transport that must drain a connection after cancellation before it exits.
    await releaseCleanup.promise
    requestExited = true
    throw new DOMException('Request aborted after cleanup', 'AbortError')
  }
  await root.installComponent({ name: 'dialout-review-dependencies', apply(ctx) {
    ctx.provide(computerWorkerServiceKey, { info: async () => ({workerId:'worker',bootId:'boot',platform:process.platform,architecture:process.arch}) })
    ctx.provide(workerAttachmentsServiceKey, { list: async () => [], onChanged: () => () => {} })
    ctx.provide(imageAssetsServiceKey, {})
  } })
  await root.installComponent(createWorkerDialoutComponent({fetch:send,requestTimeoutMs:10_000}))
  const attaching = root.get(workerDialoutServiceKey).attach({harnessUrl:'http://127.0.0.1',code:'code',ceiling:{kind:'computer',projects:'all',tools:'all'}})
  void attaching.catch(() => {})
  assert.equal(await within(entered.promise), true, 'the accepted call starts')
  const closing = root.fiber.dispose().then(() => { rootClosed = true })
  try {
    assert.equal(await within(abortObserved.promise), true, 'close cancels the accepted transport request')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(rootClosed, false, 'closing waits until the accepted HTTP request finishes cancellation cleanup')
    assert.equal(requestExited, false)
  } finally {
    releaseCleanup.resolve()
    await Promise.allSettled([closing,attaching])
  }
  assert.equal(requestExited,true)
  assert.equal(rootClosed,true)
})


test('dialout disposal cancels and joins a read-only query without shutting down the worker', { timeout: 5_000 }, async () => {
  const root = new Context(), entered = deferred(), aborted = deferred(), release = deferred()
  let closed = false, exited = false, shutdown = false, delivered = false
  const attachment = { attachmentId: 'remote', harnessUrl: 'http://127.0.0.1', instanceId: 'instance', state: 'approved' }
  await root.installComponent({ name: 'dialout-query-dependencies', apply(ctx) {
    ctx.provide(computerWorkerServiceKey, {
      info: async () => ({workerId:'worker',bootId:'boot',platform:process.platform,architecture:process.arch}),
      async query(_input, signal) {
        entered.resolve()
        await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
        await release.promise; exited = true
        return { kind: 'stat', directory: false, canonical: null }
      },
      async shutdown() { shutdown = true },
    })
    ctx.provide(workerAttachmentsServiceKey, { list: async () => [attachment], credential: async () => 'credential', onChanged: () => () => {} })
    ctx.provide(imageAssetsServiceKey, {})
  } })
  const send = async (_url, init) => {
    if (!delivered) { delivered = true; return Response.json({ requests: [{ requestId:'query',kind:'query',payload:{query:{kind:'stat',path:'/project'}} }] }) }
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    throw new DOMException('Aborted', 'AbortError')
  }
  const fiber = root.installComponent(createWorkerDialoutComponent({ fetch: send })); await fiber
  assert.equal(await within(entered.promise), true, 'the accepted call starts')
  const closing = fiber.dispose().then(() => { closed = true })
  try {
    assert.equal(await within(aborted.promise), true, 'the query cancellation reaches its executor')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.equal(exited, false)
    assert.equal(shutdown, false, 'replacing dialout only closes its own queries and observations')
  } finally { release.resolve(); await closing; await root.fiber.dispose() }
  assert.equal(exited, true)
})

test('the local query signal reaches the real worker HTTP handler and leaves tool submissions independent', { timeout: 5_000 }, async () => {
  const entered = deferred(), release = deferred(), exited = deferred()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-query-cancel-')))
  const target = join(directory, 'held.txt'), original = fs.open
  let client, worker, queryStarted = false, reads = 0
  try {
    await writeFile(target, 'content')
    worker = await openComputerWorker(join(directory, 'worker'))
    client = connectLocalComputerWorker({ directory: join(directory, 'worker') })
    fs.open = async (path, ...args) => {
      const handle = await original(path, ...args)
      if (path !== target) return handle
      queryStarted = true; entered.resolve(); await release.promise
      return { stat: (...args) => handle.stat(...args), read: (...args) => { reads++; return handle.read(...args) },
        async close() { try { await handle.close() } finally { exited.resolve() } } }
    }
    syncBuiltinESMExports()
    const controller = new AbortController()
    const querying = client.query({ attachmentId: 'local:computer', query: { kind: 'read', root: directory, path: 'held.txt' } }, controller.signal)
    void querying.catch(() => {})
    assert.equal(await within(entered.promise), true, 'the real worker opened the queried file')
    controller.abort(); await assert.rejects(querying)
    // The server receives the disconnected response while its filesystem call still owns the handle.
    await new Promise(resolve => setTimeout(resolve, 20))
    await client.claimRun({ attachmentId: 'local:computer', runId: 'run', runOwnerEpoch: 1 })
    const accepted = await client.submit({ attachmentId: 'local:computer', runId: 'run', runOwnerEpoch: 1, operationId: 'cancel', declarationDigest: 'digest', kind: 'cancel' })
    assert.equal(accepted.state, 'queued')
    release.resolve(); assert.equal(await within(exited.promise), true)
    assert.equal(reads, 0, 'the server cancellation stops the query before reading the opened file')
  } finally {
    release.resolve(); if (queryStarted) await exited.promise
    fs.open = original; syncBuiltinESMExports()
    await client?.closeObserver(); await worker?.close(); await rm(directory, { recursive: true, force: true })
  }
})


test('worker HTTP shutdown closes the root and publishes a failure receipt after query cleanup fails', { timeout: 5_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-query-close-failure-')))
  const target = join(directory, 'failure.txt'), original = fs.open, originalExitCode = process.exitCode
  let worker, client
  try {
    await writeFile(target, 'content')
    worker = await openComputerWorker(join(directory, 'worker'))
    client = connectLocalComputerWorker({ directory: join(directory, 'worker') })
    fs.open = async (path, ...args) => {
      const handle = await original(path, ...args)
      if (path !== target) return handle
      return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args), async close() { await handle.close(); throw new Error('injected query close failure') } }
    }
    syncBuiltinESMExports()
    await assert.rejects(client.query({ attachmentId: 'local:computer', query: { kind: 'read', root: directory, path: 'failure.txt' } }), { code: 'file-cleanup-failed' })
    await assert.rejects(client.shutdown(), { code: 'worker-cleanup-failed' })
    let receipt
    for (let n = 0; n < 100; n++) {
      const present = await fs.access(join(directory, 'worker', 'endpoint.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      if (!present) { receipt = JSON.parse(await fs.readFile(join(directory, 'worker', 'shutdown.json'), 'utf8')); break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(receipt?.bootId, worker.endpoint.bootId)
    assert.equal(receipt?.error, 'worker-cleanup-failed')
  } finally {
    fs.open = original; syncBuiltinESMExports()
    await client?.closeObserver(); await worker?.close().catch(() => {})
    process.exitCode = originalExitCode
    await rm(directory, { recursive: true, force: true })
  }
})

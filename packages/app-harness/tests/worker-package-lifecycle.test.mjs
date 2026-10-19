import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectLocalComputerWorker } from '../dist/core/computer/worker-client.js'

async function stub(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-package-worker-')), sockets = new Set(), workerId = randomUUID(), bootId = randomUUID(), token = randomUUID() + randomUUID()
  const server = createServer(async (request, response) => { for await (const _bytes of request) { /* App-owned wire protocol. */ } response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value: request.url === '/info' ? { workerId, bootId } : [] })) })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done; await rm(directory, { recursive: true, force: true }) })
  return { directory, server, async publish() { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'endpoint.json'), JSON.stringify({ workerId, bootId, token, pid: process.pid, url: `http://127.0.0.1:${server.address().port}` })) } }
}

test('package worker startup uses one application-owned launch hook under the existing startup lock and preserves the independent observer boundary', async t => {
  const env = await stub(t), calls = [], worker = connectLocalComputerWorker({ directory: env.directory, autoStart: false, async launch(directory) { calls.push(directory); await env.publish() } })
  t.after(() => worker.closeObserver())
  await Promise.all([worker.start(), worker.start()]); assert.deepEqual(calls, [resolve(env.directory)])
  assert.equal((await worker.status()).state, 'running'); await worker.closeObserver(); assert.equal(env.server.listening, true)
})

test('closing the observer joins an accepted package launch without stopping its independently published worker', async t => {
  const env = await stub(t)
  let release, entered
  const accepted = new Promise(resolve => { entered = resolve }), worker = connectLocalComputerWorker({ directory: env.directory, autoStart: false, async launch() { entered(); await new Promise(resolve => { release = resolve }); await env.publish() } })
  const startup = worker.start(); await accepted
  let closed = false
  const closing = worker.closeObserver().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false); release()
  await assert.rejects(startup, error => error.code === 'worker-observer-closed'); await closing
  assert.equal(env.server.listening, true)
})

test('a separately served worker is reused without launching another package role', async t => {
  const env = await stub(t); await env.publish()
  let starts = 0
  const worker = connectLocalComputerWorker({ directory: env.directory, autoStart: false, async launch() { starts++ } }); t.after(() => worker.closeObserver())
  await worker.start(); assert.equal(starts, 0); assert.equal((await worker.status()).state, 'running')
})

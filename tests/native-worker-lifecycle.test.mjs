import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'

test('a native worker starts, outlives observers, stops, and recovers identity after a process crash', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'anybox-native-worker-')), directory = join(temporary, 'worker')
  let client = connectLocalComputerWorker({ directory, autoStart: false }), ownedPid
  t.after(async () => {
    try { await client.shutdown() } catch {
      if (ownedPid) { try { process.kill(ownedPid, 'SIGKILL') } catch {} }
    }
    await client.closeObserver()
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  assert.deepEqual(await client.status(), { state: 'stopped', supported: true, attachments: [] })
  await assert.rejects(access(directory), { code: 'ENOENT' }, 'a read-only status probe creates no files')
  const previousRole = process.env.ANYBOX_SYSTEM_SERVICE_ROLE
  const restoreRole = () => { if (previousRole === undefined) delete process.env.ANYBOX_SYSTEM_SERVICE_ROLE; else process.env.ANYBOX_SYSTEM_SERVICE_ROLE = previousRole }
  process.env.ANYBOX_SYSTEM_SERVICE_ROLE = 'harness-server'
  try {
    await assert.rejects(client.start(), { code: 'worker-service-start-required' })
    await assert.rejects(access(directory), { code: 'ENOENT' }, 'a system harness cannot create a worker in its service Job/cgroup')
  } finally { restoreRole() }
  await client.start()
  const first = await client.status(); ownedPid = first.pid
  assert.equal(first.state, 'running'); assert.equal(first.platform, process.platform)
  assert.equal(first.supported, true); assert.ok(first.workerId); assert.ok(first.bootId)
  const serviceObserver = connectLocalComputerWorker({ directory })
  process.env.ANYBOX_SYSTEM_SERVICE_ROLE = 'harness-server'
  try {
    await serviceObserver.start()
    assert.equal((await serviceObserver.info()).bootId, first.bootId, 'a system harness reuses an independently started worker')
  } finally { restoreRole(); await serviceObserver.closeObserver() }
  await client.start()
  assert.equal((await client.status()).bootId, first.bootId, 'starting twice reuses the running instance')
  await client.closeObserver()
  client = connectLocalComputerWorker({ directory, autoStart: false })
  assert.equal((await client.status()).bootId, first.bootId, 'closing a client does not stop the service')
  await client.shutdown(); ownedPid = undefined
  assert.equal((await client.status()).state, 'stopped')
  await client.start()
  const second = await client.status(); ownedPid = second.pid
  assert.equal(second.workerId, first.workerId); assert.notEqual(second.bootId, first.bootId)
  process.kill(second.pid, 'SIGKILL')
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(second.pid, 0); await delay(25) } catch { break }
  }
  await client.start()
  const recovered = await client.status(); ownedPid = recovered.pid
  assert.equal(recovered.state, 'running'); assert.equal(recovered.workerId, first.workerId)
  assert.notEqual(recovered.bootId, second.bootId)
  assert.equal((await readFile(join(directory, 'worker-id'), 'utf8')).trim(), first.workerId)
  await client.shutdown(); ownedPid = undefined
  assert.equal((await client.status()).state, 'stopped')
})

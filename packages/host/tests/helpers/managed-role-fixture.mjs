// A fixed trusted role adapter used only by process-owner behavior tests.
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createPrivateRpc, rpcFailure } from '../../dist/desktop/rpc.js'
import { acquirePackageUsageLock, prepareUsageLock, tryAcquirePackageUsageExitLock } from '../../dist/package-management/usage-locks.js'

const rpc = createPrivateRpc(message => process.send(message))
process.on('message', message => rpc.receive(message))
let settings = {}
let server, startOptions, usage, usageLock, started = false, closed = false, url = '', lastLaunch
const event = (kind, details = {}) => appendFileSync(join(startOptions.packageDirectory, 'managed-events.jsonl'), JSON.stringify({ kind, pid: process.pid, generation: startOptions.generation, ...details }) + '\n')
const snapshot = (generation, id = randomUUID()) => ({ id, revision: 0, registryRevision: 1, ownerEpoch: generation, role: 'client', entries: [], capabilities: [], revoked: false })
function credential(generation) {
  const usageId = randomUUID(), secret = randomBytes(32).toString('base64url')
  prepareUsageLock(startOptions.packageDirectory, usageId, createHash('sha256').update(secret).digest('hex'))
  return { usageId, secret, snapshot: snapshot(generation) }
}
function held(id) {
  const lock = tryAcquirePackageUsageExitLock(startOptions.packageDirectory, id)
  if (!lock) return true
  void lock.release(); return false
}
function launch(credential, id = randomUUID()) {
  return { activation: { id, requestId: randomUUID(), revision: 1, registryRevision: 1, ownerEpoch: credential.snapshot.ownerEpoch, phase: 'handoff', targets: [], roles: [{ role: 'client', entries: [], capabilities: [], handoffUsageId: credential.usageId, usageIds: [credential.usageId], readyUsageId: null }], supersededUsageIds: [], receipt: null, errorCode: null, recovery: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, credentials: [credential] }
}
async function close() {
  if (closed) return
  closed = true
  event('closing')
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
rpc.handle('start', async value => {
  if (started) throw rpcFailure('already-started')
  started = true; startOptions = value
  settings = value.roleConfigPath ? JSON.parse(readFileSync(value.roleConfigPath, 'utf8')) : {}
  event('start', { role: value.role, activation: !!value.activation, managementOnly: value.managementOnly === true })
  if (settings.crashInitialOnce && !value.managementOnly && !existsSync(join(value.packageDirectory, 'fixture-initial-crashed'))) { writeFileSync(join(value.packageDirectory, 'fixture-initial-crashed'), 'yes'); event('intentional-initial-crash'); process.exit(17) }
  if (value.activation) {
    const parent = value.activation.parents[0]
    event('old-parent-before-adoption', { held: held(parent.usageId) })
    usage = credential(parent.snapshot.ownerEpoch + 1)
    const adopted = launch(usage, value.activation.id)
    adopted.activation.roles[0].handoffUsageId = parent.usageId
    adopted.activation.roles[0].usageIds.unshift(parent.usageId)
    await rpc.call('activation.adopted', adopted)
    event('new-parent-before-claim', { held: held(usage.usageId), oldHeld: held(parent.usageId) })
    if (settings.crashOnRestart && !(settings.crashOnce && existsSync(join(value.packageDirectory, 'fixture-crashed')))) { writeFileSync(join(value.packageDirectory, 'fixture-crashed'), 'yes'); event('intentional-crash'); process.exit(17) }
    usageLock = acquirePackageUsageLock(value.packageDirectory, usage)
    process.once('exit', () => { void usageLock.release() })
  }
  server = createServer((request, response) => {
    const finish = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)) }
    if (request.url === '/fixture' && request.method === 'GET') { finish(200, { generation: value.generation, pid: process.pid, usageId: usage?.usageId ?? null }); return }
    if (request.url === '/fixture/stage' && request.method === 'POST') {
      request.resume()
      const next = credential(1)
      lastLaunch = launch(next)
      const blocked = settings.blockStageAnchor ? tryAcquirePackageUsageExitLock(startOptions.packageDirectory, next.usageId) : undefined
      void rpc.call('activation.stage', lastLaunch).then(async result => { await blocked?.release(); event('stage-ack'); finish(202, result) }, async error => { await blocked?.release(); event('stage-error', { code: error.code }); finish(409, { code: error.code }) })
      return
    }
    if (request.url.startsWith('/fixture/resume?id=') && request.method === 'POST') {
      request.resume()
      const next = credential(2), id = new URL(request.url, 'http://127.0.0.1').searchParams.get('id')
      lastLaunch = launch(next, id)
      void rpc.call('activation.stage', lastLaunch).then(result => finish(202, result), error => finish(409, { code: error.code }))
      return
    }
    if (request.url === '/fixture/launch' && request.method === 'POST') {
      request.resume()
      void rpc.call('role.launch', { source: { usageId: 'fixture-source', secret: 'private-fixture-source' }, identity: { appId: 'fixture', version: '1.0.0', digest: 'a'.repeat(64), target: { os: process.platform, arch: process.arch } }, role: 'computer-worker', args: [], ownership: 'independent' }).then(result => finish(200, result), error => finish(409, { code: error.code }))
      return
    }
    if (request.url === '/fixture/registry' && request.method === 'POST') {
      request.resume()
      void rpc.call('registry', { method: 'deleteEverything', args: [] }).then(() => finish(200, {}), error => finish(409, { code: error.code }))
      return
    }
    finish(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  return { role: value.role, generation: value.generation, url, ...(usage ? { usageId: usage.usageId } : {}) }
})
rpc.handle('role.reserve', () => undefined)
rpc.handle('role.reserve-related', input => {
  if (!settings.independentReservation) throw rpcFailure('unsupported-operation')
  const next = credential(1)
  next.snapshot.role = 'computer-worker'
  next.snapshot.entries = [{ package: input.identity, entry: 'computer-worker' }]
  event('launch-reserved', { usageId: next.usageId })
  return next
})
rpc.handle('freeze', () => { event('freeze'); if (settings.busyOnFreeze) throw rpcFailure('product-busy') })
rpc.handle('release', () => event('release'))
rpc.handle('activation.finish', value => {
  event('finished', { previousExited: value.previousUsageIds.every(id => !held(id)), usageHeld: held(usage.usageId) })
  return { completed: true }
})
rpc.handle('close', async () => { await close(); setImmediate(() => process.exit(0)) })
process.on('disconnect', () => { void close().finally(() => process.exit(1)) })

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { stageProductionClosure } from '../scripts/application-artifacts.mjs'
import { connectLocalComputerWorker } from '../packages/app-harness/dist/core/computer/worker-client.js'
import { workerBuildId } from '../packages/app-harness/dist/core/computer/worker-runtime.js'
import { computerDeclarationDigest } from '../packages/app-harness/dist/core/computer/operations-domain.js'
import { getToolById } from '../packages/app-harness/dist/core/tool/catalog.js'

const repository = fileURLToPath(new URL('..', import.meta.url))
const owner = { runId: 'runtime-run', runOwnerEpoch: 1, attachmentId: 'local:computer' }

async function stub(t, report) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-health-client-')))
  const identity = { workerId: 'worker', bootId: 'boot', platform: process.platform, architecture: process.arch }
  let info = { ...identity, ...report }
  const requests = [], fact = { operationId: 'original', runId: owner.runId, declarationDigest: 'original-digest', state: 'succeeded', receipt: 'original-receipt', executeCount: 1, observation: { result: { output: 'already accepted' } } }
  const facts = new Map([[fact.operationId, fact]])
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ path: request.url, input })
    let value
    switch (request.url) {
      case '/info': value = info; break
      case '/attachments/list': value = []; break
      case '/get': value = facts.get(input.operationId) ?? null; break
      case '/query': value = { kind: 'stat', directory: true, canonical: directory }; break
      case '/claim': value = null; break
      case '/submit':
        value = facts.get(input.operationId)
        if (value && input.declarationDigest !== value.declarationDigest) {
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'worker-operation-conflict' }))
          return
        }
        value ??= { ...fact, operationId: input.operationId, declarationDigest: input.declarationDigest }
        facts.set(input.operationId, value)
        break
      case '/shutdown':
        await writeFile(join(directory, 'shutdown.json'), JSON.stringify({ bootId: identity.bootId }))
        await rm(join(directory, 'endpoint.json'))
        value = null
        break
      default: assert.fail(`unexpected request: ${request.url}`)
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(directory, 'endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'x'.repeat(64), pid: process.pid, ...identity }))
  const port = connectLocalComputerWorker({ directory, autoStart: false })
  t.after(async () => {
    await port.closeObserver()
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed
    await rm(directory, { recursive: true, force: true })
  })
  return { port, requests, fact, setReport(report) { info = { ...identity, ...report } } }
}

test('legacy, different-build and unavailable workers reject new tools without stopping original observations or cleanup', async t => {
  assert.equal(typeof workerBuildId, 'string')
  const cases = [
    { name: 'legacy', report: {}, reason: 'worker-build-mismatch' },
    { name: 'different build', report: { buildId: '0'.repeat(64), runtime: { state: 'ready' } }, reason: 'worker-build-mismatch' },
    { name: 'missing helper', report: { buildId: workerBuildId, runtime: { state: 'unavailable', reason: 'process-unavailable' } }, reason: 'worker-runtime-unavailable' },
    { name: 'missing health', report: { buildId: workerBuildId }, reason: 'worker-runtime-unavailable' },
  ]
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const f = await stub(t, scenario.report)
    const status = await f.port.status()
    assert.equal(status.state, 'restart-required')
    assert.equal(status.reason, scenario.reason)
    assert.equal(status.expectedBuildId, workerBuildId)
    assert.equal((await f.port.info()).workerId, 'worker', 'read-only legacy info stays available')
    await assert.rejects(f.port.start(), { code: 'worker-restart-required' })
    await assert.rejects(f.port.submit({ ...owner, kind: 'tool', operationId: 'new', declarationDigest: 'new', workerBootId: 'boot' }), { code: 'worker-restart-required' })
    await assert.rejects(f.port.submit({ ...owner, kind: 'tool', operationId: 'old-boot', declarationDigest: 'old-boot', workerBootId: 'retired-boot' }), { code: 'worker-instance-replaced' })
    assert.equal(f.requests.some(request => request.path === '/submit'), false, 'no new effect reaches the incompatible worker')
    assert.equal(f.requests.some(request => request.path === '/shutdown'), false, 'inspection and rejection never stop an independent worker')
    assert.deepEqual(await f.port.get({ ...owner, operationId: 'original' }), f.fact)
    assert.deepEqual(await f.port.submit({ ...owner, kind: 'tool', operationId: 'original', declarationDigest: f.fact.declarationDigest }), f.fact)
    await assert.rejects(f.port.submit({ ...owner, kind: 'tool', operationId: 'original', declarationDigest: 'changed-original' }), { code: 'worker-operation-conflict' })
    assert.equal((await f.port.query({ attachmentId: owner.attachmentId, query: { kind: 'stat', path: repository } })).directory, true)
    await f.port.claimRun(owner)
    for (const kind of ['cancel', 'close-scope']) {
      const observed = await f.port.submit({ ...owner, kind, operationId: kind, declarationDigest: kind })
      assert.equal(observed.operationId, kind)
    }
    await f.port.shutdown()
    assert.equal(f.requests.filter(request => request.path === '/shutdown').length, 1)
  })
})

test('a cached live worker is checked again before each new tool effect', async t => {
  const f = await stub(t, { buildId: workerBuildId, runtime: { state: 'ready' } })
  assert.equal((await f.port.status()).state, 'running')
  await f.port.start()
  const tool = { ...owner, kind: 'tool', operationId: 'healthy-tool', declarationDigest: 'healthy-tool', workerBootId: 'boot' }
  assert.equal((await f.port.submit(tool)).operationId, tool.operationId)
  const count = f.requests.filter(request => request.path === '/info').length
  f.setReport({ buildId: workerBuildId, runtime: { state: 'unavailable', reason: 'process-unavailable' } })
  await assert.rejects(f.port.submit({ ...tool, operationId: 'later-tool' }), { code: 'worker-restart-required' })
  assert.ok(f.requests.filter(request => request.path === '/info').length > count, 'cached endpoint liveness cannot replace current worker health')
  assert.deepEqual(f.requests.filter(request => request.path === '/submit').map(request => request.input.operationId), ['healthy-tool'])
  assert.deepEqual(await f.port.get({ ...owner, operationId: 'original' }), f.fact)
})

async function finish(port, input) {
  for (let n = 0; n < 1_000; n++) {
    const operation = await port.get(input)
    if (operation && ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(operation.state)) return operation
    await delay(10)
  }
  assert.fail('the isolated worker operation did not finish')
}

test('a running packaged worker reports its own missing helper while original facts and explicit shutdown remain usable', { timeout: 90000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-worker-health-package-')))
  const workerDirectory = join(directory, 'worker'), consumer = join(directory, 'consumer')
  let child, childDone, diagnostics = ''
  const port = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false, async launch() {
    const entrypoint = join(consumer, 'node_modules/@anybox/app-harness/dist/entrypoints/computer-worker-main.js')
    child = spawn(process.execPath, [entrypoint, 'serve', workerDirectory], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString('utf8')).slice(-16_384) })
    childDone = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    void childDone.catch(() => {})
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  } })
  t.after(async () => {
    try { await port.shutdown() } catch { /* A failing fixture still owns its temporary worker. */ }
    await port.closeObserver()
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await childDone?.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  await stageProductionClosure(repository, consumer, ['@anybox/app-harness'])
  await writeFile(join(directory, 'example.txt'), 'an isolated search result\n')
  try { await port.start() } catch (error) { t.diagnostic(diagnostics); throw error }
  const info = await port.info()
  assert.equal(info.buildId, workerBuildId)
  assert.equal(info.runtime.state, 'ready')
  await port.claimRun(owner)
  const binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: 'local', computerInstanceId: `${info.workerId}:${info.bootId}`, instanceGeneration: 1, workspaceEpoch: 1,
    revision: 0, path: directory, preparedAt: 'now' }
  const tool = (operationId, toolId, args) => {
    const entry = getToolById(toolId)
    const declaration = { schemaVersion: 1, operationId, ...owner, sessionId: 'session', projectId: 'project',
      tool: { toolId: entry.toolId, version: entry.version, definition: entry.definition },
      request: { id: operationId, name: entry.definition.name, arguments: args }, workspaceId: binding.workspaceId,
      workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    return { ...owner, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: info.bootId }
  }
  const glob = tool('original-glob', 'claude-code.Glob', { pattern: '*.txt' })
  await port.submit(glob)
  const original = await finish(port, glob)
  assert.equal(original.state, 'succeeded')
  assert.ok(original.observation.result.paths.some(path => path.endsWith('example.txt')))
  const command = tool('original-command', 'codex.exec_command', { cmd: 'echo worker-ready', yield_time_ms: 1_000 })
  await port.submit(command)
  const commandFact = await finish(port, command)
  assert.equal(commandFact.observation.result.exit_code, 0)
  assert.match(commandFact.observation.result.output, /worker-ready/)

  // Change only this independently staged package. Other tests and the developer's worker keep their own files.
  const helper = join(consumer, 'node_modules/@anybox/computer-tools/dist/platform/native', process.platform === 'win32' ? 'anybox-process-host.exe' : 'anybox-process-host')
  await rm(helper)
  const unhealthy = await port.info()
  assert.equal(unhealthy.bootId, info.bootId, 'the worker still holds its original process and code')
  assert.equal(unhealthy.buildId, info.buildId, 'removing a resource cannot turn the loaded code into another build')
  assert.equal(unhealthy.runtime.state, 'unavailable')
  assert.equal(unhealthy.runtime.reason, 'process-unavailable')
  const buildReceipt = join(consumer, 'node_modules/@anybox/app-harness/dist/core/computer/worker-build.json')
  const originalReceipt = await readFile(buildReceipt)
  try {
    await writeFile(buildReceipt, JSON.stringify({ ...JSON.parse(originalReceipt), buildId: '0'.repeat(64) }))
    const changed = await port.info()
    assert.equal(changed.buildId, info.buildId, 'the running implementation keeps its loaded identity after a build replaces the receipt')
    assert.deepEqual(changed.runtime, { state: 'unavailable', reason: 'build-changed' })
    assert.deepEqual(await port.get({ ...owner, operationId: glob.operationId }), original)
  } finally { await writeFile(buildReceipt, originalReceipt) }
  assert.deepEqual((await port.info()).runtime, { state: 'unavailable', reason: 'process-unavailable' }, 'restoring the receipt still detects the missing helper')
  const status = await port.status()
  assert.equal(status.state, 'restart-required')
  assert.equal(status.reason, 'worker-runtime-unavailable')
  assert.deepEqual(await port.get({ ...owner, operationId: glob.operationId }), original)
  assert.equal((await port.submit(glob)).receipt, original.receipt, 'an accepted original request remains observable through the server duplicate check')
  await assert.rejects(port.submit({ ...glob, declarationDigest: 'changed-original' }), { code: 'worker-operation-conflict' })
  await assert.rejects(port.submit({ ...glob, binding: { ...glob.binding, workspaceEpoch: 2 } }), { code: 'worker-operation-conflict' })
  await assert.rejects(port.submit({ ...glob, kind: 'cancel' }), { code: 'worker-operation-conflict' })
  const denied = tool('denied-write', 'claude-code.Write', { file_path: 'must-not-exist.txt', content: 'unexpected effect' })
  await assert.rejects(port.submit(denied), { code: 'worker-restart-required' })
  const endpoint = JSON.parse(await readFile(join(workerDirectory, 'endpoint.json'), 'utf8'))
  const oldBoot = { ...tool('stale-boot-write', 'claude-code.Write', { file_path: 'must-not-exist.txt', content: 'unexpected effect' }), workerBootId: 'retired-boot' }
  const oldBootResponse = await fetch(`${endpoint.url}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify(oldBoot) })
  assert.equal(oldBootResponse.ok, false)
  assert.equal((await oldBootResponse.json()).error, 'worker-instance-replaced', 'raw worker admission preserves the old-boot failure before checking runtime health')
  const response = await fetch(`${endpoint.url}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify(denied) })
  assert.equal(response.ok, false, 'the worker also guards a client that bypasses the local proxy')
  assert.equal((await response.json()).error, 'worker-restart-required')
  assert.equal(await port.get({ ...owner, operationId: denied.operationId }), undefined, 'rejection does not accept an operation')
  await assert.rejects(readFile(join(directory, 'must-not-exist.txt')), { code: 'ENOENT' })
  const close = { ...owner, kind: 'close-scope', operationId: 'close-original', declarationDigest: 'close-original' }
  await port.submit(close)
  assert.equal((await finish(port, close)).observation.cleanup, 'completed')
  await port.shutdown()
  assert.equal((await port.status()).state, 'stopped')
})

import assert from 'node:assert/strict'
import { symlinkSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fork, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createHostAccessComponent } from '../packages/host/dist/access.js'
import { hostHttpServiceKey } from '../packages/host/dist/component.js'
import { installHarnessServerCore } from '../packages/app-harness/dist/core/index.js'
import { createImageAssetsComponent } from '../packages/app-harness/dist/core/image/component.js'
import { fullScope } from '../packages/app-harness/dist/core/unit/domain.js'
import { unitTransportServiceKey } from '../packages/app-harness/dist/core/unit/transport-component.js'
import { openComputerWorker } from '../packages/app-harness/dist/core/computer/worker-server.js'
import { connectLocalComputerWorker } from '../packages/app-harness/dist/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../packages/app-harness/dist/core/computer/operations-domain.js'
import { workerBootOf } from '../packages/app-harness/dist/core/computer/worker-port.js'
import { createFixtureApplicationApiComponent } from './helpers/application-api.mjs'
import { controlledModels } from './helpers/controlled-models.mjs'

const childFixture = fileURLToPath(new URL('./helpers/unit-harness-process.mjs', import.meta.url))
const unitFixture = fileURLToPath(new URL('./helpers/unit-worker-process.mjs', import.meta.url))
/** A real worker process on `directory`; `kill()` is the unclean exit no cleanup ever records. */
async function openUnitProcess(directory, keyringFile, dialout) {
  const child = fork(unitFixture, [JSON.stringify({ directory, keyringFile, dialout })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const ready = await new Promise((resolve, reject) => {
    child.once('message', message => message.event === 'ready' ? resolve(message) : reject(new Error(message.error?.message ?? 'unit fixture failed')))
    child.once('exit', code => reject(new Error(`unit fixture exited with ${code}`)))
  })
  const exited = () => child.exitCode !== null || child.signalCode !== null
  return { endpoint: ready.endpoint, processId: child.pid,
    async close() { if (exited()) return; const gone = once(child, 'exit'); child.send({ command: 'shutdown' }); await gone },
    async kill() { if (exited()) return; const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone } }
}
const memoryEntries = () => {
  const memory = new Map()
  return { memory, openEntry: (service, id) => ({ getPassword: async () => memory.get(`${service}:${id}`), setPassword: async value => { memory.set(`${service}:${id}`, value) }, deleteCredential: async () => memory.delete(`${service}:${id}`) }) }
}
async function until(check, message, limit = 60_000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`timed out: ${message}`)
}
const exists = path => existsSync(path)
/** The script a controlled model follows: one tool call per queued entry, then "done" after the tool result. */
function scriptedModels(script) {
  return controlledModels({ call(input) {
    const result = (async () => {
      const last = input.messages.at(-1)
      if (last?.role === 'tool') { const value = JSON.parse(last.content); return { status: 'completed', text: value.stdout ?? 'done', toolCalls: [] } }
      const next = script.shift()
      return next ? { status: 'completed', text: '', toolCalls: [next] } : { status: 'completed', text: 'nothing', toolCalls: [] }
    })()
    void result.catch(() => {})
    return { result, done: Promise.resolve(), cancel() {} }
  } })
}

/** One in-process harness server (local form, no local worker started) with one remote-bound project served by an in-process unit. */
async function harnessWithUnit(t, { dialoutFetch, expectCleanupFailure = false, unitProcess = false, requestedScope = fullScope('computer'), replyTimeoutMs } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-unit-faults-')))
  const projectDirectory = join(directory, 'project'); await mkdir(projectDirectory)
  const root = new Context(), script = []
  const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Execute tools with their declared contracts.' }]
  const models = scriptedModels(script)
  await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  await root.installComponent(models.component())
  await root.installComponent(createHostAccessComponent('fault harness'))
  const core = await installHarnessServerCore(root, { agents, localWorkerDirectory: join(directory, 'never-started-local-worker'), computerUnit: { kind: 'local', claimTimeoutMs: 1_500, replyTimeoutMs: replyTimeoutMs ?? 2_500 } })
  const httpFiber = root.installComponent(createFixtureApplicationApiComponent(root, core.api.listAgents(), 0, { authenticated: true })); await httpFiber
  const web = root.get(hostHttpServiceKey)
  const { memory, openEntry } = memoryEntries()
  const unitDirectory = join(directory, 'unit-worker')
  const dialout = { pollWaitMs: 300, getWaitMs: 200, requestTimeoutMs: 5_000, ...(dialoutFetch ? { fetch: dialoutFetch } : {}) }
  const keyringFile = join(directory, 'unit-keyring.json')
  const openUnit = () => unitProcess ? openUnitProcess(unitDirectory, keyringFile, dialout) : openComputerWorker(unitDirectory, { openEntry, dialout })
  const f = { root, core, api: core.api, web, directory, projectDirectory, script, memory, unitDirectory,
    unit: await openUnit(), control: connectLocalComputerWorker({ directory: unitDirectory }),
    async reopenUnit() { await f.control.closeObserver(); await f.unit.close(); f.unit = await openUnit(); f.control = connectLocalComputerWorker({ directory: unitDirectory }); return f.unit },
    /** Unclean unit exit loses its durable cleanup receipt even when the native supervisor cleans the process tree. */
    async killUnit() { await f.control.closeObserver(); await f.unit.kill() },
    async respawnUnit() { f.unit = await openUnit(); f.control = connectLocalComputerWorker({ directory: unitDirectory }); return f.unit },
    instances: () => root.get('local-storage').read(reader => reader.all('SELECT instance_generation, status, provider_ref FROM harness_computer_instances ORDER BY instance_generation')),
    connected: () => root.get(unitTransportServiceKey).connection(f.attached.attachmentId)?.connected === true,
    execution: runId => root.get('harness.session-runs').getRunExecution(runId),
    operations: runId => root.get('local-storage').read(reader => reader.all('SELECT operation_id, state, worker_receipt, error_json, declaration_json, binding_json FROM harness_computer_operations WHERE run_id = ?', [runId])),
    pins: runId => root.get('local-storage').read(reader => reader.all('SELECT * FROM harness_computer_pins WHERE owner_id = ?', [runId])) }
  t.after(async () => {
    try {
      // A Run whose unit was revoked cannot prove its scope exited: closing reports the cleanup failure instead of hiding it.
      if (expectCleanupFailure) await assert.rejects(core.close(), /cleanup/)
      else await core.close()
    } finally {
      await f.control.closeObserver(); await f.unit.close().catch(() => {})
      await httpFiber.dispose()
      if (expectCleanupFailure) await root.fiber.dispose().catch(() => {}); else await root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
  const { code } = await core.api.createUnitAttachCode({ unitKind: 'computer', scope: typeof requestedScope === 'function' ? requestedScope(projectDirectory) : requestedScope })
  f.attached = await f.control.control.consumeAttachCode({ harnessUrl: web.url, code, ceiling: fullScope('computer') })
  await until(() => f.connected(), 'unit polls')
  const selection = await core.api.getAgentTools('assistant')
  await core.api.setAgentTools('assistant', { toolIds: ['anybox.bash'], expectedRevision: selection.revision })
  f.project = await core.api.openProject(projectDirectory, { computerAttachmentId: f.attached.attachmentId })
  f.session = await core.api.createSession(f.project.id, 'assistant')
  return f
}
const longCommand = (marker = 'once', sleep = 2, tail = "printf 'original-result'") => `printf '${marker}\\n' >> effect.log; printf started > started.flag; sleep ${sleep}; ${tail}`

test('a network interruption between the unit and the harness server delays the fact without repeating the side effect', { timeout: 180_000 }, async t => {
  let offline = false
  const f = await harnessWithUnit(t, { dialoutFetch: (url, init) => offline ? Promise.reject(new TypeError('network interrupted')) : fetch(url, init) })
  f.script.push({ id: 'call', name: 'bash', arguments: { command: longCommand('once', 2) } })
  const run = await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'interrupted' })
  await until(() => exists(join(f.projectDirectory, 'started.flag')), 'the unit started the command')
  offline = true
  try {
    await delay(4_000)
    assert.equal((await f.api.getRun(run.id)).status, 'running', 'an outage only delays: the Run stays running and is not failed')
    assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n')
  } finally { offline = false }
  const finished = await f.api.waitRun(run.id)
  assert.equal(finished.status, 'completed', JSON.stringify(finished.error ?? null)); assert.equal(finished.output, 'original-result')
  assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n', 'the command ran exactly once')
  const execution = await f.execution(run.id)
  assert.equal(execution.toolCalls, 1)
  const events = await f.api.getRunEvents(run.id)
  assert.equal(events.filter(event => event.kind === 'tool-observed').length, 1)
  const [operation] = await f.operations(run.id)
  assert.equal(operation.state, 'succeeded'); assert.equal(typeof operation.worker_receipt, 'string')
  assert.ok((await f.pins(run.id)).every(pin => pin.released_at !== null), 'the scope released its pins after the real exit')
})

test('a unit restart turns its in-flight command into a cancelled fact that the harness server consumes once, and a new generation serves later Runs', { timeout: 180_000 }, async t => {
  const f = await harnessWithUnit(t)
  f.script.push({ id: 'call', name: 'bash', arguments: { command: longCommand('once', 30, "printf never > never.flag") } })
  const run = await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'restart' })
  await until(() => exists(join(f.projectDirectory, 'started.flag')), 'the unit started the command')
  const firstBoot = f.unit.endpoint.bootId
  await f.reopenUnit()
  assert.notEqual(f.unit.endpoint.bootId, firstBoot)
  await until(() => f.connected() && f.root.get(unitTransportServiceKey).connection(f.attached.attachmentId).bootId === f.unit.endpoint.bootId, 'the new boot polls')
  const finished = await f.api.waitRun(run.id)
  assert.equal(finished.status, 'failed'); assert.equal(finished.errorCategory, 'tool-cancelled')
  assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n', 'the restart never replays the command')
  assert.equal(exists(join(f.projectDirectory, 'never.flag')), false)
  const [operation] = await f.operations(run.id)
  assert.equal(operation.state, 'cancelled')
  assert.ok((await f.pins(run.id)).every(pin => pin.released_at !== null), 'the previous boot recorded the scope cleanup and the new boot returned it')
  f.script.push({ id: 'again', name: 'bash', arguments: { command: 'printf back > back.txt' } })
  const again = await f.api.waitRun((await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'again', idempotencyKey: 'after-restart' })).id)
  assert.equal(again.status, 'completed', JSON.stringify(again.error ?? null))
  assert.equal(await readFile(join(f.projectDirectory, 'back.txt'), 'utf8'), 'back')
  const computers = await f.root.get('harness.computers').list()
  assert.equal(computers.length, 1)
})

test('revoking an attachment while a command runs rejects new declarations, cancels the unit side and settles the Run without replay', { timeout: 180_000 }, async t => {
  const f = await harnessWithUnit(t, { expectCleanupFailure: true })
  f.script.push({ id: 'call', name: 'bash', arguments: { command: longCommand('once', 30, "printf never > never.flag") } })
  const run = await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'revoked' })
  await until(() => exists(join(f.projectDirectory, 'started.flag')), 'the unit started the command')
  const revoked = await f.api.revokeUnitAttachment(f.attached.attachmentId)
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.epoch, 2)
  const local = await until(async () => (await f.control.control.listAttachments()).find(item => item.attachmentId === f.attached.attachmentId && item.state === 'revoked'), 'the unit observes the revocation')
  assert.equal(local.connection, 'revoked')
  // The durable revoked state precedes listeners and credential cleanup; observe actual deletion separately.
  await until(() => f.memory.size === 0, 'the unit dropped its credential')
  assert.equal(f.memory.size, 0, 'the unit dropped its credential')
  await assert.rejects(f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'more', idempotencyKey: 'after-revoke' }), error => ['project-unavailable', 'unit-attachment-state', 'unit-attachment-mismatch'].includes(error.code), 'new declarations for the revoked attachment are refused')
  const finished = await f.api.waitRun(run.id)
  assert.equal(finished.status, 'failed')
  assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n')
  await until(async () => (await f.control.get({ runId: run.id, runOwnerEpoch: 1, attachmentId: f.attached.attachmentId, operationId: (await f.operations(run.id))[0].operation_id }).catch(() => undefined))?.state === 'cancelled', 'the unit cancelled the in-flight command after revocation')
  assert.equal(exists(join(f.projectDirectory, 'never.flag')), false, 'the cancelled command did not complete')
  const [operation] = await f.operations(run.id)
  assert.equal(operation.state, 'outcome-unknown', 'the harness server keeps the placed operation as unknown: the revoked unit will not report it')
  assert.ok((await f.pins(run.id)).some(pin => pin.released_at === null), 'pins stay until a unit proves the scope exited')
})

test('SIGKILL of the unit keeps the dead boot\'s pin as a fact, retires its instance and serves later Runs on a new generation', { timeout: 180_000 }, async t => {
  const f = await harnessWithUnit(t, { unitProcess: true, expectCleanupFailure: true })
  // Native process cleanup cannot replace the durable scope receipt lost with the worker.
  f.script.push({ id: 'call', name: 'bash', arguments: { command: longCommand('once', 20) } })
  const run = await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'unclean' })
  await until(() => exists(join(f.projectDirectory, 'started.flag')), 'the unit started the command')
  const firstBoot = f.unit.endpoint.bootId
  await until(async () => (await f.pins(run.id)).length === 1, 'the Run pinned the first generation')
  await f.killUnit()
  await f.respawnUnit()
  assert.notEqual(f.unit.endpoint.bootId, firstBoot)
  await until(() => f.connected() && f.root.get(unitTransportServiceKey).connection(f.attached.attachmentId).bootId === f.unit.endpoint.bootId, 'the new boot polls')
  const finished = await f.api.waitRun(run.id)
  assert.equal(finished.status, 'failed')
  assert.equal(finished.errorCategory, 'tool-cleanup-failure', 'no boot observed the killed scope exit, so the Run cannot settle as a clean cancellation')
  assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n', 'the restart never replays the command')
  const [operation] = await f.operations(run.id)
  assert.equal(operation.state, 'outcome-unknown')
  assert.ok((await f.pins(run.id)).every(pin => pin.released_at === null), 'an unknown exit never releases the pin')
  // The same worker answered with a new boot, so the pinned instance is provably dead: later Runs get a new generation.
  f.script.push({ id: 'again', name: 'bash', arguments: { command: 'printf back > back.txt' } })
  const again = await f.api.waitRun((await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'again', idempotencyKey: 'after-unclean-restart' })).id)
  assert.equal(again.status, 'completed', JSON.stringify({ error: again.error ?? null, operations: await f.operations(again.id), events: await f.api.getRunEvents(again.id), instances: await f.instances() }))
  assert.equal(await readFile(join(f.projectDirectory, 'back.txt'), 'utf8'), 'back')
  const instances = await f.instances()
  assert.deepEqual(instances.map(row => [row.instance_generation, row.status]), [[1, 'retired'], [2, 'ready']])
  assert.equal(workerBootOf(instances[1].provider_ref), f.unit.endpoint.bootId)
  assert.ok((await f.pins(run.id)).every(pin => pin.released_at === null), 'retiring the dead instance keeps its pin unreleased')
})

test('SIGKILL of the harness server leaves the unit running; the replacement process reclaims the Run and consumes the original result once', { timeout: 180_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-unit-faults-restart-')))
  const projectDirectory = join(directory, 'project'); await mkdir(projectDirectory)
  const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) }) })
  const processes = []
  const start = settings => {
    const child = spawn(process.execPath, [childFixture, JSON.stringify({ directory, projectDirectory, port, command: longCommand('once', 6), ...settings })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const messages = [], pending = new Map(); let nextId = 0, diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-32_768) })
    child.on('message', message => {
      messages.push(message)
      if (message.id !== undefined) { const waiting = pending.get(message.id); if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); message.error ? waiting.reject(Object.assign(new Error(message.error.message), message.error)) : waiting.resolve(message.value) } }
    })
    child.on('exit', (code, signal) => { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(`harness server exited (${code ?? signal}): ${diagnostics}`)) } pending.clear() })
    const handle = { child,
      event: name => until(() => { const failed = messages.find(message => message.event === 'fixture-error'); if (failed) throw Object.assign(new Error(`${failed.error.message}\n${diagnostics}`), failed.error); if (child.exitCode !== null) throw new Error(`harness server exited before ${name}: ${diagnostics}`); return messages.find(message => message.event === name) }, name),
      request: (command, extra = {}) => new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`command ${command} timed out: ${diagnostics}`)) }, 90_000); pending.set(id, { resolve, reject, timer }); child.send({ id, command, ...extra }) }),
      async kill() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited } }
    processes.push(handle); return handle
  }
  const { memory, openEntry } = memoryEntries()
  let unit, control
  t.after(async () => {
    for (const handle of processes) await handle.kill()
    await control?.closeObserver(); await unit?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const first = start({ mode: 'begin' })
  const ready = await first.event('ready')
  const issued = await (await fetch(`${ready.url}/api/v1/apps/agent/units/attach-codes`, { method: 'POST', headers: { authorization: `Bearer ${ready.token}`, 'x-anybox-instance-id': ready.instanceId, 'content-type': 'application/json' }, body: JSON.stringify({ unitKind: 'computer', scope: fullScope('computer') }) })).json()
  unit = await openComputerWorker(join(directory, 'unit-worker'), { openEntry, dialout: { pollWaitMs: 300, getWaitMs: 200, requestTimeoutMs: 5_000 } })
  control = connectLocalComputerWorker({ directory: join(directory, 'unit-worker') })
  const attached = await control.control.consumeAttachCode({ harnessUrl: ready.url, code: issued.code, ceiling: fullScope('computer') })
  await until(async () => (await control.control.listAttachments())[0]?.connection === 'connected', 'unit polls the first process')
  const started = await first.request('start', { attachmentId: attached.attachmentId })
  await until(() => exists(join(projectDirectory, 'started.flag')), 'the unit started the command')
  const accepted = await until(async () => { const value = await first.request('report'); return value.operations[0]?.worker_receipt && ['starting', 'running'].includes(value.operations[0].state) ? value : undefined }, 'the first process holds a receipt')
  await first.kill()
  const second = start({ mode: 'resume', runId: started.runId })
  const restarted = await second.event('restarted')
  assert.notEqual(restarted.processId, ready.processId)
  const report = await second.request('wait')
  assert.equal(report.run.status, 'completed', JSON.stringify(report.run.error ?? null)); assert.equal(report.run.output, 'original-result')
  assert.equal(report.execution.toolCalls, 1); assert.equal(report.execution.modelCalls, 2)
  assert.equal(report.events.filter(event => event.kind === 'tool-observed').length, 1); assert.equal(report.nodes.nodes.length, 1)
  assert.equal(report.operations[0].worker_receipt, accepted.operations[0].worker_receipt, 'the replacement process consumed the original receipt')
  assert.equal(report.operations[0].state, 'succeeded')
  assert.ok(report.pins.every(pin => pin.released_at !== null))
  assert.equal(await readFile(join(projectDirectory, 'effect.log'), 'utf8'), 'once\n', 'the command ran exactly once across the restart')
  assert.equal((await readFile(join(directory, 'model-calls.jsonl'), 'utf8')).trim().split('\n').length, 2)
  assert.equal(memory.size, 1, 'the unit kept its credential and reconnected to the same instance')
  await second.request('shutdown')
})


test('an empty approved tool scope rejects a new tool before the worker receives it', { timeout: 30_000 }, async t => {
  const f = await harnessWithUnit(t, { requestedScope: { kind: 'computer', projects: 'all', tools: [] } })
  assert.deepEqual(f.attached.scope.tools, [])
  f.script.push({ id: 'blocked', name: 'bash', arguments: { command: 'printf forbidden > forbidden.txt' } })
  const run = await f.api.waitRun((await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'blocked-tool' })).id)
  assert.equal(run.status, 'failed')
  assert.equal(run.errorCategory, 'tool-unavailable')
  assert.equal(exists(join(f.projectDirectory, 'forbidden.txt')), false)
  const [operation] = await f.operations(run.id)
  assert.equal(operation.worker_receipt, null)
  assert.equal(await f.control.get({ attachmentId: f.attached.attachmentId, runId: run.id, runOwnerEpoch: 1, operationId: operation.operation_id }).catch(error => {
    if (error.code === 'worker-owner-rejected') return undefined
    throw error
  }), undefined, 'no remote Run ownership or tool declaration was dispatched')
  assert.ok((await f.pins(run.id)).every(pin => pin.released_at !== null))
})

test('the approved project scope limits remote queries even when the device ceiling is broader', { timeout: 30_000 }, async t => {
  const f = await harnessWithUnit(t, { requestedScope: project => ({ kind: 'computer', projects: [project], tools: 'all' }) })
  await assert.rejects(f.api.openProject(f.directory, { computerAttachmentId: f.attached.attachmentId }), { code: 'project-unavailable' })
  await assert.rejects(f.root.get('computer.worker').query({ attachmentId: f.attached.attachmentId, query: { kind: 'stat', path: f.directory } }), { code: 'worker-scope-rejected' })
  const allowed = await f.root.get('computer.worker').query({ attachmentId: f.attached.attachmentId, query: { kind: 'stat', path: f.projectDirectory } })
  assert.equal(allowed.directory, true)
})

test('a lost first submit receipt is recovered after the worker changes boot without repeating the side effect', { timeout: 30_000 }, async t => {
  let dropped = false
  const f = await harnessWithUnit(t, { replyTimeoutMs: 20_000, dialoutFetch: (url, init) => {
    if (String(url).endsWith('/replies') && !dropped) {
      const body = JSON.parse(init.body)
      if (body.replies?.some(reply => reply.value?.state === 'queued')) { dropped = true; return Promise.reject(new TypeError('lost initial submit receipt')) }
    }
    return fetch(url, init)
  } })
  f.script.push({ id: 'call', name: 'bash', arguments: { command: "printf 'once\n' >> effect.log; printf done" } })
  const run = await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'lost-first-submit' })
  await until(() => dropped, 'the worker accepted the submission but its reply was lost')
  const [placed] = await f.operations(run.id)
  assert.equal(placed.worker_receipt, null)
  const saved = await until(async () => {
    const op = await f.control.get({ attachmentId: f.attached.attachmentId, runId: run.id, runOwnerEpoch: 1, operationId: placed.operation_id })
    return op?.state === 'succeeded' ? op : undefined
  }, 'the worker saved the original tool result')
  assert.equal(saved.observation.result.stdout, 'done')
  await f.reopenUnit()
  const finished = await f.api.waitRun(run.id)
  assert.equal(finished.status, 'completed', JSON.stringify(finished.error ?? null))
  const [observed] = await f.operations(run.id)
  assert.equal(observed.state, 'succeeded')
  assert.equal(observed.worker_receipt, saved.receipt)
  assert.equal(await readFile(join(f.projectDirectory, 'effect.log'), 'utf8'), 'once\n')
  assert.equal((await f.api.getRunEvents(run.id)).filter(event => event.kind === 'tool-observed').length, 1)
})


test('new tools resolve approved project aliases on the worker and reject a broader-ceiling directory', { timeout: 30_000 }, async t => {
  const f = await harnessWithUnit(t, { requestedScope: project => {
    const alias = join(dirname(project), 'authorized-alias')
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    return { kind: 'computer', projects: [alias], tools: ['anybox.bash'] }
  } })
  f.script.push({ id: 'allowed', name: 'bash', arguments: { command: 'printf allowed' } })
  const run = await f.api.waitRun((await f.api.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'go', idempotencyKey: 'canonical-scope' })).id)
  assert.equal(run.status, 'completed', JSON.stringify(run.error ?? null))
  const [original] = await f.operations(run.id), runId = 'out-of-scope', operationId = 'out-of-scope-tool'
  const declaration = { ...JSON.parse(original.declaration_json), runId, operationId, workspaceId: 'outside-workspace' }
  const binding = { ...JSON.parse(original.binding_json), scopeId: runId, workspaceId: declaration.workspaceId, path: f.directory }
  await f.control.claimRun({ attachmentId: f.attached.attachmentId, runId, runOwnerEpoch: 1 })
  await assert.rejects(f.control.submit({ attachmentId: f.attached.attachmentId, runId, runOwnerEpoch: 1, operationId, kind: 'tool',
    declaration, binding, declarationDigest: computerDeclarationDigest(declaration), workerBootId: f.unit.endpoint.bootId }), { code: 'worker-scope-rejected' })
  assert.equal(await f.control.get({ attachmentId: f.attached.attachmentId, runId, runOwnerEpoch: 1, operationId }), undefined, 'rejected new work has no worker operation receipt')
})

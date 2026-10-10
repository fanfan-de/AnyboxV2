import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'

const unix = process.platform !== 'win32'
const childFixture = fileURLToPath(new URL('./helpers/computer-runtime-process.mjs', import.meta.url))
const boundary = 30_000

async function until(predicate, timeout = boundary) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('fault-injection boundary was not reached')
    await delay(20)
  }
}
function runtime(settings) {
  const child = spawn(process.execPath, [childFixture, JSON.stringify(settings)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = [], pending = new Map()
  let nextId = 0, diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-32_768) })
  child.on('message', message => {
    messages.push(message)
    if (message.id !== undefined) {
      const waiting = pending.get(message.id)
      if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); message.error ? waiting.reject(Object.assign(new Error(message.error.message), message.error)) : waiting.resolve(message.value) }
    }
  })
  child.on('exit', (code, signal) => {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(`Runtime exited (${code ?? signal}): ${diagnostics}`)) }
    pending.clear()
  })
  return {
    child,
    async event(name) {
      return until(() => {
        const failed = messages.find(message => message.event === 'fixture-error')
        if (failed) throw Object.assign(new Error(`${failed.error.message}\n${diagnostics}`), failed.error)
        if (child.exitCode !== null) throw new Error(`Runtime exited before ${name}: ${diagnostics}`)
        return messages.find(message => message.event === name)
      })
    },
    request(command, extra = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Runtime command ${command} timed out: ${diagnostics}`)) }, boundary)
        pending.set(id, { resolve, reject, timer })
        child.send({ id, command, ...extra })
      })
    },
    async kill() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited },
  }
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-computer-worker-resume-')))
  const processes = []
  const start = settings => { const value = runtime({ directory, ...settings }); processes.push(value); return value }
  t.after(async () => {
    for (const value of processes) await value.kill()
    // Explicit worker shutdown is separate from killing Runtime. It is also
    // needed when a failed assertion prevented the current Runtime closing.
    let connection
    try {
      connection = connectLocalComputerWorker({ directory: join(directory, 'worker'), startupTimeoutMs: 5_000, requestTimeoutMs: 5_000 })
      await connection.shutdown()
    } catch { /* A worker that was never activated has no accepted resources. */ }
    finally { await connection?.closeObserver?.() }
    await rm(directory, { recursive: true, force: true })
  })
  const read = name => readFile(join(directory, name), 'utf8')
  const calls = async () => (await read('model-calls.jsonl')).trim().split('\n').filter(Boolean).map(JSON.parse)
  return { directory, start, read, calls }
}
function facts(report, expectedOutput = 'original-result\n') {
  assert.equal(report.run.status, 'completed')
  assert.equal(report.run.output, expectedOutput)
  assert.equal(report.execution.toolCalls, 1)
  assert.equal(report.execution.modelCalls, 2)
  assert.equal(report.nodes.nodes.length, 1)
  assert.equal(report.events.filter(event => event.kind === 'tool-started').length, 1)
  assert.equal(report.events.filter(event => event.kind === 'tool-observed').length, 1)
  assert.equal(report.events.filter(event => event.kind === 'terminal').length, 1)
  assert.equal(report.resume.state.totalToolOutputBytes, Buffer.byteLength(expectedOutput))
  const tools = report.operations.filter(operation => JSON.parse(operation.declaration_json).request.name === 'bash')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].state, 'succeeded')
  assert.equal(tools[0].observed, 1)
}

test('SIGKILL Runtime leaves its independent worker alive; a new Runtime obtains the original Bash result without replay', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', command: "printf 'once\\n' >> effect.log; printf 'started\\n' > started.flag; while [ ! -f release.flag ]; do sleep 0.02; done; printf 'original-result\\n'" })
  const started = await first.event('started')
  await until(() => f.read('started.flag').catch(() => false))
  const accepted = await until(async () => {
    const value = await first.request('report')
    return value.operations[0]?.worker_receipt && ['queued', 'starting', 'running'].includes(value.operations[0].state) ? value : undefined
  })
  assert.equal(accepted.operations[0].observed, 0)
  assert.equal(accepted.run.status, 'running')
  const originalWorker = JSON.parse(await f.read('worker/endpoint.json'))
  assert.notEqual(originalWorker.pid, first.child.pid)
  await first.kill()
  assert.doesNotThrow(() => process.kill(originalWorker.pid, 0))
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  await writeFile(join(f.directory, 'release.flag'), 'continue')
  const report = await second.request('wait')
  facts(report)
  assert.equal(report.operations[0].worker_receipt, accepted.operations[0].worker_receipt)
  assert.equal(report.worker.pid, originalWorker.pid)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  await second.request('shutdown')
})

async function workerFixture(t) {
  const f = await fixture(t)
  const connection = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
  t.after(() => connection.closeObserver())
  const identity = await connection.info()
  const owner = { runId: 'worker-run', runOwnerEpoch: 1 }
  await connection.claimRun(owner)
  const binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
    computerId: 'local', computerInstanceId: `${identity.workerId}:${identity.bootId}`, instanceGeneration: 1, workspaceEpoch: 1,
    revision: 0, path: f.directory, preparedAt: 'now' }
  const submit = (operationId, name, args, toolId = 'anybox.bash') => {
    const declaration = { schemaVersion: 1, operationId, runId: owner.runId, sessionId: 'session', projectId: 'project', tool: getToolById(toolId),
      request: { id: `${operationId}-call`, name, arguments: args }, workspaceId: 'workspace', workspaceRevision: 0,
      computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    return { ...owner, workerBootId: identity.bootId, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding }
  }
  const done = input => until(async () => {
    const value = await connection.get({ ...owner, operationId: input.operationId })
    return ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(value?.state) ? value : undefined
  })
  const close = async () => {
    const input = { ...owner, kind: 'close-scope', operationId: 'close-worker-run', declarationDigest: 'close-worker-run' }
    await connection.submit(input)
    return done(input)
  }
  return { ...f, connection, identity, owner, binding, submit, done, close }
}

test('worker receipts survive confirmation loss and ownership takeover rejects stale dispatch, reads and controls', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await workerFixture(t)
  const input = f.submit('original', 'bash', { command: "printf 'once\\n' >> effect.log; printf 'original-result\\n'" })
  const receipt = await f.connection.submit(input)
  const value = await f.done(input)
  assert.equal(value.executeCount, 1)
  assert.equal(value.state, 'succeeded')
  assert.equal(value.observation.result.stdout, 'original-result\n')
  assert.equal((await f.connection.submit(input)).receipt, receipt.receipt)
  await f.connection.claimRun({ ...f.owner, runOwnerEpoch: 2 })
  await assert.rejects(f.connection.submit(input), { code: 'worker-owner-rejected' })
  await assert.rejects(f.connection.get({ ...f.owner, operationId: input.operationId }), { code: 'worker-owner-rejected' })
  await assert.rejects(f.connection.claimRun(f.owner), { code: 'worker-owner-rejected' })
  await assert.rejects(f.connection.submit({ ...f.owner, kind: 'cancel', operationId: 'stale-cancel', declarationDigest: 'stale-cancel', targetOperationId: input.operationId }), { code: 'worker-owner-rejected' })
  f.owner.runOwnerEpoch = 2
  const recovered = await f.connection.submit({ ...input, runOwnerEpoch: 2 })
  assert.equal(recovered.receipt, receipt.receipt)
  assert.equal(recovered.executeCount, 1)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.close()).state, 'succeeded')
})

test('worker cancellation can pass its execution queue and durably cancel a never-started command', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await workerFixture(t)
  const first = f.submit('blocked', 'bash', { command: "printf 'started\\n' > started.flag; while [ ! -f release.flag ]; do sleep 0.02; done" })
  const queued = f.submit('queued', 'bash', { command: "printf 'must-not-run\\n' > queued-effect.log" })
  await f.connection.submit(first)
  await until(() => f.read('started.flag').catch(() => false))
  await f.connection.submit(queued)
  const cancelQueued = { ...f.owner, operationId: 'cancel-queued', kind: 'cancel', declarationDigest: 'cancel-queued', targetOperationId: queued.operationId }
  await f.connection.submit(cancelQueued)
  assert.equal((await f.done(cancelQueued)).state, 'succeeded')
  const neverStarted = await f.done(queued)
  assert.equal(neverStarted.state, 'cancelled')
  assert.equal(neverStarted.executeCount, 0)
  assert.equal(neverStarted.error.category, 'cancelled')
  const repeated = await f.connection.submit(queued)
  assert.equal(repeated.receipt, neverStarted.receipt)
  assert.equal(repeated.executeCount, 0)
  const reobserved = await f.connection.get({ ...f.owner, operationId: queued.operationId })
  assert.equal(reobserved.receipt, neverStarted.receipt)
  assert.equal(reobserved.executeCount, 0)
  assert.equal(reobserved.error.category, 'cancelled')
  assert.equal(await f.read('queued-effect.log').catch(() => 'absent'), 'absent')
  const cancelFirst = { ...f.owner, operationId: 'cancel-blocked', kind: 'cancel', declarationDigest: 'cancel-blocked', targetOperationId: first.operationId }
  await f.connection.submit(cancelFirst)
  assert.equal((await f.done(cancelFirst)).state, 'succeeded')
  assert.equal((await f.done(first)).state, 'cancelled')
  assert.equal((await f.close()).state, 'succeeded')
})

test('a worker crash preserves unknown execution facts and refuses replay, new side effects or a false scope exit', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await workerFixture(t)
  const original = f.submit('unknown', 'bash', { command: "printf '%s\\n' \"$$\" > shell.pid; printf 'once\\n' >> effect.log; while [ ! -f release.flag ]; do sleep 0.02; done; printf 'too-late\\n'" })
  await f.connection.submit(original)
  const shellPid = Number(await until(() => f.read('shell.pid').catch(() => false)))
  const endpoint = JSON.parse(await f.read('worker/endpoint.json'))
  let recovered
  try {
    process.kill(endpoint.pid, 'SIGKILL')
    await f.connection.closeObserver()
    await until(() => { try { process.kill(endpoint.pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
    recovered = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
    const newWorker = await recovered.info()
    assert.notEqual(newWorker.bootId, f.identity.bootId)
    await recovered.claimRun(f.owner)
    const fact = await recovered.get({ ...f.owner, operationId: original.operationId })
    assert.equal(fact.state, 'outcome-unknown')
    assert.equal(fact.executeCount, 1)
    const repeated = await recovered.submit(original)
    assert.equal(repeated.receipt, fact.receipt)
    assert.equal(repeated.executeCount, 1)
    assert.equal(repeated.state, 'outcome-unknown')
    const unsafe = f.submit('unsafe-new', 'bash', { command: "printf 'must-not-run\\n' > new-effect.log" })
    await assert.rejects(recovered.submit(unsafe), { code: 'worker-instance-replaced' })
    await assert.rejects(recovered.submit({ ...unsafe, workerBootId: newWorker.bootId }), { code: 'worker-scope-unknown' })
    const close = { ...f.owner, operationId: 'unknown-close', kind: 'close-scope', declarationDigest: 'unknown-close' }
    await recovered.submit(close)
    const exit = await until(async () => {
      const operation = await recovered.get({ ...f.owner, operationId: close.operationId })
      return ['failed', 'outcome-unknown'].includes(operation?.state) ? operation : undefined
    })
    assert.equal(exit.error.code, 'worker-scope-unknown')
    assert.equal(await f.read('effect.log'), 'once\n')
    assert.equal(await f.read('new-effect.log').catch(() => 'absent'), 'absent')
  } finally {
    // This PID came from our isolated command before the crash. The implementation
    // itself deliberately does not treat a persisted PID as a recovery credential.
    try { process.kill(-shellPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (recovered) await assert.rejects(recovered.shutdown(), { code: 'worker-cleanup-failed' })
    await recovered?.closeObserver()
  }
})

test('Codex process identity survives observer replacement; repeated stdin and output receipt do not write or drain twice', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await workerFixture(t)
  const exec = f.submit('exec', 'codex_exec_command', {
    cmd: 'while IFS= read -r line; do printf \'%s\\n\' "$line" >> stdin.log; printf \'echo=%s\\n\' "$line"; done',
    yield_time_ms: 0,
  }, 'codex.exec_command')
  await f.connection.submit(exec)
  const processFact = await f.done(exec)
  assert.equal(processFact.state, 'succeeded')
  const sessionId = processFact.observation.result.session_id
  assert.equal(typeof sessionId, 'number')
  assert.equal(processFact.processRef.sessionId, sessionId)
  assert.equal(processFact.processRef.computerInstanceId, f.binding.computerInstanceId)
  await f.connection.closeObserver()
  const fresh = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
  t.after(() => fresh.closeObserver())
  f.owner.runOwnerEpoch = 2
  await fresh.claimRun(f.owner)
  const write = f.submit('stdin', 'codex_write_stdin', { session_id: sessionId, chars: 'hello\n', yield_time_ms: 100 }, 'codex.write_stdin')
  const receipt = await fresh.submit(write)
  const observation = await until(async () => {
    const value = await fresh.get({ ...f.owner, operationId: write.operationId })
    return value?.state === 'succeeded' ? value : undefined
  })
  assert.equal(observation.executeCount, 1)
  assert.equal(observation.observation.result.output, 'echo=hello\n')
  const again = await fresh.submit(write)
  assert.equal(again.receipt, receipt.receipt)
  assert.deepEqual(again.observation, observation.observation)
  assert.equal(again.executeCount, 1)
  assert.equal(await f.read('stdin.log'), 'hello\n')
  await assert.rejects(fresh.submit({ ...write, runOwnerEpoch: 1 }), { code: 'worker-owner-rejected' })
  const poll = f.submit('output-poll', 'codex_write_stdin', { session_id: sessionId, chars: '', yield_time_ms: 0 }, 'codex.write_stdin')
  await fresh.submit(poll)
  const polled = await until(async () => {
    const value = await fresh.get({ ...f.owner, operationId: poll.operationId })
    return value?.state === 'succeeded' ? value : undefined
  })
  assert.equal(polled.observation.result.output, '')
  const close = { ...f.owner, operationId: 'close-process', kind: 'close-scope', declarationDigest: 'close-process' }
  await fresh.submit(close)
  const closed = await until(async () => {
    const value = await fresh.get({ ...f.owner, operationId: close.operationId })
    return value?.state === 'succeeded' ? value : undefined
  })
  assert.equal(closed.executeCount, 1)
  assert.equal((await fresh.submit(close)).receipt, closed.receipt)
  assert.deepEqual((await fresh.submit(close)).observation, closed.observation)
})

test('losing worker acceptance confirmation returns the original receipt and executes and counts Bash once', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const child = f.start({ mode: 'begin', fault: 'accept-confirmation', command: "printf 'once\\n' >> effect.log; printf 'original-result\\n'" })
  await child.event('started')
  await child.event('accept-confirmation-lost')
  const report = await child.request('wait')
  facts(report)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  await child.request('shutdown')
})

test('SIGKILL after Session commits observation but before confirmation does not consume or count the result twice', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', fault: 'consume-confirmation', command: "printf 'once\\n' >> effect.log; printf 'original-result\\n'" })
  const started = await first.event('started')
  await first.event('consume-confirmation-lost')
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  facts(report)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  await second.request('shutdown')
})

test('a real second-file permission failure and Runtime crash retain the original partial patch without replay', { skip: !unix || process.getuid?.() === 0, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const protectedDirectory = join(f.directory, 'protected')
  await mkdir(protectedDirectory)
  await chmod(protectedDirectory, 0o555)
  t.after(() => chmod(protectedDirectory, 0o755).catch(() => {}))
  const patch = '*** Begin Patch\n*** Add File: first.txt\n+original\n*** Add File: protected/second.txt\n+pending\n*** End Patch'
  const first = f.start({ mode: 'begin', fault: 'consume-confirmation', patch })
  const started = await first.event('started')
  await first.event('consume-confirmation-lost')
  assert.equal(await f.read('first.txt'), 'original\n')
  assert.equal(await f.read('protected/second.txt').catch(() => 'absent'), 'absent')
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  assert.equal(report.run.status, 'completed')
  assert.equal(report.execution.toolCalls, 1)
  assert.equal(report.events.filter(event => event.kind === 'tool-observed').length, 1)
  assert.equal(report.nodes.nodes.length, 1)
  const value = JSON.parse(report.run.output)
  assert.equal(value.status, 'partial')
  assert.deepEqual(value.changes, [{ kind: 'added', path: 'first.txt' }])
  assert.deepEqual(value.pending, [{ kind: 'add', path: 'protected/second.txt' }])
  assert.equal(await f.read('first.txt'), 'original\n')
  assert.equal(await f.read('protected/second.txt').catch(() => 'absent'), 'absent')
  assert.equal((await f.calls()).length, 2)
  await second.request('shutdown')
  await chmod(protectedDirectory, 0o755)
})

test('a persisted cancellation during a transport outage resumes cancelling and waits for the original worker exit', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', fault: 'cancel-offline', command: "printf 'once\\n' >> effect.log; printf 'started\\n' > started.flag; printf 'before-cancel\\n'; while [ ! -f release.flag ]; do sleep 0.02; done" })
  const started = await first.event('started')
  await until(() => f.read('started.flag').catch(() => false))
  const cancelled = first.request('cancel')
  void cancelled.catch(() => {})
  await first.event('cancel-transport-offline')
  const coordinating = await first.request('report')
  assert.equal(coordinating.run.status, 'cancelling')
  assert.equal(coordinating.nodes.nodes.length, 0)
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  assert.equal(report.run.status, 'cancelled')
  assert.equal(report.nodes.nodes.length, 0)
  assert.equal(report.execution.toolCalls, 1)
  assert.equal(report.events.filter(event => event.kind === 'terminal').length, 1)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 1)
  await second.request('shutdown')
})

test('SIGKILL after a durable scope close receipt resumes original cleanup and creates only one successful node', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', fault: 'close-confirmation', command: "printf 'once\\n' >> effect.log; printf 'original-result\\n'" })
  const started = await first.event('started')
  await first.event('close-confirmation-lost')
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  facts(report)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  await second.request('shutdown')
})

test('SIGKILL after final settlement commits returns the original successful node and terminal event', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', fault: 'settlement-confirmation', command: "printf 'once\\n' >> effect.log; printf 'original-result\\n'" })
  const started = await first.event('started')
  await first.event('settlement-confirmation-lost')
  const committed = await first.request('report')
  facts(committed)
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  facts(report)
  assert.equal(report.run.resultNodeId, committed.run.resultNodeId)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  await second.request('shutdown')
})

test('a model request without a saved response is interrupted after SIGKILL and is not reissued or allowed to activate computer', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'model-pending', command: 'must never execute' })
  const started = await first.event('started')
  await first.event('model-pending')
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await second.request('wait')
  assert.equal(report.run.status, 'interrupted')
  assert.equal(report.worker, undefined)
  assert.equal(report.operations.length, 0)
  assert.equal(report.execution.toolCalls, 0)
  assert.equal((await f.calls()).length, 1)
  await second.request('shutdown')
})

test('an account epoch change rejects resume and fails only after the original worker command exits and pins release', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'begin', command: "printf 'once\\n' >> effect.log; printf 'started\\n' > started.flag; while [ ! -f release.flag ]; do sleep 0.02; done" })
  const started = await first.event('started')
  await until(() => f.read('started.flag').catch(() => false))
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId, changedAccountEpoch: true })
  await second.event('restarted')
  const report = await second.request('wait')
  assert.equal(report.run.status, 'failed')
  assert.equal(report.run.errorCategory, 'dependency-unavailable')
  assert.equal(report.nodes.nodes.length, 0)
  assert.equal(report.pins.length, 1)
  assert.notEqual(report.pins[0].released_at, null)
  assert.equal(report.scopes[0].closed, 1)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 1)
  const worker = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
  try {
    const operation = await worker.get({ runId: started.runId, runOwnerEpoch: report.resume.state.runOwnerEpoch, operationId: report.operations[0].operation_id })
    assert.equal(operation.state, 'cancelled')
    assert.equal(operation.executeCount, 1)
  } finally { await worker.closeObserver() }
  await second.request('shutdown')
})

test('SIGKILL while the next model response is pending interrupts the Run but drains its previously yielded process', { skip: !unix, timeout: 90_000 }, async t => {
  const f = await fixture(t)
  const first = f.start({ mode: 'process-model-pending', toolName: 'codex_exec_command', toolArgs: {
    cmd: "printf 'once\\n' >> effect.log; printf 'started\\n' > started.flag; while [ ! -f release.flag ]; do sleep 0.02; done",
    yield_time_ms: 100,
  } })
  const started = await first.event('started')
  await first.event('model-pending')
  await first.kill()
  const second = f.start({ mode: 'resume', runId: started.runId })
  await second.event('restarted')
  const report = await until(async () => {
    const value = await second.request('report')
    return value.scopes[0]?.closed === 1 && value.pins[0]?.released_at !== null ? value : undefined
  })
  assert.equal(report.run.status, 'interrupted')
  assert.equal(report.execution.toolCalls, 1)
  assert.equal(report.nodes.nodes.length, 0)
  assert.notEqual(report.pins[0].released_at, null)
  assert.equal(await f.read('effect.log'), 'once\n')
  assert.equal((await f.calls()).length, 2)
  const worker = connectLocalComputerWorker({ directory: join(f.directory, 'worker') })
  try {
    const close = await worker.get({ runId: started.runId, runOwnerEpoch: report.resume.state.runOwnerEpoch, operationId: `${started.runId}:computer-close-scope` })
    assert.equal(close.state, 'succeeded')
    assert.equal(close.executeCount, 1)
    assert.equal(close.observation.processes.length, 1)
  } finally { await worker.closeObserver() }
  await second.request('shutdown')
})

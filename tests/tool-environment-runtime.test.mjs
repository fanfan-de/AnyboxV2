import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createImageAssetsComponent } from '../packages/app-harness/dist/core/image/component.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { controlledModels, deferred, modelSnapshot } from './helpers/controlled-models.mjs'
import { completedOutcome, nativeRegistration, sessionInitialization } from './helpers/native-records.mjs'

const immediate = result => ({ result: Promise.resolve(result), done: Promise.resolve(), cancel() {} })
const echo = Object.freeze({ toolId: 'sample.echo', version: '1', definition: {
  name: 'sample_echo', description: 'Echo a value from the inserted sample environment.',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
} })

function environment(events, options = {}) {
  return { environmentId: 'sample', version: '1', tools: [echo],
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }), openScope(context) {
    events.push({ kind: 'open', scopeId: context.scopeId })
    let used = false
    return {
      execute(request) {
        used = true
        events.push({ kind: 'execute', request })
        return options.execute?.(request, context) ?? immediate({ result: request.arguments.value })
      },
      hasResources: () => used,
      async cancel() { events.push({ kind: 'cancel' }); await options.cancel?.() },
      close() { events.push({ kind: 'close', aborted: context.signal.aborted }); return options.close?.() ?? immediate({ closed: true }) },
    }
  } }
}

/** Stop after durable tool admission, leaving the original native reply available for takeover. */
async function admitUnobservedTool(f, runId, admitted) {
  const records = f.root.get('harness.session-runs'), protocols = f.root.get('harness.protocol-agents')
  const input = { sessionId: f.session.id, parentNodeId: null, input: 'Recover the original tool operation', idempotencyKey: runId }
  const initialization = sessionInitialization(f.session, [], f.session.toolSelection.tools.map(tool => tool.definition))
  const controller = new AbortController()
  const program = await protocols.prepare({ runId, sessionId: f.session.id, modelId: 'default', signal: controller.signal,
    initialization, input: { schemaVersion: 1, raw: input.input, text: input.input, template: null } })
  let operationId
  try {
    await records.registerRun(runId, input, 'now', [], program.modelSnapshot,
      { binding: program.binding, initialization, input: program.input, parentContextRef: null })
    const executing = program.execute({ signal: controller.signal, publish() {},
      async perform(descriptor, start) {
        await records.startOperation(runId, { id: descriptor.id, kind: descriptor.kind, intent: descriptor.intent, records: descriptor.records }, 'now', 1)
        const call = start()
        let value
        try { value = await call.result } finally { await call.done }
        await records.observeOperation(runId, descriptor.id, { kind: 'value', ...descriptor.observe(value) }, 'now', 1)
        return value
      },
      async executeTools(requests, scheduling, batchId) {
        assert.equal(scheduling, 'serial')
        assert.equal(requests.length, 1)
        operationId = `${runId}:tool:${batchId}:0`
        await records.saveRunResume(runId, 1, { batch: { id: batchId, requests, operationIds: [operationId] } }, 'now')
        const request = requests[0]
        await records.startOperation(runId, { id: operationId, kind: 'tool', tool: request,
          intent: { name: request.name, requestId: request.id, arguments: request.arguments } }, 'now', 1)
        admitted(operationId)
        throw new Error('simulated Runtime loss before observing the accepted tool operation')
      },
    })
    await until(() => f.llm.calls.length === 1)
    f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'original-call', name: echo.definition.name, arguments: { value: 'original argument' } }] })
    f.llm.calls[0].done.resolve()
    await executing
    assert.ok(operationId)
    assert.equal((await records.getRunOperation(runId, operationId)).observation, undefined)
  } finally { try { await program.close() } finally { program.release() } }
  return { records, protocols, operationId, resume: await records.claimRunResume(runId, 1, 'takeover') }
}

async function fixture(provider, environmentIds = ['sample']) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-tool-environment-')))
  const root = new Context(), llm = controlledModels()
  await root.installComponent(llm.component())
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  const harness = await createTestHarnessServerCore(root, {
    agents: [{ id: 'assistant', instructions: 'Use only the tools supplied by your environments.', modelId: 'default', environmentIds }],
    toolEnvironments: [provider],
  }, { legacyTools: false })
  const project = await harness.openProject(directory), session = await harness.createSession(project.id, 'assistant')
  return { directory, root, llm, harness, session,
    async close(expectedFailure = false) {
      llm.calls.forEach(call => call.done.resolve())
      try { if (expectedFailure) await assert.rejects(harness.close()); else await harness.close() }
      finally { rmSync(directory, { recursive: true, force: true }) }
    },
  }
}

async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('tool environment did not reach the expected lifecycle boundary')
}

test('an inserted non-Computer environment determines tools and runs through the native Agent loop', { timeout: 15000 }, async () => {
  const events = [], f = await fixture(environment(events))
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Echo this task', idempotencyKey: 'echo' })
    assert.deepEqual(f.llm.calls[0].input.tools.map(tool => tool.name), ['sample_echo'])
    assert.deepEqual(f.session.toolEnvironments.environments.map(value => value.environmentId), ['sample'])
    f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'echo-call', name: 'sample_echo', arguments: { value: 'environment result' } }] })
    f.llm.calls[0].done.resolve()
    await until(() => f.llm.calls.length === 2)
    assert.equal(JSON.parse(f.llm.calls[1].input.messages.find(message => message.role === 'tool').content), 'environment result')
    f.llm.calls[1].result.resolve('complete'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'completed', JSON.stringify(finished))
    assert.ok(finished.resultNodeId)
    assert.equal(finished.units, undefined)
    const observed = (await f.harness.getRunEvents(run.id)).find(event => event.kind === 'tool-observed')
    assert.equal(observed.name, 'sample_echo'); assert.equal(observed.result, 'environment result')
    assert.equal(events.filter(event => event.kind === 'execute').length, 1)
    assert.equal(events.find(event => event.kind === 'execute').request.resuming, false)
    assert.equal(events.filter(event => event.kind === 'close').length, 1)
    assert.equal(await f.root.get('local-storage').read(reader => Number(reader.get('SELECT COUNT(*) AS count FROM harness_computer_operations').count)), 0)
  } finally { await f.close() }
})

test('Runtime resumes an admitted custom operation by observing its original receipt without replaying its side effect', { timeout: 15000 }, async () => {
  const events = [], receipts = new Map()
  let executeCount = 0
  const f = await fixture(environment(events, { recovery: 'observe-existing', execute(request) {
    assert.equal(request.resuming, true)
    assert.ok(receipts.has(request.operationId), 'recovery must find the original operation')
    assert.equal(request.toolId, echo.toolId)
    assert.equal(request.version, echo.version)
    return immediate({ result: receipts.get(request.operationId) })
  } }))
  try {
    const runId = 'custom-receipt-takeover'
    const saved = await admitUnobservedTool(f, runId, operationId => {
      // The external operation completed once, but its result never reached the Run ledger.
      executeCount++
      receipts.set(operationId, 'original durable result')
    })
    assert.equal(saved.resume.state.runOwnerEpoch, 2)
    const program = await saved.protocols.prepareResume({ resume: saved.resume, signal: new AbortController().signal })
    const runtime = f.root.get('harness.run-runtime'), starting = runtime.start({ runId, program, resume: saved.resume })
    await until(() => f.llm.calls.length === 2)
    assert.equal(executeCount, 1)
    const recovered = events.filter(event => event.kind === 'execute')
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].request.operationId, saved.operationId)
    assert.equal(recovered[0].request.resuming, true)
    const feedback = f.llm.calls[1].input.messages.filter(message => message.role === 'tool')
    assert.equal(feedback.length, 1)
    assert.equal(JSON.parse(feedback[0].content), 'original durable result')
    f.llm.calls[1].result.resolve('recovered completion'); f.llm.calls[1].done.resolve()
    await starting
    const finished = await runtime.wait(runId)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.output, 'recovered completion')
    assert.equal(executeCount, 1)
    assert.equal(f.llm.calls.length, 2, 'only one additional model request follows the recovered tool result')
    assert.equal((await saved.records.getRunOperation(runId, saved.operationId)).observation.tool.result, 'original durable result')
  } finally { await f.close() }
})

test('Runtime does not redispatch an admitted custom operation when its environment has no recovery contract', { timeout: 15000 }, async () => {
  const events = [], f = await fixture(environment(events, { execute() { assert.fail('an unknown operation must never be executed again') } }))
  try {
    const runId = 'custom-unknown-takeover'
    const saved = await admitUnobservedTool(f, runId, () => {})
    const program = await saved.protocols.prepareResume({ resume: saved.resume, signal: new AbortController().signal })
    const runtime = f.root.get('harness.run-runtime')
    await runtime.start({ runId, program, resume: saved.resume })
    const finished = await runtime.wait(runId)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.errorCategory, 'tool-unavailable')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal(events.filter(event => event.kind === 'execute').length, 0)
    assert.equal(f.llm.calls.length, 1, 'the committed native reply is restored without another model request')
    assert.equal((await saved.records.getRunOperation(runId, saved.operationId)).observation.kind, 'error')
  } finally { await f.close() }
})

test('Computer and another environment supply independent tools to the same Run', { timeout: 15000 }, async () => {
  const events = [], f = await fixture(environment(events), ['computer', 'sample'])
  try {
    writeFileSync(join(f.directory, 'environment.txt'), 'Computer bytes')
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Use both environments', idempotencyKey: 'mixed' })
    assert.ok(f.llm.calls[0].input.tools.some(tool => tool.name === 'sample_echo'))
    assert.ok(f.llm.calls[0].input.tools.some(tool => tool.name === 'claude_code_Read'))
    f.llm.calls[0].result.resolve({ toolCalls: [
      { id: 'read', name: 'claude_code_Read', arguments: { file_path: 'environment.txt' } },
      { id: 'echo', name: 'sample_echo', arguments: { value: 'Other environment' } },
    ] })
    f.llm.calls[0].done.resolve()
    await until(() => f.llm.calls.length === 2)
    const feedback = f.llm.calls[1].input.messages.filter(message => message.role === 'tool')
    assert.match(feedback[0].content, /Computer bytes/)
    assert.equal(JSON.parse(feedback[1].content), 'Other environment')
    f.llm.calls[1].result.resolve('both completed'); f.llm.calls[1].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
    assert.equal(events.filter(event => event.kind === 'execute').length, 1)
  } finally { await f.close() }
})

test('cancelling a custom environment waits for the call and scope to actually exit', { timeout: 15000 }, async () => {
  const events = [], result = deferred(), exited = deferred(), closed = deferred()
  const f = await fixture(environment(events, {
    execute: () => ({ result: result.promise, done: exited.promise, cancel() { events.push({ kind: 'call-cancel' }) } }),
    cancel: () => { result.reject(Object.assign(new Error('cancelled'), { category: 'cancelled' })); return exited.promise },
    close: () => ({ result: Promise.resolve({ closed: true }), done: closed.promise, cancel() {} }),
  }))
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'cancel' })
    f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'wait', name: 'sample_echo', arguments: { value: 'waiting' } }] })
    f.llm.calls[0].done.resolve()
    await until(() => events.some(event => event.kind === 'execute'))
    let settled = false
    const waiting = f.harness.waitRun(run.id).then(value => { settled = true; return value })
    await f.harness.cancelRun(run.id)
    await until(() => events.some(event => event.kind === 'call-cancel'))
    await until(() => events.some(event => event.kind === 'cancel'))
    assert.equal(settled, false)
    exited.resolve()
    await until(() => events.some(event => event.kind === 'close'))
    assert.equal(settled, false)
    assert.equal(events.find(event => event.kind === 'close').aborted, true)
    closed.resolve()
    const finished = await waiting
    assert.equal(finished.status, 'cancelled')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal(f.llm.calls.length, 1)
  } finally { exited.resolve(); closed.resolve(); await f.close() }
})

test('custom environment cleanup failure preserves partial facts and prevents a successful node', { timeout: 15000 }, async () => {
  const events = [], partial = { remaining: 'resource-1' }
  const f = await fixture(environment(events, { close: () => {
    const done = Promise.reject(new Error('resource did not exit')); void done.catch(() => {})
    return { result: Promise.resolve(partial), done, cancel() {} }
  } }))
  try {
    const run = await f.harness.startRun({ sessionId: f.session.id, parentNodeId: null, input: 'cleanup', idempotencyKey: 'cleanup' })
    f.llm.calls[0].result.resolve({ toolCalls: [{ id: 'echo', name: 'sample_echo', arguments: { value: 'done' } }] }); f.llm.calls[0].done.resolve()
    await until(() => f.llm.calls.length === 2)
    f.llm.calls[1].result.resolve('must not publish'); f.llm.calls[1].done.resolve()
    const finished = await f.harness.waitRun(run.id)
    assert.equal(finished.status, 'failed'); assert.equal(finished.errorCategory, 'tool-cleanup-failure')
    assert.equal(finished.resultNodeId, undefined)
    const rows = await f.root.get('local-storage').read(reader => reader.all('SELECT intent_json, observation_json FROM harness_run_operations WHERE run_id = ?', [run.id]))
    const cleanup = rows.find(row => JSON.parse(row.intent_json).kind === 'tool-environment-cleanup')
    const fact = JSON.parse(cleanup.observation_json)
    assert.equal(fact.kind, 'cleanup-failed')
    assert.deepEqual(fact.result.environments, [{ environmentId: 'sample', result: partial }])
  } finally { await f.close(true) }
})

test('a recovered success proposal cannot override a newly failed environment exit', { timeout: 15000 }, async () => {
  const events = [], f = await fixture(environment(events, { close: () => {
    const done = Promise.reject(new Error('old environment exit is unknown')); void done.catch(() => {})
    return { result: Promise.resolve({ remaining: true }), done, cancel() {} }
  } }))
  let failedCleanup = false
  try {
    const records = f.root.get('harness.session-runs'), id = 'settling-environment-run'
    const input = { sessionId: f.session.id, parentNodeId: null, input: 'resume cleanup', idempotencyKey: id }
    const initialization = sessionInitialization(f.session, [], f.session.toolSelection.tools.map(tool => tool.definition))
    const registration = nativeRegistration(input, modelSnapshot(), [], null, initialization)
    await records.registerRun(id, input, 'now', [], modelSnapshot(), registration)
    const settlement = completedOutcome(id, 'saved success')
    await records.startOperation(id, { id: `exchange:${id}`, kind: 'model', intent: {}, records: [settlement.records[0]] }, 'now', 1)
    await records.observeOperation(id, `exchange:${id}`, { kind: 'value', records: settlement.records,
      protocolCursor: { schemaVersion: 1, protocolId: 'chat-completions', exchangeId: `exchange:${id}` } }, 'now', 1)
    await records.saveRunResume(id, 1, { stage: 'settling', settlement }, 'now')
    const resume = await records.claimRunResume(id, 1, 'takeover')
    const program = { initialization, binding: registration.binding, modelSnapshot: modelSnapshot(), input: registration.input,
      signal: new AbortController().signal,
      async execute() { assert.fail('settling recovery must not execute the model') },
      async close() { return { records: [], checkpoint: null, cleanup: 'completed' } }, release() {},
    }
    const finished = await f.root.get('harness.run-runtime').start({ runId: id, program, resume })
    failedCleanup = finished.errorCategory === 'tool-cleanup-failure'
    assert.equal(finished.status, 'failed'); assert.equal(finished.errorCategory, 'tool-cleanup-failure')
    assert.equal(finished.resultNodeId, undefined)
    assert.equal(f.llm.calls.length, 0)
    assert.equal(events.filter(event => event.kind === 'close').length, 1)
  } finally { await f.close(failedCleanup) }
})

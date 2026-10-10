import { Context } from '@nya/core'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../../dist/applications/harness/core/image/component.js'
import { createLocalComputerWorkerComponent } from '../../dist/applications/harness/core/computer/worker-client.js'
import { createTestHarnessServerCore } from './harness-server-core.mjs'
import { controlledModels, modelSnapshot } from './controlled-models.mjs'
import { validateRestore } from '../../packages/models/dist/execution.js'

// A real Runtime/Authority process. Its computer worker has an independent OS
// lifetime; the parent intentionally SIGKILLs this process without its cleanup.
const settings = JSON.parse(process.argv[2])
const root = new Context()
const reply = message => process.send?.(message)
const logFile = join(settings.directory, 'model-calls.jsonl')
let api, actualWorker
let missingReceipt = settings.fault === 'accept-confirmation'
let missingObservation = settings.fault === 'consume-confirmation'
let pendingModel
const models = controlledModels({ call(input) {
  const result = (async () => {
    await appendFile(logFile, `${JSON.stringify({ messages: input.messages, processId: process.pid })}\n`)
    if (settings.mode === 'model-pending') {
      reply({ event: 'model-pending' })
      pendingModel = new Promise(() => {})
      return pendingModel
    }
    const tool = input.messages.findLast(message => message.role === 'tool')
    if (tool && settings.mode === 'process-model-pending') {
      reply({ event: 'model-pending' })
      pendingModel = new Promise(() => {})
      return pendingModel
    }
    if (tool) {
      const value = JSON.parse(tool.content)
      return { status: 'completed', text: value.stdout ?? value.output ?? JSON.stringify(value), toolCalls: [] }
    }
    return { status: 'completed', text: '', toolCalls: [{ id: 'original-call',
      name: settings.toolName ?? (settings.patch === undefined ? 'bash' : 'apply_patch'),
      arguments: settings.toolArgs ?? (settings.patch === undefined ? { command: settings.command } : { patch: settings.patch }) }] }
  })()
  void result.catch(() => {})
  return { result, done: Promise.resolve(), cancel() {} }
} })

try {
  await root.installComponent(createLocalSqliteComponent(join(settings.directory, 'authority.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(settings.directory, 'images') }))
  await root.installComponent(models.component())
  if (settings.changedAccountEpoch) {
    const service = root.get('models'), open = service.openNative
    service.openNative = async input => {
      if (input.restore) validateRestore(input.restore, { ...modelSnapshot(), historyScopeEpoch: 'test-scope-after-account-change' }, models.protocol())
      return open(input)
    }
  }
  await root.installComponent(createLocalComputerWorkerComponent({ directory: join(settings.directory, 'worker') }))
  actualWorker = root.get('computer.worker')
  const submit = actualWorker.submit
  if (missingReceipt || ['cancel-offline', 'close-confirmation'].includes(settings.fault)) actualWorker.submit = async input => {
    if (settings.fault === 'cancel-offline' && input.kind === 'cancel') {
      reply({ event: 'cancel-transport-offline', operationId: input.operationId })
      throw Object.assign(new Error('injected cancel transport outage'), { name: 'ComputerWorkerError', code: 'worker-unavailable' })
    }
    const accepted = await submit(input)
    if (settings.fault === 'close-confirmation' && input.kind === 'close-scope') {
      reply({ event: 'close-confirmation-lost', operationId: input.operationId })
      await new Promise(() => {})
    }
    if (missingReceipt && input.kind === 'tool') {
      missingReceipt = false
      reply({ event: 'accept-confirmation-lost', operationId: input.operationId })
      throw Object.assign(new Error('injected durable accept confirmation loss'), { name: 'ComputerWorkerError', code: 'worker-unavailable' })
    }
    return accepted
  }
  api = await createTestHarnessServerCore(root, {
    agents: [{ id: 'assistant', modelId: 'default', instructions: 'Execute tools with their declared contracts.' }],
    localWorkerDirectory: join(settings.directory, 'worker'),
  })
  const sessions = root.get('harness.sessions'), records = root.get('harness.session-runs')
  if (settings.toolName?.startsWith('codex_')) {
    const selection = await sessions.getAgentTools('assistant')
    await sessions.setAgentTools('assistant', { toolIds: ['codex.exec_command', 'codex.write_stdin'], expectedRevision: selection.revision })
  }
  if (missingObservation) {
    const observe = records.observeOperation
    records.observeOperation = async (...args) => {
      await observe(...args)
      if (missingObservation && args[2].tool) {
        missingObservation = false
        reply({ event: 'consume-confirmation-lost', runId: args[0], operationId: args[1] })
        await new Promise(() => {})
      }
    }
  }
  if (settings.fault === 'settlement-confirmation') {
    const settle = records.settleRun
    records.settleRun = async (...args) => {
      const accepted = await settle(...args)
      reply({ event: 'settlement-confirmation-lost', runId: args[0] })
      await new Promise(() => {})
      return accepted
    }
  }
  let runId = settings.runId
  if (settings.mode !== 'resume') {
    const project = await api.openProject(settings.directory)
    const session = await sessions.createSession(project.id, 'assistant')
    const run = await api.startRun({ sessionId: session.id, parentNodeId: null, idempotencyKey: 'original-run', input: 'Execute the original operation' })
    runId = run.id
    reply({ event: 'started', runId, sessionId: session.id })
  } else reply({ event: 'restarted', runId })
  const report = async () => {
    const run = await sessions.getRun(runId)
    const db = root.get('local-storage')
    return { run, execution: await records.getRunExecution(runId), resume: await records.loadRunResume(runId),
      events: await sessions.getRunEvents(runId), records: await sessions.getRunRecords(runId),
      nodes: run ? await sessions.listNodes(run.sessionId, null) : undefined,
      operations: await db.read(reader => reader.all('SELECT * FROM harness_computer_operations WHERE run_id = ?', [runId])),
      scopes: await db.read(reader => reader.all('SELECT * FROM harness_computer_scopes WHERE run_id = ?', [runId])),
      pins: await db.read(reader => reader.all('SELECT * FROM harness_computer_pins WHERE owner_id = ?', [runId])),
      worker: await readFile(join(settings.directory, 'worker', 'endpoint.json'), 'utf8').then(JSON.parse, () => undefined) }
  }
  process.on('message', async message => {
    const id = message.id
    try {
      if (message.command === 'wait') {
        await api.waitRun(runId)
        reply({ id, value: await report() })
      } else if (message.command === 'report') reply({ id, value: await report() })
      else if (message.command === 'cancel') reply({ id, value: await api.cancelRun(runId) })
      else if (message.command === 'shutdown') {
        await actualWorker.shutdown()
        await api.close()
        reply({ id, value: true })
        process.disconnect()
      } else throw new Error('unknown fixture command')
    } catch (error) { reply({ id, error: { name: error.name, message: error.message, code: error.code, stack: error.stack } }) }
  })
} catch (error) {
  reply({ event: 'fixture-error', error: { name: error.name, message: error.message, code: error.code, stack: error.stack } })
  process.exitCode = 1
  try { await actualWorker?.shutdown() } catch { /* Report startup failure first. */ }
  try { await root.fiber.dispose() } catch { /* Preserve startup failure. */ }
  process.disconnect?.()
}

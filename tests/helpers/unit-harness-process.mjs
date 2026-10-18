import { Context } from '@nya/core'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLocalSqliteComponent } from '../../packages/storage-sqlite/dist/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../../packages/host/dist/access.js'
import { hostHttpServiceKey } from '../../packages/host/dist/component.js'
import { createImageAssetsComponent } from '../../packages/app-harness/dist/core/image/component.js'
import { installHarnessServerCore } from '../../packages/app-harness/dist/core/index.js'
import { createFixtureApplicationApiComponent } from './application-api.mjs'
import { controlledModels } from './controlled-models.mjs'

// A real harness server process whose Computer unit lives in the parent test process and dials in over HTTP.
// The parent SIGKILLs this process mid-Run and starts a replacement on the same database and port.
const settings = JSON.parse(process.argv[2])
const root = new Context()
const reply = message => process.send?.(message)
const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Execute tools with their declared contracts.' }]
const models = controlledModels({ call(input) {
  const result = (async () => {
    await appendFile(join(settings.directory, 'model-calls.jsonl'), `${JSON.stringify({ messages: input.messages.length, processId: process.pid })}\n`)
    const last = input.messages.at(-1)
    if (last?.role === 'tool') { const value = JSON.parse(last.content); return { status: 'completed', text: value.stdout ?? JSON.stringify(value), toolCalls: [] } }
    return { status: 'completed', text: '', toolCalls: [{ id: 'original-call', name: 'bash', arguments: { command: settings.command } }] }
  })()
  void result.catch(() => {})
  return { result, done: Promise.resolve(), cancel() {} }
} })
let core
try {
  await root.installComponent(createLocalSqliteComponent(join(settings.directory, 'authority.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(settings.directory, 'images') }))
  await root.installComponent(models.component())
  await root.installComponent(createHostAccessComponent('fault harness'))
  const access = root.get(hostAccessServiceKey)
  core = await installHarnessServerCore(root, { agents, localWorkerDirectory: join(settings.directory, 'never-started-local-worker'), computerUnit: { kind: 'local', claimTimeoutMs: 3_000 } })
  const httpFiber = root.installComponent(createFixtureApplicationApiComponent(root, core.api.listAgents(), settings.port, { authenticated: true })); await httpFiber
  const web = root.get(hostHttpServiceKey), api = core.api, sessions = root.get('harness.sessions'), records = root.get('harness.session-runs')
  let runId = settings.runId
  if (settings.mode !== 'resume') {
    const { token } = await access.issue('parent test')
    reply({ event: 'ready', url: web.url, instanceId: access.instance.instanceId, token, processId: process.pid })
  } else reply({ event: 'restarted', runId, processId: process.pid })
  const report = async () => {
    const run = runId ? await sessions.getRun(runId) : undefined
    const db = root.get('local-storage')
    return { run, execution: runId ? await records.getRunExecution(runId) : undefined, resume: runId ? await records.loadRunResume(runId) : undefined,
      events: runId ? await sessions.getRunEvents(runId) : [], nodes: run ? await sessions.listNodes(run.sessionId, null) : undefined,
      operations: runId ? await db.read(reader => reader.all('SELECT * FROM harness_computer_operations WHERE run_id = ?', [runId])) : [],
      scopes: runId ? await db.read(reader => reader.all('SELECT * FROM harness_computer_scopes WHERE run_id = ?', [runId])) : [],
      pins: runId ? await db.read(reader => reader.all('SELECT * FROM harness_computer_pins WHERE owner_id = ?', [runId])) : [],
      attachments: await root.get('harness.unit-attachments').list(), processId: process.pid }
  }
  process.on('message', async message => {
    const id = message.id
    try {
      if (message.command === 'start') {
        const project = await api.openProject(settings.projectDirectory, { computerAttachmentId: message.attachmentId })
        const selection = await api.getAgentTools('assistant')
        await api.setAgentTools('assistant', { toolIds: ['anybox.bash'], expectedRevision: selection.revision })
        const session = await api.createSession(project.id, 'assistant')
        const run = await api.startRun({ sessionId: session.id, parentNodeId: null, idempotencyKey: 'original-run', input: 'Execute the original operation' })
        runId = run.id
        reply({ id, value: { runId, sessionId: session.id, projectId: project.id } })
      } else if (message.command === 'wait') { await api.waitRun(runId); reply({ id, value: await report() }) }
      else if (message.command === 'report') reply({ id, value: await report() })
      else if (message.command === 'cancel') reply({ id, value: await api.cancelRun(runId) })
      else if (message.command === 'shutdown') { await core.close(); await httpFiber.dispose(); await root.fiber.dispose(); reply({ id, value: true }); process.disconnect() }
      else throw new Error('unknown fixture command')
    } catch (error) { reply({ id, error: { name: error.name, message: error.message, code: error.code, stack: error.stack } }) }
  })
} catch (error) {
  reply({ event: 'fixture-error', error: { name: error.name, message: error.message, code: error.code, stack: error.stack } })
  process.exitCode = 1
}

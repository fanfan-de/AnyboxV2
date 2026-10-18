import { createLocalComputerProviderComponent } from './fixed-computer-provider.mjs'
import { createComputersComponent } from '../../packages/app-harness/dist/core/computer/component.js'
import { createWorkspacesComponent } from '../../packages/app-harness/dist/core/workspace/component.js'
import { createComputerOperationsComponent } from '../../packages/app-harness/dist/core/computer/operations-component.js'
import { computerInstanceProviderServiceKey, computerServiceKey } from '../../packages/app-harness/dist/core/computer/port.js'
import { workspacesServiceKey } from '../../packages/app-harness/dist/core/workspace/port.js'
import { computerOperationsServiceKey } from '../../packages/app-harness/dist/core/computer/operations-port.js'
import { createImageAssetsComponent } from '../../packages/app-harness/dist/core/image/component.js'
import { computerWorkerServiceKey, workerError } from '../../packages/app-harness/dist/core/computer/worker-port.js'
import { installUnitAttachments } from './unit-attachments.mjs'

const immediate = result => ({ result: Promise.resolve(result), done: Promise.resolve(), cancel() {} })
const map = (call, convert) => ({ ...call, result: call.result.then(convert) })
function localExecution(root, input) {
  const bash = root.get('tools.bash'), patch = root.get('tools.apply-patch'), files = root.get('tools.files'), processes = root.get('tools.processes')
  let scope
  return { execute(request, binding) {
    const target = { projectId: input.declaration.projectId, workspacePath: binding.path }
    const process = () => scope ??= processes.openRun({ ...target, runId: input.runId })
    const name = request.name, args = request.arguments
    if (name === 'bash') return map(bash.execute({ ...target, command: args.command }), result => ({ name, result }))
    if (name === 'apply_patch' || name === 'codex_apply_patch') return map(patch.execute({ ...target, patch: args.patch }), result => ({ name, result }))
    if (name === 'codex_exec_command' || name === 'codex_write_stdin') return map(process().execute(name, args), result => ({ name, result }))
    if (name === 'claude_code_Bash' || name === 'deepseek_harness_bash') return map(process().foreground({ command: String(args.command),
      ...(typeof (args.timeout ?? args.timeoutMs) === 'number' ? { timeoutMs: Number(args.timeout ?? args.timeoutMs) } : {}),
      ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}) }), result => ({ name, result }))
    return map(files.execute({ ...target, runId: input.runId, sessionId: input.declaration.sessionId, name, args, imageInput: input.imageInput === true }), value => ({ name, ...value }))
  }, hasProcesses: () => !!scope, close: () => scope?.close() ?? immediate({ processes: [] }) }
}

/** Controlled worker facts exercise Authority polling without launching a detached test daemon. */
export function createControlledComputerWorker(root, { inject = [], serviceKey = computerWorkerServiceKey } = {}) {
  const owners = new Map(), records = new Map(), executors = new Map(), configured = new Map(), active = new Map(), pending = new Set()
  let stopped = false, shutting
  const authorize = input => { if (owners.get(input.runId) !== input.runOwnerEpoch) throw workerError('worker-owner') }
  const execute = async (input, record) => {
    record.state = 'running'
    let call
    try {
      if (input.kind === 'cancel') { for (const [id, operation] of active) if (records.get(id).runId === input.runId) operation.cancel('user-requested'); record.observation = { cancelled: true } }
      else {
        let executor = executors.get(input.runId)
        if (!executor && input.kind === 'tool') { executor = configured.get(input.runId) ?? localExecution(root, input); executors.set(input.runId, executor) }
        call = input.kind === 'close-scope' ? executor?.close() ?? immediate({ processes: [] }) : executor.execute(input.declaration.request, input.binding)
        active.set(input.operationId, call)
        let value = await Promise.race([call.result, call.done.then(() => new Promise(() => {}))])
        // Worker-level image facts (base64 or pushed receipts) sit beside the observation, as the real worker reports them.
        if (value && typeof value === 'object' && 'workerImages' in value) { const { workerImages, ...rest } = value; record.images = workerImages; value = rest }
        record.observation = value
        await call.done
        if (input.kind === 'tool' && value?.name === 'codex_exec_command' && Number.isSafeInteger(value.result?.session_id)) {
          record.processRef = { processId: `${input.runId}:${value.result.session_id}`, runId: input.runId, sessionId: value.result.session_id,
            computerInstanceId: input.binding.computerInstanceId, instanceGeneration: input.binding.instanceGeneration }
        }
      }
      record.state = 'succeeded'
    } catch (error) {
      let cleanup = false
      if (call) { try { call.cancel('failed'); await call.done } catch { cleanup = true } }
      record.state = cleanup ? 'outcome-unknown' : 'failed'
      record.error = { name: error?.name ?? 'Error', message: error?.message ?? 'failed', ...(error?.code ? { code: error.code } : {}),
        category: cleanup || input.kind === 'close-scope' ? 'cleanup-failure' : error?.category === 'tool-cancelled' ? 'cancelled' : error?.category === 'tool-timeout' ? 'timeout' : error?.category }
    } finally { active.delete(input.operationId) }
  }
  const service = {
    async info() { return { workerId: 'controlled-local', bootId: 'controlled-boot', platform: process.platform, architecture: process.arch } },
    async claimRun(input) { if (stopped || (owners.get(input.runId) ?? 0) > input.runOwnerEpoch) throw workerError('worker-owner'); owners.set(input.runId, input.runOwnerEpoch) },
    async get(input) { authorize(input); return records.get(input.operationId) ? structuredClone(records.get(input.operationId)) : undefined },
    async query() { throw workerError('worker-request-unsupported') },
    async submit(input) {
      authorize(input); if (stopped) throw workerError('worker-closed')
      const prior = records.get(input.operationId)
      if (prior) { if (prior.declarationDigest !== input.declarationDigest) throw workerError('worker-conflict'); return structuredClone(prior) }
      const record = { operationId: input.operationId, runId: input.runId, declarationDigest: input.declarationDigest,
        receipt: `receipt:${input.operationId}`, state: 'accepted', executeCount: input.kind === 'tool' ? 1 : 0 }
      records.set(input.operationId, record)
      const promise = Promise.resolve().then(() => execute(input, record)); pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {})
      return structuredClone(record)
    },
    shutdown() { return shutting ??= (async () => { stopped = true; for (const call of active.values()) call.cancel('worker-shutdown');
      await Promise.allSettled([...pending]); const exits = await Promise.allSettled([...executors.values()].map(async executor => { const call = executor.close(); await call.result; await call.done }))
      const errors = exits.filter(result => result.status === 'rejected'); if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'controlled worker cleanup failed')
    })() },
  }
  return { service, records, setExecution(runId, execution) { configured.set(runId, execution) }, component: {
    name: 'controlled-computer-worker', inject, apply(ctx) { ctx.provide(serviceKey, service); ctx.effect(() => () => service.shutdown(), 'join controlled worker execution') },
  } }
}

/** Project Files injects computer.worker; fixtures without a worker of their own install a controlled stand-in first. */
const standIns = new WeakMap()
export async function installComputerWorkerStub(root) {
  if (root.get(computerWorkerServiceKey)) return standIns.get(root)
  const worker = createControlledComputerWorker(root)
  standIns.set(root, worker)
  await root.installComponent(worker.component)
  return worker
}

/** Direct component fixtures use the same resource closure as the trusted composition root. */
export async function installComputerServices(root, inputs, options = {}) {
  await installUnitAttachments(root, inputs)
  if (!root.get('harness.image-assets')) {
    const file = await root.get('local-storage').read(reader => reader.get('PRAGMA database_list').file)
    await root.installComponent(createImageAssetsComponent({ directory: `${file}.images` }))
  }
  let worker = options.worker ?? standIns.get(root), workerFiber
  if (!root.get(computerWorkerServiceKey)) {
    worker ??= createControlledComputerWorker(root)
    workerFiber = root.installComponent(worker.component); await workerFiber
  }
  if (!root.get(computerInstanceProviderServiceKey)) await root.installComponent(createLocalComputerProviderComponent())
  if (!root.get(computerServiceKey)) await root.installComponent(createComputersComponent(inputs))
  if (!root.get(workspacesServiceKey)) await root.installComponent(createWorkspacesComponent(inputs))
  if (!root.get(computerOperationsServiceKey)) await root.installComponent(createComputerOperationsComponent(inputs))
  return { worker, workerFiber }
}

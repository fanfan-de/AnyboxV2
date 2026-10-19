import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { createDirectoryIdentityCheck } from '../platform/path-identity.js'
import { readProjectFile, searchProjectFiles } from '../project-files/filesystem.js'
import { listProjectDirectory } from '../project-files/tree-access.js'
import { fileTreeLimits } from '../project-files/domain.js'
import { ceilingPermitsRoot, queryRoot, validateComputerQuery } from './query-domain.js'
import type { ComputerQueryResult } from './query-domain.js'
import type { UnitScope } from '../unit/domain.js'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import { computerDeclarationDigest } from './operations-domain.js'
import type { ProcessRef } from './operations-domain.js'
import { validateToolBatch } from '../run/domain.js'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageReader, StorageTransaction, StorageMigration } from '@anybox/storage-sqlite/port'
import { bashServiceKey, type BashPort } from '../tool/bash-component.js'
import { applyPatchServiceKey, type ApplyPatchPort } from '../tool/apply-patch-component.js'
import { processToolsServiceKey, type ProcessToolsPort } from '../tool/process-component.js'
import { fileToolsServiceKey, type FileToolsPort } from '../tool/files-component.js'
import { imageAssetsServiceKey, type ImageAssetsPort } from '../image/port.js'
import { sameWorkspaceBinding } from '../workspace/domain.js'
import { createWorkerExecution, type WorkerExecution } from './worker-execution.js'
import { ceilingPermits, localWorkerAttachmentId } from './worker-attachments-domain.js'
import { workerAttachmentsServiceKey } from './worker-attachments.js'
import type { WorkerAttachmentsPort } from './worker-attachments.js'
import { computerWorkerServiceKey, workerError } from './worker-port.js'
import type { ComputerWorkerPort, WorkerAuthorization, WorkerSubmission, WorkerOperation, WorkerImage } from './worker-port.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE computer_worker_runs (run_id TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL, binding_json TEXT, image_input INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, has_processes INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, cleanup_json TEXT)')
  tx.execute('CREATE TABLE computer_worker_operations (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, digest TEXT NOT NULL, submission_json TEXT NOT NULL, receipt TEXT NOT NULL, state TEXT NOT NULL, execute_count INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, observation_json TEXT, error_json TEXT, process_ref_json TEXT, images_json TEXT)')
  tx.execute('CREATE INDEX computer_worker_operations_run ON computer_worker_operations(run_id, operation_id)')
  tx.execute('CREATE TABLE computer_worker_workspace_fences (workspace_id TEXT PRIMARY KEY, workspace_epoch INTEGER NOT NULL, instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL, path TEXT NOT NULL)')
  tx.execute('CREATE TABLE computer_worker_instance_fences (computer_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL)')
} }, { version: 2, up(tx) {
  // Runs accepted before attachments existed belong to the loopback harness server.
  tx.execute(`ALTER TABLE computer_worker_runs ADD COLUMN attachment_id TEXT NOT NULL DEFAULT '${localWorkerAttachmentId}'`)
  tx.execute('CREATE INDEX computer_worker_runs_attachment ON computer_worker_runs(attachment_id, closed)')
} }]
const terminal = (state: string) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const cancelledError: NonNullable<WorkerOperation['error']> = Object.freeze({ name: 'WorkerCancelledError', message: 'worker operation cancelled', category: 'cancelled' })
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw workerError('worker-invalid')
}
function auth(input: WorkerAuthorization): void {
  text(input.runId); text(input.attachmentId)
  if (!Number.isSafeInteger(input.runOwnerEpoch) || input.runOwnerEpoch < 1) throw workerError('worker-invalid')
}
/** A Run is owned by exactly one attachment; another attachment can neither read nor continue it. */
function authorize(reader: StorageReader, input: WorkerAuthorization): void {
  auth(input)
  const row = reader.get('SELECT owner_epoch, attachment_id FROM computer_worker_runs WHERE run_id = ?', [input.runId])
  if (!row || row.owner_epoch !== input.runOwnerEpoch || row.attachment_id !== input.attachmentId) throw workerError('worker-owner-rejected')
}
function read(reader: StorageReader, id: string): WorkerOperation | undefined {
  const row = reader.get('SELECT * FROM computer_worker_operations WHERE operation_id = ?', [id])
  if (!row) return undefined
  const submission = JSON.parse(String(row.submission_json)) as WorkerSubmission
  return Object.freeze({ operationId: String(row.operation_id), runId: String(row.run_id), declarationDigest: String(row.digest),
    ...(submission.declaration?.sessionId ? { sessionId: submission.declaration.sessionId } : {}),
    receipt: String(row.receipt), state: row.state as WorkerOperation['state'], executeCount: Number(row.execute_count),
    ...(typeof row.observation_json === 'string' ? { observation: JSON.parse(row.observation_json) as JsonValue } : {}),
    ...(typeof row.error_json === 'string' ? { error: JSON.parse(row.error_json) as WorkerOperation['error'] }
      : row.state === 'cancelled' && submission.kind === 'tool' ? { error: cancelledError } : {}),
    ...(typeof row.process_ref_json === 'string' ? { processRef: JSON.parse(row.process_ref_json) as ProcessRef } : {}),
    ...(typeof row.images_json === 'string' ? { images: JSON.parse(row.images_json) as readonly WorkerImage[] } : {}) })
}
function errorInfo(error: unknown): NonNullable<WorkerOperation['error']> {
  if (!(error instanceof Error)) return { name: 'Error', message: 'worker execution failed' }
  return { name: error.name, message: error.message,
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...('category' in error && typeof error.category === 'string' ? { category: error.category } : {}) }
}
async function joined<T>(call: OwnedCall<T>): Promise<T> {
  const failedExit = call.done.then(() => new Promise<never>(() => {}), error => Promise.reject(error))
  try { return await Promise.race([call.result, failedExit]) } finally { await call.done }
}
/** Worker-owned execution outlives all HTTP observers and Runtime generations. */
export function createComputerWorkerExecutorComponent(identity: { readonly workerId: string; readonly bootId: string }): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort; [bashServiceKey]: BashPort; [applyPatchServiceKey]: ApplyPatchPort
  [processToolsServiceKey]: ProcessToolsPort; [fileToolsServiceKey]: FileToolsPort; [imageAssetsServiceKey]: ImageAssetsPort
  [workerAttachmentsServiceKey]: WorkerAttachmentsPort
}> {
  return { name: 'computer-worker-executor', inject: [localStorageServiceKey, bashServiceKey, applyPatchServiceKey, processToolsServiceKey, fileToolsServiceKey, imageAssetsServiceKey, workerAttachmentsServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], attachments = deps[workerAttachmentsServiceKey]
      await db.migrate('computer-worker', migrations)
      await db.transaction(tx => {
        tx.execute("UPDATE computer_worker_runs SET uncertain = 1 WHERE run_id IN (SELECT run_id FROM computer_worker_operations WHERE state IN ('starting','running'))")
        tx.execute("UPDATE computer_worker_operations SET state = 'outcome-unknown' WHERE state IN ('starting','running')")
        tx.execute('UPDATE computer_worker_runs SET uncertain = 1 WHERE closed = 0 AND has_processes = 1')
      })
      let accepting = true
      const queries = new AbortController()
      const pendingQueries = new Set<{ readonly attachmentId: string; readonly abort: AbortController; readonly done: Promise<ComputerQueryResult> }>()
      const queryCleanupFailures: unknown[] = []
      const scopes = new Map<string, { execution: WorkerExecution; abort: AbortController }>()
      const active = new Map<string, OwnedCall<unknown>>()
      const running = new Map<string, Promise<void>>()
      const tails = new Map<string, Promise<void>>()
      const assertOpen = () => { if (!accepting) throw workerError('worker-closing') }
      // Compare the directory's identity on this worker, including aliases in an explicitly granted directory.
      const canonicalPermitted = async (scope: UnitScope, canonical: string, signal: AbortSignal) => {
        if (scope.kind !== 'computer') return false
        if (scope.projects === 'all') return true
        const within = process.platform === 'win32' ? createDirectoryIdentityCheck() : undefined
        for (const directory of scope.projects) {
          if (!isAbsolute(directory)) continue
          signal.throwIfAborted()
          let granted: string
          try { granted = await realpath(directory) } catch { signal.throwIfAborted(); continue }
          signal.throwIfAborted()
          if (ceilingPermitsRoot({ ...scope, projects: [granted] }, canonical, within)) return true
        }
        return false
      }
      const scope = async (submission: WorkerSubmission) => {
        let current = scopes.get(submission.runId)
        if (current) return current
        const row = await db.read(reader => reader.get('SELECT * FROM computer_worker_runs WHERE run_id = ?', [submission.runId]))
        if (!row || typeof row.binding_json !== 'string' || row.closed || row.uncertain) throw workerError(row?.uncertain ? 'worker-scope-unknown' : 'worker-scope-closed')
        const declaration = submission.declaration ?? await db.read(reader => {
          const first = reader.get("SELECT submission_json FROM computer_worker_operations WHERE run_id = ? AND json_extract(submission_json,'$.kind') = 'tool' ORDER BY rowid LIMIT 1", [submission.runId])
          return first && (JSON.parse(String(first.submission_json)) as WorkerSubmission).declaration
        })
        if (!declaration) throw workerError('worker-invalid')
        const abort = new AbortController()
        current = { abort, execution: createWorkerExecution({ runId: submission.runId, sessionId: declaration.sessionId,
          projectId: declaration.projectId, imageInput: !!row.image_input, signal: abort.signal,
          bash: deps[bashServiceKey], patch: deps[applyPatchServiceKey], processes: deps[processToolsServiceKey], files: deps[fileToolsServiceKey] }) }
        scopes.set(submission.runId, current)
        return current
      }
      const finish = async (id: string, state: WorkerOperation['state'], observation?: JsonValue, error?: unknown,
        processRef?: ProcessRef, images?: readonly WorkerImage[]) => db.transaction(tx => {
        tx.execute('UPDATE computer_worker_operations SET state = ?, observation_json = ?, error_json = ?, process_ref_json = ?, images_json = ? WHERE operation_id = ?',
          [state, observation === undefined ? null : JSON.stringify(observation), error === undefined ? null : JSON.stringify(errorInfo(error)),
            processRef ? JSON.stringify(processRef) : null, images ? JSON.stringify(images) : null, id])
      })
      const execute = async (submission: WorkerSubmission) => {
        let call: OwnedCall<unknown> | undefined
        let resultValue: unknown, actualExitFailed = false
        try {
          const started = await db.transaction(tx => {
            const original = read(tx, submission.operationId)
            if (!original || terminal(original.state)) return false
            if (submission.kind === 'tool' && (!accepting || tx.get('SELECT cancel_requested FROM computer_worker_operations WHERE operation_id = ?', [submission.operationId])?.cancel_requested || tx.get('SELECT cancelled FROM computer_worker_runs WHERE run_id = ?', [submission.runId])?.cancelled)) {
              tx.execute("UPDATE computer_worker_operations SET state = 'cancelled' WHERE operation_id = ?", [submission.operationId]); return false
            }
            // Durable starting precedes the synchronous acquisition of every tool resource.
            tx.execute("UPDATE computer_worker_operations SET state = 'starting', execute_count = execute_count + 1 WHERE operation_id = ?", [submission.operationId])
            return true
          })
          if (!started) return
          if (submission.kind === 'cancel') {
            const targets = submission.targetOperationId ? [submission.targetOperationId] : await db.read(reader => reader.all("SELECT operation_id FROM computer_worker_operations WHERE run_id = ? AND json_extract(submission_json,'$.kind') = 'tool'", [submission.runId]).map(row => String(row.operation_id)))
            for (const id of targets) active.get(id)?.cancel('run-cancelled')
            if (!submission.targetOperationId) scopes.get(submission.runId)?.abort.abort('run-cancelled')
            // A cancelled queued call still sits behind the active command in the Run queue.
            // Its terminal zero-dispatch receipt already proves it acquired no resources.
            const waiting = await db.read(reader => targets.filter(id => {
              const state = read(reader, id)?.state
              return state === 'starting' || state === 'running'
            }))
            await Promise.allSettled(waiting.map(id => running.get(id)).filter((work): work is Promise<void> => !!work))
            let cleanup: JsonValue | undefined
            if (!submission.targetOperationId) {
              const row = await db.read(reader => reader.get('SELECT * FROM computer_worker_runs WHERE run_id = ?', [submission.runId]))
              if (row?.uncertain) {
                // Retain this boot's failed scope so control retries can still release its resources.
                const current = scopes.get(submission.runId)
                if (current) await joined(current.execution.close())
                throw workerError('worker-scope-unknown')
              }
              cleanup = row?.cleanup_json ? JSON.parse(String(row.cleanup_json)) as JsonValue : json(await joined(scopes.get(submission.runId)?.execution.close() ?? { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }))
              await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET closed = 1, has_processes = 0, cleanup_json = ? WHERE run_id = ?', [JSON.stringify(cleanup), submission.runId]))
            }
            await finish(submission.operationId, 'succeeded', { cancelled: submission.targetOperationId ?? submission.runId, ...(cleanup === undefined ? {} : { cleanup }) }); return
          }
          if (submission.kind === 'close-scope') {
            const row = await db.read(reader => reader.get('SELECT * FROM computer_worker_runs WHERE run_id = ?', [submission.runId]))
            const current = scopes.get(submission.runId)
            if (row?.uncertain) {
              if (current) await joined(current.execution.close())
              throw workerError('worker-scope-unknown')
            }
            call = row?.cleanup_json ? { result: Promise.resolve(JSON.parse(String(row.cleanup_json)) as JsonValue), done: Promise.resolve(), cancel() {} } : current?.execution.close() ?? { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }
            active.set(submission.operationId, call)
            const observation = json(await joined(call))
            await db.transaction(tx => {
              tx.execute('UPDATE computer_worker_runs SET closed = 1, has_processes = 0, cleanup_json = ? WHERE run_id = ?', [JSON.stringify(observation), submission.runId])
              tx.execute('UPDATE computer_worker_operations SET state = ?, observation_json = ? WHERE operation_id = ?', ['succeeded', JSON.stringify(observation), submission.operationId])
            })
            scopes.delete(submission.runId); return
          }
          const current = await scope(submission)
          const request = submission.declaration!.request
          // Long processes are conservatively fenced before the operation can create one.
          if (['codex_exec_command', 'codex_write_stdin', 'claude_code_Bash', 'deepseek_harness_bash'].includes(request.name)) {
            await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET has_processes = 1 WHERE run_id = ?', [submission.runId]))
          }
          const cancelled = await db.read(reader => reader.get('SELECT cancel_requested FROM computer_worker_operations WHERE operation_id = ?', [submission.operationId])?.cancel_requested || reader.get('SELECT cancelled FROM computer_worker_runs WHERE run_id = ?', [submission.runId])?.cancelled)
          if (cancelled || !accepting) { await finish(submission.operationId, 'cancelled'); return }
          call = current.execution.execute(request, submission.binding!)
          active.set(submission.operationId, call)
          void call.result.then(value => { resultValue = value }, () => {})
          void call.done.catch(() => { actualExitFailed = true })
          await db.transaction(tx => tx.execute("UPDATE computer_worker_operations SET state = 'running' WHERE operation_id = ?", [submission.operationId]))
          const observation = json(await joined(call))
          const value = observation as unknown as { result?: { session_id?: unknown }; images?: readonly WorkerImage['ref'][] }
          let processRef: ProcessRef | undefined
          if (request.name === 'codex_exec_command' && Number.isSafeInteger(value.result?.session_id)) {
            processRef = { processId: `${identity.bootId}:${submission.runId}:${String(value.result!.session_id)}`, runId: submission.runId,
              sessionId: Number(value.result!.session_id), computerInstanceId: submission.binding!.computerInstanceId, instanceGeneration: submission.binding!.instanceGeneration }
          }
          let images: WorkerImage[] | undefined
          if (value.images?.length) {
            const retained = await db.transaction(tx => deps[imageAssetsServiceKey].retainIn(tx, submission.declaration!.sessionId, `worker-operation:${submission.operationId}`, value.images!))
            images = []
            for (const ref of retained) {
              const bytes = await joined(deps[imageAssetsServiceKey].readImage(submission.declaration!.sessionId, ref.assetId))
              images.push({ ref, base64: Buffer.from(bytes).toString('base64') })
            }
          }
          await finish(submission.operationId, 'succeeded', observation, undefined, processRef, images)
        } catch (error) {
          if (call) {
            call.cancel('worker-execution-failed'); void call.result.catch(() => {})
            const exit = await Promise.allSettled([call.done]); actualExitFailed ||= exit[0].status === 'rejected'
          }
          const category = errorInfo(error).category
          const failedCleanup = actualExitFailed || category === 'cleanup-failure'
          if (failedCleanup) await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET uncertain = 1 WHERE run_id = ?', [submission.runId]))
          const failure = failedCleanup ? Object.assign(new Error('worker tool cleanup failed'), { name: 'WorkerCleanupError', category: 'cleanup-failure' }) : error
          await finish(submission.operationId, category === 'cancelled' && !failedCleanup ? 'cancelled' : error instanceof Error && 'code' in error && error.code === 'worker-scope-unknown' ? 'outcome-unknown' : 'failed', resultValue === undefined ? undefined : json(resultValue), failure)
        } finally { active.delete(submission.operationId) }
      }
      const schedule = (submission: WorkerSubmission) => {
        if (running.has(submission.operationId)) return
        // A cancel declaration bypasses the Run queue so it can stop an active command.
        const previous = submission.kind === 'cancel' ? Promise.resolve() : tails.get(submission.runId) ?? Promise.resolve()
        const work = previous.catch(() => {}).then(() => execute(submission))
        running.set(submission.operationId, work)
        if (submission.kind !== 'cancel') tails.set(submission.runId, work)
        void work.finally(() => running.delete(submission.operationId)).catch(() => { accepting = false })
      }
      // A revoked attachment stops accepting immediately; its open scopes are cancelled and drained like a shutdown of that harness server's work.
      const revokeRuns = async (attachmentId: string) => {
        let cleanupFailed = false
        const reading = [...pendingQueries].filter(query => query.attachmentId === attachmentId)
        for (const query of reading) query.abort.abort(workerError('worker-attachment-rejected'))
        try {
          const runIds = await db.transaction(tx => {
            const open = tx.all('SELECT run_id FROM computer_worker_runs WHERE attachment_id = ? AND closed = 0', [attachmentId]).map(row => String(row.run_id))
            tx.execute('UPDATE computer_worker_runs SET cancelled = 1 WHERE attachment_id = ? AND closed = 0', [attachmentId])
            for (const runId of open) tx.execute("UPDATE computer_worker_operations SET cancel_requested = 1, state = CASE WHEN state IN ('accepted','queued') THEN 'cancelled' ELSE state END WHERE run_id = ? AND state IN ('accepted','queued','starting','running') AND json_extract(submission_json,'$.kind') = 'tool'", [runId])
            return open
          })
          const operationIds = await db.read(reader => runIds.flatMap(runId => reader.all('SELECT operation_id FROM computer_worker_operations WHERE run_id = ?', [runId]).map(row => String(row.operation_id))))
          for (const runId of runIds) scopes.get(runId)?.abort.abort('attachment-revoked')
          for (const id of operationIds) active.get(id)?.cancel('attachment-revoked')
          await Promise.allSettled([...operationIds.map(id => running.get(id)).filter((work): work is Promise<void> => !!work), ...reading.map(query => query.done)])
          for (const runId of runIds) {
            const current = scopes.get(runId)
            if (!current) continue
            try {
              const uncertain = await db.read(reader => reader.get('SELECT uncertain FROM computer_worker_runs WHERE run_id = ?', [runId])?.uncertain === 1)
              const cleanup = await joined(current.execution.close())
              if (!uncertain) {
                await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET closed = 1, has_processes = 0, cleanup_json = ? WHERE run_id = ?', [JSON.stringify(cleanup), runId]))
                scopes.delete(runId)
              }
            } catch { cleanupFailed = true; await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET uncertain = 1 WHERE run_id = ?', [runId])) }
          }
        } finally { await Promise.allSettled(reading.map(query => query.done)) }
        if (cleanupFailed) throw workerError('worker-cleanup-failed')
      }
      const unsubscribe = attachments.onChanged((attachment, change) => attachment.state === 'revoked' || change === 'permissions' ? revokeRuns(attachment.attachmentId) : undefined)
      ctx.effect(() => () => unsubscribe(), 'stop observing attachment revocations')
      const service: ComputerWorkerPort = {
        info: async () => ({ ...identity, platform: process.platform, architecture: process.arch }),
        claimRun(input) {
          assertOpen(); auth(input)
          return db.transaction(tx => {
            assertOpen()
            attachments.requireApprovedIn(tx, input.attachmentId)
            const previous = tx.get('SELECT owner_epoch, attachment_id FROM computer_worker_runs WHERE run_id = ?', [input.runId])
            if (previous && (Number(previous.owner_epoch) > input.runOwnerEpoch || previous.attachment_id !== input.attachmentId)) throw workerError('worker-owner-rejected')
            tx.execute('INSERT INTO computer_worker_runs (run_id, owner_epoch, attachment_id) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET owner_epoch = excluded.owner_epoch', [input.runId, input.runOwnerEpoch, input.attachmentId])
          })
        },
        async submit(input) {
          assertOpen(); auth(input); text(input.operationId); text(input.declarationDigest)
          if (!['tool','close-scope','cancel'].includes(input.kind)) throw workerError('worker-invalid')
          const accepted = await db.transaction(async tx => {
            assertOpen()
            authorize(tx, input)
            const prior = read(tx, input.operationId)
            if (prior) {
              if (prior.runId !== input.runId || prior.declarationDigest !== input.declarationDigest) throw workerError('worker-operation-conflict')
              const priorSubmission = JSON.parse(String(tx.get('SELECT submission_json FROM computer_worker_operations WHERE operation_id = ?', [input.operationId])!.submission_json)) as WorkerSubmission
              if (priorSubmission.kind !== input.kind || priorSubmission.targetOperationId !== input.targetOperationId || input.kind === 'tool' && !sameWorkspaceBinding(priorSubmission.binding!, input.binding!)) throw workerError('worker-operation-conflict')
              return { original: priorSubmission, operation: prior }
            }
            const run = tx.get('SELECT * FROM computer_worker_runs WHERE run_id = ?', [input.runId])!
            if (input.kind === 'tool') {
              if (input.workerBootId !== identity.bootId) throw workerError('worker-instance-replaced')
              const declaration = input.declaration, binding = input.binding
              if (!declaration || !binding || declaration.operationId !== input.operationId || declaration.runId !== input.runId || binding.scopeId !== input.runId ||
                declaration.projectId !== binding.projectId || declaration.workspaceId !== binding.workspaceId || declaration.computerId !== binding.computerId || declaration.workspaceRevision !== binding.revision || !isAbsolute(binding.path) || binding.path.includes('\0') ||
                !Number.isSafeInteger(binding.instanceGeneration) || binding.instanceGeneration < 1 || !Number.isSafeInteger(binding.workspaceEpoch) || binding.workspaceEpoch < 1 ||
                declaration.spec.platform !== process.platform || declaration.spec.architecture !== process.arch || computerDeclarationDigest(declaration) !== input.declarationDigest) throw workerError('worker-invalid')
              validateToolBatch([declaration.request], [declaration.tool.definition])
              // New work checks both grants against this worker's actual directory identity. Existing receipts return above.
              const attachment = attachments.requireApprovedIn(tx, input.attachmentId)
              const granted = [attachment.ceiling, attachment.scope]
              if (granted.some(scope => scope.kind !== 'computer' || !ceilingPermits({ ...scope, projects: 'all' }, { path: binding.path, toolId: declaration.tool.toolId }))) throw workerError('worker-scope-rejected')
              let canonical: string
              try { canonical = await realpath(binding.path) } catch { throw workerError('worker-scope-rejected') }
              for (const scope of granted) if (!await canonicalPermitted(scope, canonical, queries.signal)) throw workerError('worker-scope-rejected')
              assertOpen()
              if (run.cancelled) throw workerError('worker-run-cancelled')
              if (run.closed || run.uncertain) throw workerError(run.uncertain ? 'worker-scope-unknown' : 'worker-scope-closed')
              if (typeof run.binding_json === 'string' && !sameWorkspaceBinding(JSON.parse(run.binding_json) as typeof binding, binding)) throw workerError('worker-binding-conflict')
              if (typeof run.binding_json === 'string' && !!run.image_input !== !!input.imageInput) throw workerError('worker-binding-conflict')
              const workspaceFence = tx.get('SELECT * FROM computer_worker_workspace_fences WHERE workspace_id = ?', [binding.workspaceId])
              const instanceFence = tx.get('SELECT * FROM computer_worker_instance_fences WHERE computer_id = ?', [binding.computerId])
              if (workspaceFence && (binding.workspaceEpoch < Number(workspaceFence.workspace_epoch) || binding.instanceGeneration < Number(workspaceFence.instance_generation) ||
                binding.workspaceEpoch === workspaceFence.workspace_epoch && binding.path !== workspaceFence.path) ||
                instanceFence && (binding.instanceGeneration < Number(instanceFence.instance_generation) || binding.instanceGeneration === instanceFence.instance_generation && binding.computerInstanceId !== instanceFence.instance_id)) throw workerError('worker-binding-conflict')
              // Another active Run cannot silently replace the same workspace generation. A Run of a dead boot (uncertain) can never
              // execute again here: its unknown exit is a fact, not a live generation, so it does not fence later Runs out.
              for (const other of tx.all('SELECT binding_json FROM computer_worker_runs WHERE binding_json IS NOT NULL AND closed = 0 AND uncertain = 0 AND run_id != ?', [input.runId])) {
                const bound = JSON.parse(String(other.binding_json)) as typeof binding
                if (bound.workspaceId === binding.workspaceId && (bound.workspaceEpoch !== binding.workspaceEpoch || bound.computerInstanceId !== binding.computerInstanceId || bound.instanceGeneration !== binding.instanceGeneration)) throw workerError('worker-binding-conflict')
              }
              tx.execute('INSERT INTO computer_worker_workspace_fences (workspace_id, workspace_epoch, instance_id, instance_generation, path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET workspace_epoch = excluded.workspace_epoch, instance_id = excluded.instance_id, instance_generation = excluded.instance_generation, path = excluded.path',
                [binding.workspaceId, binding.workspaceEpoch, binding.computerInstanceId, binding.instanceGeneration, binding.path])
              tx.execute('INSERT INTO computer_worker_instance_fences (computer_id, instance_id, instance_generation) VALUES (?, ?, ?) ON CONFLICT(computer_id) DO UPDATE SET instance_id = excluded.instance_id, instance_generation = excluded.instance_generation', [binding.computerId, binding.computerInstanceId, binding.instanceGeneration])
              tx.execute('UPDATE computer_worker_runs SET binding_json = ?, image_input = ? WHERE run_id = ?', [JSON.stringify(binding), input.imageInput ? 1 : 0, input.runId])
            } else if (input.kind === 'cancel') {
              if (input.targetOperationId) {
                text(input.targetOperationId)
                const target = read(tx, input.targetOperationId)
                if (!target || target.runId !== input.runId) throw workerError('worker-operation-missing')
                tx.execute('UPDATE computer_worker_operations SET cancel_requested = 1 WHERE operation_id = ?', [input.targetOperationId])
                tx.execute("UPDATE computer_worker_operations SET state = 'cancelled' WHERE operation_id = ? AND state IN ('accepted','queued')", [input.targetOperationId])
              } else {
                tx.execute('UPDATE computer_worker_runs SET cancelled = 1 WHERE run_id = ?', [input.runId])
                tx.execute("UPDATE computer_worker_operations SET cancel_requested = 1, state = CASE WHEN state IN ('accepted','queued') THEN 'cancelled' ELSE state END WHERE run_id = ? AND json_extract(submission_json,'$.kind') = 'tool'", [input.runId])
              }
            }
            tx.execute('INSERT INTO computer_worker_operations (operation_id, run_id, digest, submission_json, receipt, state) VALUES (?, ?, ?, ?, ?, ?)',
              [input.operationId, input.runId, input.declarationDigest, JSON.stringify(input), randomUUID(), 'queued'])
            return { original: JSON.parse(JSON.stringify(input)) as WorkerSubmission, operation: read(tx, input.operationId)! }
          })
          if (!terminal(accepted.operation.state)) schedule(accepted.original)
          return accepted.operation
        },
        get(input) { text(input.operationId); return db.read(reader => { authorize(reader, input); const op = read(reader, input.operationId); if (op && op.runId !== input.runId) throw workerError('worker-operation-conflict'); return op }) },
        // Queries read the filesystem under the attachment's ceiling and never enter the operation ledger.
        async query(input, callerSignal) {
          assertOpen(); text(input?.attachmentId)
          const query = validateComputerQuery(input.query)
          const abort = new AbortController(), signal = AbortSignal.any([queries.signal, abort.signal, ...(callerSignal ? [callerSignal] : [])])
          // Register before the first asynchronous read; cancellation never detaches the real filesystem work.
          const done = Promise.resolve().then(async (): Promise<ComputerQueryResult> => {
            signal.throwIfAborted()
            const attachment = await db.read(reader => attachments.requireApprovedIn(reader, input.attachmentId))
            signal.throwIfAborted()
            const root = queryRoot(query), scopes = [attachment.ceiling, attachment.scope]
            if (scopes.some(scope => scope.kind !== 'computer')) throw workerError('worker-scope-rejected')
            let canonical: string
            try { canonical = await realpath(root) }
            catch (error) {
              signal.throwIfAborted()
              if (scopes.some(scope => scope.kind !== 'computer' || !ceilingPermitsRoot(scope, root))) throw workerError('worker-scope-rejected')
              if (query.kind === 'stat') return { kind: 'stat', directory: false, canonical: null }
              throw error
            }
            signal.throwIfAborted()
            for (const scope of scopes) if (!await canonicalPermitted(scope, canonical, signal)) throw workerError('worker-scope-rejected')
            let result: ComputerQueryResult
            switch (query.kind) {
              case 'stat': {
                try { result = { kind: 'stat', directory: (await stat(canonical)).isDirectory(), canonical } }
                catch { signal.throwIfAborted(); result = { kind: 'stat', directory: false, canonical: null } }
                break
              }
              case 'list': result = { kind: 'list', ...await listProjectDirectory(canonical, query.path, fileTreeLimits.scanEntries, signal) }; break
              case 'search': result = { kind: 'search', search: await searchProjectFiles(canonical, query.query, signal) }; break
              case 'read': result = { kind: 'read', preview: await readProjectFile(canonical, query.path, query.range, signal) }; break
            }
            signal.throwIfAborted()
            return result
          }).catch(error => {
            if (error instanceof Error && 'code' in error && error.code === 'file-cleanup-failed') { queryCleanupFailures.push(error); accepting = false }
            throw error
          })
          const pending = { attachmentId: input.attachmentId, abort, done }
          pendingQueries.add(pending)
          void done.finally(() => pendingQueries.delete(pending)).catch(() => {})
          return done
        },
        async shutdown() {
          accepting = false; queries.abort(workerError('worker-closing'))
          await Promise.allSettled([...pendingQueries].map(query => query.done))
          if (queryCleanupFailures.length) throw workerError('worker-cleanup-failed')
        },
      }
      ctx.provide(computerWorkerServiceKey, service)
      // Only never-started queued declarations can safely start after a worker restart.
      for (const row of await db.read(reader => reader.all("SELECT submission_json FROM computer_worker_operations WHERE state IN ('accepted','queued') ORDER BY rowid"))) schedule(JSON.parse(String(row.submission_json)) as WorkerSubmission)
      ctx.effect(() => async () => {
        accepting = false; queries.abort(workerError('worker-closing'))
        const failures: unknown[] = []
        try {
          await db.transaction(tx => {
            tx.execute('UPDATE computer_worker_runs SET cancelled = 1 WHERE closed = 0')
            tx.execute("UPDATE computer_worker_operations SET cancel_requested = 1, state = CASE WHEN state IN ('accepted','queued') THEN 'cancelled' ELSE state END WHERE state IN ('accepted','queued','starting','running') AND json_extract(submission_json,'$.kind') = 'tool'")
          })
        } catch (error) { failures.push(error) }
        for (const current of scopes.values()) current.abort.abort('worker-shutdown')
        for (const call of active.values()) call.cancel('worker-shutdown')
        await Promise.allSettled([...running.values(), ...[...pendingQueries].map(query => query.done)])
        failures.push(...queryCleanupFailures)
        for (const [runId, current] of scopes) {
          try {
            const uncertain = await db.read(reader => reader.get('SELECT uncertain FROM computer_worker_runs WHERE run_id = ?', [runId])?.uncertain === 1)
            if (uncertain) { await joined(current.execution.close()); throw workerError('worker-scope-unknown') }
            const cleanup = await joined(current.execution.close())
            await db.transaction(tx => tx.execute('UPDATE computer_worker_runs SET closed = 1, has_processes = 0, cleanup_json = ? WHERE run_id = ?', [JSON.stringify(cleanup), runId]))
          } catch (error) { failures.push(error) }
        }
        if (await db.read(reader => !!reader.get('SELECT 1 FROM computer_worker_runs WHERE closed = 0 AND uncertain = 1 LIMIT 1'))) failures.push(workerError('worker-scope-unknown'))
        if (failures.length) throw workerError('worker-cleanup-failed')
      }, 'cancel worker tools, join real exit, and commit scope cleanup')
    } }
}

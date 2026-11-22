import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { RunFailure } from '../run/domain.js'
import type { ToolObservation, RunFailureCategory } from '../run/domain.js'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageTransaction } from '@anybox/storage-sqlite/port'
import { workspacesServiceKey } from '../workspace/port.js'
import type { WorkspacesPort, WorkspaceBinding } from '../workspace/port.js'
import { imageAssetsServiceKey, isImageAssetError } from '../image/port.js'
import type { ImageAssetsPort } from '../image/port.js'
import { computerServiceKey } from './port.js'
import type { ComputersPort } from './port.js'
import { computerDeclarationDigest, computerWorkspaceScopeId, needsComputer, operationError, unitComputerId, unitComputerProviderId } from './operations-domain.js'
import type { ComputerDeclaration, ComputerOperation, ComputerOperationState, ComputerWorkspaceScope } from './operations-domain.js'
import { computerOperationsServiceKey } from './operations-port.js'
import type { ComputerOperationsPort, ComputerOperationsOptions, ComputerRunScope } from './operations-port.js'
import { computerWorkerServiceKey, workerBootOf, workerError } from './worker-port.js'
import { computerToolExecutor } from './tool-support.js'
import type { ComputerWorkerPort, WorkerOperation, WorkerSubmission } from './worker-port.js'
import { bindingMatches, computerScopeAllowsTool, isUnitError, localAttachmentId, unitError, validateRunUnitBinding } from '../unit/domain.js'
import type { RunUnitBinding } from '../unit/domain.js'
import { unitAttachmentsServiceKey } from '../unit/port.js'
import type { UnitAttachmentsPort } from '../unit/port.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_computer_operations (
    operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, declaration_json TEXT NOT NULL,
    declaration_digest TEXT NOT NULL, run_owner_epoch INTEGER NOT NULL, state TEXT NOT NULL,
    binding_json TEXT, observation_json TEXT, consumption_json TEXT, process_ref_json TEXT, observed INTEGER NOT NULL DEFAULT 0
  )`)
  tx.execute('CREATE INDEX harness_computer_operations_run ON harness_computer_operations(run_id, operation_id)')
} }, { version: 2, up(tx) {
  tx.execute('ALTER TABLE harness_computer_operations ADD COLUMN worker_receipt TEXT')
  tx.execute('ALTER TABLE harness_computer_operations ADD COLUMN error_json TEXT')
  tx.execute(`CREATE TABLE harness_computer_scopes (run_id TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, close_receipt TEXT, result_json TEXT)`)
} }, { version: 3, up(tx) {
  // Scopes opened before unit attachments existed talk to the local worker attachment.
  tx.execute('ALTER TABLE harness_computer_scopes ADD COLUMN unit_binding_json TEXT')
} }, { version: 4, up(tx) {
  tx.execute('ALTER TABLE harness_computer_scopes ADD COLUMN parent_run_id TEXT')
  tx.execute('ALTER TABLE harness_computer_scopes ADD COLUMN workspace_binding_id TEXT')
  tx.execute('UPDATE harness_computer_scopes SET parent_run_id=run_id')
  tx.execute('CREATE UNIQUE INDEX harness_computer_scopes_workspace ON harness_computer_scopes(parent_run_id,workspace_binding_id)')
  tx.execute(`CREATE TABLE harness_computer_process_handles (
    handle INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL REFERENCES harness_computer_scopes(run_id),
    worker_session_id INTEGER NOT NULL, UNIQUE(scope_id,worker_session_id))`)
} }]
const reservationId = (runId: string) => `computer-run:${runId}`
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const terminal = (state: ComputerOperationState) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
function workspaceScope(input: { runId: string; workspaceBindingId?: string; unit?: RunUnitBinding }): ComputerWorkspaceScope | undefined {
  if (input.workspaceBindingId === undefined) return undefined
  if (!input.workspaceBindingId || !input.unit || input.unit.unitKind !== 'computer') throw operationError('computer-operation-conflict')
  const unit = validateRunUnitBinding(input.unit)
  return { parentRunId: input.runId, bindingId: input.workspaceBindingId, attachmentId: unit.attachmentId, unitId: unit.unitId, unitEpoch: unit.epoch }
}

function processHandle(tx: StorageTransaction, scopeId: string, workerId: JsonValue, create: boolean): number {
  if (typeof workerId !== 'number' || !Number.isSafeInteger(workerId) || workerId < 1) throw operationError('computer-operation-conflict')
  const record = tx.get('SELECT handle FROM harness_computer_process_handles WHERE scope_id=? AND worker_session_id=?', [scopeId, workerId])
  if (record) return Number(record.handle)
  if (!create) throw operationError('computer-operation-conflict')
  return Number(tx.execute('INSERT INTO harness_computer_process_handles(scope_id,worker_session_id) VALUES (?,?)', [scopeId, workerId]).lastInsertRowid)
}
/** Worker process numbers are only meaningful in the original workspace and boot. */
function translateProcessResult(tx: StorageTransaction, declaration: ComputerDeclaration, binding: WorkspaceBinding,
  worker: WorkerOperation, observation: JsonValue | undefined): JsonValue | undefined {
  if (declaration.schemaVersion !== 2 || computerToolExecutor(declaration.request.name) !== 'processes' ||
    !observation || typeof observation !== 'object' || !('result' in observation)) return observation
  const result = observation.result
  if (!result || typeof result !== 'object' || !('session_id' in result)) return observation
  const workerId = result.session_id
  const create = declaration.tool.toolId !== 'codex.write_stdin'
  if (create) {
    const ref = worker.processRef
    if (!ref || ref.runId !== declaration.runId || ref.sessionId !== workerId || ref.computerInstanceId !== binding.computerInstanceId ||
      ref.instanceGeneration !== binding.instanceGeneration) throw operationError('computer-operation-conflict')
  } else if (declaration.request.arguments.session_id !== workerId) throw operationError('computer-operation-conflict')
  return { ...observation, result: { ...result, session_id: processHandle(tx, declaration.runId, workerId, create) } }
}
function translateProcessExits(tx: StorageTransaction, scopeId: string, fact: JsonValue): JsonValue {
  if (!fact || typeof fact !== 'object' || !('processes' in fact) || !Array.isArray(fact.processes)) return fact
  return { ...fact, processes: fact.processes.map((process: JsonValue) => {
    if (!process || typeof process !== 'object' || !('session_id' in process)) return process
    return { ...process, session_id: processHandle(tx, scopeId, process.session_id, true) }
  }) }
}
function read(reader: StorageReader, id: string): ComputerOperation | undefined {
  const row = reader.get('SELECT * FROM harness_computer_operations WHERE operation_id = ?', [id])
  if (!row) return undefined
  return { declaration: JSON.parse(String(row.declaration_json)) as ComputerDeclaration, declarationDigest: String(row.declaration_digest),
    runOwnerEpoch: Number(row.run_owner_epoch), state: String(row.state) as ComputerOperationState, observed: row.observed === 1,
    ...(typeof row.binding_json === 'string' ? { binding: JSON.parse(row.binding_json) as WorkspaceBinding } : {}),
    ...(typeof row.process_ref_json === 'string' ? { processRef: JSON.parse(row.process_ref_json) } : {}),
    ...(typeof row.observation_json === 'string' ? { observation: JSON.parse(row.observation_json) as JsonValue } : {}),
    ...(typeof row.worker_receipt === 'string' ? { workerReceipt: row.worker_receipt } : {}) }
}
function owner(reader: StorageReader, runId: string, epoch: number): void {
  const row = reader.get('SELECT owner_epoch FROM harness_computer_scopes WHERE run_id = ?', [runId])
  if (row && row.owner_epoch !== epoch) throw operationError('computer-operation-owner')
}
function remoteFailure(error?: WorkerOperation['error']): RunFailure {
  const category: RunFailureCategory = error?.category === 'timeout' ? 'tool-timeout' : error?.category === 'cancelled' ? 'tool-cancelled'
    : error?.category === 'cleanup-failure' ? 'tool-cleanup-failure' : error?.category === 'invalid-request' ? 'invalid-tool-request' : 'tool-unavailable'
  return new RunFailure(category)
}
function retryable(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return true // transport failure has no execution conclusion
  const code = String(error.code)
  if (error.name === 'ComputerWorkerError') return ['worker-unavailable','worker-closing','worker-startup-failed','worker-startup-timeout','worker-request-timeout'].includes(code)
  return !/owner|conflict|invalid|closed|generation|binding|unknown|cancelled|instance-replaced/.test(code)
}

export function createComputerOperationsComponent(inputs: RuntimeInputs, options: ComputerOperationsOptions = {}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort; [computerServiceKey]: ComputersPort; [workspacesServiceKey]: WorkspacesPort
  [computerWorkerServiceKey]: ComputerWorkerPort; [imageAssetsServiceKey]: ImageAssetsPort; [unitAttachmentsServiceKey]: UnitAttachmentsPort
}> {
  const computerId = options.computerId ?? 'local', spec = options.spec ?? { providerId: 'local', platform: process.platform, architecture: process.arch }
  return { name: 'harness-computer-operations', inject: [localStorageServiceKey, computerServiceKey, workspacesServiceKey, computerWorkerServiceKey, imageAssetsServiceKey, unitAttachmentsServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], computers = deps[computerServiceKey], workspaces = deps[workspacesServiceKey], worker = deps[computerWorkerServiceKey], attachments = deps[unitAttachmentsServiceKey]
      const scopeUnit = (reader: StorageReader, runId: string): RunUnitBinding | undefined => {
        const row = reader.get('SELECT unit_binding_json FROM harness_computer_scopes WHERE run_id=?', [runId])
        return typeof row?.unit_binding_json === 'string' ? validateRunUnitBinding(JSON.parse(row.unit_binding_json)) : undefined
      }
      const attachmentOf = (unit: RunUnitBinding | undefined) => unit?.attachmentId ?? localAttachmentId('computer')
      // A Run bound to a remote Computer unit declares against that unit's logical computer; its platform comes from the attachment record.
      // Only placement facts are read here; the approval fence runs when the declaration is about to start.
      const placementFor = (tx: StorageTransaction, binding: RunUnitBinding | undefined): { computerId: string; spec: typeof spec } => {
        const unit = binding === undefined ? undefined : validateRunUnitBinding(binding)
        if (!unit || unit.attachmentId === localAttachmentId('computer')) return { computerId, spec }
        if (unit.unitKind !== 'computer') throw operationError('computer-operation-conflict')
        const attachment = attachments.getIn(tx, unit.attachmentId)
        if (!attachment || attachment.unitKind !== 'computer' || attachment.unitId !== unit.unitId) throw operationError('computer-operation-unavailable')
        const raw = attachment.capabilities
        const capabilities = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Readonly<Record<string, JsonValue>> : {}
        const platform = capabilities.platform, architecture = capabilities.architecture
        if (typeof platform !== 'string' || !platform || typeof architecture !== 'string' || !architecture) throw operationError('computer-operation-unavailable')
        return { computerId: unitComputerId(unit.attachmentId), spec: { providerId: unitComputerProviderId, platform, architecture } }
      }
      await db.migrate('computer-operations', migrations)
      await db.transaction(tx => tx.execute("UPDATE harness_computer_operations SET state='outcome-unknown' WHERE state IN ('starting','running') AND NOT EXISTS (SELECT 1 FROM harness_computer_scopes s WHERE s.run_id=harness_computer_operations.run_id)"))
      let accepting = true
      const knownUnsent = new Set<string>()
      const scopes = new Map<string, ComputerRunScope>(), pending = new Set<Promise<unknown>>(), observers = new Set<AbortController>(), cleanupFailures = new Set<unknown>()
      const assertOpen = () => { if (!accepting) throw operationError('computer-operation-unavailable') }
      const track = <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise }
      const write = async <T>(work: (tx: StorageTransaction) => T): Promise<T> => {
        try { return await db.transaction(work) } catch (error) {
          if (error instanceof RunFailure || error instanceof Error && ['ComputerError','WorkspaceError','ComputerOperationError'].includes(error.name)) throw error
          if (isUnitError(error)) throw new RunFailure('tool-unavailable')
          accepting = false; throw new RunFailure('state-write-failure')
        }
      }
      const wait = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(operationError('computer-operation-unavailable')); return }
        const end = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() }
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(operationError('computer-operation-unavailable')) }
        const timer = setTimeout(end, 30); signal.addEventListener('abort', abort, { once: true })
      })
      // The unit holds something of this Run only once a submission was durably received there.
      const delivered = (reader: StorageReader, runId: string) =>
        !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND worker_receipt IS NOT NULL LIMIT 1', [runId]) ||
        !!reader.get('SELECT 1 FROM harness_computer_scopes WHERE run_id=? AND close_receipt IS NOT NULL', [runId])
      // A restarted observer cannot prove that a previously placed call with no receipt was never dispatched.
      const unconfirmed = (reader: StorageReader, runId: string) => reader.all("SELECT operation_id FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL AND worker_receipt IS NULL AND state IN ('starting','running','outcome-unknown')", [runId]).some(row => !knownUnsent.has(String(row.operation_id)))
      const unreachable = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'worker-unreachable'
      const transportFailure = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'worker-unreachable' || error.code === 'worker-unavailable')
      // A revoked or narrowed attachment will never answer again for this Run: its placed operations become outcome-unknown instead of waiting forever.
      const stillAttached = async (unit: RunUnitBinding | undefined) => {
        if (!unit || unit.attachmentId === localAttachmentId('computer')) return
        if (!bindingMatches(unit, await attachments.get(unit.attachmentId))) throw Object.assign(workerError('worker-attachment-revoked'), { category: 'cleanup-failure' })
      }
      const reconcile = async (submission: WorkerSubmission, signal: AbortSignal, unit?: RunUnitBinding, mayHaveDispatched = false): Promise<WorkerOperation> => {
        while (!signal.aborted) {
          await db.read(reader => owner(reader, submission.runId, submission.runOwnerEpoch))
          try {
            await worker.claimRun(submission)
            const known = await worker.get(submission)
            let current: WorkerOperation
            if (known) { knownUnsent.delete(submission.operationId); current = known }
            else {
              // A restored or ambiguously delivered workspace tool has no permission for a new dispatch.
              if (submission.declaration?.schemaVersion === 2 && mayHaveDispatched) throw workerError('worker-outcome-unknown')
              knownUnsent.delete(submission.operationId)
              try { current = await worker.submit(submission) }
              catch (error) {
                if (!unreachable(error)) mayHaveDispatched = true
                else if (!mayHaveDispatched) knownUnsent.add(submission.operationId)
                throw error
              }
            }
            if (current.operationId !== submission.operationId || current.runId !== submission.runId || current.declarationDigest !== submission.declarationDigest) throw operationError('computer-operation-conflict')
            mayHaveDispatched = true
            if (terminal(current.state)) return current
            if (submission.kind === 'tool') await write(tx => {
              owner(tx,submission.runId,submission.runOwnerEpoch)
              const prior = read(tx,submission.operationId)
              if (prior && !terminal(prior.state) && (prior.state !== current.state || prior.workerReceipt !== current.receipt)) tx.execute('UPDATE harness_computer_operations SET state=?,worker_receipt=? WHERE operation_id=?',[current.state,current.receipt,submission.operationId])
            })
          } catch (error) {
            if (transportFailure(error)) await stillAttached(unit)
            // A unit that never received anything of this Run makes admission fail; once it holds a receipt, an outage only delays.
            if (unreachable(error)) { if (!mayHaveDispatched && !await db.read(reader => delivered(reader, submission.runId))) throw error }
            else if (!retryable(error)) throw error
          }
          await wait(signal)
        }
        throw operationError('computer-operation-unavailable')
      }
      ctx.effect(() => async () => {
        accepting = false; for (const observer of observers) observer.abort()
        await Promise.allSettled([...pending])
        if (cleanupFailures.size) throw operationError('computer-operation-cleanup')
      }, 'stop local computer observations and join persistence')
      const service: ComputerOperationsPort = {
        acceptIn(tx, input) {
          assertOpen()
          if (!needsComputer(input.request)) throw operationError('computer-operation-conflict')
          const epoch = input.runOwnerEpoch ?? 1, workspace = workspaceScope(input)
          const scopeId = workspace ? computerWorkspaceScopeId(workspace) : input.runId
          if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          const prior = read(tx, input.operationId)
          const sibling = tx.get('SELECT run_id FROM harness_computer_scopes WHERE parent_run_id=? AND workspace_binding_id IS ?', [input.runId, input.workspaceBindingId ?? null])
          if (sibling && sibling.run_id !== scopeId) throw operationError('computer-operation-conflict')
          owner(tx, scopeId, epoch)
          const placement = placementFor(tx, input.unit)
          computers.reserveIn(tx, placement)
          const reservation = prior ? undefined : workspaces.reserveIn(tx, { reservationId: reservationId(scopeId), scopeId, projectId: input.projectId,
            ...(workspace ? { projectWorkspaceId: workspace.bindingId, projectWorkspaceRevision: input.workspaceBindingRevision, computerAttachmentId: workspace.attachmentId } : {}) })
          let request = input.request
          if (workspace && input.tool.toolId === 'codex.write_stdin') {
            const handle = request.arguments.session_id
            const process = typeof handle === 'number' && Number.isSafeInteger(handle) && tx.get('SELECT worker_session_id FROM harness_computer_process_handles WHERE scope_id=? AND handle=?', [scopeId, handle])
            if (!process) throw new RunFailure('invalid-tool-request')
            request = { ...request, arguments: { ...request.arguments, session_id: Number(process.worker_session_id) } }
          }
          const declaration = json({ ...(workspace ? { schemaVersion: 2, workspaceScope: workspace } : { schemaVersion: 1 }), operationId: input.operationId, runId: scopeId, sessionId: input.sessionId,
            projectId: input.projectId, tool: input.tool, request, workspaceId: prior?.declaration.workspaceId ?? reservation!.workspaceId,
            workspaceRevision: prior?.declaration.workspaceRevision ?? 0, computerId: placement.computerId, spec: placement.spec }) as unknown as ComputerDeclaration
          const digest = computerDeclarationDigest(declaration)
          if (prior) { if (prior.declarationDigest !== digest) throw operationError('computer-operation-conflict'); return prior }
          tx.execute(`INSERT INTO harness_computer_scopes(run_id,parent_run_id,workspace_binding_id,owner_epoch,unit_binding_json)
            VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING`, [scopeId, input.runId, input.workspaceBindingId ?? null, epoch, workspace ? JSON.stringify(input.unit) : null])
          owner(tx, scopeId, epoch)
          tx.execute(`INSERT INTO harness_computer_operations (operation_id,run_id,declaration_json,declaration_digest,run_owner_epoch,state) VALUES (?,?,?,?,?,'accepted')`,
            [input.operationId,scopeId,JSON.stringify(declaration),digest,epoch]); return read(tx, input.operationId)!
        },
        claimRunIn(tx, runId, epoch) {
          assertOpen(); if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          if (tx.get('SELECT 1 FROM harness_computer_scopes WHERE parent_run_id=? AND owner_epoch>?', [runId, epoch])) throw operationError('computer-operation-owner')
          tx.execute('UPDATE harness_computer_scopes SET owner_epoch=? WHERE parent_run_id=?', [epoch, runId])
          tx.execute('UPDATE harness_computer_operations SET run_owner_epoch=? WHERE run_id IN (SELECT run_id FROM harness_computer_scopes WHERE parent_run_id=?)', [epoch, runId])
        },
        requestCancelIn(tx, runId) { assertOpen(); tx.execute('UPDATE harness_computer_scopes SET cancel_requested=1 WHERE parent_run_id=?', [runId]) },
        observeIn(tx, id, observation) {
          assertOpen(); const prior = read(tx,id); if (!prior) return
          if (!terminal(prior.state)) throw operationError('computer-operation-conflict')
          const text = JSON.stringify(json(observation))
          if (prior.observed) { if (tx.get('SELECT consumption_json FROM harness_computer_operations WHERE operation_id=?',[id])?.consumption_json !== text) throw operationError('computer-operation-conflict'); return }
          tx.execute('UPDATE harness_computer_operations SET observed=1,consumption_json=? WHERE operation_id=?',[text,id])
        },
        get(id) { assertOpen(); return track(db.read(reader => read(reader,id))) },
        hasRunResources(runId, workspaceBindingId) {
          assertOpen()
          return track(db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_scopes WHERE parent_run_id=? AND workspace_binding_id IS ?', [runId, workspaceBindingId ?? null])))
        },
        authorizeRun(runId, runOwnerEpoch, signal) {
          assertOpen()
          return track((async () => {
            const placed = await db.read(reader => reader.all(`SELECT run_id FROM harness_computer_scopes s WHERE parent_run_id=? AND closed=0
              AND EXISTS (SELECT 1 FROM harness_computer_operations o WHERE o.run_id=s.run_id AND o.binding_json IS NOT NULL)`, [runId]).map(row => {
              const scopeId = String(row.run_id)
              owner(reader, scopeId, runOwnerEpoch)
              const unit = scopeUnit(reader, scopeId)
              return { scopeId, unit, attachmentId: attachmentOf(unit) }
            }))
            const failed = new AbortController(), lifetime = AbortSignal.any([signal, failed.signal])
            const attempts = placed.map(async ({ scopeId, unit, attachmentId }) => {
              while (!lifetime.aborted) {
                try { await worker.claimRun({ runId: scopeId, runOwnerEpoch, attachmentId }); return }
                catch (error) {
                  if (transportFailure(error)) await stillAttached(unit)
                  if (unreachable(error)) { if (!await db.read(reader => delivered(reader, scopeId) || unconfirmed(reader, scopeId))) return }
                  else if (!retryable(error)) throw error
                }
                await wait(lifetime)
              }
              throw operationError('computer-operation-unavailable')
            })
            try { await Promise.all(attempts) }
            finally { failed.abort(); await Promise.allSettled(attempts) }
          })())
        },
        recoverCancelledRuns(excludeRunIds) {
          assertOpen()
          return track((async () => {
            const excluded = new Set(excludeRunIds)
            const runs = await db.read(reader => reader.all('SELECT run_id,parent_run_id,workspace_binding_id,owner_epoch,unit_binding_json FROM harness_computer_scopes WHERE cancel_requested=1 AND closed=0'))
            const results = await Promise.allSettled(runs.filter(row => !excluded.has(String(row.parent_run_id))).map(async row => {
              const scope = service.openRun({runId:String(row.parent_run_id),runOwnerEpoch:Number(row.owner_epoch),
                ...(typeof row.workspace_binding_id === 'string' ? {workspaceBindingId: row.workspace_binding_id} : {}),
                ...(typeof row.unit_binding_json === 'string' ? { unit: validateRunUnitBinding(JSON.parse(row.unit_binding_json)) } : {})})
              try {
                await scope.cancel()
                const ids = await db.read(reader => reader.all('SELECT operation_id FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[String(row.run_id)]))
                for (const operation of ids) {
                  const call = scope.execute(String(operation.operation_id))
                  await Promise.allSettled([call.result,call.done])
                }
              } finally {
                const call = scope.close(); try { await call.result } finally { await call.done }
              }
            }))
            const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (failures.length) throw new AggregateError(failures, 'Computer scope recovery failed')
          })())
        },
        openRun(input) {
          const workspace = workspaceScope(input), scopeId = workspace ? computerWorkspaceScopeId(workspace) : input.runId
          assertOpen(); if (scopes.has(scopeId)) throw operationError('computer-operation-conflict')
          const epoch = input.runOwnerEpoch ?? 1
          if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          const unit = input.unit === undefined ? undefined : validateRunUnitBinding(input.unit)
          if (unit && unit.unitKind !== 'computer') throw operationError('computer-operation-conflict')
          const attachmentId = attachmentOf(unit)
          let unitFixed = false
          // The scope's unit reference is persisted with the first placement so recovery and cancellation use the same attachment.
          const fixUnit = (tx: StorageTransaction) => {
            if (unitFixed) return
            const stored = scopeUnit(tx, scopeId)
            if (stored ? stored.attachmentId !== attachmentId : unit !== undefined) {
              if (stored) throw operationError('computer-operation-conflict')
              tx.execute('UPDATE harness_computer_scopes SET unit_binding_json=? WHERE run_id=?', [JSON.stringify(unit), scopeId])
            }
            unitFixed = true
          }
          const controller = new AbortController(); observers.add(controller)
          const calls = new Map<string,OwnedCall<ToolObservation>>()
          let binding: WorkspaceBinding | undefined, preparing: Promise<WorkspaceBinding> | undefined, stopped = false
          let closeCall: OwnedCall<JsonValue> | undefined, cancellation: Promise<unknown> | undefined, cleanupFailed = false
          const check = () => { assertOpen(); controller.signal.throwIfAborted(); if (stopped) throw operationError('computer-operation-unavailable') }
          const control = (kind: 'cancel'|'close-scope'): WorkerSubmission => {
            const operationId = `${scopeId}:computer-${kind}`
            return { operationId, runId: scopeId,runOwnerEpoch:epoch,attachmentId,kind,declarationDigest:createHash('sha256').update(JSON.stringify({operationId,runId:scopeId,kind})).digest('hex') }
          }
          const cancel = () => cancellation ??= track((async () => {
            await write(tx => { owner(tx,scopeId,epoch); tx.execute('UPDATE harness_computer_scopes SET cancel_requested=1 WHERE run_id=?', [scopeId])
              tx.execute("UPDATE harness_computer_operations SET state='cancelled',error_json=? WHERE run_id=? AND binding_json IS NULL AND state IN ('accepted','queued')",[JSON.stringify({category:'cancelled'}),scopeId])
            })
            if (await db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[scopeId]))) {
              // Nothing to cancel on a unit that never received this Run.
              try { await reconcile(control('cancel'),controller.signal,unit,await db.read(reader => unconfirmed(reader, scopeId))) } catch (error) { if (!unreachable(error)) throw error }
            }
          })())
          const prepare = (operation: ComputerOperation): Promise<WorkspaceBinding> => preparing ??= (async () => {
            const existing = operation.binding ?? await workspaces.getBinding(reservationId(scopeId))
            if (existing) { binding = existing; return existing }
            const activation = computers.activate(operation.declaration.computerId)
            let active: Awaited<typeof activation.result>; try { active = await activation.result } finally { await activation.done }
            check(); const preparation = workspaces.prepare({reservationId:reservationId(scopeId),instance:active})
            let ready: Awaited<typeof preparation.result>; try { ready = await preparation.result } finally { await preparation.done }
            check(); return binding = await write(tx => { owner(tx,scopeId,epoch)
              const selected = workspaces.bindIn(tx,{reservationId:reservationId(scopeId),prepared:ready})
              computers.pinIn(tx,{...selected,pinId:reservationId(scopeId),ownerId:scopeId}); return selected
            })
          })()
          const scope: ComputerRunScope = {
            execute(id) {
              check(); const existing = calls.get(id); if (existing) return existing
              let cancelled = false
              const result = track(Promise.resolve().then(async () => {
                const operation = await db.read(reader => { owner(reader,scopeId,epoch); return read(reader,id) })
                if (!operation || operation.declaration.runId !== scopeId) throw operationError('computer-operation-missing')
                if (operation.runOwnerEpoch !== epoch) throw operationError('computer-operation-owner')
                if (terminal(operation.state)) {
                  const row = await db.read(reader => reader.get('SELECT error_json FROM harness_computer_operations WHERE operation_id=?',[id]))
                  const error = typeof row?.error_json === 'string' ? JSON.parse(row.error_json) as WorkerOperation['error'] : undefined
                  if (operation.state === 'outcome-unknown' || error?.category === 'cleanup-failure') cleanupFailed = true
                  if (operation.observation && typeof operation.observation === 'object' && 'result' in operation.observation) return operation.observation as unknown as ToolObservation
                  if (cleanupFailed) throw operationError('computer-operation-cleanup')
                  if (error?.name === 'ComputerOperationError' && error.code === 'worker-scope-version-unsupported') throw new RunFailure('computer-worker-upgrade-required')
                  throw remoteFailure(error)
                }
                const cancellationRequested = await db.read(reader => reader.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[scopeId])?.cancel_requested === 1)
                if ((cancelled || cancellationRequested) && !operation.binding) { await write(tx => { owner(tx,scopeId,epoch); tx.execute("UPDATE harness_computer_operations SET state='cancelled',error_json=? WHERE operation_id=?",[JSON.stringify({category:'cancelled'}),id]) }); throw new RunFailure('tool-cancelled') }
                const selected = operation.binding ?? binding ?? await prepare(operation)
                // A v2 operation with a placement may only observe its original receipt, including after the instance retired.
                const bootId = operation.binding && workspace ? undefined : workerBootOf((await computers.requireInstance(selected)).providerRef)
                if (workspace && !operation.binding) {
                  const info = await worker.info(attachmentId)
                  if (info.workspaceScopeVersion !== 1) throw Object.assign(new RunFailure('computer-worker-upgrade-required'), { code: 'worker-scope-version-unsupported' })
                  if (info.bootId !== bootId) throw workerError('worker-instance-replaced')
                }
                if (!operation.binding) await write(tx => { owner(tx,scopeId,epoch)
                  if (cancelled || tx.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[scopeId])?.cancel_requested === 1 || read(tx,id)?.state === 'cancelled') throw new RunFailure('tool-cancelled')
                  // A revoked or narrowed attachment rejects new declarations; operations already placed continue to their exit.
                  if (unit) {
                    const attachment = attachments.requireApprovedIn(tx, unit)
                    if (!computerScopeAllowsTool(attachment.scope, operation.declaration.tool.toolId)) throw unitError('unit-scope-exceeded')
                  }
                  fixUnit(tx)
                  workspaces.requireBindingIn(tx,{...selected,reservationId:reservationId(scopeId),scopeId})
                  knownUnsent.add(id)
                  tx.execute("UPDATE harness_computer_operations SET state='starting',binding_json=? WHERE operation_id=?",[JSON.stringify(selected),id])
                })
                const wanted = await db.read(reader => reader.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[scopeId])?.cancel_requested === 1)
                if (wanted || cancelled) await cancel()
                const outcome = await reconcile({ operationId:id,runId:scopeId,runOwnerEpoch:epoch,attachmentId,declarationDigest:operation.declarationDigest,kind:'tool',
                  declaration:operation.declaration,binding:selected,...(bootId === undefined ? {} : {workerBootId:bootId}),imageInput:input.imageInput === true },controller.signal,unit,operation.binding !== undefined)
                let observed = outcome.observation
                if (outcome.images?.length && observed && typeof observed === 'object' && !Array.isArray(observed)) {
                  const imported = []
                  for (const image of outcome.images) {
                    if (image.pushed) {
                      // The unit already pushed the bytes through the byte channel; the receipt must name the same immutable bytes.
                      if (image.pushed.sha256 !== image.ref.sha256 || image.pushed.byteLength !== image.ref.byteLength) throw operationError('computer-operation-conflict')
                      const described = await deps[imageAssetsServiceKey].describe(operation.declaration.sessionId, [image.pushed.assetId])
                        .then(refs => refs[0], error => { if (isImageAssetError(error)) return undefined; throw error })
                      if (!described || described.sha256 !== image.ref.sha256 || described.byteLength !== image.ref.byteLength) throw operationError('computer-operation-conflict')
                      const { expiresAt: _draft, ...ref } = described; imported.push(ref); continue
                    }
                    if (typeof image.base64 !== 'string') throw operationError('computer-operation-conflict')
                    const bytes = Buffer.from(image.base64,'base64')
                    if (bytes.byteLength !== image.ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== image.ref.sha256) throw operationError('computer-operation-conflict')
                    const call = deps[imageAssetsServiceKey].importImage({scopeId:operation.declaration.sessionId,bytes:(async function* () { yield bytes })()})
                    try { const {expiresAt:_expiry,...ref} = await call.result; imported.push(ref) } finally { await call.done }
                  }
                  observed = {...observed,images:imported} as JsonValue
                }
                await write(tx => { owner(tx,scopeId,epoch)
                  observed = translateProcessResult(tx, operation.declaration, selected, outcome, observed)
                  const refs = observed && typeof observed === 'object' && 'images' in observed ? observed.images : undefined
                  if (Array.isArray(refs)) deps[imageAssetsServiceKey].retainIn(tx,operation.declaration.sessionId,`computer-operation:${id}`,refs as unknown as import('../image/port.js').ImageRef[])
                  tx.execute('UPDATE harness_computer_operations SET state=?,worker_receipt=?,observation_json=?,error_json=?,process_ref_json=? WHERE operation_id=?',
                  [outcome.state,outcome.receipt,observed === undefined ? null : JSON.stringify(observed),outcome.error ? JSON.stringify(outcome.error) : null,outcome.processRef ? JSON.stringify(outcome.processRef) : null,id]) })
                if (outcome.state === 'outcome-unknown' || outcome.error?.category === 'cleanup-failure') {
                  cleanupFailed = true
                  if (observed) return observed as unknown as ToolObservation
                  throw operationError('computer-operation-cleanup')
                }
                if (outcome.error) throw remoteFailure(outcome.error)
                if (!observed) throw remoteFailure(); return observed as unknown as ToolObservation
              }).catch(async error => {
                const code = error instanceof Error && 'code' in error ? String(error.code) : ''
                if (/owner/.test(code) || controller.signal.aborted || error instanceof RunFailure && error.category === 'state-write-failure') throw error
                await write(tx => {
                  owner(tx,scopeId,epoch)
                  const current = read(tx,id)
                  if (!current || current.declaration.runId !== scopeId || terminal(current.state)) return
                  const mayHaveDispatched = current.declaration.schemaVersion === 1 || current.binding !== undefined
                  const unknown = mayHaveDispatched && /unknown|instance-replaced|worker-request-failed|worker-cleanup-failed|attachment-revoked/.test(code)
                  if (unknown) cleanupFailed = true
                  const state = unknown ? 'outcome-unknown' : /cancelled/.test(code) || cancelled || error instanceof RunFailure && error.category === 'tool-cancelled' ? 'cancelled' : 'failed'
                  const reason = error instanceof RunFailure && error.category === 'computer-worker-upgrade-required' ? { code: 'worker-scope-version-unsupported' } : {}
                  tx.execute('UPDATE harness_computer_operations SET state=?,error_json=? WHERE operation_id=?', [state,JSON.stringify({name:'ComputerOperationError',message:code || 'tool unavailable',...reason,category:state === 'cancelled' ? 'cancelled' : unknown ? 'cleanup-failure' : 'unavailable'}),id])
                })
                throw error
              }))
              const done = result.then(() => {},() => {}).then(() => { if (cleanupFailed) throw operationError('computer-operation-cleanup') })
              const call: OwnedCall<ToolObservation> = {result,done,cancel() { cancelled = true; void cancel().catch(() => {}) }}
              calls.set(id,call); void result.catch(() => {}); void done.catch(() => {}); return call
            },
            async cancel() { await cancel() },
            close() {
              if (closeCall) return closeCall; stopped = true
              const result = track((async () => {
                await Promise.allSettled([...calls.values()].map(call => call.done)); await cancellation
                const persisted = await db.read(reader => { owner(reader,scopeId,epoch); return reader.get('SELECT * FROM harness_computer_scopes WHERE run_id=?',[scopeId]) })
                if (!persisted) return {processes:[]}
                if (persisted.closed === 1) return JSON.parse(String(persisted.result_json)) as JsonValue
                const placed = await db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[scopeId]))
                if (persisted.cancel_requested === 1 && placed) await cancel()
                // A placed Run whose unit never received a submission has no remote scope to close.
                const closed = placed ? await reconcile(control('close-scope'),controller.signal,unit,await db.read(reader => unconfirmed(reader, scopeId))).catch(error => { if (unreachable(error)) return undefined; throw error }) : undefined
                if (closed?.error || closed?.state === 'outcome-unknown' || cleanupFailed) {
                  cleanupFailed = true
                  if (closed?.observation !== undefined) {
                    const original = closed.observation
                    return write(tx => { owner(tx,scopeId,epoch)
                      const fact = workspace ? translateProcessExits(tx, scopeId, original) : original
                      tx.execute('UPDATE harness_computer_scopes SET close_receipt=?,result_json=? WHERE run_id=?',[closed.receipt,JSON.stringify(fact),scopeId])
                      return fact
                    })
                  }
                  throw operationError('computer-operation-cleanup')
                }
                const original = closed?.observation ?? {processes:[]}
                return write(tx => { owner(tx,scopeId,epoch)
                  const fact = workspace ? translateProcessExits(tx, scopeId, original) : original
                  if (tx.get("SELECT 1 FROM harness_computer_operations WHERE run_id=? AND state='outcome-unknown'",[scopeId])) throw operationError('computer-operation-cleanup')
                  tx.execute("UPDATE harness_computer_operations SET state='cancelled' WHERE run_id=? AND state IN ('accepted','queued','starting','running')",[scopeId])
                  workspaces.releaseIn(tx,reservationId(scopeId),scopeId); computers.releasePinIn(tx,reservationId(scopeId),scopeId)
                  tx.execute('UPDATE harness_computer_scopes SET closed=1,close_receipt=?,result_json=? WHERE run_id=?',[closed?.receipt ?? null,JSON.stringify(fact),scopeId])
                  return fact
                })
              })().catch(error => { cleanupFailed = true; throw error }))
              const done = result.then(() => {},() => {}).then(() => { if (cleanupFailed) throw operationError('computer-operation-cleanup') }).catch(error => {cleanupFailures.add(error);throw error})
                .finally(() => {observers.delete(controller);scopes.delete(scopeId)})
              closeCall = {result,done,cancel() {}}; void result.catch(() => {}); void done.catch(() => {}); return closeCall
            },
          }
          scopes.set(scopeId,scope); return scope
        },
      }
      ctx.provide(computerOperationsServiceKey,service)
    },
  }
}

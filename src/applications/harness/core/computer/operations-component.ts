import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { RunFailure } from '../run/domain.js'
import type { ToolObservation, RunFailureCategory } from '../run/domain.js'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageTransaction } from '../../../../storage/port.js'
import { workspacesServiceKey } from '../workspace/port.js'
import type { WorkspacesPort, WorkspaceBinding } from '../workspace/port.js'
import { imageAssetsServiceKey } from '../image/port.js'
import type { ImageAssetsPort } from '../image/port.js'
import { computerServiceKey } from './port.js'
import type { ComputersPort } from './port.js'
import { computerDeclarationDigest, needsComputer, operationError } from './operations-domain.js'
import type { ComputerDeclaration, ComputerOperation, ComputerOperationState } from './operations-domain.js'
import { computerOperationsServiceKey } from './operations-port.js'
import type { ComputerOperationsPort, ComputerOperationsOptions, ComputerRunScope } from './operations-port.js'
import { computerWorkerServiceKey } from './worker-port.js'
import type { ComputerWorkerPort, WorkerOperation, WorkerSubmission } from './worker-port.js'

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
} }]
const reservationId = (runId: string) => `computer-run:${runId}`
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const terminal = (state: ComputerOperationState) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
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
  [computerWorkerServiceKey]: ComputerWorkerPort; [imageAssetsServiceKey]: ImageAssetsPort
}> {
  const computerId = options.computerId ?? 'local', spec = options.spec ?? { providerId: 'local', platform: process.platform, architecture: process.arch }
  return { name: 'harness-computer-operations', inject: [localStorageServiceKey, computerServiceKey, workspacesServiceKey, computerWorkerServiceKey, imageAssetsServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], computers = deps[computerServiceKey], workspaces = deps[workspacesServiceKey], worker = deps[computerWorkerServiceKey]
      await db.migrate('computer-operations', migrations)
      await db.transaction(tx => tx.execute("UPDATE harness_computer_operations SET state='outcome-unknown' WHERE state IN ('starting','running') AND NOT EXISTS (SELECT 1 FROM harness_computer_scopes s WHERE s.run_id=harness_computer_operations.run_id)"))
      let accepting = true
      const scopes = new Map<string, ComputerRunScope>(), pending = new Set<Promise<unknown>>(), observers = new Set<AbortController>(), cleanupFailures = new Set<unknown>()
      const assertOpen = () => { if (!accepting) throw operationError('computer-operation-unavailable') }
      const track = <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise }
      const write = async <T>(work: (tx: StorageTransaction) => T): Promise<T> => {
        try { return await db.transaction(work) } catch (error) {
          if (error instanceof RunFailure || error instanceof Error && ['ComputerError','WorkspaceError','ComputerOperationError'].includes(error.name)) throw error
          accepting = false; throw new RunFailure('state-write-failure')
        }
      }
      const wait = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(operationError('computer-operation-unavailable')); return }
        const end = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() }
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(operationError('computer-operation-unavailable')) }
        const timer = setTimeout(end, 30); signal.addEventListener('abort', abort, { once: true })
      })
      const reconcile = async (submission: WorkerSubmission, signal: AbortSignal): Promise<WorkerOperation> => {
        while (!signal.aborted) {
          await db.read(reader => owner(reader, submission.runId, submission.runOwnerEpoch))
          try {
            await worker.claimRun(submission)
            const known = await worker.get(submission), current = known ?? await worker.submit(submission)
            if (current.declarationDigest !== submission.declarationDigest) throw operationError('computer-operation-conflict')
            if (terminal(current.state)) return current
            if (submission.kind === 'tool') await write(tx => {
              owner(tx,submission.runId,submission.runOwnerEpoch)
              const prior = read(tx,submission.operationId)
              if (prior && !terminal(prior.state) && (prior.state !== current.state || prior.workerReceipt !== current.receipt)) tx.execute('UPDATE harness_computer_operations SET state=?,worker_receipt=? WHERE operation_id=?',[current.state,current.receipt,submission.operationId])
            })
          } catch (error) { if (!retryable(error)) throw error }
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
          assertOpen(); if (!needsComputer(input.request)) throw operationError('computer-operation-conflict')
          const epoch = input.runOwnerEpoch ?? 1
          if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          const prior = read(tx, input.operationId)
          owner(tx, input.runId, epoch)
          computers.reserveIn(tx, { computerId, spec })
          const reservation = prior ? undefined : workspaces.reserveIn(tx, { reservationId: reservationId(input.runId), scopeId: input.runId, projectId: input.projectId })
          const declaration = json({ schemaVersion: 1, operationId: input.operationId, runId: input.runId, sessionId: input.sessionId,
            projectId: input.projectId, tool: input.tool, request: input.request, workspaceId: prior?.declaration.workspaceId ?? reservation!.workspaceId,
            workspaceRevision: prior?.declaration.workspaceRevision ?? 0, computerId, spec }) as unknown as ComputerDeclaration
          const digest = computerDeclarationDigest(declaration)
          if (prior) { if (prior.declarationDigest !== digest) throw operationError('computer-operation-conflict'); return prior }
          tx.execute('INSERT OR IGNORE INTO harness_computer_scopes (run_id,owner_epoch) VALUES (?,?)', [input.runId, epoch]); owner(tx, input.runId, epoch)
          tx.execute(`INSERT INTO harness_computer_operations (operation_id,run_id,declaration_json,declaration_digest,run_owner_epoch,state) VALUES (?,?,?,?,?,'accepted')`,
            [input.operationId,input.runId,JSON.stringify(declaration),digest,epoch]); return read(tx, input.operationId)!
        },
        claimRunIn(tx, runId, epoch) {
          assertOpen(); if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          const prior = tx.get('SELECT owner_epoch FROM harness_computer_scopes WHERE run_id=?', [runId])
          if (prior && Number(prior.owner_epoch) > epoch) throw operationError('computer-operation-owner')
          tx.execute('UPDATE harness_computer_scopes SET owner_epoch=? WHERE run_id=?', [epoch,runId])
          tx.execute('UPDATE harness_computer_operations SET run_owner_epoch=? WHERE run_id=?', [epoch,runId])
        },
        requestCancelIn(tx, runId) { assertOpen(); tx.execute('UPDATE harness_computer_scopes SET cancel_requested=1 WHERE run_id=?', [runId]) },
        observeIn(tx, id, observation) {
          assertOpen(); const prior = read(tx,id); if (!prior) return
          if (!terminal(prior.state)) throw operationError('computer-operation-conflict')
          const text = JSON.stringify(json(observation))
          if (prior.observed) { if (tx.get('SELECT consumption_json FROM harness_computer_operations WHERE operation_id=?',[id])?.consumption_json !== text) throw operationError('computer-operation-conflict'); return }
          tx.execute('UPDATE harness_computer_operations SET observed=1,consumption_json=? WHERE operation_id=?',[text,id])
        },
        get(id) { assertOpen(); return track(db.read(reader => read(reader,id))) },
        hasRunResources(id) { assertOpen(); return track(db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_scopes WHERE run_id=?',[id]))) },
        authorizeRun(runId,runOwnerEpoch,signal) {
          assertOpen()
          return track((async () => {
            const placed = await db.read(reader => { owner(reader,runId,runOwnerEpoch); return !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[runId]) })
            if (!placed) return
            while (!signal.aborted) {
              try { await worker.claimRun({runId,runOwnerEpoch}); return }
              catch (error) { if (!retryable(error)) throw error }
              await wait(signal)
            }
            throw operationError('computer-operation-unavailable')
          })())
        },
        recoverCancelledRuns(excludeRunIds) {
          assertOpen()
          return track((async () => {
            const excluded = new Set(excludeRunIds)
            const runs = await db.read(reader => reader.all('SELECT run_id,owner_epoch FROM harness_computer_scopes WHERE cancel_requested=1 AND closed=0'))
            await Promise.all(runs.filter(row => !excluded.has(String(row.run_id))).map(async row => {
              const scope = service.openRun({runId:String(row.run_id),runOwnerEpoch:Number(row.owner_epoch)})
              await scope.cancel()
              const ids = await db.read(reader => reader.all('SELECT operation_id FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[String(row.run_id)]))
              for (const operation of ids) {
                const call = scope.execute(String(operation.operation_id))
                await Promise.allSettled([call.result,call.done])
              }
              const call = scope.close(); try { await call.result } finally { await call.done }
            }))
          })())
        },
        openRun(input) {
          assertOpen(); if (scopes.has(input.runId)) throw operationError('computer-operation-conflict')
          const epoch = input.runOwnerEpoch ?? 1
          if (!Number.isSafeInteger(epoch) || epoch < 1) throw operationError('computer-operation-owner')
          const controller = new AbortController(); observers.add(controller)
          const calls = new Map<string,OwnedCall<ToolObservation>>()
          let binding: WorkspaceBinding | undefined, preparing: Promise<WorkspaceBinding> | undefined, stopped = false
          let closeCall: OwnedCall<JsonValue> | undefined, cancellation: Promise<unknown> | undefined, processes = false, cleanupFailed = false
          const check = () => { assertOpen(); controller.signal.throwIfAborted(); if (stopped) throw operationError('computer-operation-unavailable') }
          const control = (kind: 'cancel'|'close-scope'): WorkerSubmission => {
            const operationId = `${input.runId}:computer-${kind}`
            return { operationId, runId: input.runId,runOwnerEpoch:epoch,kind,declarationDigest:createHash('sha256').update(JSON.stringify({operationId,runId:input.runId,kind})).digest('hex') }
          }
          const cancel = () => cancellation ??= track((async () => {
            await write(tx => { owner(tx,input.runId,epoch); service.requestCancelIn(tx,input.runId)
              tx.execute("UPDATE harness_computer_operations SET state='cancelled',error_json=? WHERE run_id=? AND binding_json IS NULL AND state IN ('accepted','queued')",[JSON.stringify({category:'cancelled'}),input.runId])
            })
            if (await db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[input.runId]))) await reconcile(control('cancel'),controller.signal)
          })())
          const prepare = (operation: ComputerOperation): Promise<WorkspaceBinding> => preparing ??= (async () => {
            const existing = operation.binding ?? await workspaces.getBinding(reservationId(input.runId))
            if (existing) { binding = existing; return existing }
            const activation = computers.activate(operation.declaration.computerId)
            let active: Awaited<typeof activation.result>; try { active = await activation.result } finally { await activation.done }
            check(); const preparation = workspaces.prepare({reservationId:reservationId(input.runId),instance:active})
            let ready: Awaited<typeof preparation.result>; try { ready = await preparation.result } finally { await preparation.done }
            check(); return binding = await write(tx => { owner(tx,input.runId,epoch)
              const selected = workspaces.bindIn(tx,{reservationId:reservationId(input.runId),prepared:ready})
              computers.pinIn(tx,{...selected,pinId:reservationId(input.runId),ownerId:input.runId}); return selected
            })
          })()
          const scope: ComputerRunScope = {
            execute(id) {
              check(); const existing = calls.get(id); if (existing) return existing
              let cancelled = false
              const result = track(Promise.resolve().then(async () => {
                const operation = await db.read(reader => { owner(reader,input.runId,epoch); return read(reader,id) })
                if (!operation || operation.declaration.runId !== input.runId) throw operationError('computer-operation-missing')
                if (operation.runOwnerEpoch !== epoch) throw operationError('computer-operation-owner')
                processes ||= ['codex_exec_command','codex_write_stdin','claude_code_Bash','deepseek_harness_bash'].includes(operation.declaration.request.name)
                if (terminal(operation.state)) {
                  const row = await db.read(reader => reader.get('SELECT error_json FROM harness_computer_operations WHERE operation_id=?',[id]))
                  const error = typeof row?.error_json === 'string' ? JSON.parse(row.error_json) as WorkerOperation['error'] : undefined
                  if (operation.state === 'outcome-unknown' || error?.category === 'cleanup-failure') cleanupFailed = true
                  if (operation.observation && typeof operation.observation === 'object' && 'result' in operation.observation) return operation.observation as unknown as ToolObservation
                  if (cleanupFailed) throw operationError('computer-operation-cleanup')
                  throw remoteFailure(error)
                }
                const cancellationRequested = await db.read(reader => reader.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[input.runId])?.cancel_requested === 1)
                if ((cancelled || cancellationRequested) && !operation.binding) { await write(tx => { owner(tx,input.runId,epoch); tx.execute("UPDATE harness_computer_operations SET state='cancelled',error_json=? WHERE operation_id=?",[JSON.stringify({category:'cancelled'}),id]) }); throw new RunFailure('tool-cancelled') }
                const selected = binding ?? await prepare(operation), instance = await computers.requireInstance(selected)
                await write(tx => { owner(tx,input.runId,epoch)
                  if (!operation.binding && (cancelled || tx.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[input.runId])?.cancel_requested === 1 || read(tx,id)?.state === 'cancelled')) throw new RunFailure('tool-cancelled')
                  workspaces.requireBindingIn(tx,{...selected,reservationId:reservationId(input.runId),scopeId:input.runId})
                  tx.execute("UPDATE harness_computer_operations SET state='starting',binding_json=? WHERE operation_id=?",[JSON.stringify(selected),id])
                })
                const wanted = await db.read(reader => reader.get('SELECT cancel_requested FROM harness_computer_scopes WHERE run_id=?',[input.runId])?.cancel_requested === 1)
                if (wanted || cancelled) await cancel()
                const outcome = await reconcile({ operationId:id,runId:input.runId,runOwnerEpoch:epoch,declarationDigest:operation.declarationDigest,kind:'tool',
                  declaration:operation.declaration,binding:selected,workerBootId:instance.providerRef.slice(instance.providerRef.lastIndexOf(':')+1),imageInput:input.imageInput === true },controller.signal)
                let observed = outcome.observation
                if (outcome.images?.length && observed && typeof observed === 'object' && !Array.isArray(observed)) {
                  const imported = []
                  for (const image of outcome.images) {
                    const bytes = Buffer.from(image.base64,'base64')
                    if (bytes.byteLength !== image.ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== image.ref.sha256) throw operationError('computer-operation-conflict')
                    const call = deps[imageAssetsServiceKey].importImage({scopeId:operation.declaration.sessionId,bytes:(async function* () { yield bytes })()})
                    try { const {expiresAt:_expiry,...ref} = await call.result; imported.push(ref) } finally { await call.done }
                  }
                  observed = {...observed,images:imported} as JsonValue
                }
                await write(tx => { owner(tx,input.runId,epoch)
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
                  owner(tx,input.runId,epoch)
                  const current = read(tx,id)
                  if (!current || terminal(current.state)) return
                  const unknown = /unknown|instance-replaced|worker-request-failed|worker-cleanup-failed/.test(code)
                  if (unknown) cleanupFailed = true
                  const state = unknown ? 'outcome-unknown' : /cancelled/.test(code) || cancelled || error instanceof RunFailure && error.category === 'tool-cancelled' ? 'cancelled' : 'failed'
                  tx.execute('UPDATE harness_computer_operations SET state=?,error_json=? WHERE operation_id=?', [state,JSON.stringify({name:'ComputerOperationError',message:code || 'tool unavailable',category:state === 'cancelled' ? 'cancelled' : unknown ? 'cleanup-failure' : 'unavailable'}),id])
                })
                throw error
              }))
              const done = result.then(() => {},() => {}).then(() => { if (cleanupFailed) throw operationError('computer-operation-cleanup') })
              const call: OwnedCall<ToolObservation> = {result,done,cancel() { cancelled = true; void cancel().catch(() => {}) }}
              calls.set(id,call); void result.catch(() => {}); void done.catch(() => {}); return call
            },
            hasProcesses: () => processes,
            async cancel() { await cancel() },
            close() {
              if (closeCall) return closeCall; stopped = true
              const result = track((async () => {
                await Promise.allSettled([...calls.values()].map(call => call.done)); await cancellation
                const persisted = await db.read(reader => { owner(reader,input.runId,epoch); return reader.get('SELECT * FROM harness_computer_scopes WHERE run_id=?',[input.runId]) })
                if (!persisted) return {processes:[]}
                if (persisted.closed === 1) return JSON.parse(String(persisted.result_json)) as JsonValue
                const placed = await db.read(reader => !!reader.get('SELECT 1 FROM harness_computer_operations WHERE run_id=? AND binding_json IS NOT NULL',[input.runId]))
                if (persisted.cancel_requested === 1 && placed) await cancel()
                const closed = placed ? await reconcile(control('close-scope'),controller.signal) : undefined
                if (closed?.error || closed?.state === 'outcome-unknown' || cleanupFailed) {
                  cleanupFailed = true
                  if (closed?.observation !== undefined) {
                    await write(tx => { owner(tx,input.runId,epoch); tx.execute('UPDATE harness_computer_scopes SET close_receipt=?,result_json=? WHERE run_id=?',[closed.receipt,JSON.stringify(closed.observation),input.runId]) })
                    return closed.observation
                  }
                  throw operationError('computer-operation-cleanup')
                }
                const fact = closed?.observation ?? {processes:[]}
                await write(tx => { owner(tx,input.runId,epoch)
                  if (tx.get("SELECT 1 FROM harness_computer_operations WHERE run_id=? AND state='outcome-unknown'",[input.runId])) throw operationError('computer-operation-cleanup')
                  tx.execute("UPDATE harness_computer_operations SET state='cancelled' WHERE run_id=? AND state IN ('accepted','queued','starting','running')",[input.runId])
                  workspaces.releaseIn(tx,reservationId(input.runId),input.runId); computers.releasePinIn(tx,reservationId(input.runId),input.runId)
                  tx.execute('UPDATE harness_computer_scopes SET closed=1,close_receipt=?,result_json=? WHERE run_id=?',[closed?.receipt ?? null,JSON.stringify(fact),input.runId])
                }); return fact
              })().catch(error => { cleanupFailed = true; throw error }))
              const done = result.then(() => {},() => {}).then(() => { if (cleanupFailed) throw operationError('computer-operation-cleanup') }).catch(error => {cleanupFailures.add(error);throw error})
                .finally(() => {observers.delete(controller);scopes.delete(input.runId)})
              closeCall = {result,done,cancel() {}}; void result.catch(() => {}); void done.catch(() => {}); return closeCall
            },
          }
          scopes.set(input.runId,scope); return scope
        },
      }
      ctx.provide(computerOperationsServiceKey,service)
    },
  }
}

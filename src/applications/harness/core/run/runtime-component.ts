import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { BashFailure } from '../tool/bash-component.js'
import type { BashResult } from '../tool/bash-component.js'
import { isApplyPatchFailure } from '../tool/apply-patch-component.js'
import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { RunFailure, runLimits, toolOutputBytes, validateToolBatch } from './domain.js'
import type { Run, RunOutcome, ToolObservation, ValidatedToolRequest, RunFailureCategory } from './domain.js'
import { modelFailure, normalizeModelFailure, isModelFailure } from './model.js'
import { sessionRunServiceKey } from '../session/port.js'
import type { SessionRunPort, RunOperationStart, RunOperationObservation } from '../session/port.js'
import type { PreparedRunProgram, RunHost, ProgramExitReport, OperationDescriptor, RunResumeRecord } from './program.js'
import { runViewEvent } from './notifications.js'
import { createWaiters } from './waiters.js'
import { ProcessFailure } from '../tool/process-component.js'
import { updateToolPlan } from '../tool/plan-domain.js'
import { computerOperationsServiceKey } from '../computer/operations-port.js'
import type { ComputerOperationsPort, ComputerRunScope } from '../computer/operations-port.js'
import { needsComputer } from '../computer/operations-domain.js'

export const runRuntimeServiceKey = 'harness.run-runtime'
export type RunCancelReason = 'user-requested' | 'owner-disposed' | 'dependency-unavailable'
export interface RunRuntimePort {
  /** Ownership is acquired synchronously. A synchronous refusal acquires nothing. */
  start(input: { readonly runId: string; readonly program: PreparedRunProgram; readonly resume?: RunResumeRecord }): Promise<Run>
  cancel(runId: string, reason: RunCancelReason): Promise<void>
  wait(runId: string, signal?: AbortSignal): Promise<Run | undefined>
  getView(runId: string): JsonValue | undefined
}
interface ActiveRun {
  readonly program: PreparedRunProgram
  readonly started: Promise<Run>
  readonly finished: Promise<Run>
  cancel(reason: RunCancelReason): Promise<void>
}
type Observed<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'cleanup-failed'; value?: T }

/** Observe both promises immediately; a failed done cannot leave us waiting for result forever. */
async function observe<T>(call: OwnedCall<T>): Promise<Observed<T>> {
  let available: { value: T } | undefined
  const result = call.result.then(value => { available = { value }; return { kind: 'value' as const, value } },
    (error: unknown) => ({ kind: 'error' as const, error }))
  const exited = call.done.then(() => true, () => false)
  const early = exited.then(async (ok): Promise<Observed<T>> => ok ? await result : { kind: 'cleanup-failed' })
  const value = await Promise.race([result, early])
  return await exited ? value : { kind: 'cleanup-failed', ...available }
}
function toolFailure(error: unknown): RunFailure {
  if (error instanceof RunFailure) return error
  if (error instanceof ProcessFailure) {
    if (error.category === 'cancelled') return new RunFailure('tool-cancelled')
    if (error.category === 'cleanup-failure') return new RunFailure('tool-cleanup-failure')
    if (error.category === 'invalid-request') return new RunFailure('invalid-tool-request')
  }
  if (error instanceof BashFailure) {
    if (error.category === 'timeout') return new RunFailure('tool-timeout')
    if (error.category === 'cancelled') return new RunFailure('tool-cancelled')
    if (error.category === 'cleanup-failure') return new RunFailure('tool-cleanup-failure')
    if (error.category === 'invalid-request') return new RunFailure('invalid-tool-request')
  }
  if (isApplyPatchFailure(error)) {
    if (error.category === 'cleanup-failure') return new RunFailure('tool-cleanup-failure')
    if (error.category === 'invalid-request') return new RunFailure('invalid-tool-request')
  }
  return new RunFailure('tool-unavailable')
}
function toolObservation(request: ValidatedToolRequest, value: unknown): ToolObservation {
  if (value && typeof value === 'object' && 'name' in value && value.name === request.name && 'result' in value) return value as ToolObservation
  if (request.name === 'bash') return { name: 'bash', result: value as BashResult }
  if (request.name === 'apply_patch') return { name: 'apply_patch', result: value as ApplyPatchResult }
  return { name: request.name, result: value as JsonValue }
}
/** Owns Run resource trees and durable operation barriers, without interpreting protocol state. */
export function createRunRuntimeComponent(inputs: RuntimeInputs): Component.Object<void, {
  [sessionRunServiceKey]: SessionRunPort
  [computerOperationsServiceKey]: ComputerOperationsPort
}> {
  return {
    name: 'harness-run-runtime', inject: [sessionRunServiceKey, computerOperationsServiceKey],
    apply(ctx, _config, deps) {
      const records = deps[sessionRunServiceKey]
      const active = new Map<string, ActiveRun>()
      const rejected = new Map<string, { program: PreparedRunProgram; finished: Promise<Run> }>()
      const views = new Map<string, JsonValue>()
      const failures: unknown[] = []
      const waitFor = createWaiters<Run | undefined>()
      let accepting = true
      ctx.effect(() => async () => {
        accepting = false
        const owners = [...active.values()]
        await Promise.allSettled(owners.map(owner => owner.cancel('dependency-unavailable')))
        await Promise.allSettled(owners.map(owner => owner.finished))
        views.clear()
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Run Runtime cleanup failed')
      }, 'cancel and join Run resource owners')

      const service: RunRuntimePort = {
        start({ runId, program, resume }) {
          const existing = active.get(runId) ?? rejected.get(runId)
          if (existing) {
            if (existing.program !== program) throw modelFailure('model-unavailable')
            return 'started' in existing ? existing.started : existing.finished
          }
          if (!accepting) throw modelFailure('dependency-unavailable')
          const controller = new AbortController()
          const managed = new Set<Promise<unknown>>()
          const track = <T>(task: Promise<T>): Promise<T> => {
            managed.add(task)
            void task.finally(() => managed.delete(task)).catch(() => {})
            return task
          }
          const operations = new Map<string, { call: OwnedCall<unknown>; kind: 'model' | 'operation' | 'tool' }>()
          const acceptedTools = new Set<string>()
          let resolveStarted!: (run: Run) => void, rejectStarted!: (error: unknown) => void
          const started = new Promise<Run>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
          let reason: RunCancelReason | undefined
          let cancellation: Promise<unknown> = Promise.resolve()
          let cleanupCategory: RunFailureCategory | undefined
          let stateFailed = false
          let finalOutputExceeded = false
          const ownerEpoch = resume?.state.runOwnerEpoch ?? 1
          let sequence = 0, totalToolBytes = resume?.state.totalToolOutputBytes ?? 0
          let run: Run | undefined
          let closing: Promise<ProgramExitReport> | undefined
          let computerScope: ComputerRunScope | undefined
          let processClosing: Promise<void> | undefined
          const scope = () => computerScope ??= deps[computerOperationsServiceKey].openRun({ runId, runOwnerEpoch: ownerEpoch,
            imageInput: program.modelSnapshot.capabilities.imageInput === true })
          const executeTool = (request: ValidatedToolRequest, operationId: string): OwnedCall<ToolObservation> => {
            if (needsComputer(request)) return scope().execute(operationId)
            const result = updateToolPlan(request.name, request.arguments)
            return { result: Promise.resolve({ name: request.name, result } as ToolObservation), done: Promise.resolve(), cancel() {} }
          }
          const markCleanup = (category: RunFailureCategory) => {
            if (!cleanupCategory) { cleanupCategory = category; failures.push(modelFailure('cleanup-failure')) }
          }
          const closeProgram = () => {
            if (!closing) closing = Promise.resolve().then(() => program.close()).then(report => {
              if (report.cleanup !== 'completed') markCleanup('cleanup-failure')
              return report
            }, () => {
              markCleanup('cleanup-failure')
              return { cleanup: 'failed' as const, records: [], checkpoint: null }
            })
            return closing
          }
          const ensureRunning = () => {
            if (!accepting || controller.signal.aborted || program.signal.aborted || stateFailed) throw modelFailure('dependency-unavailable')
          }
          const persist = async <T>(work: () => Promise<T>): Promise<T> => {
            try { return await work() } catch (error) { stateFailed = true; controller.abort(); throw error }
          }
          const perform = async <T>(operation: RunOperationStart, start: () => OwnedCall<T>, observeValue: (value: T) => RunOperationObservation): Promise<T> => {
            ensureRunning()
            const prior = await persist(() => records.getRunOperation(runId, operation.id))
            if (prior?.observation) {
              if (JSON.stringify(prior.start.intent) !== JSON.stringify(operation.intent)) throw new RunFailure('state-write-failure')
              if (prior.observation.kind === 'value') return (prior.observation.tool ?? prior.observation.result) as T
              if (prior.observation.kind === 'cleanup-failed') { markCleanup(operation.kind === 'tool' ? 'tool-cleanup-failure' : 'cleanup-failure'); throw modelFailure('cleanup-failure') }
              const category = prior.observation.errorCategory
              if (category && ['invalid-tool-request','limit-exceeded','tool-unavailable','tool-timeout','tool-cancelled','tool-cleanup-failure','state-write-failure'].includes(category)) throw new RunFailure(category as ConstructorParameters<typeof RunFailure>[0])
              throw modelFailure(category as Parameters<typeof modelFailure>[0] ?? 'dependency-unavailable')
            }
            let accepted: boolean
            try { accepted = await records.startOperation(runId, operation, inputs.now(), ownerEpoch) }
            catch (error) {
              const committed = await records.getRunOperation(runId, operation.id)
              if (!committed || JSON.stringify(committed.start.intent) !== JSON.stringify(operation.intent)) { stateFailed = true; controller.abort(); throw error }
              accepted = true
            }
            if (!accepted) throw modelFailure('dependency-unavailable')
            ensureRunning()
            let call: OwnedCall<T>
            try {
              // No await between this cancellation check and synchronous handle ownership.
              call = start()
              operations.set(operation.id, { call, kind: operation.kind })
            } catch (error) {
              const failure = operation.kind === 'tool' ? toolFailure(error) : normalizeModelFailure(error)
              await persist(() => records.observeOperation(runId, operation.id, { kind: 'error', errorCategory: failure.category }, inputs.now(), ownerEpoch))
              throw failure
            }
            const observing = observe(call)
            if (run) resolveStarted(run)
            const observed = await observing
            operations.delete(operation.id)
            let observation: RunOperationObservation
            if (observed.kind === 'value') observation = observeValue(observed.value)
            else if (observed.kind === 'cleanup-failed') {
              const category = operation.kind === 'tool' ? 'tool-cleanup-failure' : 'cleanup-failure'
              markCleanup(category)
              observation = { kind: 'cleanup-failed', errorCategory: category,
                ...(operation.tool && observed.value !== undefined ? { tool: toolObservation(operation.tool, observed.value) } : {}) }
            } else observation = { kind: 'error', errorCategory: operation.kind === 'tool' ? toolFailure(observed.error).category : normalizeModelFailure(observed.error).category }
            // Actual observations survive cancellation; only new operation admission is closed.
            try { await records.observeOperation(runId, operation.id, observation, inputs.now(), ownerEpoch) }
            catch (error) {
              const committed = await records.getRunOperation(runId, operation.id)
              if (JSON.stringify(committed?.observation) !== JSON.stringify(observation)) { stateFailed = true; controller.abort(); throw error }
            }
            if (observed.kind === 'cleanup-failed') throw modelFailure('cleanup-failure')
            if (observed.kind === 'error') throw operation.kind === 'tool' ? toolFailure(observed.error) : normalizeModelFailure(observed.error)
            ensureRunning()
            return observed.value
          }
          const host: RunHost = {
            signal: controller.signal,
            perform<T>(descriptor: OperationDescriptor<T>, start: () => OwnedCall<T>) {
              return track(perform(descriptor, start, value => ({ kind: 'value', ...descriptor.observe(value) })))
            },
            async executeTools(requests, scheduling = 'serial', batchId) {
              if (scheduling !== 'serial') throw new RunFailure('invalid-tool-request')
              const batch = validateToolBatch(requests, program.initialization.tools), output: ToolObservation[] = []
              // Own a local scope before an intent can commit, so cancellation before dispatch releases its reservation.
              if (batch.some(needsComputer)) scope()
              const ids = batch.map((_request, index) => batchId ? `${runId}:tool:${batchId}:${index}` : inputs.newId())
              if (batchId) await persist(() => records.saveRunResume(runId, ownerEpoch, { batch: { id: batchId, requests: batch, operationIds: ids } }, inputs.now()))
              for (const [index, request] of batch.entries()) {
                const operation: RunOperationStart = { id: ids[index]!, kind: 'tool', tool: request,
                  intent: { name: request.name, requestId: request.id, arguments: request.arguments } }
                acceptedTools.add(operation.id)
                const value = await track(perform<ToolObservation>(operation, () => executeTool(request, operation.id),
                  value => ({ kind: 'value', tool: value })))
                const observation = toolObservation(request, value)
                totalToolBytes = (await records.loadRunResume(runId))?.state.totalToolOutputBytes ?? totalToolBytes + toolOutputBytes(observation)
                if (totalToolBytes > runLimits.totalToolOutputBytes) throw new RunFailure('limit-exceeded')
                output.push(observation)
              }
              return Object.freeze(output)
            },
            publish(frame) {
              if (!run || controller.signal.aborted) return
              try {
                const payload = structuredClone(frame.payload)
                // Keep at most one bounded snapshot per active Run; it remains a temporary view.
                if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1_048_576) return
                views.set(runId, payload)
                ctx.emit(runViewEvent, Object.freeze({ sessionId: run.sessionId, runId, sequence: ++sequence,
                  frame: Object.freeze({ ...frame, payload }) }))
              } catch { /* Display observers cannot fail execution. */ }
            },
          }
          let projectId: string | undefined
          const finished = Promise.resolve().then(async (): Promise<Run> => {
            run = await persist(() => records.getRun(runId))
            if (!run) throw new Error('missing accepted Run')
            const context = await persist(() => records.loadRunContext(runId))
            if (!context) throw new Error('missing accepted Run context')
            projectId = context.projectId
            if (resume && await deps[computerOperationsServiceKey].hasRunResources(runId)) scope()
            let outcome: RunOutcome
            try {
              if (run.status === 'cancelling') { reason ??= 'user-requested'; controller.abort() }
              ensureRunning()
              if (run.contextVersion !== 'native-local-v1' || (!resume && run.protocolBinding?.generationId !== program.binding.generationId) || run.protocolBinding?.protocolId !== program.binding.protocolId ||
                run.modelSnapshot?.schemaVersion !== 3 || JSON.stringify(run.modelSnapshot) !== JSON.stringify(program.modelSnapshot)) throw modelFailure('model-unavailable')
              if (resume?.state.settlement && resume.state.stage === 'settling') return finish(resume.state.settlement)
              const conclusion = resume?.state.conclusion && ['cleanup','settling'].includes(resume.state.stage) ? resume.state.conclusion : await program.execute(host)
              await persist(() => records.saveRunResume(runId, ownerEpoch, {stage: 'cleanup', conclusion}, inputs.now()))
              if (conclusion.kind === 'completed' && (typeof conclusion.output !== 'string' || Buffer.byteLength(conclusion.output, 'utf8') > runLimits.finalBytes)) throw new RunFailure('limit-exceeded')
              outcome = conclusion.kind === 'completed'
                ? { kind: 'completed', output: conclusion.output, resultRecordIds: conclusion.resultRecordIds }
                : { kind: 'failed', error: conclusion.error, category: conclusion.category }
            } catch (error) {
              const failure = error instanceof RunFailure || isModelFailure(error) ? error : normalizeModelFailure(error)
              outcome = { kind: 'failed', category: stateFailed ? 'state-write-failure' : failure.category,
                error: stateFailed ? 'run state could not be persisted' : failure.message }
            }
            return finish(outcome)
          }).catch(async () => {
            stateFailed = true
            return finish({ kind: 'failed', category: 'state-write-failure', error: 'run state could not be persisted' })
          })
            .finally(async () => {
              await closeProgram()
              program.signal.removeEventListener('abort', revoked)
              program.release()
              views.delete(runId)
            })
          const finish = async (proposed: RunOutcome): Promise<Run> => {
            controller.abort()
            for (const operation of operations.values()) {
              try { operation.call.cancel(reason ?? 'dependency-unavailable') }
              catch { markCleanup(operation.kind === 'tool' ? 'tool-cleanup-failure' : 'cleanup-failure') }
            }
            const outstanding = [...operations.values()]
            await Promise.all(outstanding.map(async operation => {
              void operation.call.result.catch(() => {})
              try { await operation.call.done } catch { markCleanup(operation.kind === 'tool' ? 'tool-cleanup-failure' : 'cleanup-failure') }
            }))
            await Promise.allSettled([...managed])
            if (computerScope) {
              if (proposed.kind !== 'completed' || reason) {
                try { await computerScope.cancel() } catch { markCleanup('tool-cleanup-failure') }
              }
              // A cancelling or unresumable program still owns the already-accepted tool facts.
              const savedResume = await records.loadRunResume(runId)
              for (const id of new Set([...acceptedTools,...(savedResume?.state.batch?.operationIds ?? [])])) {
                const prior = await records.getRunOperation(runId,id)
                if (!prior?.start.tool || prior.observation || !needsComputer(prior.start.tool) || stateFailed) continue
                const observed = await observe(computerScope.execute(id))
                if (observed.kind === 'cleanup-failed') markCleanup('tool-cleanup-failure')
                const fact: RunOperationObservation = observed.kind === 'value' ? {kind:'value',tool:observed.value}
                  : observed.kind === 'cleanup-failed' ? {kind:'cleanup-failed',errorCategory:'tool-cleanup-failure',...(observed.value ? {tool:observed.value} : {})}
                  : {kind:'error',errorCategory:toolFailure(observed.error).category}
                try { await records.observeOperation(runId,id,fact,inputs.now(),ownerEpoch) }
                catch (error) {
                  const saved = await records.getRunOperation(runId,id)
                  if (JSON.stringify(saved?.observation) !== JSON.stringify(fact)) { stateFailed=true; controller.abort() }
                }
              }
              processClosing ??= (async () => {
                const id = `${runId}:computer-scope-close`
                let recorded = false
                if (!stateFailed) {
                  try {
                    const prior = await records.getRunOperation(runId,id)
                    recorded = await persist(() => records.startOperation(runId, prior?.start ?? { id, kind: 'operation', cleanup: true, intent: { kind: computerScope!.hasProcesses() ? 'tool-process-cleanup' : 'computer-scope-cleanup' } }, inputs.now(), ownerEpoch))
                  }
                  catch { /* Cleanup must still run after storage failure. */ }
                }
                const call = computerScope!.close()
                const closed = await observe(call)
                if (closed.kind !== 'value') markCleanup('tool-cleanup-failure')
                if (recorded && !stateFailed) {
                  try { await persist(() => records.observeOperation(runId, id, closed.kind === 'value'
                    ? { kind: 'value', result: closed.value }
                    : { kind: 'cleanup-failed', errorCategory: 'tool-cleanup-failure', ...(closed.kind === 'cleanup-failed' && closed.value !== undefined ? { result: closed.value } : {}) }, inputs.now(), ownerEpoch)) }
                  catch { /* The final settlement reports a state-write failure. */ }
                }
                totalToolBytes = (await records.loadRunResume(runId))?.state.totalToolOutputBytes ?? totalToolBytes
                finalOutputExceeded = totalToolBytes > runLimits.totalToolOutputBytes
              })().catch(() => { markCleanup('tool-cleanup-failure') })
              await processClosing
            }
            const report = await closeProgram()
            await cancellation.catch(() => { stateFailed = true })
            let outcome: RunOutcome = proposed
            if (cleanupCategory) outcome = { kind: 'cleanup-failed', category: cleanupCategory, error: 'Run resources could not be released' }
            else if (stateFailed) outcome = { kind: 'failed', category: 'state-write-failure', error: 'run state could not be persisted' }
            else if (finalOutputExceeded) outcome = { kind: 'failed', category: 'limit-exceeded', error: 'tool output limit exceeded' }
            else if (reason) outcome = reason === 'dependency-unavailable'
              ? { kind: 'failed', category: 'dependency-unavailable', error: 'model dependency is unavailable' } : { kind: 'cancelled' }
            const settlement = resume?.state.settlement ?? { ...outcome, records: report.records, checkpoint: report.checkpoint }
            if (!stateFailed) await records.saveRunResume(runId, ownerEpoch, {stage: 'settling',settlement}, inputs.now())
            return records.settleRun(runId, settlement, inputs.now(), ownerEpoch)
          }
          const entry: ActiveRun = {
            program, started, finished,
            cancel(nextReason) {
              if (!reason || reason === 'dependency-unavailable') reason = nextReason
              controller.abort()
              for (const operation of operations.values()) {
                try { operation.call.cancel(reason) } catch { markCleanup(operation.kind === 'tool' ? 'tool-cleanup-failure' : 'cleanup-failure') }
              }
              void closeProgram()
              const write = nextReason === 'dependency-unavailable' ? Promise.resolve() : records.requestCancellation(runId, inputs.now())
              cancellation = write
              void write.catch(() => { stateFailed = true })
              return write.then(() => {})
            },
          }
          const revoked = () => { void entry.cancel('dependency-unavailable').catch(() => {}) }
          active.set(runId, entry)
          program.signal.addEventListener('abort', revoked, { once: true })
          if (program.signal.aborted) revoked()
          void finished.then(resolveStarted, rejectStarted)
          void started.catch(() => {})
          void finished.then(() => { active.delete(runId) }, error => { active.delete(runId); rejected.set(runId, { program, finished }); failures.push(error) })
          return started
        },
        async cancel(runId, reason) {
          const entry = active.get(runId)
          if (entry) return entry.cancel(reason)
          const run = reason === 'dependency-unavailable' ? await records.getRun(runId) : await records.requestCancellation(runId, inputs.now())
          const handedOff = active.get(runId)
          if (handedOff) return handedOff.cancel(reason)
          // Untransferred accepted Runs belong to Run admission; it must close the program first.
          if (run?.status === 'running' || run?.status === 'cancelling') return
        },
        wait: (id, signal) => waitFor(active.get(id)?.finished ?? rejected.get(id)?.finished ?? records.getRun(id), signal),
        getView: id => { const view = views.get(id); return view === undefined ? undefined : structuredClone(view) },
      }
      ctx.provide(runRuntimeServiceKey, service)
    },
  }
}

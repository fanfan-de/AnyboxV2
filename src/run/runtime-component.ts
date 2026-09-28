import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { BashFailure, bashServiceKey } from '../tool/bash-component.js'
import type { BashPort, BashResult } from '../tool/bash-component.js'
import { applyPatchServiceKey, isApplyPatchFailure } from '../tool/apply-patch-component.js'
import type { ApplyPatchPort } from '../tool/apply-patch-component.js'
import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { RunFailure, runLimits, toolOutputBytes, validateToolBatch } from './domain.js'
import type { Run, RunOutcome, ToolObservation, ValidatedToolRequest, RunFailureCategory } from './domain.js'
import { modelFailure, normalizeModelFailure, isModelFailure } from './model.js'
import { sessionRunServiceKey } from '../session/port.js'
import type { SessionRunPort, RunOperationStart, RunOperationObservation } from '../session/port.js'
import type { PreparedRunProgram, RunHost, ProgramExitReport, OperationDescriptor } from './program.js'
import { runViewEvent } from './notifications.js'
import { createWaiters } from './waiters.js'

export const runRuntimeServiceKey = 'harness.run-runtime'
export type RunCancelReason = 'user-requested' | 'owner-disposed' | 'dependency-unavailable'
export interface RunRuntimePort {
  /** Ownership is acquired synchronously. A synchronous refusal acquires nothing. */
  start(input: { readonly runId: string; readonly program: PreparedRunProgram }): Promise<Run>
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
  return request.name === 'bash' ? { name: 'bash', result: value as BashResult } : { name: 'apply_patch', result: value as ApplyPatchResult }
}

/** Owns Run resource trees and durable operation barriers, without interpreting protocol state. */
export function createRunRuntimeComponent(inputs: RuntimeInputs): Component.Object<void, {
  [sessionRunServiceKey]: SessionRunPort
  [bashServiceKey]: BashPort
  [applyPatchServiceKey]: ApplyPatchPort
}> {
  return {
    name: 'harness-run-runtime', inject: [sessionRunServiceKey, bashServiceKey, applyPatchServiceKey],
    apply(ctx, _config, deps) {
      const records = deps[sessionRunServiceKey], bash = deps[bashServiceKey], patch = deps[applyPatchServiceKey]
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
        start({ runId, program }) {
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
          let resolveStarted!: (run: Run) => void, rejectStarted!: (error: unknown) => void
          const started = new Promise<Run>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
          let reason: RunCancelReason | undefined
          let cancellation: Promise<unknown> = Promise.resolve()
          let cleanupCategory: RunFailureCategory | undefined
          let stateFailed = false
          let sequence = 0, totalToolBytes = 0
          let run: Run | undefined
          let closing: Promise<ProgramExitReport> | undefined
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
            if (!await persist(() => records.startOperation(runId, operation, inputs.now()))) throw modelFailure('dependency-unavailable')
            ensureRunning()
            let call: OwnedCall<T>
            try {
              // No await between this cancellation check and synchronous handle ownership.
              call = start()
              operations.set(operation.id, { call, kind: operation.kind })
            } catch (error) {
              const failure = operation.kind === 'tool' ? toolFailure(error) : normalizeModelFailure(error)
              await persist(() => records.observeOperation(runId, operation.id, { kind: 'error', errorCategory: failure.category }, inputs.now()))
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
            await persist(() => records.observeOperation(runId, operation.id, observation, inputs.now()))
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
            async executeTools(requests, scheduling = 'serial') {
              if (scheduling !== 'serial') throw new RunFailure('invalid-tool-request')
              const batch = validateToolBatch(requests), output: ToolObservation[] = []
              for (const request of batch) {
                const operation: RunOperationStart = { id: inputs.newId(), kind: 'tool', tool: request,
                  intent: { name: request.name, requestId: request.id, arguments: request.arguments } }
                const value = await track(perform<unknown>(operation, () => request.name === 'bash'
                  ? bash.execute({ projectId: projectId!, command: request.arguments.command })
                  : patch.execute({ projectId: projectId!, patch: request.arguments.patch }),
                value => ({ kind: 'value', tool: toolObservation(request, value) })))
                const observation = toolObservation(request, value)
                totalToolBytes += toolOutputBytes(observation)
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
            let outcome: RunOutcome
            try {
              if (run.status === 'cancelling') { reason ??= 'user-requested'; controller.abort() }
              ensureRunning()
              if (run.contextVersion !== 'native-local-v1' || run.protocolBinding?.generationId !== program.binding.generationId ||
                run.modelSnapshot?.schemaVersion !== 3 || JSON.stringify(run.modelSnapshot) !== JSON.stringify(program.modelSnapshot)) throw modelFailure('model-unavailable')
              const conclusion = await program.execute(host)
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
            const report = await closeProgram()
            await cancellation.catch(() => { stateFailed = true })
            let outcome: RunOutcome = proposed
            if (cleanupCategory) outcome = { kind: 'cleanup-failed', category: cleanupCategory, error: 'Run resources could not be released' }
            else if (stateFailed) outcome = { kind: 'failed', category: 'state-write-failure', error: 'run state could not be persisted' }
            else if (reason) outcome = reason === 'dependency-unavailable'
              ? { kind: 'failed', category: 'dependency-unavailable', error: 'model dependency is unavailable' } : { kind: 'cancelled' }
            return records.settleRun(runId, { ...outcome, records: report.records, checkpoint: report.checkpoint }, inputs.now())
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

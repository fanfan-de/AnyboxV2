import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { LLMFailure, llmServiceKey, normalizeLLMFailure } from '../llm/port.js'
import type { LLMMessage, LLMPort, ModelReply } from '../llm/port.js'
import { BashFailure, bashServiceKey } from '../tool/bash-component.js'
import type { BashPort, BashResult } from '../tool/bash-component.js'
import { applyPatchServiceKey, isApplyPatchFailure } from '../tool/apply-patch-component.js'
import type { ApplyPatchPort } from '../tool/apply-patch-component.js'
import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { toolObservationMessage, toolOutputBytes, buildLLMMessages, RunFailure, runLimits, validateToolBatch } from './domain.js'
import type { Run, RunOutcome, ValidatedToolRequest, ToolObservation } from './domain.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'
import { createWaiters } from './waiters.js'

export const agentLoopServiceKey = 'harness.agent-loop'

export type LoopCancelReason = 'user-requested' | 'owner-disposed' | 'dependency-unavailable'

export interface AgentLoopPort {
  start(runId: string): Promise<Run>
  cancel(runId: string, reason: LoopCancelReason): Promise<void>
  wait(runId: string, signal?: AbortSignal): Promise<Run | undefined>
}

interface ActiveRun {
  readonly started: Promise<Run>
  readonly finished: Promise<Run>
  cancel(reason: LoopCancelReason): Promise<void>
}

type Observation<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cleanup-failed'; readonly value?: T }

/** Observe both promises immediately; an early cleanup failure must not wait forever for result. */
async function observe<T>(call: OwnedCall<T>): Promise<Observation<T>> {
  let available: { readonly value: T } | undefined
  const result = call.result.then(
    value => { available = { value }; return { kind: 'value' as const, value } },
    (error: unknown) => ({ kind: 'error' as const, error }),
  )
  const exited = call.done.then(() => true, () => false)
  const early = exited.then(async (ok): Promise<Observation<T>> =>
    ok ? await result : { kind: 'cleanup-failed' })
  const observed = await Promise.race<Observation<T>>([result, early])
  if (!await exited) return { kind: 'cleanup-failed', ...available }
  return observed
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

function observation(request: ValidatedToolRequest, value: unknown): ToolObservation {
  return request.name === 'bash'
    ? { name: 'bash', result: value as BashResult }
    : { name: 'apply_patch', result: value as ApplyPatchResult }
}

/** Owns every model and tool call until its result and actual exit have been observed. */
export function createAgentLoopComponent(inputs: RuntimeInputs): Component.Object<void, {
  [stateServiceKey]: StatePort
  [llmServiceKey]: LLMPort
  [bashServiceKey]: BashPort
  [applyPatchServiceKey]: ApplyPatchPort
}> {
  return {
    name: 'harness-agent-loop',
    inject: [stateServiceKey, llmServiceKey, bashServiceKey, applyPatchServiceKey],
    apply(ctx, _config, deps) {
      const state = deps[stateServiceKey]
      const llm = deps[llmServiceKey]
      const bash = deps[bashServiceKey]
      const applyPatch = deps[applyPatchServiceKey]
      const active = new Map<string, ActiveRun>()
      const waitFor = createWaiters<Run | undefined>()
      // Retain rejected owners until this component exits; a persistence error must never allow replay.
      const rejected = new Map<string, Promise<Run>>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...active.values()]
        await Promise.allSettled(pending.map(item => item.cancel('dependency-unavailable')))
        await Promise.allSettled(pending.map(item => item.finished))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'agent loop cleanup failed')
      }, 'cancel and join agent loop calls')

      const service: AgentLoopPort = {
        start(runId) {
          const existing = active.get(runId)
          if (existing) return existing.started
          const previousFailure = rejected.get(runId)
          if (previousFailure) return previousFailure
          if (!accepting) return Promise.reject(new LLMFailure('dependency-unavailable'))
          let resolveStarted!: (run: Run) => void
          let rejectStarted!: (error: unknown) => void
          const started = new Promise<Run>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
          let current: OwnedCall<unknown> | undefined
          let currentKind: 'model' | 'tool' = 'model'
          let reason: LoopCancelReason | undefined
          let cancelError: unknown
          let cleanupProblem: LLMFailure | RunFailure | undefined
          let cancellation: Promise<unknown> = Promise.resolve()
          const cancelCurrent = () => {
            try { current?.cancel(reason ?? 'dependency-unavailable') } catch (error) { cancelError = error }
          }
          const settle = (outcome: RunOutcome) => state.settleRun(runId, outcome, inputs.now())
          const fail = (failure: LLMFailure | RunFailure) => settle({ kind: 'failed', error: failure.message, category: failure.category })
          const cleanupFailure = () => currentKind === 'model' ? new LLMFailure('cleanup-failure') : new RunFailure('tool-cleanup-failure')
          const rememberCleanupFailure = () => {
            if (!cleanupProblem) { cleanupProblem = cleanupFailure(); failures.push(cleanupProblem) }
            return cleanupProblem
          }
          const stop = async (): Promise<Run | undefined> => {
            await cancellation
            const latest = await state.getRun(runId)
            if (!latest) throw new Error('missing accepted Run')
            if (latest.status !== 'running' && latest.status !== 'cancelling') return latest
            if (latest.status === 'cancelling') return settle({ kind: 'cancelled' })
            if (!accepting || reason === 'dependency-unavailable') return fail(new LLMFailure('dependency-unavailable'))
            if (reason) return settle({ kind: 'cancelled' })
            return undefined
          }
          const finished = Promise.resolve().then(async (): Promise<Run> => {
            const run = await state.getRun(runId)
            if (!run) throw new Error(`unknown run ${runId}`)
            const stopped = await stop()
            if (stopped) return stopped
            if (run.history.kind !== 'tree' || run.contextVersion !== 'dialogue-v1') return fail(new LLMFailure('dependency-unavailable'))
            const [session, history, prompts, plan] = await Promise.all([
              state.getSession(run.sessionId), state.getNodePath(run.sessionId, run.history.parentNodeId),
              state.getRunPrompts(run.id), state.getRunPlan(run.id),
            ])
            if (!session || !prompts || !plan) return fail(new LLMFailure('dependency-unavailable'))
            const messages: LLMMessage[] = [...buildLLMMessages(prompts, history, run.input)]
            let request: ValidatedToolRequest | undefined
            let totalToolOutputBytes = 0
            while (true) {
              const stopped = await stop()
              if (stopped) return stopped
              const intent = currentKind === 'model' ? { kind: 'model-started' as const }
                : { kind: 'tool-started' as const, call: request! }
              if (!await state.recordRunEvent(runId, intent, inputs.now())) {
                return (await stop()) ?? await settle({ kind: 'cancelled' })
              }
              const afterIntent = await stop()
              if (afterIntent) return afterIntent
              // No await between the final local cancellation check and taking ownership of the call.
              if (reason || !accepting) return (await stop())!
              try {
                current = currentKind === 'model'
                  ? llm.call({ plan, messages: Object.freeze([...messages]),
                    ...(llm.supportsTools ? { tools: Object.freeze([bash.definition, applyPatch.definition]) } : {}) })
                  : request!.name === 'bash'
                    ? bash.execute({ projectId: session.projectId, command: request!.arguments.command })
                    : applyPatch.execute({ projectId: session.projectId, patch: request!.arguments.patch })
              } catch (error) {
                const failure = currentKind === 'model' ? normalizeLLMFailure(error) : toolFailure(error)
                if (currentKind === 'tool') await state.recordRunEvent(runId,
                  { kind: 'tool-failed', name: request!.name, requestId: request!.id, category: failure.category }, inputs.now())
                return fail(failure)
              }
              // Observe immediately, before exposing successful startup.
              const observing = observe(current)
              resolveStarted(run)
              const observed = await observing
              current = undefined
              if (observed.kind === 'cleanup-failed' || cancelError) {
                const failure = rememberCleanupFailure()
                if (currentKind === 'tool') await state.recordRunEvent(runId,
                  { kind: 'tool-failed', name: request!.name, requestId: request!.id, category: failure.category,
                    ...(request!.name === 'apply_patch' && 'value' in observed && observed.value !== undefined
                      ? { result: observed.value as ApplyPatchResult } : {}) }, inputs.now())
                return settle({ kind: 'cleanup-failed', error: failure.message, category: failure.category })
              }
              if (currentKind === 'tool') {
                await state.recordRunEvent(runId, observed.kind === 'value'
                  ? { kind: 'tool-observed', requestId: request!.id, ...observation(request!, observed.value) }
                  : { kind: 'tool-failed', name: request!.name, requestId: request!.id, category: toolFailure(observed.error).category }, inputs.now())
              }
              const afterCall = await stop()
              if (afterCall) return afterCall
              if (observed.kind === 'error') return fail(currentKind === 'model' ? normalizeLLMFailure(observed.error) : toolFailure(observed.error))
              if (currentKind === 'model') {
                const reply = observed.value as ModelReply
                if (!reply || typeof reply !== 'object') return fail(new LLMFailure('invalid-response'))
                if (reply.kind === 'final') {
                  if (typeof reply.text !== 'string' || !reply.text.trim()) return fail(new LLMFailure('invalid-response'))
                  if (Buffer.byteLength(reply.text, 'utf8') > runLimits.finalBytes) return fail(new RunFailure('limit-exceeded'))
                  return settle({ kind: 'completed', output: reply.text })
                }
                if (reply.kind !== 'tool-calls' || (reply.content !== undefined && reply.content !== null && typeof reply.content !== 'string')) {
                  return fail(new LLMFailure('invalid-response'))
                }
                let batch: readonly ValidatedToolRequest[]
                try { batch = validateToolBatch(reply.calls) }
                catch { return fail(new RunFailure('invalid-tool-request')) }
                await state.recordRunEvent(runId, { kind: 'model-tool-calls', calls: batch }, inputs.now())
                messages.push(Object.freeze({ role: 'assistant', content: reply.content ?? null, toolCalls: batch }))
              } else {
                const result = observation(request!, observed.value)
                totalToolOutputBytes += toolOutputBytes(result)
                if (totalToolOutputBytes > runLimits.totalToolOutputBytes) return fail(new RunFailure('limit-exceeded'))
                messages.push(toolObservationMessage(request!.id, result))
              }
              const execution = await state.getRunExecution(runId)
              if (execution?.phase === 'ready-tool') {
                request = execution.batch[execution.nextToolIndex]
                if (!request) throw new Error('missing queued tool request')
                currentKind = 'tool'
              } else if (execution?.phase === 'ready-model') {
                currentKind = 'model'
                request = undefined
              } else throw new Error('Run has no executable next phase')
            }
          }).catch(async () => {
            // State/read/commit failures stop the loop; external operations are never retried.
            if (current) {
              cancelCurrent()
              const exited = await current.done.then(() => true, () => false)
              void current.result.catch(() => {})
              current = undefined
              if (!exited || cancelError) rememberCleanupFailure()
            }
            if (cleanupProblem) return settle({ kind: 'cleanup-failed', error: cleanupProblem.message, category: cleanupProblem.category })
            return fail(new RunFailure('state-write-failure'))
          })
          const entry: ActiveRun = {
            started, finished,
            cancel(nextReason) {
              // Dependency loss cannot replace a user's already requested cancellation.
              if (!reason || reason === 'dependency-unavailable') reason = nextReason
              cancelCurrent()
              const write = nextReason === 'dependency-unavailable' ? Promise.resolve()
                : state.requestCancellation(runId, inputs.now())
              cancellation = write
              void write.catch(() => {})
              return write.then(() => {})
            },
          }
          active.set(runId, entry)
          void finished.then(resolveStarted, rejectStarted)
          void started.catch(() => {})
          void finished.then(() => { active.delete(runId) }, error => {
            active.delete(runId)
            rejected.set(runId, finished)
            failures.push(error)
          })
          return started
        },
        async cancel(runId, reason) {
          const entry = active.get(runId)
          if (entry) return entry.cancel(reason)
          const run = reason === 'dependency-unavailable' ? await state.getRun(runId) : await state.requestCancellation(runId, inputs.now())
          // A handoff can register an owner while the cancellation transaction is pending.
          const handedOff = active.get(runId)
          if (handedOff) return handedOff.cancel(reason)
          if (run?.status === 'running' || run?.status === 'cancelling') {
            const failure = new LLMFailure('dependency-unavailable')
            await state.settleRun(runId, reason === 'dependency-unavailable'
              ? { kind: 'failed', error: failure.message, category: failure.category } : { kind: 'cancelled' }, inputs.now())
          }
        },
        wait(runId, signal) {
          return waitFor(active.get(runId)?.finished ?? rejected.get(runId) ?? state.getRun(runId), signal)
        },
      }
      ctx.provide(agentLoopServiceKey, service)
    },
  }
}

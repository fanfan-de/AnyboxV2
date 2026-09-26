import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { LLMFailure, llmServiceKey, normalizeLLMFailure } from '../llm/port.js'
import type { LLMMessage, LLMPort, ModelReply } from '../llm/port.js'
import { BashFailure, bashServiceKey } from '../tool/bash-component.js'
import type { BashPort, BashResult } from '../tool/bash-component.js'
import { bashObservationMessage, buildLLMMessages, RunFailure, runLimits, validateBashBatch } from './domain.js'
import type { Run, RunOutcome, ValidatedBashRequest } from './domain.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'

export const agentLoopServiceKey = 'harness.agent-loop'

export type LoopCancelReason = 'user-requested' | 'owner-disposed' | 'dependency-unavailable'

export interface AgentLoopPort {
  start(runId: string): Promise<Run>
  cancel(runId: string, reason: LoopCancelReason): Promise<void>
  wait(runId: string): Promise<Run | undefined>
}

interface ActiveRun {
  readonly finished: Promise<Run>
  cancel(reason: LoopCancelReason): void
}

type Observation<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cleanup-failed' }

/** Observe both promises immediately; an early cleanup failure must not wait forever for result. */
async function observe<T>(call: OwnedCall<T>): Promise<Observation<T>> {
  const result = call.result.then(
    value => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  )
  const exited = call.done.then(() => true, () => false)
  const early = exited.then(async (ok): Promise<Observation<T>> =>
    ok ? await result : { kind: 'cleanup-failed' })
  const observed = await Promise.race<Observation<T>>([result, early])
  if (!await exited) return { kind: 'cleanup-failed' }
  return observed
}

function bashFailure(error: unknown): RunFailure {
  if (error instanceof BashFailure) {
    if (error.category === 'timeout') return new RunFailure('tool-timeout')
    if (error.category === 'cancelled') return new RunFailure('tool-cancelled')
    if (error.category === 'cleanup-failure') return new RunFailure('tool-cleanup-failure')
    if (error.category === 'invalid-request') return new RunFailure('invalid-tool-request')
  }
  return new RunFailure('tool-unavailable')
}

/** Owns every model and Bash call until its result and actual exit have been observed. */
export function createAgentLoopComponent(inputs: RuntimeInputs): Component.Object<void, {
  [stateServiceKey]: StatePort
  [llmServiceKey]: LLMPort
  [bashServiceKey]: BashPort
}> {
  return {
    name: 'harness-agent-loop',
    inject: [stateServiceKey, llmServiceKey, bashServiceKey],
    apply(ctx, _config, deps) {
      const state = deps[stateServiceKey]
      const llm = deps[llmServiceKey]
      const bash = deps[bashServiceKey]
      const active = new Map<string, ActiveRun>()
      const starting = new Set<Promise<Run>>()
      const startingRunIds = new Set<string>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        await Promise.allSettled([...starting])
        const pending = [...active.entries()]
        for (const [, item] of pending) item.cancel('dependency-unavailable')
        for (const result of await Promise.allSettled(pending.map(([, item]) => item.finished))) {
          if (result.status === 'rejected') failures.push(result.reason)
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'agent loop cleanup failed')
      }, 'cancel and join agent loop calls')

      const service: AgentLoopPort = {
        start(runId) {
          startingRunIds.add(runId)
          const task = (async (): Promise<Run> => {
            const run = await state.getRun(runId)
            if (!run) throw new Error(`unknown run ${runId}`)
            if (run.status === 'cancelling') return state.settleRun(runId, { kind: 'cancelled' }, inputs.now())
            if (run.status !== 'running') return run
            const [session, prompts, plan] = await Promise.all([
              state.getSession(run.sessionId), state.getRunPrompts(run.id), state.getRunPlan(run.id),
            ])
            if (!accepting || !session || !prompts || !plan) {
              const failure = new LLMFailure('dependency-unavailable')
              return state.settleRun(runId, { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
            }
            const messages: LLMMessage[] = [...buildLLMMessages(prompts, session, run.input)]
            let current: OwnedCall<unknown> | undefined
            let currentKind: 'model' | 'bash' = 'model'
            let currentRequest: ValidatedBashRequest | undefined
            let dependencyLost = false
            let cancelError: unknown
            let launchFailure: Run | undefined
            let totalToolOutputBytes = 0
            const settle = (outcome: RunOutcome) => state.settleRun(run.id, outcome, inputs.now())
            const fail = (failure: LLMFailure | RunFailure) =>
              settle({ kind: 'failed', error: failure.message, category: failure.category })

            const launchModel = async (): Promise<OwnedCall<ModelReply> | undefined> => {
              if (!await state.recordRunEvent(run.id, { kind: 'model-started' }, inputs.now())) {
                launchFailure = await settle({ kind: 'cancelled' })
                return undefined
              }
              const latest = await state.getRun(run.id)
              if (latest?.status !== 'running') {
                launchFailure = await settle({ kind: 'cancelled' })
                return undefined
              }
              if (!accepting || dependencyLost) {
                launchFailure = await fail(new LLMFailure('dependency-unavailable'))
                return undefined
              }
              try {
                const call = llm.call({ plan, messages: Object.freeze([...messages]),
                  ...(llm.supportsTools ? { tools: Object.freeze([bash.definition]) } : {}) })
                current = call
                return call
              } catch (error) {
                launchFailure = await fail(normalizeLLMFailure(error))
                return undefined
              }
            }

            const launchBash = async (request: ValidatedBashRequest): Promise<OwnedCall<BashResult> | undefined> => {
              if (!await state.recordRunEvent(run.id, { kind: 'bash-started', call: request }, inputs.now())) {
                launchFailure = await settle({ kind: 'cancelled' })
                return undefined
              }
              const latest = await state.getRun(run.id)
              if (latest?.status !== 'running') {
                launchFailure = await settle({ kind: 'cancelled' })
                return undefined
              }
              if (!accepting || dependencyLost) {
                launchFailure = await fail(new LLMFailure('dependency-unavailable'))
                return undefined
              }
              try {
                const call = bash.execute({ projectId: session.projectId, command: request.arguments.command })
                current = call
                return call
              }
              catch (error) {
                const failure = bashFailure(error)
                await state.recordRunEvent(run.id,
                  { kind: 'bash-failed', requestId: request.id, category: failure.category }, inputs.now())
                launchFailure = await fail(failure)
                return undefined
              }
            }

            const first = await launchModel()
            if (!first) return launchFailure!
            current = first

            const finished = (async (): Promise<Run> => {
              while (current) {
                const observed = await observe(current)
                current = undefined
                if (currentKind === 'bash') {
                  if (observed.kind === 'value') {
                    await state.recordRunEvent(run.id,
                      { kind: 'bash-observed', requestId: currentRequest!.id, result: observed.value as BashResult }, inputs.now())
                  } else {
                    const failure = observed.kind === 'cleanup-failed' || cancelError
                      ? new RunFailure('tool-cleanup-failure') : bashFailure(observed.error)
                    await state.recordRunEvent(run.id,
                      { kind: 'bash-failed', requestId: currentRequest!.id, category: failure.category }, inputs.now())
                  }
                }
                if (observed.kind === 'cleanup-failed' || cancelError) {
                  const failure = currentKind === 'model'
                    ? new LLMFailure('cleanup-failure') : new RunFailure('tool-cleanup-failure')
                  failures.push(failure)
                  return settle({ kind: 'cleanup-failed', error: failure.message, category: failure.category })
                }
                const latest = await state.getRun(run.id)
                if (latest?.status === 'cancelling' || latest?.status === 'cancelled') return settle({ kind: 'cancelled' })
                if (!accepting || dependencyLost) return fail(new LLMFailure('dependency-unavailable'))
                if (observed.kind === 'error') {
                  if (currentKind === 'bash') {
                    return fail(bashFailure(observed.error))
                  }
                  return fail(normalizeLLMFailure(observed.error))
                }

                if (currentKind === 'model') {
                  const reply = observed.value as ModelReply
                  if (!reply || typeof reply !== 'object') return fail(new LLMFailure('invalid-response'))
                  if (reply.kind === 'final') {
                    if (typeof reply.text !== 'string' || !reply.text.trim()) {
                      return fail(new LLMFailure('invalid-response'))
                    }
                    if (Buffer.byteLength(reply.text, 'utf8') > runLimits.finalBytes) {
                      return fail(new RunFailure('limit-exceeded'))
                    }
                    return settle({ kind: 'completed', output: reply.text })
                  }
                  if (reply.kind !== 'tool-calls') return fail(new LLMFailure('invalid-response'))
                  if (reply.content !== undefined && reply.content !== null && typeof reply.content !== 'string') {
                    return fail(new LLMFailure('invalid-response'))
                  }
                  let batch: readonly ValidatedBashRequest[]
                  try {
                    batch = validateBashBatch(reply.calls)
                  } catch (error) {
                    return fail(error instanceof RunFailure ? error : new RunFailure('invalid-tool-request'))
                  }
                  await state.recordRunEvent(run.id, { kind: 'model-tool-calls', calls: batch }, inputs.now())
                  messages.push(Object.freeze({ role: 'assistant', content: reply.content ?? null, toolCalls: batch }))
                } else {
                  const result = observed.value as BashResult
                  totalToolOutputBytes += Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8')
                  if (totalToolOutputBytes > runLimits.totalToolOutputBytes) {
                    return fail(new RunFailure('limit-exceeded'))
                  }
                  messages.push(bashObservationMessage(currentRequest!.id, result))
                }

                const execution = await state.getRunExecution(run.id)
                if (execution?.phase === 'ready-tool') {
                  const request = execution.batch[execution.nextToolIndex]
                  if (!request) throw new Error('missing queued Bash request')
                  currentKind = 'bash'
                  currentRequest = request
                  current = await launchBash(request)
                } else if (execution?.phase === 'ready-model') {
                  currentKind = 'model'
                  currentRequest = undefined
                  current = await launchModel()
                } else throw new Error('Run has no executable next phase')
                if (!current) return launchFailure!
              }
              throw new Error('Run loop exited without a result')
            })()
            const item: ActiveRun = {
              finished,
              cancel(reason) {
                if (reason === 'dependency-unavailable') dependencyLost = true
                try { current?.cancel(reason) } catch (error) { cancelError = error }
              },
            }
            active.set(run.id, item)
            if ((await state.getRun(run.id))?.status === 'cancelling') item.cancel('user-requested')
            void finished.finally(() => { active.delete(run.id) }).catch(error => { failures.push(error) })
            return run
          })()
          starting.add(task)
          void task.finally(() => { starting.delete(task); startingRunIds.delete(runId) }).catch(() => {})
          return task
        },
        async cancel(runId, reason) {
          const run = reason !== 'dependency-unavailable'
            ? await state.requestCancellation(runId, inputs.now()) : await state.getRun(runId)
          const item = active.get(runId)
          if (run && (run.status === 'running' || run.status === 'cancelling') && item) item.cancel(reason)
          else if (run && (run.status === 'running' || run.status === 'cancelling') && !startingRunIds.has(runId)) {
            await state.settleRun(runId, { kind: 'cancelled' }, inputs.now())
          }
        },
        wait(runId) { return active.get(runId)?.finished ?? state.getRun(runId) },
      }
      ctx.provide(agentLoopServiceKey, service)
    },
  }
}

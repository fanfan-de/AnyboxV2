import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { LLMFailure, llmServiceKey, normalizeLLMFailure } from '../llm/port.js'
import type { LLMPort } from '../llm/port.js'
import { buildLLMMessages } from './domain.js'
import type { Run, RunOutcome } from './domain.js'
import { stateServiceKey } from './memory-state.js'
import type { StatePort } from './memory-state.js'

export const agentLoopServiceKey = 'harness.agent-loop'

export type LoopCancelReason = 'user-requested' | 'owner-disposed' | 'dependency-unavailable'

export interface AgentLoopPort {
  start(runId: string): Run
  cancel(runId: string, reason: LoopCancelReason): void
  wait(runId: string): Promise<Run | undefined>
}

interface ActiveRun {
  readonly finished: Promise<Run>
  cancel(reason: LoopCancelReason): void
}

/** Owns in-flight calls and advances accepted Runs after observing result and exit. */
export function createAgentLoopComponent(inputs: RuntimeInputs): Component.Object<void, {
  [stateServiceKey]: StatePort
  [llmServiceKey]: LLMPort
}> {
  return {
    name: 'harness-agent-loop',
    inject: [stateServiceKey, llmServiceKey],
    apply(ctx, _config, deps) {
      const state = deps[stateServiceKey]
      const llm = deps[llmServiceKey]
      const active = new Map<string, ActiveRun>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
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
          const run = state.getRun(runId)
          if (!run) throw new Error(`unknown run ${runId}`)
          if (!accepting) {
            const failure = new LLMFailure('dependency-unavailable')
            return state.settleRun(runId, { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
          }
          const session = state.getSession(run.sessionId)!
          let call: OwnedCall<string>
          try {
            call = llm.call({
              plan: state.getRunPlan(run.id)!,
              messages: buildLLMMessages(state.getRunPrompts(run.id)!, session, run.input),
            })
          } catch (error) {
            const failure = normalizeLLMFailure(error)
            return state.settleRun(run.id, { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
          }
          // done may reject before result. Observe both as soon as the call is acquired.
          const exited = call.done.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          let cancelError: { readonly value: unknown } | undefined
          let dependencyLost = false
          const finished = (async (): Promise<Run> => {
            let outcome: RunOutcome
            try {
              outcome = { kind: 'completed', output: await Promise.race([call.result,
                exited.then(exit => { if (!exit.ok) throw new LLMFailure('cleanup-failure'); return call.result })]) }
            } catch (error) {
              const failure = normalizeLLMFailure(error)
              outcome = { kind: 'failed', error: failure.message, category: failure.category }
            }
            const exit = await exited
            if (!exit.ok) {
              outcome = { kind: 'cleanup-failed', error: new LLMFailure('cleanup-failure').message, category: 'cleanup-failure' }
              failures.push(new LLMFailure('cleanup-failure'))
            }
            if (cancelError) {
              outcome = { kind: 'cleanup-failed', error: new LLMFailure('cleanup-failure').message, category: 'cleanup-failure' }
              failures.push(new LLMFailure('cleanup-failure'))
            }
            if (dependencyLost && state.getRun(run.id)?.status !== 'cancelling' && outcome.kind !== 'cleanup-failed') {
              const failure = new LLMFailure('dependency-unavailable')
              outcome = { kind: 'failed', error: failure.message, category: failure.category }
            }
            return state.settleRun(run.id, outcome, inputs.now())
          })()
          const item: ActiveRun = {
            finished,
            cancel(reason) {
              if (reason === 'dependency-unavailable') dependencyLost = true
              try { call.cancel(reason) } catch (error) { cancelError = { value: error } }
            },
          }
          active.set(run.id, item)
          void finished.finally(() => { active.delete(run.id) }).catch(error => { failures.push(error) })
          return run
        },
        cancel(runId, reason) {
          if (reason !== 'dependency-unavailable') state.requestCancellation(runId, inputs.now())
          const run = state.getRun(runId)
          const item = active.get(runId)
          if (run && (run.status === 'running' || run.status === 'cancelling') && item) item.cancel(reason)
        },
        wait(runId) { return active.get(runId)?.finished ?? Promise.resolve(state.getRun(runId)) },
      }
      ctx.provide(agentLoopServiceKey, service)
    },
  }
}

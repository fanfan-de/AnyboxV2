import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { LLMFailure, llmServiceKey, normalizeLLMFailure } from '../llm/port.js'
import type { LLMPort } from '../llm/port.js'
import { buildLLMMessages } from './domain.js'
import type { Run, RunOutcome } from './domain.js'
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
      const starting = new Set<Promise<Run>>()
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
          const task = (async (): Promise<Run> => {
          const run = await state.getRun(runId)
          if (!run) throw new Error(`unknown run ${runId}`)
          if (run.status !== 'running') return run
          const [session, prompts, plan] = await Promise.all([
            state.getSession(run.sessionId), state.getRunPrompts(run.id), state.getRunPlan(run.id),
          ])
          if (!accepting || !session || !prompts || !plan) {
            const failure = new LLMFailure('dependency-unavailable')
            return state.settleRun(runId, { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
          }
          // Cancellation may have settled the Run while the persisted inputs were loading.
          const current = await state.getRun(runId)
          if (!current) throw new Error(`unknown run ${runId}`)
          if (current.status !== 'running') return current
          let call: OwnedCall<string>
          try {
            call = llm.call({
              plan, messages: buildLLMMessages(prompts, session, run.input),
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
            if (dependencyLost && (await state.getRun(run.id))?.status !== 'cancelling' && outcome.kind !== 'cleanup-failed') {
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
          })()
          starting.add(task)
          void task.finally(() => starting.delete(task)).catch(() => {})
          return task
        },
        async cancel(runId, reason) {
          const run = reason !== 'dependency-unavailable'
            ? await state.requestCancellation(runId, inputs.now()) : await state.getRun(runId)
          const item = active.get(runId)
          if (run && (run.status === 'running' || run.status === 'cancelling') && item) item.cancel(reason)
          else if (run && (run.status === 'running' || run.status === 'cancelling')) {
            await state.settleRun(runId, { kind: 'cancelled' }, inputs.now())
          }
        },
        wait(runId) { return active.get(runId)?.finished ?? state.getRun(runId) },
      }
      ctx.provide(agentLoopServiceKey, service)
    },
  }
}

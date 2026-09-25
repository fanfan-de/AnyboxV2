import type { Component } from '@nya/core'
import {
  appendTurn, createRun, createSession, requestCancellation, settleRun,
  validateRunInput,
} from './domain.js'
import type { Run, RunInput, RunOutcome, Session } from './domain.js'
import type { LLMPlan } from '../llm/port.js'
import type { PromptSnapshot } from '../prompt/domain.js'

export const stateServiceKey = 'harness.state'

export interface StatePort {
  createSession(id: string, agentId: string, now: string): Session
  getSession(id: string): Session | undefined
  /** Check duplicates and session admission before resolving this Run's configuration. */
  findAcceptedRun(input: RunInput): Run | undefined
  /** Recheck admission and commit the prepared snapshot without calling other services. */
  acceptRun(id: string, input: RunInput, now: string,
    prompts: readonly PromptSnapshot[], plan: LLMPlan): { readonly run: Run; readonly created: boolean }
  getRun(id: string): Run | undefined
  /** Internal content snapshot. Do not expose through user-facing Run queries. */
  getRunPrompts(id: string): readonly PromptSnapshot[] | undefined
  /** Internal call plan; contains no client or credential reference. */
  getRunPlan(id: string): LLMPlan | undefined
  requestCancellation(id: string, now: string): Run | undefined
  settleRun(id: string, outcome: RunOutcome, now: string): Run
}

/** One component owns one in-memory state instance. Disposal loses its data. */
export function createMemoryStateComponent(): Component.Object<void> {
  return {
    name: 'harness-memory-state',
    apply(ctx) {
      const sessions = new Map<string, Session>()
      const runs = new Map<string, Run>()
      const runPrompts = new Map<string, readonly PromptSnapshot[]>()
      const runPlans = new Map<string, LLMPlan>()
      const keys = new Map<string, string>()
      let accepting = true
      ctx.effect(() => () => {
        accepting = false; sessions.clear(); runs.clear(); runPrompts.clear(); runPlans.clear(); keys.clear()
      }, 'memory state')
      const assertOpen = () => { if (!accepting) throw new Error('state is closing') }
      const findAcceptedRun = (raw: RunInput): Run | undefined => {
        assertOpen()
        const input = validateRunInput(raw)
        const session = sessions.get(input.sessionId)
        if (!session) throw new Error(`unknown session ${input.sessionId}`)
        const priorId = keys.get(JSON.stringify([input.sessionId, input.idempotencyKey]))
        if (priorId) {
          const prior = runs.get(priorId)!
          if (prior.input !== input.input) throw new Error('idempotency key already used with different input')
          return prior
        }
        if ([...runs.values()].some(run => run.sessionId === session.id &&
          (run.status === 'running' || run.status === 'cancelling'))) {
          throw new Error('session already has an active run')
        }
        return undefined
      }
      const service: StatePort = {
        createSession(id, agentId, now) {
          assertOpen()
          if (sessions.has(id)) throw new Error(`session id ${id} already exists`)
          const session = createSession(id, agentId, now)
          sessions.set(id, session)
          return session
        },
        getSession(id) { return sessions.get(id) },
        findAcceptedRun,
        acceptRun(id, raw, now, prompts, plan) {
          const input = validateRunInput(raw)
          const prior = findAcceptedRun(input)
          if (prior) return { run: prior, created: false }
          if (runs.has(id)) throw new Error(`run id ${id} already exists`)
          const run = createRun(id, input, prompts, plan, now)
          runs.set(id, run)
          runPrompts.set(id, Object.freeze([...prompts]))
          runPlans.set(id, plan)
          keys.set(JSON.stringify([input.sessionId, input.idempotencyKey]), id)
          return { run, created: true }
        },
        getRun(id) { return runs.get(id) },
        getRunPrompts(id) { return runPrompts.get(id) },
        getRunPlan(id) { return runPlans.get(id) },
        requestCancellation(id, now) {
          const run = runs.get(id)
          if (!run) return undefined
          const next = requestCancellation(run, now)
          runs.set(id, next)
          return next
        },
        settleRun(id, outcome, now) {
          const run = runs.get(id)
          if (!run) throw new Error(`unknown run ${id}`)
          const next = settleRun(run, outcome, now)
          runs.set(id, next)
          if (next.status === 'completed' && run.status !== 'completed') {
            const session = sessions.get(run.sessionId)!
            sessions.set(session.id, appendTurn(session, run.input, next.output!))
          }
          return next
        },
      }
      ctx.provide(stateServiceKey, service)
    },
  }
}

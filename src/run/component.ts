import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { AgentDefinition } from '../agent/domain.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'
import { llmServiceKey, normalizeLLMFailure } from '../llm/port.js'
import type { LLMPort } from '../llm/port.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { validateRunInput } from './domain.js'
import type { Run, RunInput } from './domain.js'
import type { RunEvent } from './execution.js'
import { agentLoopServiceKey } from './agent-loop-component.js'
import type { AgentLoopPort, LoopCancelReason } from './agent-loop-component.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'

export const runServiceKey = 'harness.runs'

export interface RunPort {
  startRun(input: RunInput): Promise<Run>
  getRun(id: string): Promise<Run | undefined>
  listRuns(sessionId: string): Promise<readonly Run[]>
  getRunEvents(id: string): Promise<readonly RunEvent[] | undefined>
  cancelRun(id: string): Promise<Run | undefined>
  waitRun(id: string): Promise<Run | undefined>
}

/** Admits Runs and exposes control; AgentLoop alone owns their in-flight calls. */
export function createRunComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[], isHarnessClosing: () => boolean = () => false): Component.Object<void, {
  [stateServiceKey]: StatePort
  [agentPromptServiceKey]: AgentPromptPort
  [llmServiceKey]: LLMPort
  [agentLoopServiceKey]: AgentLoopPort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-runs',
    inject: [stateServiceKey, agentPromptServiceKey, llmServiceKey, agentLoopServiceKey, projectServiceKey],
    apply(ctx, _config, deps) {
      const state = deps[stateServiceKey]
      const prompts = deps[agentPromptServiceKey]
      const llm = deps[llmServiceKey]
      const loop = deps[agentLoopServiceKey]
      const projects = deps[projectServiceKey]
      const owned = new Set<string>()
      const admissions = new Set<Promise<Run>>()
      const tails = new Map<string, Promise<void>>()
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        await Promise.allSettled([...admissions])
        const pending = [...owned]
        const reason: LoopCancelReason = isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable'
        const cancelled = await Promise.allSettled(pending.map(id => loop.cancel(id, reason)))
        const failures = [
          ...await Promise.allSettled(pending.map(id => loop.wait(id))), ...cancelled,
        ].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'run shutdown failed')
      }, 'stop and join accepted runs')

      const ensureOpen = () => { if (!accepting) throw new Error('run service is closing') }
      const enqueue = (sessionId: string, work: () => Promise<Run>): Promise<Run> => {
        const previous = tails.get(sessionId) ?? Promise.resolve()
        const result = previous.then(work)
        const tail = result.then(() => {}, () => {})
        tails.set(sessionId, tail)
        void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
        admissions.add(result)
        void result.finally(() => admissions.delete(result)).catch(() => {})
        return result
      }
      const service: RunPort = {
        startRun(raw) {
          ensureOpen()
          const input = validateRunInput(raw)
          return enqueue(input.sessionId, async () => {
            ensureOpen()
            // Check the original key before consulting configuration that may since have changed.
            const prior = await state.findAcceptedRun(input)
            if (prior) return prior
            const session = await state.getSession(input.sessionId)
            if (!session) throw new Error(`unknown session ${input.sessionId}`)
            await projects.requireAvailable(session.projectId)
            const agent = agents.find(agent => agent.id === session.agentId)
            if (!agent) throw new Error('agent is unavailable')
            const snapshots = prompts.resolveRunPrompts(session.agentId)
            const plan = llm.prepare(agent.modelProfileId)
            ensureOpen()
            const accepted = await state.acceptRun(inputs.newId(), input, inputs.now(), snapshots, plan)
            if (!accepted.created) return accepted.run
            const run = accepted.run
            owned.add(run.id)
            let started: Run
            try { started = await loop.start(run.id) } catch (error) {
              const failure = normalizeLLMFailure(error)
              started = await state.settleRun(run.id,
                { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
            }
            void loop.wait(run.id).finally(() => { owned.delete(run.id) }).catch(() => {})
            return started
          })
        },
        getRun: id => state.getRun(id),
        listRuns: id => state.listRuns(id),
        getRunEvents: id => state.getRunEvents(id),
        async cancelRun(id) {
          await loop.cancel(id, 'user-requested')
          return state.getRun(id)
        },
        waitRun: id => loop.wait(id),
      }
      ctx.provide(runServiceKey, service)
    },
  }
}

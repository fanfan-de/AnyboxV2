import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { AgentDefinition } from '../agent/domain.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'
import { llmServiceKey } from '../llm/port.js'
import type { LLMPort } from '../llm/port.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { treeError, validateRunInput } from './domain.js'
import type { Run, RunInput, RunQuery } from './domain.js'
import type { RunEvent } from './execution.js'
import { agentLoopServiceKey } from './agent-loop-component.js'
import type { AgentLoopPort, LoopCancelReason } from './agent-loop-component.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'
import { createWaiters } from './waiters.js'

export const runServiceKey = 'harness.runs'

export interface RunPort {
  startRun(input: RunInput): Promise<Run>
  getRun(id: string): Promise<Run | undefined>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
  cancelRun(id: string): Promise<Run | undefined>
  waitRun(id: string, signal?: AbortSignal): Promise<Run | undefined>
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
      const requests = new Map<string, { input: RunInput; result: Promise<Run> }>()
      const handoffs = new Map<string, Promise<Run>>()
      const waitFor = createWaiters<Run>()
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const reason: LoopCancelReason = isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable'
        const initial = new Set(owned)
        const stopping = [...initial].map(id => loop.cancel(id, reason))
        const cancelledEarly = Promise.allSettled(stopping)
        await Promise.allSettled([...admissions])
        const pending = [...new Set([...initial, ...owned])]
        const cancelled = await Promise.allSettled(pending.filter(id => !initial.has(id)).map(id => loop.cancel(id, reason)))
        const failures = [
          ...await Promise.allSettled(pending.map(id => loop.wait(id))), ...cancelled, ...await cancelledEarly,
        ].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'run shutdown failed')
      }, 'stop and join accepted runs')

      const ensureOpen = () => { if (!accepting) throw new Error('run service is closing') }
      const service: RunPort = {
        startRun(raw) {
          ensureOpen()
          const input = validateRunInput(raw)
          const key = JSON.stringify([input.sessionId, input.idempotencyKey])
          const pending = requests.get(key)
          if (pending) {
            if (pending.input.input !== input.input || pending.input.parentNodeId !== input.parentNodeId) return Promise.reject(treeError('idempotency-conflict'))
            return pending.result
          }
          const result = Promise.resolve().then(async () => {
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
            const id = inputs.newId()
            // Register the handoff before the transaction can make the Run visible.
            const handoff = Promise.resolve().then(async () => {
              const accepted = await state.acceptRun(id, input, inputs.now(), snapshots, plan)
              if (!accepted.created) return accepted.run
              owned.add(id)
              try {
                if (!accepting) {
                  await loop.cancel(id, isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable')
                  return (await state.getRun(id))!
                }
                return await loop.start(id)
              }
              finally {
                void loop.wait(id).finally(() => { owned.delete(id) }).catch(() => {})
              }
            })
            handoffs.set(id, handoff)
            try { return await handoff } finally { handoffs.delete(id) }
          })
          requests.set(key, { input, result })
          admissions.add(result)
          void result.finally(() => { requests.delete(key); admissions.delete(result) }).catch(() => {})
          return result
        },
        getRun: id => state.getRun(id),
        getRunByKey: (id, key) => state.getRunByKey(id, key),
        listRuns: (id, query) => state.listRuns(id, query),
        getRunEvents: (id, afterSeq) => state.getRunEvents(id, afterSeq),
        async cancelRun(id) {
          await loop.cancel(id, 'user-requested')
          return state.getRun(id)
        },
        async waitRun(id, signal) {
          signal?.throwIfAborted()
          const handoff = handoffs.get(id)
          if (handoff) await waitFor(handoff, signal)
          return loop.wait(id, signal)
        },
      }
      ctx.provide(runServiceKey, service)
    },
  }
}

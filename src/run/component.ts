import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { agentServiceKey } from '../agent/component.js'
import type { AgentPort } from '../agent/component.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'
import { llmServiceKey } from '../llm/port.js'
import type { LLMPort } from '../llm/port.js'
import { validateRunInput } from './domain.js'
import type { Run, RunInput } from './domain.js'
import { agentLoopServiceKey } from './agent-loop-component.js'
import type { AgentLoopPort, LoopCancelReason } from './agent-loop-component.js'
import { stateServiceKey } from './memory-state.js'
import type { StatePort } from './memory-state.js'

export const runServiceKey = 'harness.runs'

export interface RunPort {
  startRun(input: RunInput): Run
  getRun(id: string): Run | undefined
  cancelRun(id: string): Run | undefined
  waitRun(id: string): Promise<Run | undefined>
}

/** Admits Runs and exposes control; AgentLoop alone owns their in-flight calls. */
export function createRunComponent(inputs: RuntimeInputs, isHarnessClosing: () => boolean = () => false): Component.Object<void, {
  [agentServiceKey]: AgentPort
  [stateServiceKey]: StatePort
  [agentPromptServiceKey]: AgentPromptPort
  [llmServiceKey]: LLMPort
  [agentLoopServiceKey]: AgentLoopPort
}> {
  return {
    name: 'harness-runs',
    inject: [agentServiceKey, stateServiceKey, agentPromptServiceKey, llmServiceKey, agentLoopServiceKey],
    apply(ctx, _config, deps) {
      const agents = deps[agentServiceKey]
      const state = deps[stateServiceKey]
      const prompts = deps[agentPromptServiceKey]
      const llm = deps[llmServiceKey]
      const loop = deps[agentLoopServiceKey]
      const owned = new Set<string>()
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...owned]
        const reason: LoopCancelReason = isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable'
        for (const id of pending) loop.cancel(id, reason)
        const failures = (await Promise.allSettled(pending.map(id => loop.wait(id))))
          .flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'run shutdown failed')
      }, 'stop and join accepted runs')

      const ensureOpen = () => { if (!accepting) throw new Error('run service is closing') }
      const service: RunPort = {
        startRun(raw) {
          ensureOpen()
          const input = validateRunInput(raw)
          // A repeated key must return its original Run even if current configuration changed.
          const prior = state.findAcceptedRun(input)
          if (prior) return prior
          const session = state.getSession(input.sessionId)!
          const agent = agents.get(session.agentId)
          if (!agent) throw new Error('agent is unavailable')
          const snapshots = prompts.resolveRunPrompts(session.agentId)
          const plan = llm.prepare(agent.modelProfileId)
          const accepted = state.acceptRun(inputs.newId(), input, inputs.now(), snapshots, plan)
          if (!accepted.created) return accepted.run
          const run = accepted.run
          owned.add(run.id)
          const started = loop.start(run.id)
          void loop.wait(run.id).finally(() => { owned.delete(run.id) }).catch(() => {})
          return started
        },
        getRun: id => state.getRun(id),
        cancelRun(id) {
          loop.cancel(id, 'user-requested')
          return state.getRun(id)
        },
        waitRun: id => loop.wait(id),
      }
      ctx.provide(runServiceKey, service)
    },
  }
}

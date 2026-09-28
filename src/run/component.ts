import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { AgentDefinition } from '../agent/domain.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'
import { modelsServiceKey } from '@anybox/models'
import type { ModelsService, ModelExecution } from '@anybox/models'
import { modelFailure, normalizeModelFailure } from './model.js'
import { bashToolDefinition } from '../tool/bash-component.js'
import { applyPatchToolDefinition } from '../tool/apply-patch-component.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { validateRunInput } from './domain.js'
import { treeError } from '../session/domain.js'
import type { Run, RunInput } from './domain.js'
import { agentLoopServiceKey } from './agent-loop-component.js'
import type { AgentLoopPort, LoopCancelReason } from './agent-loop-component.js'
import { sessionServiceKey, sessionRunServiceKey } from '../session/port.js'
import type { SessionPort, SessionRunPort } from '../session/port.js'
import { createWaiters } from './waiters.js'

export const runServiceKey = 'harness.runs'

export interface RunPort {
  startRun(input: RunInput): Promise<Run>
  cancelRun(id: string): Promise<Run | undefined>
  waitRun(id: string, signal?: AbortSignal): Promise<Run | undefined>
}

/** Admits Runs and exposes control; AgentLoop alone owns their in-flight calls. */
export function createRunComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[], isHarnessClosing: () => boolean = () => false): Component.Object<void, {
  [sessionServiceKey]: SessionPort
  [sessionRunServiceKey]: SessionRunPort
  [agentPromptServiceKey]: AgentPromptPort
  [modelsServiceKey]: ModelsService
  [agentLoopServiceKey]: AgentLoopPort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-runs',
    inject: [sessionServiceKey, sessionRunServiceKey, agentPromptServiceKey, modelsServiceKey, agentLoopServiceKey, projectServiceKey],
    apply(ctx, _config, deps) {
      const sessions = deps[sessionServiceKey]
      const records = deps[sessionRunServiceKey]
      const prompts = deps[agentPromptServiceKey]
      const models = deps[modelsServiceKey]
      const loop = deps[agentLoopServiceKey]
      const projects = deps[projectServiceKey]
      const owned = new Set<string>()
      const admissions = new Set<Promise<Run>>()
      const opening = new Set<AbortController>()
      const cleanupFailures: unknown[] = []
      const requests = new Map<string, { input: RunInput; result: Promise<Run> }>()
      const handoffs = new Map<string, Promise<Run>>()
      // Before AgentLoop takes ownership, cancellation can mark the record but must
      // not publish its terminal state ahead of execution cleanup.
      const untransferred = new Map<string, AbortController>()
      const waitFor = createWaiters<Run>()
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        for (const controller of opening) controller.abort()
        const reason: LoopCancelReason = isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable'
        const initial = new Set(owned)
        const stopping = [...initial].filter(id => !untransferred.has(id)).map(id => loop.cancel(id, reason))
        const cancelledEarly = Promise.allSettled(stopping)
        await Promise.allSettled([...admissions])
        const pending = [...new Set([...initial, ...owned])]
        const cancelled = await Promise.allSettled(pending.filter(id => !initial.has(id)).map(id => loop.cancel(id, reason)))
        const joined = [...await Promise.allSettled(pending.map(id => loop.wait(id))), ...cancelled, ...await cancelledEarly]
        const failures = [...cleanupFailures, ...joined.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
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
            if (pending.input.input !== input.input || pending.input.parentNodeId !== input.parentNodeId || pending.input.modelId !== input.modelId) return Promise.reject(treeError('idempotency-conflict'))
            return pending.result
          }
          const controller = new AbortController()
          opening.add(controller)
          const result = Promise.resolve().then(async () => {
            ensureOpen()
            // Check the original key before consulting configuration that may since have changed.
            const prior = await records.findAcceptedRun(input)
            if (prior) return prior
            const session = await sessions.getSession(input.sessionId)
            if (!session) throw new Error(`unknown session ${input.sessionId}`)
            await projects.requireAvailable(session.projectId)
            const agent = agents.find(agent => agent.id === session.agentId)
            if (!agent) throw new Error('agent is unavailable')
            const snapshots = prompts.resolveRunPrompts(session.agentId)
            const modelId = input.modelId ?? session.modelId ?? agent.modelId
            if (!modelId) throw modelFailure('model-unavailable')
            const supportsTools = models.get(modelId)?.effectiveCapabilities?.tools === true
            let execution: ModelExecution
            try {
              execution = await models.open({ modelId, signal: controller.signal,
                ...(supportsTools ? { tools: [bashToolDefinition, applyPatchToolDefinition] } : {}) })
            } catch (error) { throw normalizeModelFailure(error) }
            let transferred = false
            const id = inputs.newId()
            untransferred.set(id, controller)
            try {
              ensureOpen()
              const handoff = Promise.resolve().then(async () => {
                const accepted = await records.registerRun(id, input, inputs.now(), snapshots, execution.snapshot)
                if (!accepted.created) return accepted.run
                owned.add(id)
                try {
                  if (!accepting) {
                    await execution.close()
                    const failure = modelFailure('dependency-unavailable')
                    return await records.settleRun(id, isHarnessClosing() ? { kind: 'cancelled' }
                      : { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
                  }
                  let started: Promise<Run>
                  try {
                    started = loop.start({ runId: id, execution })
                    transferred = true
                    untransferred.delete(id)
                  } catch {
                    // Synchronous refusal means AgentLoop acquired no execution.
                    await execution.close()
                    const failure = modelFailure('dependency-unavailable')
                    return await records.settleRun(id, { kind: 'failed', error: failure.message, category: failure.category }, inputs.now())
                  }
                  return await started
                } finally {
                  void loop.wait(id).finally(() => { owned.delete(id) }).catch(() => {})
                }
              })
              handoffs.set(id, handoff)
              try { return await handoff } finally { handoffs.delete(id) }
            } finally {
              try {
                if (!transferred) {
                  try { await execution.close() }
                  catch {
                    const failure = modelFailure('cleanup-failure')
                    cleanupFailures.push(failure)
                    const accepted = await records.getRun(id)
                    if (accepted) await records.settleRun(id, { kind: 'cleanup-failed', error: failure.message, category: failure.category }, inputs.now())
                    throw failure
                  }
                }
              } finally { untransferred.delete(id) }
            }
          })
          requests.set(key, { input, result })
          admissions.add(result)
          void result.finally(() => { requests.delete(key); admissions.delete(result); opening.delete(controller) }).catch(() => {})
          return result
        },
        async cancelRun(id) {
          const admission = untransferred.get(id)
          if (admission) {
            admission.abort()
            return records.requestCancellation(id, inputs.now())
          }
          await loop.cancel(id, 'user-requested')
          return records.getRun(id)
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

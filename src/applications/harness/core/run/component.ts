import type { FileContent } from '../project-files/domain.js'
import type { Component } from '@nya/core'
import type { JsonValue, ModelsService } from '@anybox/models'
import { modelsServiceKey } from '@anybox/models'
import type { RuntimeInputs } from '../contracts.js'
import type { AgentDefinition } from '../agent/domain.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'
import { modelFailure, normalizeModelFailure } from './model.js'
import { bashToolDefinition } from '../tool/bash-component.js'
import { applyPatchToolDefinition } from '../tool/apply-patch-component.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { validateRunInput, sameRunInput } from './domain.js'
import { validateImageBatch } from '../image/limits.js'
import { treeError } from '../session/domain.js'
import type { Run, RunInput } from './domain.js'
import { runRuntimeServiceKey } from './runtime-component.js'
import type { RunRuntimePort, RunCancelReason } from './runtime-component.js'
import { protocolAgentServiceKey } from './program.js'
import type { ProtocolAgentPort, PreparedRunProgram, NativeInitialization, NativeRunInput } from './program.js'
import { sessionServiceKey, sessionRunServiceKey } from '../session/port.js'
import type { SessionPort, SessionRunPort } from '../session/port.js'
import { createWaiters } from './waiters.js'

export const runServiceKey = 'harness.runs'
export const runAdmissionServiceKey = 'harness.run-admission'
/** Trusted host control; does not cancel accepted work when a product is merely disabled. */
export interface RunAdmissionPort {
  busy(): boolean
  /** Atomically freezes new Runs only when preparation and execution are both idle. */
  pauseIfIdle(): (() => void) | undefined
  closeAdmission(): void
}
export interface RunPort {
  startRun(input: RunInput): Promise<Run>
  cancelRun(id: string): Promise<Run | undefined>
  waitRun(id: string, signal?: AbortSignal): Promise<Run | undefined>
  getView(id: string): JsonValue | undefined
}

/** Admission owns a prepared program until the Runtime synchronously accepts it. */
export function createRunComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[], isHarnessClosing: () => boolean = () => false, closingSignal?: AbortSignal): Component.Object<void, {
  [sessionServiceKey]: SessionPort
  [sessionRunServiceKey]: SessionRunPort
  [agentPromptServiceKey]: AgentPromptPort
  [modelsServiceKey]: ModelsService
  [protocolAgentServiceKey]: ProtocolAgentPort
  [runRuntimeServiceKey]: RunRuntimePort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-runs',
    inject: [sessionServiceKey, sessionRunServiceKey, agentPromptServiceKey, modelsServiceKey, protocolAgentServiceKey, runRuntimeServiceKey, projectServiceKey],
    apply(ctx, _config, deps) {
      const sessions = deps[sessionServiceKey], records = deps[sessionRunServiceKey], prompts = deps[agentPromptServiceKey]
      const models = deps[modelsServiceKey], protocols = deps[protocolAgentServiceKey], runtime = deps[runRuntimeServiceKey], projects = deps[projectServiceKey]
      const owned = new Set<string>(), admissions = new Set<Promise<Run>>(), opening = new Set<AbortController>()
      const cleanupFailures: unknown[] = []
      const requests = new Map<string, { input: RunInput; result: Promise<Run> }>()
      const handoffs = new Map<string, Promise<Run>>()
      const untransferred = new Map<string, AbortController>()
      const waitFor = createWaiters<Run>()
      let accepting = true, pauseCount = 0
      const stopPreparing = () => { for (const controller of opening) controller.abort() }
      ctx.effect(() => {
        closingSignal?.addEventListener('abort', stopPreparing)
        return () => { closingSignal?.removeEventListener('abort', stopPreparing) }
      }, 'observe host admission shutdown')
      ctx.effect(() => async () => {
        accepting = false
        for (const controller of opening) controller.abort()
        const reason: RunCancelReason = isHarnessClosing() ? 'owner-disposed' : 'dependency-unavailable'
        const initial = new Set(owned)
        const first = Promise.allSettled([...initial].filter(id => !untransferred.has(id)).map(id => runtime.cancel(id, reason)))
        await Promise.allSettled([...admissions])
        const pending = [...new Set([...initial, ...owned])]
        const cancelled = await Promise.allSettled(pending.filter(id => !initial.has(id)).map(id => runtime.cancel(id, reason)))
        const joined = [...await Promise.allSettled(pending.map(id => runtime.wait(id))), ...cancelled, ...await first]
        const failures = [...cleanupFailures, ...joined.flatMap(value => value.status === 'rejected' ? [value.reason] : [])]
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Run shutdown failed')
      }, 'stop admission and join accepted Runs')
      const busy = () => opening.size > 0 || admissions.size > 0 || owned.size > 0 || handoffs.size > 0 || untransferred.size > 0
      const admission: RunAdmissionPort = {
        busy,
        pauseIfIdle() {
          if (!accepting || busy()) return undefined
          pauseCount++
          let active = true
          return () => { if (active) { active = false; pauseCount-- } }
        },
        closeAdmission() { accepting = false; stopPreparing() },
      }
      const ensureOpen = () => { if (!accepting || pauseCount > 0 || isHarnessClosing()) throw new Error('run service is closing') }
      const service: RunPort = {
        startRun(raw) {
          ensureOpen()
          const input = validateRunInput(raw), key = JSON.stringify([input.sessionId, input.idempotencyKey])
          const pending = requests.get(key)
          if (pending) {
            if (!sameRunInput(pending.input, input)) return Promise.reject(treeError('idempotency-conflict'))
            return pending.result
          }
          const controller = new AbortController()
          opening.add(controller)
          const result = Promise.resolve().then(async () => {
            ensureOpen()
            const prior = await records.findAcceptedRun(input)
            if (prior) return prior
            const session = await sessions.getSession(input.sessionId)
            if (!session) throw new Error(`unknown session ${input.sessionId}`)
            if (session.archivedAt !== null) throw treeError('session-archived')
            if (session.historyMode !== 'native-local-v1') throw treeError('legacy-session-readonly')
            await projects.requireAvailable(session.projectId)
            const agent = agents.find(value => value.id === session.agentId)
            if (!agent) throw new Error('agent is unavailable')
            const modelId = input.modelId ?? session.modelId ?? agent.modelId
            if (!modelId) throw modelFailure('model-unavailable')
            const protocolId = protocols.protocolForModel(modelId)
            if (session.protocolId && session.protocolId !== protocolId) throw treeError('protocol-mismatch')
            const history = await records.loadNativeHistory(session.id, input.parentNodeId)
            const fixedInitialization = history?.initialization ?? await records.loadNativeInitialization(session.id)
            const availableTools = [bashToolDefinition, applyPatchToolDefinition]
            if (fixedInitialization?.tools.some(tool => !availableTools.some(current => JSON.stringify(current) === JSON.stringify(tool)))) throw treeError('history-incompatible')
            const initialization: NativeInitialization = fixedInitialization ?? Object.freeze({ schemaVersion: 1,
              prompts: prompts.resolveInitialPrompts(session.agentId),
              tools: Object.freeze(models.get(modelId)?.effectiveCapabilities?.tools === true ? availableTools : []),
              toolContractVersion: 'known-tools-v1' })
            const template = prompts.resolveTaskTemplate(session.agentId) ?? null
            const images = (input.images?.length ? await records.describeImages(session.id, input.images.map(image => image.assetId)) : [])
              .map(({ expiresAt: _expiresAt, ...image }) => Object.freeze(image))
            validateImageBatch(images)
            let fileContents: readonly FileContent[] = []
            if (input.files?.length) {
              const call = records.readFileSnapshots(session.id, input.files.map(file => file.snapshotId), controller.signal)
              try { fileContents = await call.result } finally { await call.done }
            }
            const files = fileContents.map(({ file: { expiresAt: _expiry, ...file } }) => Object.freeze(file))
            const nativeInput: NativeRunInput = Object.freeze({ schemaVersion: 3, raw: input.input,
              text: template ? template.content.replace('{{input}}', () => input.input) : input.input, images: Object.freeze(images), files: Object.freeze(files), template })
            const id = inputs.newId()
            let program: PreparedRunProgram
            try { program = await protocols.prepare({ runId: id, sessionId: session.id, modelId, signal: controller.signal, initialization, input: nativeInput, fileContents, ...(history ? { history } : {}) }) }
            catch (error) { if (error instanceof Error && 'code' in error && String(error.code).startsWith('history-')) throw error; throw normalizeModelFailure(error) }
            let transferred = false
            untransferred.set(id, controller)
            const closeUntransferred = async () => {
              const report = await program.close()
              if (report.cleanup !== 'completed') { const failure = modelFailure('cleanup-failure'); cleanupFailures.push(failure); throw failure }
              return report
            }
            try {
              ensureOpen()
              if (controller.signal.aborted || program.signal.aborted) throw modelFailure('dependency-unavailable')
              const handoff = Promise.resolve().then(async () => {
                const accepted = await records.registerRun(id, input, inputs.now(), [...initialization.prompts, ...(template ? [template] : [])], program.modelSnapshot,
                  { binding: program.binding, initialization: program.initialization, input: program.input, parentContextRef: history?.contextRef ?? null })
                if (!accepted.created) return accepted.run
                owned.add(id)
                try {
                  if (!accepting || controller.signal.aborted || program.signal.aborted) {
                    const report = await closeUntransferred()
                    return records.settleRun(id, { ...(isHarnessClosing() || controller.signal.aborted ? { kind: 'cancelled' as const }
                      : { kind: 'failed' as const, category: 'dependency-unavailable' as const, error: 'model dependency is unavailable' }), records: report.records }, inputs.now())
                  }
                  let started: Promise<Run>
                  try {
                    started = runtime.start({ runId: id, program })
                    transferred = true
                    untransferred.delete(id)
                  } catch {
                    const report = await closeUntransferred()
                    return records.settleRun(id, { kind: 'failed', category: 'dependency-unavailable', error: 'model dependency is unavailable', records: report.records }, inputs.now())
                  }
                  return await started
                } finally { void runtime.wait(id).finally(() => { owned.delete(id) }).catch(() => {}) }
              })
              handoffs.set(id, handoff)
              try { return await handoff } finally { handoffs.delete(id) }
            } finally {
              try {
                if (!transferred) {
                  try { await closeUntransferred() }
                  catch {
                    const failure = modelFailure('cleanup-failure')
                    const accepted = await records.getRun(id)
                    if (accepted) await records.settleRun(id, { kind: 'cleanup-failed', category: failure.category, error: failure.message }, inputs.now())
                    throw failure
                  } finally { program.release() }
                }
              } finally { untransferred.delete(id) }
            }
          })
          requests.set(key, { input, result }); admissions.add(result)
          void result.finally(() => { requests.delete(key); admissions.delete(result); opening.delete(controller) }).catch(() => {})
          return result
        },
        async cancelRun(id) {
          const opening = untransferred.get(id)
          if (opening) { opening.abort(); return records.requestCancellation(id, inputs.now()) }
          await runtime.cancel(id, 'user-requested')
          return records.getRun(id)
        },
        async waitRun(id, signal) {
          signal?.throwIfAborted()
          const handoff = handoffs.get(id)
          if (handoff) await waitFor(handoff, signal)
          return runtime.wait(id, signal)
        },
        getView: id => runtime.getView(id),
      }
      ctx.provide(runServiceKey, service)
      ctx.provide(runAdmissionServiceKey, admission)
    },
  }
}

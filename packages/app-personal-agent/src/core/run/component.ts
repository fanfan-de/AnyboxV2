import { environmentManagerKey, planToolAccess, managedModelTools } from '../tool-environments/access.js'
import { assertRunGrants } from '@anybox/execution-environments/bindings'
import { environmentError, type ExecutionEnvironmentManager } from '@anybox/execution-environments'
import { modelsSettingsServiceKey, nativeSearchTool, type ModelsSettingsService } from '@anybox/models'
import type { FileContent } from '../project-files/domain.js'
import { isDeepStrictEqual } from 'node:util'
import type { Component } from '@nya/core'
import type { JsonValue, ModelsService, NativeContinuation } from '@anybox/models'
import { modelsServiceKey } from '@anybox/models'
import type { RuntimeInputs } from '../contracts.js'
import { agentDirectoryServiceKey } from '../agent/directory-component.js'
import type { AgentDirectoryPort } from '../agent/directory-component.js'
import { agentPrompt } from '../agent/domain.js'
import { modelFailure, normalizeModelFailure } from './model.js'
import { validateToolSelection } from '../tool/catalog.js'
import { createComputerRunPreparation } from '../tool-environments/computer.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { validateRunInput, sameRunInput } from './domain.js'
import { validateImageBatch } from '../image/limits.js'
import { treeError } from '../session/domain.js'
import { addHistoryUsage, historyImagesFit, nativeHistoryUsage } from '../session/continuous-history.js'
import type { HistoryUsage } from '../session/continuous-history.js'
import type { Run, RunInput } from './domain.js'
import { runRuntimeServiceKey } from './runtime-component.js'
import type { RunRuntimePort, RunCancelReason } from './runtime-component.js'
import { protocolAgentServiceKey, runResumeCheckpoint } from './program.js'
import type { ApplicationHistory, ProtocolAgentPort, PreparedRunProgram, NativeHistory, NativeInitialization, NativeRunInput, RunResumeRecord } from './program.js'
import { sessionServiceKey, sessionRunServiceKey } from '../session/port.js'
import type { ContinuousNativeHistoryScope, SessionPort, SessionRunPort } from '../session/port.js'
import { createWaiters } from './waiters.js'
import { computerOperationsServiceKey, type ComputerOperationsPort } from '../computer/operations-port.js'
import { unitAttachmentsServiceKey } from '../unit/port.js'
import type { UnitAttachmentsPort, RunUnitBindings } from '../unit/port.js'
import { isUnitError } from '../unit/domain.js'
import type { ToolEnvironmentAssembly } from '../tool-environments/port.js'

export const runServiceKey = 'personal-agent.runs'
export const runAdmissionServiceKey = 'personal-agent.run-admission'
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

interface CachedContinuation {
  readonly nodeId: string
  readonly contextRef: string
  readonly projectId: string
  readonly units?: RunUnitBindings
  readonly modelId: string
  readonly protocolId: string
  readonly initialization: NativeInitialization
  readonly usage: HistoryUsage
  readonly continuation: NativeContinuation
  readonly estimatedContinuationTokens: number
}
const maxCachedHeads = 16
const maxCachedBytes = 16 * 1024 * 1024
const emptyHistoryUsage: HistoryUsage = Object.freeze({ bytes: 0, images: 0, imageBytes: 0 })

/** Admission owns a prepared program until the Runtime synchronously accepts it. */
export function createRunComponent(inputs: RuntimeInputs, isHarnessServerClosing: () => boolean = () => false, closingSignal?: AbortSignal, assembly?: ToolEnvironmentAssembly): Component.Object<void, {
  [environmentManagerKey]: ExecutionEnvironmentManager
  [modelsSettingsServiceKey]: ModelsSettingsService
  [agentDirectoryServiceKey]: AgentDirectoryPort
  [sessionServiceKey]: SessionPort
  [sessionRunServiceKey]: SessionRunPort
  [modelsServiceKey]: ModelsService
  [protocolAgentServiceKey]: ProtocolAgentPort
  [runRuntimeServiceKey]: RunRuntimePort
  [projectServiceKey]: ProjectPort
  [computerOperationsServiceKey]: ComputerOperationsPort
  [unitAttachmentsServiceKey]: UnitAttachmentsPort
} & Readonly<Record<string, unknown>>> {
  const prepareRun = assembly?.prepareRun ?? createComputerRunPreparation()
  return {
    name: 'personal-agent-runs',
    inject: [agentDirectoryServiceKey, sessionServiceKey, sessionRunServiceKey, modelsServiceKey, protocolAgentServiceKey, runRuntimeServiceKey, projectServiceKey, computerOperationsServiceKey, unitAttachmentsServiceKey, ...(assembly ? [environmentManagerKey, modelsSettingsServiceKey, ...assembly.inject] : [])],
    apply(ctx, _config, deps) {
      const { catalog: environments, bindings } = assembly?.describe(deps) ?? {}
      const manager = bindings ? deps[environmentManagerKey] : undefined
      const sessions = deps[sessionServiceKey], records = deps[sessionRunServiceKey], agents = deps[agentDirectoryServiceKey]
      const models = deps[modelsServiceKey], protocols = deps[protocolAgentServiceKey], runtime = deps[runRuntimeServiceKey], projects = deps[projectServiceKey]
      const attachments = deps[unitAttachmentsServiceKey]
      const owned = new Set<string>(), admissions = new Set<Promise<unknown>>(), opening = new Set<AbortController>()
      const cleanupFailures: unknown[] = []
      const requests = new Map<string, { input: RunInput; result: Promise<Run> }>()
      const handoffs = new Map<string, Promise<Run>>()
      const untransferred = new Map<string, AbortController>()
      const continuationCache = new Map<string, CachedContinuation>()
      let cachedBytes = 0
      const forgetContinuation = (sessionId: string) => {
        const previous = continuationCache.get(sessionId)
        if (previous && continuationCache.delete(sessionId)) cachedBytes -= previous.usage.bytes
      }
      const rememberContinuation = (sessionId: string, entry: CachedContinuation) => {
        const bytes = entry.usage.bytes
        forgetContinuation(sessionId)
        if (bytes > maxCachedBytes) return
        continuationCache.set(sessionId, entry)
        cachedBytes += bytes
        while (continuationCache.size > maxCachedHeads || cachedBytes > maxCachedBytes) {
          const oldest = continuationCache.keys().next()
          if (oldest.done) return
          forgetContinuation(oldest.value)
        }
      }
      const waitFor = createWaiters<Run>()
      const waitForRecoveryReady = createWaiters<readonly Promise<unknown>[]>()
      let accepting = true, pauseCount = 0
      const resumeOne = async (candidate: RunResumeRecord): Promise<Run> => {
        const id = candidate.run.id, controller = new AbortController()
        opening.add(controller); owned.add(id)
        let program: PreparedRunProgram | undefined, transferred = false, resumed: RunResumeRecord | undefined
        try {
          resumed = await records.claimRunResume(id, candidate.state.runOwnerEpoch, inputs.now())
          if (resumed.initialization.schemaVersion !== 3 || resumed.initialization.toolEnvironments.environments.some(environment => environment.environmentId === 'computer')) {
            await deps[computerOperationsServiceKey].authorizeRun(id,resumed.state.runOwnerEpoch,controller.signal)
          }
          if (resumed.initialization.schemaVersion === 3) {
            if (!environments) throw modelFailure('dependency-unavailable')
            environments.validate(resumed.initialization.toolEnvironments)
          }
          // A revoked or re-scoped unit attachment never rebinds silently; the Run settles instead.
          if (resumed.run.units) await attachments.verify(resumed.run.units)
          if (resumed.state.conclusion && ['cleanup','settling'].includes(resumed.state.stage) || resumed.run.status === 'cancelling') {
            const snapshot = resumed.run.modelSnapshot, binding = resumed.run.protocolBinding, input = resumed.run.nativeInput
            if (snapshot?.schemaVersion !== 3 || !binding || !input) throw modelFailure('model-unavailable')
            const checkpoint = runResumeCheckpoint(resumed)
            program = { binding, modelSnapshot: snapshot, initialization: resumed.initialization, input, signal: controller.signal,
              async execute() { throw modelFailure('dependency-unavailable') },
              async close() { return { records: [], checkpoint, cleanup: 'completed' } }, release() {} }
          } else {
            if (manager && !resumed.access) throw environmentError('environment-target-unavailable', 409)
            if (manager && resumed.access) assertRunGrants(await manager.get(resumed.access.agentId), resumed.access)
            const { access, initialization } = resumed
            program = await protocols.prepareResume({resume: resumed, signal: controller.signal,
              managedTools: manager && access ? managedModelTools(manager, id, access, initialization, () => {
                if (initialization.schemaVersion === 3) bindings?.assertCurrentTargetedAccess(initialization.toolEnvironments.environments, access)
              }) : undefined})
          }
          if (!program) throw modelFailure('model-unavailable')
          const started = runtime.start({runId:id, program, resume:resumed, access:resumed.access}); transferred = true
          void runtime.wait(id).finally(() => owned.delete(id)).catch(() => {})
          return await started
        } catch (error) {
          if (program && !transferred) { try { await program.close() } finally { program.release() } }
          if (resumed && !transferred) {
            const snapshot = resumed.run.modelSnapshot, binding = resumed.run.protocolBinding, input = resumed.run.nativeInput
            if (snapshot?.schemaVersion === 3 && binding && input) {
              const failed: PreparedRunProgram = { binding,modelSnapshot:snapshot,initialization:resumed.initialization,input,signal:controller.signal,
                async execute() { return {kind:'failed',category:'dependency-unavailable',error:isUnitError(error) ? 'accepted Run is bound to a unit attachment that is no longer valid' : 'accepted Run cannot resume with the available protocol execution'} },
                async close() { return {records:[],checkpoint:runResumeCheckpoint(resumed!),cleanup:'completed'} }, release() {} }
              const started = runtime.start({runId:id,program:failed,resume:resumed}); transferred = true
              void runtime.wait(id).finally(() => owned.delete(id)).catch(() => {})
              return await started
            }
          }
          throw error
        } finally { opening.delete(controller); if (!transferred) owned.delete(id) }
      }
      // Initialization returns immediately; recovery is owned by the same admission/exit barriers as new Runs.
      const stoppedRecovery = new AbortController()
      const recoveryReady = Promise.resolve().then(async () => {
        const candidates = await records.listRunResumes()
        const tasks = candidates.map(candidate => {
          const task = resumeOne(candidate); handoffs.set(candidate.run.id,task)
          void task.finally(() => handoffs.delete(candidate.run.id)).catch(() => {})
          return task
        })
        const runIds = candidates.map(candidate => candidate.run.id)
        const stopped = await runtime.recoverStoppedScopes(runIds, stoppedRecovery.signal)
        return [stopped.done, deps[computerOperationsServiceKey].recoverCancelledRuns([...runIds, ...stopped.runIds]), ...tasks]
      })
      const recovery = recoveryReady.then(tasks => Promise.all(tasks)).then(() => {})
      admissions.add(recovery)
      void recovery.finally(() => admissions.delete(recovery)).catch(error => { cleanupFailures.push(error) })
      const stopPreparing = () => {
        stoppedRecovery.abort()
        for (const controller of opening) controller.abort()
      }
      ctx.effect(() => {
        closingSignal?.addEventListener('abort', stopPreparing)
        return () => { closingSignal?.removeEventListener('abort', stopPreparing) }
      }, 'observe host admission shutdown')
      ctx.effect(() => async () => {
        accepting = false
        continuationCache.clear()
        cachedBytes = 0
        stopPreparing()
        const reason: RunCancelReason = isHarnessServerClosing() ? 'owner-disposed' : 'dependency-unavailable'
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
      const ensureOpen = () => { if (!accepting || pauseCount > 0 || isHarnessServerClosing()) throw new Error('run service is closing') }
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
            if (!session.continuous || session.historyMode !== 'native-local-v1') throw treeError('legacy-session-readonly')
            if (session.archivedAt !== null) throw treeError('session-archived')
            if (!input.projectId) throw new TypeError('projectId is required for a continuous Session')
            if (session.headNodeId !== input.parentNodeId) throw treeError('history-position-changed')
            const project = await projects.requireAvailable(input.projectId, session.agentId)
            const agent = agents.get(session.agentId)
            if (!agent) throw new Error('agent is unavailable')
            let history: NativeHistory | undefined
            const modelId = agent.modelId ?? input.modelId ?? session.modelId
            if (!modelId) throw modelFailure('model-unavailable')
            const protocolId = protocols.protocolForModel(modelId)
            const model = models.get(modelId)
            if (!model) throw modelFailure('model-unavailable')
            try {
              if (session.toolEnvironments) {
                if (!environments) throw treeError('history-incompatible')
                environments.validate(session.toolEnvironments)
              } else validateToolSelection(session.toolSelection)
            } catch { throw treeError('history-incompatible') }
            const modelSupportsTools = model.effectiveCapabilities?.tools === true
            const { units, supports, prompts: toolPrompts } = await prepareRun({ project, session, modelSupportsTools }, attachments)
            const requestedInitialization: NativeInitialization = Object.freeze({
              ...(session.toolEnvironments ? { schemaVersion: 3 as const, toolContractVersion: 'tool-environments-v1' as const, toolEnvironments: session.toolEnvironments }
                : { schemaVersion: 2 as const, toolContractVersion: 'tool-library-v1' as const }),
              prompts: Object.freeze([agentPrompt(agent), ...(toolPrompts ?? [])]),
              tools: Object.freeze(modelSupportsTools ? session.toolSelection.tools.map(tool => tool.definition) : []),
              toolSelection: session.toolSelection })
            const availableModel = models.get(modelId)
            const parameters = availableModel?.parameters?.value
            const provider = session.environmentSelection?.environmentIds.includes('model-search') &&
              session.environmentSelection.toolIdsByEnvironment?.['model-search']?.includes('web_search') !== false && availableModel?.effectiveCapabilities?.webSearch &&
              Array.isArray(parameters?.tools) && parameters.tools.length > 0 ?
              deps[modelsSettingsServiceKey]?.configuredProviders?.().find(value => value.id === availableModel.providerId) : undefined
            const grants = manager && await manager.get(session.agentId)
            const approved = grants && bindings ? planToolAccess(bindings, grants, requestedInitialization, assembly?.runTargets(units),
              provider ? nativeSearchTool(provider) : undefined, false, supports) : undefined
            const initialization = approved?.initialization ?? requestedInitialization
            const access = approved?.access
            const images = (input.images?.length ? await records.describeImages(session.id, input.images.map(image => image.assetId)) : [])
              .map(({ expiresAt: _expiresAt, ...image }) => Object.freeze(image))
            validateImageBatch(images)
            let fileContents: readonly FileContent[] = []
            if (input.files?.length) {
              const call = records.readFileSnapshots(session.id, input.files.map(file => file.snapshotId), controller.signal)
              try { fileContents = await call.result } finally { await call.done }
              if (fileContents.some(({ file }) => file.projectId !== project.id)) throw treeError('invalid-history')
            }
            const files = fileContents.map(({ file: { expiresAt: _expiry, ...file } }) => Object.freeze(file))
            const nativeInput: NativeRunInput = Object.freeze({ schemaVersion: 3, raw: input.input,
              text: input.input, images: Object.freeze(images), files: Object.freeze(files), template: null })
            let applicationHistory: ApplicationHistory | undefined
            const historyScope: ContinuousNativeHistoryScope = { projectId: project.id, units }
            const parentNodeId = input.parentNodeId
            const candidate = parentNodeId !== null ? continuationCache.get(session.id) : undefined
            let cached = candidate && candidate.nodeId === parentNodeId && candidate.projectId === project.id &&
              candidate.modelId === modelId && candidate.protocolId === protocolId &&
              isDeepStrictEqual(candidate.units, units) && isDeepStrictEqual(candidate.initialization, initialization) ? candidate : undefined
            const id = inputs.newId()
            const preparation = { managedTools: manager && access ? managedModelTools(manager, id, access, initialization, () => {
              if (initialization.schemaVersion === 3) bindings?.assertCurrentTargetedAccess(initialization.toolEnvironments.environments, access)
            }) : undefined, runId: id, sessionId: session.id, modelId, signal: controller.signal,
              initialization, input: nativeInput, fileContents, continuous: true }
            const prepareFromRecords = async () => {
              if (parentNodeId !== null) {
                const saved = await records.loadNativeHistory(session.id, parentNodeId, historyScope)
                if (saved?.modelSnapshot.modelId === modelId && saved.binding.protocolId === protocolId &&
                  isDeepStrictEqual(saved.initialization, initialization)) history = saved
                else applicationHistory = await records.loadApplicationHistory(session.id, parentNodeId, historyScope)
              }
              return protocols.prepare({ ...preparation, history, applicationHistory }).catch(async error => {
                if (!history || parentNodeId === null ||
                  !(error instanceof Error && 'code' in error && error.code === 'history-incompatible')) throw error
                applicationHistory = await records.loadApplicationHistory(session.id, parentNodeId, historyScope)
                history = undefined
                return protocols.prepare({ ...preparation, applicationHistory })
              })
            }
            let program: PreparedRunProgram
            try {
              program = cached
                ? await protocols.prepare({ ...preparation, continuation: cached.continuation,
                    continuationInputTokens: cached.estimatedContinuationTokens }).catch(error => {
                    if (!(error instanceof Error && 'code' in error && error.code === 'history-incompatible')) throw error
                    if (continuationCache.get(session.id) === cached) forgetContinuation(session.id)
                    cached = undefined
                    return prepareFromRecords()
                  })
                : await prepareFromRecords()
            }
            catch (error) {
              if (error instanceof Error && 'code' in error && String(error.code).startsWith('history-')) throw error
              throw normalizeModelFailure(error)
            }
            const priorUsage = cached?.usage ?? history?.usage ?? applicationHistory?.usage ??
              (parentNodeId === null ? emptyHistoryUsage : undefined)
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
              if (priorUsage && !historyImagesFit(priorUsage, images)) throw modelFailure('request-too-large')
              const handoff = Promise.resolve().then(async () => {
                const accepted = await records.registerRun(id, input, inputs.now(), initialization.prompts, program.modelSnapshot,
                  { access, selectionVersion: session.environmentSelection?.version, grantRevision: grants?.revision,
                    binding: program.binding, initialization: program.initialization, input: program.input,
                    parentContextRef: cached?.contextRef ?? history?.contextRef ?? applicationHistory?.contextRef ?? null,
                    ...(applicationHistory ? { applicationPrefix: true } : {}), estimatedInputTokens: program.estimatedInputTokens, units })
                if (!accepted.created) return accepted.run
                owned.add(id)
                try {
                  if (!accepting || controller.signal.aborted || program.signal.aborted) {
                    const report = await closeUntransferred()
                    return records.settleRun(id, { ...(isHarnessServerClosing() || controller.signal.aborted ? { kind: 'cancelled' as const }
                      : { kind: 'failed' as const, category: 'dependency-unavailable' as const, error: 'model dependency is unavailable' }), records: report.records }, inputs.now())
                  }
                  let started: Promise<Run>
                  try {
                    started = runtime.start({ runId: id, program, access, ...(priorUsage ? {
                      async publishContinuation(settled, report) {
                        const nodeId = settled.resultNodeId, { continuation, estimatedContinuationTokens } = report
                        if (!accepting || !nodeId || !continuation || estimatedContinuationTokens === undefined) return
                        const contextRef = await records.getCompletedContextRef(session.id, nodeId, settled.id)
                        if (!accepting || !contextRef) return
                        const usage = addHistoryUsage(priorUsage, nativeHistoryUsage(report.records))
                        rememberContinuation(session.id, { nodeId, contextRef, projectId: project.id, units, modelId,
                          protocolId, initialization, usage, continuation, estimatedContinuationTokens })
                      },
                    } : {}) })
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
          await waitForRecoveryReady(recoveryReady, signal)
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

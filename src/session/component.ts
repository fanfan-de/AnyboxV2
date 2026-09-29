import type { Component } from '@nya/core'
import type { RuntimeInputs, OwnedCall } from '../contracts.js'
import { imageAssetsServiceKey, imageAssetError } from '../image/port.js'
import type { ImageAssetsPort } from '../image/port.js'
import type { AgentDefinition } from '../agent/domain.js'
import { nonEmpty } from '../validation.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort } from '../storage/port.js'
import { runChangedEvent } from '../run/notifications.js'
import { sessionServiceKey, sessionRunServiceKey } from './port.js'
import type { SessionPort, SessionRunPort } from './port.js'
import { openSqliteSessionRecords } from './sqlite-records.js'

/** One owner for every Session's conversation and execution records; execution resources stay in RunRuntime. */
export function createSessionComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[]): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [projectServiceKey]: ProjectPort
  [imageAssetsServiceKey]: ImageAssetsPort
}> {
  return {
    name: 'harness-sessions',
    inject: [localStorageServiceKey, projectServiceKey, imageAssetsServiceKey],
    async apply(ctx, _config, deps) {
      const projects = deps[projectServiceKey], images = deps[imageAssetsServiceKey]
      const records = await openSqliteSessionRecords(deps[localStorageServiceKey], inputs, async run => {
        const change = Object.freeze({ sessionId: run.sessionId, runId: run.id, revision: run.revision })
        try { await ctx.parallel(runChangedEvent, change) }
        catch { ctx.logger.warn('Run change notification failed after commit', change) }
      }, images)
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      const imageCalls = new Set<OwnedCall<unknown>>()
      const imageCall = <T>(sessionId: string, signal: AbortSignal | undefined,
        start: (signal: AbortSignal) => Promise<OwnedCall<T>>): OwnedCall<T> => {
        if (!accepting) throw new Error('session is closing')
        const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
        let cleanupFailed = false
        const result = Promise.resolve().then(async () => {
          combined.throwIfAborted()
          const session = await records.getSession(nonEmpty(sessionId, 'sessionId'))
          if (!session) throw new Error(`unknown session ${sessionId}`)
          if (session.historyMode !== 'native-local-v1') throw new Error('legacy-session-readonly')
          combined.throwIfAborted()
          const call = await start(combined)
          let cancellationRequested = false, valueFailed = false, valueError: unknown, value!: T
          const cancel = () => {
            if (cancellationRequested) return
            cancellationRequested = true
            try { call.cancel('session-image-cancelled') } catch { cleanupFailed = true }
          }
          combined.addEventListener('abort', cancel, { once: true })
          if (combined.aborted) cancel()
          try {
            // Failed done is an actual exit boundary even when a broken result never settles.
            // A result failure requests cancellation but still joins the provider's real exit.
            await Promise.all([
              call.result.then(result => { value = result }, error => { valueFailed = true; valueError = error; cancel() }),
              call.done.catch(() => { cleanupFailed = true; cancel(); throw imageAssetError('asset-cleanup-failed') }),
            ])
            if (cleanupFailed) throw imageAssetError('asset-cleanup-failed')
            if (valueFailed) throw valueError
            combined.throwIfAborted()
            return value
          } finally { combined.removeEventListener('abort', cancel) }
        })
        const done = result.then(() => {}, () => { if (cleanupFailed) throw imageAssetError('asset-cleanup-failed') }).finally(() => imageCalls.delete(handle))
        const handle: OwnedCall<T> = { result, done, cancel: reason => abort.abort(reason) }
        imageCalls.add(handle)
        void result.catch(() => {}); void done.catch(() => {})
        return handle
      }
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(new Error('session is closing'))
        const result = Promise.resolve().then(work)
        pending.add(result)
        void result.finally(() => pending.delete(result)).catch(() => {})
        return result
      }
      ctx.effect(() => async () => {
        accepting = false
        for (const call of imageCalls) call.cancel('session-closed')
        const exits = await Promise.allSettled([...imageCalls].map(call => call.done))
        await Promise.allSettled([...pending])
        const failures = exits.flatMap(exit => exit.status === 'rejected' ? [exit.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'image calls failed to exit')
      }, 'join session record operations')

      const sessions: SessionPort = {
        importImage: (sessionId, bytes, signal) => imageCall(sessionId, signal,
          async signal => images.importImage({ scopeId: sessionId, bytes }, signal)),
        getImage: (sessionId, assetId, signal) => imageCall(sessionId, signal, async signal => {
          const [image] = await images.describe(sessionId, [assetId])
          signal.throwIfAborted()
          const call = images.readImage(sessionId, assetId, signal)
          return { ...call, result: call.result.then(bytes => ({ image, bytes })) }
        }),
        renewImages: (sessionId, assetIds) => track(async () => {
          if (!await records.getSession(sessionId)) throw new Error(`unknown session ${sessionId}`)
          return images.renew(sessionId, assetIds)
        }),
        createSession(projectId, agentId, requestedModelId) {
          return track(async () => {
            const id = nonEmpty(agentId, 'agentId')
            const agent = agents.find(agent => agent.id === id)
            if (!agent) throw new Error(`unknown agent ${id}`)
            const modelId = requestedModelId === undefined ? agent.modelId ?? null : nonEmpty(requestedModelId, 'modelId')
            await projects.requireAvailable(nonEmpty(projectId, 'projectId'))
            return records.createSession(inputs.newId(), projectId, id, inputs.now(), modelId)
          })
        },
        selectSessionModel(sessionId, rawModelId, protocolId) {
          return track(async () => {
            const modelId = nonEmpty(rawModelId, 'modelId')
            return records.selectSessionModel(nonEmpty(sessionId, 'sessionId'), modelId, protocolId)
          })
        },
        getSession: id => track(() => records.getSession(id)),
        listSessions: projectId => track(async () => {
          if (!await projects.getProject(projectId)) throw new Error(`unknown project ${projectId}`)
          return records.listSessions(projectId)
        }),
        getNode: (sessionId, id) => track(() => records.getNode(sessionId, id)),
        getNodePath: (sessionId, id) => track(() => records.getNodePath(sessionId, id)),
        listNodes: (sessionId, id, query) => track(() => records.listNodes(sessionId, id, query)),
        getRun: id => track(() => records.getRun(id)),
        getRunByKey: (sessionId, key) => track(() => records.getRunByKey(sessionId, key)),
        listRuns: (sessionId, query) => track(() => records.listRuns(sessionId, query)),
        getRunEvents: (id, afterSeq) => track(() => records.getRunEvents(id, afterSeq)),
        getRunRecords: id => track(() => records.getRunRecords(id)),
      }
      const runs: SessionRunPort = {
        describeImages: (sessionId, assetIds) => track(() => images.describe(sessionId, assetIds)),
        findAcceptedRun: input => track(() => records.findAcceptedRun(input)),
        registerRun: (id, input, now, prompts, model, native) => track(() => records.registerRun(id, input, now, prompts, model, native)),
        loadNativeInitialization: sessionId => track(() => records.loadNativeInitialization(sessionId)),
        loadNativeHistory: (sessionId, parentNodeId) => track(() => records.loadNativeHistory(sessionId, parentNodeId)),
        startOperation: (id, operation, at) => track(() => records.startOperation(id, operation, at)),
        observeOperation: (id, operationId, observation, at) => track(() => records.observeOperation(id, operationId, observation, at)),
        loadRunContext: id => track(() => records.loadRunContext(id)),
        getRun: id => track(() => records.getRun(id)),
        getRunExecution: id => track(() => records.getRunExecution(id)),
        requestCancellation: (id, now) => track(() => records.requestCancellation(id, now)),
        settleRun: (id, outcome, now) => track(() => records.settleRun(id, outcome, now)),
      }
      ctx.provide(sessionServiceKey, sessions)
      ctx.provide(sessionRunServiceKey, runs)
    },
  }
}

import { projectFilesServiceKey } from '../project-files/port.js'
import type { ProjectFilesPort } from '../project-files/port.js'
import { fileError } from '../project-files/domain.js'
import { treeError, resolveSessionModel, type Session, type SessionDefaults } from './domain.js'
import type { Component } from '@nya/core'
import type { RuntimeInputs, OwnedCall } from '../contracts.js'
import { imageAssetsServiceKey, imageAssetError } from '../image/port.js'
import type { ImageAssetsPort } from '../image/port.js'
import type { AgentDefinition } from '../agent/domain.js'
import { nonEmpty } from '../validation.js'
import { createToolSelection } from '../tool/catalog.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort } from '../../../../storage/port.js'
import { runChangedEvent } from '../run/notifications.js'
import { sessionServiceKey, sessionRunServiceKey } from './port.js'
import type { SessionPort, SessionRunPort } from './port.js'
import { openSqliteSessionRecords } from './sqlite-records.js'
import { computerOperationsServiceKey } from '../computer/operations-port.js'
import type { ComputerOperationsPort } from '../computer/operations-port.js'

/** One owner for every Session's conversation and execution records; execution resources stay in RunRuntime. */
export function createSessionComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[]): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [projectServiceKey]: ProjectPort
  [imageAssetsServiceKey]: ImageAssetsPort
  [projectFilesServiceKey]: ProjectFilesPort
  [computerOperationsServiceKey]: ComputerOperationsPort
}> {
  return {
    name: 'harness-sessions',
    inject: [localStorageServiceKey, projectServiceKey, imageAssetsServiceKey, projectFilesServiceKey, computerOperationsServiceKey],
    async apply(ctx, _config, deps) {
      const projects = deps[projectServiceKey], images = deps[imageAssetsServiceKey], files = deps[projectFilesServiceKey]
      const records = await openSqliteSessionRecords(deps[localStorageServiceKey], inputs, async run => {
        const change = Object.freeze({ sessionId: run.sessionId, runId: run.id, revision: run.revision })
        try { await ctx.parallel(runChangedEvent, change) }
        catch { ctx.logger.warn('Run change notification failed after commit', change) }
      }, images, files, deps[computerOperationsServiceKey])
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      const resourceCalls = new Set<OwnedCall<unknown>>()
      const treeCursors = new Map<string, { scope: string; owner: string }>()
      const stopTreeRetirement = files.onTreeRetired(id => treeCursors.delete(id))
      const resourceCall = <T>(sessionId: string, signal: AbortSignal | undefined,
        start: (signal: AbortSignal, session: Session) => Promise<OwnedCall<T>>, kind: 'image' | 'file' = 'image', writable = false,
        access: 'native' | 'project-read' = 'native'): OwnedCall<T> => {
        if (!accepting) throw new Error('session is closing')
        const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
        let cleanupFailed = false
        const result = Promise.resolve().then(async () => {
          combined.throwIfAborted()
          const session = await records.getSession(nonEmpty(sessionId, 'sessionId'))
          if (!session) throw new Error(`unknown session ${sessionId}`)
          if (writable && session.archivedAt !== null) throw treeError('session-archived')
          if (session.historyMode !== 'native-local-v1' && (access !== 'project-read' || writable)) throw treeError('legacy-session-readonly')
          combined.throwIfAborted()
          const call = await start(combined, session)
          let cancellationRequested = false, valueFailed = false, valueError: unknown, value!: T
          const cancel = () => {
            if (cancellationRequested) return
            cancellationRequested = true
            try { call.cancel(kind === 'file' ? 'session-file-cancelled' : 'session-image-cancelled') } catch { cleanupFailed = true }
          }
          combined.addEventListener('abort', cancel, { once: true })
          if (combined.aborted) cancel()
          try {
            // Failed done is an actual exit boundary even when a broken result never settles.
            // A result failure requests cancellation but still joins the provider's real exit.
            await Promise.all([
              call.result.then(result => { value = result }, error => { valueFailed = true; valueError = error; cancel() }),
              call.done.catch(() => { cleanupFailed = true; cancel(); throw kind === 'file' ? fileError('file-cleanup-failed') : imageAssetError('asset-cleanup-failed') }),
            ])
            if (cleanupFailed) throw kind === 'file' ? fileError('file-cleanup-failed') : imageAssetError('asset-cleanup-failed')
            if (valueFailed) throw valueError
            combined.throwIfAborted()
            return value
          } finally { combined.removeEventListener('abort', cancel) }
        })
        const done = result.then(() => {}, () => { if (cleanupFailed) throw kind === 'file' ? fileError('file-cleanup-failed') : imageAssetError('asset-cleanup-failed') }).finally(() => resourceCalls.delete(handle))
        const handle: OwnedCall<T> = { result, done, cancel: reason => abort.abort(reason) }
        resourceCalls.add(handle)
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
      const requireAgent = (rawId: string) => {
        const id = nonEmpty(rawId, 'agentId')
        const agent = agents.find(agent => agent.id === id)
        if (!agent) throw new Error(`unknown agent ${id}`)
        return agent
      }
      const withFallback = (saved: Pick<SessionDefaults, 'agentId' | 'modelId' | 'revision'>, agent: AgentDefinition): SessionDefaults => {
        const fallbackModelId = agent.modelId ?? null
        return Object.freeze({ ...saved, fallbackModelId, effectiveModelId: resolveSessionModel(undefined, saved.modelId, fallbackModelId) })
      }
      ctx.effect(() => async () => {
        accepting = false
        for (const call of resourceCalls) call.cancel('session-closed')
        const exits = await Promise.allSettled([...resourceCalls].map(call => call.done))
        // A cancelled open can publish its cursor while its actual exit is being joined.
        const treeExits = await Promise.allSettled([...treeCursors].map(([id, cursor]) => files.closeTree(cursor.scope, cursor.owner, id)))
        await Promise.allSettled([...pending])
        stopTreeRetirement()
        const failures = [...exits, ...treeExits].flatMap(exit => exit.status === 'rejected' ? [exit.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'session resource calls failed to exit')
      }, 'join session record operations')

      const sessions: SessionPort = {
        openProjectFileTree: (id, path, owner, signal) => resourceCall(id, signal, async (signal, session) => {
          const call = files.openTree(id, session.projectId, path, owner, signal)
          return { ...call, result: call.result.then(page => {
            if (page.nextPage !== null) treeCursors.set(page.cursorId, { scope: id, owner })
            return page
          }) }
        }, 'file', false, 'project-read'),
        readProjectFileTreePage: (id, owner, cursorId, page, signal) => resourceCall(id, signal,
          async signal => files.readTreePage(id, owner, cursorId, page, signal), 'file', false, 'project-read'),
        // Close retains the captured provider generation and remains valid after Session shutdown.
        closeProjectFileTree: (id, owner, cursorId) => files.closeTree(id, owner, cursorId),
        onProjectFileTreeRetired: listener => files.onTreeRetired(listener),
        searchProjectFiles: (id, query, signal) => resourceCall(id, signal, async (signal, session) => files.search(session.projectId, query, signal), 'file', false, 'project-read'),
        previewProjectFile: (id, selection, signal) => resourceCall(id, signal, async (signal, session) => files.preview(session.projectId, selection, signal), 'file', false, 'project-read'),
        prepareProjectFiles: (id, key, selections, signal) => resourceCall(id, signal, async (signal, session) => files.prepare(id, session.projectId, key, selections, signal), 'file', true),
        getFileSnapshot: (id, snapshotId, signal) => resourceCall(id, signal, async signal => {
          const call = files.read(id, [snapshotId], signal)
          return { ...call, result: call.result.then(values => values[0]) }
        }, 'file'),
        renewProjectFiles: (id, ids) => track(async () => {
          if (!await records.getSession(id)) throw new Error(`unknown session ${id}`)
          return files.renew(id, ids)
        }),
        importImage: (sessionId, bytes, signal) => resourceCall(sessionId, signal,
          async signal => images.importImage({ scopeId: sessionId, bytes }, signal), 'image', true),
        getImage: (sessionId, assetId, signal) => resourceCall(sessionId, signal, async signal => {
          const [image] = await images.describe(sessionId, [assetId])
          signal.throwIfAborted()
          const call = images.readImage(sessionId, assetId, signal)
          return { ...call, result: call.result.then(bytes => ({ image, bytes })) }
        }),
        renewImages: (sessionId, assetIds) => track(async () => {
          if (!await records.getSession(sessionId)) throw new Error(`unknown session ${sessionId}`)
          return images.renew(sessionId, assetIds)
        }),
        getSessionDefaults: agentId => track(async () => {
          const agent = requireAgent(agentId)
          return withFallback(await records.getSessionDefaults(agent.id), agent)
        }),
        setSessionDefaults: (agentId, requestedModelId, expectedRevision) => track(async () => {
          const agent = requireAgent(agentId)
          const modelId = requestedModelId === null ? null : nonEmpty(requestedModelId, 'modelId')
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative safe integer')
          return withFallback(await records.setSessionDefaults(agent.id, modelId, expectedRevision), agent)
        }),
        getAgentTools: agentId => track(() => records.getAgentTools(requireAgent(agentId).id)),
        setAgentTools: (agentId, input) => track(() => {
          const agent = requireAgent(agentId)
          if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative safe integer')
          const selection = createToolSelection(input.toolIds)
          return records.setAgentTools(agent.id, { toolIds: selection.tools.map(tool => tool.toolId), expectedRevision: input.expectedRevision })
        }),
        createSession(projectId, agentId, requestedModelId) {
          return track(async () => {
            const agent = requireAgent(agentId)
            const modelId = requestedModelId === undefined ? undefined : nonEmpty(requestedModelId, 'modelId')
            await projects.requireAvailable(nonEmpty(projectId, 'projectId'))
            return records.createSession(inputs.newId(), projectId, agent.id, inputs.now(), modelId, agent.modelId ?? null)
          })
        },
        selectSessionModel(sessionId, rawModelId, protocolId) {
          return track(async () => {
            const modelId = nonEmpty(rawModelId, 'modelId')
            return records.selectSessionModel(nonEmpty(sessionId, 'sessionId'), modelId, protocolId)
          })
        },
        archiveSession: id => track(() => records.archiveSession(nonEmpty(id, 'sessionId'))),
        restoreSession: id => track(() => records.restoreSession(nonEmpty(id, 'sessionId'))),
        listArchivedSessions: () => track(() => records.listArchivedSessions()),
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
        readFileSnapshots: (id, ids, signal) => resourceCall(id, signal, async signal => files.read(id, ids, signal), 'file'),
        describeImages: (sessionId, assetIds) => track(() => images.describe(sessionId, assetIds)),
        findAcceptedRun: input => track(() => records.findAcceptedRun(input)),
        registerRun: (id, input, now, prompts, model, native) => track(() => records.registerRun(id, input, now, prompts, model, native)),
        loadNativeInitialization: sessionId => track(() => records.loadNativeInitialization(sessionId)),
        loadNativeHistory: (sessionId, parentNodeId) => track(() => records.loadNativeHistory(sessionId, parentNodeId)),
        loadRunResume: id => track(() => records.loadRunResume(id)),
        listRunResumes: () => track(() => records.listRunResumes()),
        claimRunResume: (id, epoch, at) => track(() => records.claimRunResume(id, epoch, at)),
        saveRunResume: (id, epoch, patch, at) => track(() => records.saveRunResume(id, epoch, patch, at)),
        getRunOperation: (runId, id) => track(() => records.getRunOperation(runId, id)),
        startOperation: (id, operation, at, epoch) => track(() => records.startOperation(id, operation, at, epoch)),
        observeOperation: (id, operationId, observation, at, epoch) => track(() => records.observeOperation(id, operationId, observation, at, epoch)),
        loadRunContext: id => track(() => records.loadRunContext(id)),
        getRun: id => track(() => records.getRun(id)),
        getRunExecution: id => track(() => records.getRunExecution(id)),
        requestCancellation: (id, now) => track(() => records.requestCancellation(id, now)),
        settleRun: (id, outcome, now, epoch) => track(() => records.settleRun(id, outcome, now, epoch)),
      }
      ctx.provide(sessionServiceKey, sessions)
      ctx.provide(sessionRunServiceKey, runs)
    },
  }
}

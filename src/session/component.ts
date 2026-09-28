import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
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

/** One owner for every Session's conversation and execution records; execution resources stay in AgentLoop. */
export function createSessionComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[]): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-sessions',
    inject: [localStorageServiceKey, projectServiceKey],
    async apply(ctx, _config, deps) {
      const projects = deps[projectServiceKey]
      const records = await openSqliteSessionRecords(deps[localStorageServiceKey], inputs, async run => {
        const change = Object.freeze({ sessionId: run.sessionId, runId: run.id, revision: run.revision })
        try { await ctx.parallel(runChangedEvent, change) }
        catch { ctx.logger.warn('Run change notification failed after commit', change) }
      })
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(new Error('session is closing'))
        const result = Promise.resolve().then(work)
        pending.add(result)
        void result.finally(() => pending.delete(result)).catch(() => {})
        return result
      }
      ctx.effect(() => async () => {
        accepting = false
        await Promise.allSettled([...pending])
      }, 'join session record operations')

      const sessions: SessionPort = {
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
        selectSessionModel(sessionId, rawModelId) {
          return track(async () => {
            const modelId = nonEmpty(rawModelId, 'modelId')
            return records.selectSessionModel(nonEmpty(sessionId, 'sessionId'), modelId)
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
      }
      const runs: SessionRunPort = {
        findAcceptedRun: input => track(() => records.findAcceptedRun(input)),
        registerRun: (id, input, now, prompts, model) => track(() => records.registerRun(id, input, now, prompts, model)),
        loadRunContext: id => track(() => records.loadRunContext(id)),
        getRun: id => track(() => records.getRun(id)),
        getRunExecution: id => track(() => records.getRunExecution(id)),
        recordRunEvent: (id, event, at) => track(() => records.recordRunEvent(id, event, at)),
        requestCancellation: (id, now) => track(() => records.requestCancellation(id, now)),
        settleRun: (id, outcome, now) => track(() => records.settleRun(id, outcome, now)),
      }
      ctx.provide(sessionServiceKey, sessions)
      ctx.provide(sessionRunServiceKey, runs)
    },
  }
}

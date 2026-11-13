import { randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import { failure } from '@anybox/application-api/node'
import type { ActivityLease, ProductActivityPort } from '@anybox/application-api/contracts'
import type { ModelsService } from '@anybox/models'
import type { LocalStoragePort } from '@anybox/storage-sqlite'
import type { Agent, Artifact, PersonalAgentAdmissionPort, PersonalAgentPort, Run, Work, WorkStatus } from '../contracts.js'
import { personalAgentAdmissionServiceKey, personalAgentServiceKey } from '../contracts.js'
import { agentConfiguration, identifier, modelFailureCode, runContext, sameRevision, text } from './domain.js'
import { all, get, personalAgentMigrations, preferred, putAgent, putArtifact, putPreferred, putRun, putWork } from './storage.js'

export { personalAgentAdmissionServiceKey } from '../contracts.js'
export type { PersonalAgentAdmissionPort } from '../contracts.js'
export interface PersonalAgentCoreOptions { now?: () => string; newId?: () => string }
interface RunOwner {
  controller: AbortController
  done: Promise<void>
  finish(): void
  runId: string
  lease?: ActivityLease
}
type Dependencies = { 'local-storage': LocalStoragePort; models: ModelsService; 'app.activity': ProductActivityPort }

/** Owns one application's persisted workspace and admitted model work on the application root. */
export function createPersonalAgentComponent(options: PersonalAgentCoreOptions = {}): Component.Object<void, Dependencies> {
  const now = options.now ?? (() => new Date().toISOString()), newId = options.newId ?? randomUUID
  return {
    name: 'personal-agent-workspace', inject: ['local-storage', 'models', 'app.activity'],
    async apply(ctx, _configuration, deps) {
      const storage = deps['local-storage'], models = deps.models, activity = deps['app.activity']
      let accepting = true, pauseCount = 0, cleanupFailed = false
      const writes = new Set<Promise<unknown>>(), owners = new Map<string, RunOwner>()
      const requireOpen = () => { if (!accepting || pauseCount || cleanupFailed) throw failure(503, 'application-unavailable') }
      const admission: PersonalAgentAdmissionPort = {
        closeAdmission() { accepting = false },
        busy: () => writes.size > 0 || owners.size > 0 || cleanupFailed,
        pauseIfIdle() {
          if (admission.busy()) return undefined
          pauseCount++
          let released = false
          return () => { if (!released) { released = true; pauseCount-- } }
        },
      }
      const mutate = <Value>(work: () => Promise<Value>): Promise<Value> => {
        try { requireOpen() } catch (error) { return Promise.reject(error) }
        let lease: ActivityLease
        try { lease = activity.enter('personal-agent') } catch (error) { return Promise.reject(error) }
        const promise = Promise.resolve().then(work)
        writes.add(promise)
        void promise.finally(() => { writes.delete(promise); lease.release() }).catch(() => {})
        return promise
      }
      const assertIdle = (id: string) => { if (owners.has(id)) throw failure(409, 'work-busy') }
      const updatedWork = (work: Work, changes: Partial<Work>): Work => ({ ...work, ...changes, revision: work.revision + 1, updatedAt: now() })
      await storage.migrate('personal-agent', personalAgentMigrations)
      await storage.transaction(tx => {
        for (const run of all<Run>(tx, 'runs')) if (run.status === 'running') {
          putRun(tx, { ...run, status: 'interrupted', error: 'interrupted', finishedAt: now() })
          const work = get<Work>(tx, 'works', run.workId)
          putWork(tx, updatedWork(work, { status: 'waiting', waitReason: 'interrupted' }))
        }
        if (!all<Agent>(tx, 'agents').length) {
          const timestamp = now(), agent: Agent = { id: newId(), revision: 1, name: '我的 Agent', description: '', systemPrompt: '清晰、诚实地回答用户，帮助澄清目标并形成可用的成果。', memory: '', skills: '', modelId: null, contextLimit: 48000, createdAt: timestamp, updatedAt: timestamp }
          putAgent(tx, agent); putPreferred(tx, agent.id)
        }
      })
      ctx.effect(() => activity.registerGuard('personal-agent', () => admission.pauseIfIdle()), 'unregister Personal Agent stop protection')
      ctx.effect(() => async () => {
        accepting = false
        for (const owner of owners.values()) owner.controller.abort()
        await Promise.allSettled([...writes])
        const remaining = [...owners.values()]
        for (const owner of remaining) owner.controller.abort()
        await Promise.all(remaining.map(owner => owner.done))
        if (cleanupFailed) throw failure(500, 'cleanup-failure')
      }, 'close Personal Agent admission and join model work and writes')

      const execute = async (run: Run, owner: RunOwner): Promise<void> => {
        let status: Run['status'] = 'failed', output = '', error: string | null = null, modelRevision: number | null = null, protocolId: string | null = null
        try {
          const operation = models.generateText({ modelId: run.agent.modelId!, instruction: run.instruction, input: run.context, signal: owner.controller.signal })
          const [result, exit] = await Promise.allSettled([operation.result, operation.done])
          if (result.status === 'fulfilled') { output = result.value.text; modelRevision = result.value.modelRevision; protocolId = result.value.protocolId }
          if (exit.status === 'rejected' || result.status === 'rejected' && modelFailureCode(result.reason) === 'cleanup-failure') {
            cleanupFailed = true; error = 'cleanup-failure'
          } else if (owner.controller.signal.aborted || result.status === 'rejected' && modelFailureCode(result.reason) === 'cancelled') {
            status = 'cancelled'; error = 'cancelled'
          } else if (result.status === 'fulfilled') status = 'succeeded'
          else error = modelFailureCode(result.reason)
        } catch (caught) { error = modelFailureCode(caught); if (error === 'cleanup-failure') cleanupFailed = true }
        try {
          await storage.transaction(tx => {
            const previous = get<Run>(tx, 'runs', run.id)
            putRun(tx, { ...previous, status, output, error, modelRevision, protocolId, finishedAt: now() })
            const work = get<Work>(tx, 'works', run.workId)
            putWork(tx, updatedWork(work, { status: status === 'succeeded' ? 'open' : 'waiting', waitReason: error ?? '' }))
          })
        } catch { cleanupFailed = true }
        finally { owners.delete(run.workId); owner.lease?.release(); owner.finish() }
      }

      const service: PersonalAgentPort = {
        state: () => storage.read(reader => ({ agents: all<Agent>(reader, 'agents'), works: all<Work>(reader, 'works'), preferredAgentId: preferred(reader) })),
        detail(id) {
          identifier(id)
          return storage.read(reader => ({ work: get<Work>(reader, 'works', id), runs: all<Run>(reader, 'runs', 'work_id', id), artifacts: all<Artifact>(reader, 'artifacts', 'work_id', id), delegations: all<Work>(reader, 'works', 'source_work_id', id) }))
        },
        saveAgent(input) {
          return mutate(() => {
            const configuration = agentConfiguration(input)
            return storage.transaction(tx => {
              if (input.id !== undefined) {
                const previous = get<Agent>(tx, 'agents', identifier(input.id)); sameRevision(previous.revision, input.expectedRevision)
                const agent: Agent = { ...previous, ...configuration, revision: previous.revision + 1, updatedAt: now() }
                putAgent(tx, agent); return agent
              }
              const timestamp = now(), agent: Agent = { ...configuration, id: newId(), revision: 1, createdAt: timestamp, updatedAt: timestamp }
              putAgent(tx, agent); return agent
            })
          })
        },
        preferAgent(agentId) {
          return mutate(() => storage.transaction(tx => { get<Agent>(tx, 'agents', identifier(agentId)); putPreferred(tx, agentId) }))
        },
        createWork(input) {
          return mutate(() => {
            if (!['conversation', 'task'].includes(input.kind)) throw failure(400, 'invalid-input')
            const title = text(input.title, 200, true), goal = text(input.goal, 131072, input.kind === 'task')
            return storage.transaction(tx => {
              get<Agent>(tx, 'agents', identifier(input.agentId))
              const timestamp = now(), work: Work = { id: newId(), agentId: input.agentId, kind: input.kind, title, goal, status: 'open', waitReason: '', progress: '', contextSegment: 1, sourceWorkId: null, createdAt: timestamp, updatedAt: timestamp, revision: 1 }
              putWork(tx, work); return work
            })
          })
        },
        updateWork(id, input) {
          return mutate(() => {
            identifier(id); assertIdle(id)
            if (input.status !== undefined && !(['open', 'waiting', 'completed', 'cancelled'] satisfies Exclude<WorkStatus, 'running'>[]).includes(input.status)) throw failure(400, 'invalid-input')
            const changes: Partial<Work> = {}
            if (input.status !== undefined) changes.status = input.status
            if (input.waitReason !== undefined) changes.waitReason = text(input.waitReason, 2000)
            else if (input.status !== undefined && input.status !== 'waiting') changes.waitReason = ''
            if (input.progress !== undefined) changes.progress = text(input.progress, 131072)
            return storage.transaction(tx => { const previous = get<Work>(tx, 'works', id); sameRevision(previous.revision, input.expectedRevision); const work = updatedWork(previous, changes); putWork(tx, work); return work })
          })
        },
        startRun(id, input) {
          return mutate(async () => {
            identifier(id); const message = text(input.input, 262144, true); assertIdle(id)
            let finish!: () => void
            const owner: RunOwner = { controller: new AbortController(), done: new Promise<void>(resolve => { finish = resolve }), finish: () => finish(), runId: newId() }
            owners.set(id, owner)
            let transferred = false
            try {
              const run = await storage.transaction(tx => {
                const work = get<Work>(tx, 'works', id); sameRevision(work.revision, input.expectedRevision)
                if (work.status === 'completed' || work.status === 'cancelled') throw failure(409, 'work-closed')
                const agent = get<Agent>(tx, 'agents', work.agentId)
                if (!agent.modelId) throw failure(409, 'model-required')
                const context = runContext(agent, work, all<Run>(tx, 'runs', 'work_id', id), message)
                if (!context.fits) { putWork(tx, updatedWork(work, { status: 'waiting', waitReason: 'context-capacity' })); return undefined }
                const record: Run = { id: owner.runId, workId: id, status: 'running', contextSegment: work.contextSegment, agent, input: message, instruction: context.instruction, context: context.context, output: '', error: null, modelRevision: null, protocolId: null, createdAt: now(), finishedAt: null }
                putRun(tx, record); putWork(tx, updatedWork(work, { status: 'running', waitReason: '' })); return record
              })
              if (!run) throw failure(409, 'context-capacity')
              owner.lease = activity.enter('personal-agent')
              transferred = true
              void execute(run, owner)
              return run
            } finally {
              if (!transferred) { owners.delete(id); owner.lease?.release(); owner.finish() }
            }
          })
        },
        cancelRun(workId, runId) {
          return mutate(async () => {
            identifier(workId); identifier(runId)
            const current = await storage.read(reader => { const run = get<Run>(reader, 'runs', runId); if (run.workId !== workId) throw failure(404, 'not-found'); return run })
            const owner = owners.get(workId)
            if (owner?.runId === runId) { owner.controller.abort(); await owner.done }
            else if (current.status === 'running') throw failure(409, 'run-unavailable')
            return storage.read(reader => get<Run>(reader, 'runs', runId))
          })
        },
        newContext(id, expectedRevision) {
          return mutate(() => { identifier(id); assertIdle(id); return storage.transaction(tx => {
            const previous = get<Work>(tx, 'works', id); sameRevision(previous.revision, expectedRevision)
            if (previous.status === 'completed' || previous.status === 'cancelled') throw failure(409, 'work-closed')
            const work = updatedWork(previous, { contextSegment: previous.contextSegment + 1, status: 'open', waitReason: '' }); putWork(tx, work); return work
          }) })
        },
        delegate(id, input) {
          return mutate(() => {
            identifier(id); const title = text(input.title, 200, true), goal = text(input.goal, 131072, true)
            return storage.transaction(tx => {
              get<Work>(tx, 'works', id); get<Agent>(tx, 'agents', identifier(input.agentId))
              const timestamp = now(), delegated: Work = { id: newId(), agentId: input.agentId, kind: 'task', title, goal, status: 'open', waitReason: '', progress: '', contextSegment: 1, sourceWorkId: id, createdAt: timestamp, updatedAt: timestamp, revision: 1 }
              putWork(tx, delegated); return delegated
            })
          })
        },
        saveArtifact(id, input) {
          return mutate(() => {
            identifier(id); const title = text(input.title, 200, true), content = text(input.content, 524288, true)
            return storage.transaction(tx => {
              get<Work>(tx, 'works', id)
              if (input.runId !== undefined && get<Run>(tx, 'runs', identifier(input.runId)).workId !== id) throw failure(404, 'not-found')
              const artifact: Artifact = { id: newId(), workId: id, runId: input.runId ?? null, title, content, createdAt: now() }
              putArtifact(tx, artifact); return artifact
            })
          })
        },
      }
      ctx.provide(personalAgentServiceKey, service)
      ctx.provide(personalAgentAdmissionServiceKey, admission)
    },
  }
}

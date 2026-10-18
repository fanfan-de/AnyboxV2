import { claudeAgentError, idempotencyKeyPattern } from '../domain.js'
import type { ClaudeAgentClock } from '../domain.js'
import type { ClaudeAgentSdkPort, SdkRunHandle, SdkRunHooks, SdkRunRequest } from '../sdk/port.js'
import type { ClaudeAgentStorePort, ThreadRecord } from '../store/component.js'
import type { CapabilitiesView, HistoryMessageView, ThreadView } from '../view.js'
import { boundedName, defaultSessionOptions, elicitationAnswer, exact, validateSessionOptions } from '../workspace.js'
import type { Checkpoint, ContextUsage, ElicitationAnswer, ElicitationView, FilePreview, RewindPreview, SessionInspection, SessionOptions } from '../workspace.js'
import { mergeSessionPermissions } from '../permissions.js'

export interface ConnectionJob { readonly id: string; readonly threadId: string; readonly status: 'running' | 'completed' | 'failed' | 'cancelled'; readonly result: CapabilitiesView | null; readonly error: string | null }
export interface ClaudeAgentWorkspacePort {
  updateOptions(threadId: string, input: unknown): Promise<ThreadView>
  contextUsage(threadId: string, signal?: AbortSignal, detail?: 'summary'|'full'): Promise<ContextUsage>
  subagents(threadId: string, signal?: AbortSignal): Promise<readonly string[]>
  subagentMessages(threadId: string, agentId: string, offset: number, signal?: AbortSignal): Promise<{ readonly messages: readonly HistoryMessageView[]; readonly hasMore: boolean }>
  manageThread(threadId: string, input: unknown): Promise<ThreadView>
  filePreview(threadId: string, path: string, signal?: AbortSignal): Promise<FilePreview>
  checkpoints(threadId: string): Promise<readonly Checkpoint[]>
  rewind(threadId: string, input: unknown, signal?: AbortSignal): Promise<RewindPreview>
  connectMcp(threadId: string): Promise<ConnectionJob>
  connectionJob(threadId: string, id: string): ConnectionJob
  connectionJobs(threadId: string): readonly ConnectionJob[]
  cancelConnectionJob(threadId: string, id: string): ConnectionJob
  waitConnectionJob(id: string): Promise<void>
  interactions(threadId: string): readonly ElicitationView[]
  answerInteraction(threadId: string, id: string, answer: unknown): void
}
/** Resources belong to Runs. This closure is a helper, not a second root or component. */
export function createWorkspaceOperations(deps: {
  store: ClaudeAgentStorePort; sdk: ClaudeAgentSdkPort; clock: ClaudeAgentClock
  requireThread(id: string): Promise<ThreadRecord>; viewThread(record: ThreadRecord): ThreadView
  ensureOpen(): void; active(threadId: string): SdkRunHandle | undefined
  starting: Set<string>; changing: Set<string>; nativeBusy?(sessionId:string):boolean
}) {
  const { store, sdk, clock } = deps
  const pending = new Map<string, { view: ElicitationView; resolve(answer: ElicitationAnswer): void }>()
  const jobs = new Map<string, { view: ConnectionJob; controller: AbortController; done: Promise<void> }>()
  const reservations = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const combined = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const idle = async <T>(threadId: string, work: (thread: ThreadRecord) => Promise<T>): Promise<T> => {
    deps.ensureOpen()
    if (deps.active(threadId) || deps.starting.has(threadId) || deps.changing.has(threadId)) throw claudeAgentError('thread-busy', 409, '请等待此会话的任务或操作结束。')
    deps.starting.add(threadId)
    try { const thread = await deps.requireThread(threadId); deps.ensureOpen();if(thread.nativeSessionId&&deps.nativeBusy?.(thread.nativeSessionId))throw claudeAgentError('thread-busy',409,'此原生会话仍有任务运行，请等待完成。');return await work(thread) }
    finally { deps.starting.delete(threadId) }
  }
  const hooks = (threadId: string): Pick<SdkRunHooks, 'onElicitation'> => ({ onElicitation: (request, signal) => {
    if (lifetime.signal.aborted || signal.aborted || pending.size >= 50) return Promise.resolve({ action: 'cancel' })
    const id = clock.newId(), view = { ...request, id, threadId }
    return new Promise<ElicitationAnswer>(resolve => {
      const finish = (answer: ElicitationAnswer) => { pending.delete(id); signal.removeEventListener('abort', abort); resolve(answer) }
      const abort = () => finish({ action: 'cancel' })
      pending.set(id, { view, resolve: finish }); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  } })
  const request = async (thread: ThreadRecord): Promise<SdkRunRequest> => ({ cwd: thread.projectPath, prompt: '', resume: thread.nativeSessionId, options: thread.options ?? defaultSessionOptions,
    permissionMode: thread.permissionMode, sessionPermissions: mergeSessionPermissions((await store.listSessionGrants(thread.id)).map(value => value.permissions)) })
  const inspect = async (threadId: string, input: SessionInspection, signal?: AbortSignal) => {
    deps.ensureOpen()
    const run = deps.active(threadId)
    if (run) { if (!run.inspect) throw claudeAgentError('control-unavailable', 503); return run.inspect(input) }
    return idle(threadId, async thread => {
      if (!sdk.inspectSession) throw claudeAgentError('control-unavailable', 503)
      return sdk.inspectSession(await request(thread), input, hooks(threadId), combined(signal))
    })
  }
  const service: ClaudeAgentWorkspacePort = {
    updateOptions: (threadId, input) => idle(threadId, async () => {
      exact(input, ['maxBudgetUsd', 'maxTurns', 'fallbackModel', 'checkpointing', 'mcpServers', 'revision'])
      const { revision, ...settings } = input
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw claudeAgentError('invalid-input', 400)
      return deps.viewThread(await store.updateThread(threadId, { options: validateSessionOptions(settings), optionsRevision: revision + 1 }, clock.now()))
    }),
    contextUsage: async (threadId, signal, detail) => inspect(threadId, { action: 'context', detail }, signal) as Promise<ContextUsage>,
    async subagents(threadId, signal) {
      deps.ensureOpen(); const thread = await deps.requireThread(threadId)
      if (!thread.nativeSessionId) return []
      if (!sdk.listSubagents) throw claudeAgentError('history-unavailable', 503)
      return sdk.listSubagents(thread.nativeSessionId, thread.projectPath, combined(signal))
    },
    async subagentMessages(threadId, agentId, offset, signal) {
      deps.ensureOpen(); const thread = await deps.requireThread(threadId)
      if (!thread.nativeSessionId || !sdk.readSubagentMessages) throw claudeAgentError('history-unavailable', 404)
      if (!(await service.subagents(threadId, signal)).includes(agentId)) throw claudeAgentError('agent-not-found', 404)
      return sdk.readSubagentMessages(thread.nativeSessionId, thread.projectPath, agentId, offset, combined(signal))
    },
    manageThread: (threadId, raw) => idle(threadId, async thread => {
      exact(raw, ['action', 'value', 'messageId', 'idempotencyKey'])
      const action = raw.action
      if (!['rename', 'tag', 'archive', 'restore', 'fork', 'delete'].includes(String(action)) || typeof raw.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(raw.idempotencyKey)) throw claudeAgentError('invalid-input', 400)
      const value = action === 'tag' && raw.value === '' ? '' : action === 'rename' || action === 'tag' ? boundedName(raw.value, action === 'tag' ? 100 : 200) : action === 'fork' ? raw.value === undefined ? `${thread.title.slice(0, 190)} · 分支` : boundedName(raw.value) : ''
      const messageId = raw.messageId === undefined ? undefined : boundedName(raw.messageId, 128)
      if (messageId && (action !== 'fork' || !thread.nativeSessionId || !(await sdk.readSessionMessages(thread.nativeSessionId, thread.projectPath)).some(message => message.id === messageId))) throw claudeAgentError('message-not-found', 404)
      const prior = await store.reserveMutation(raw.idempotencyKey, threadId, String(action), JSON.stringify({ value, messageId }))
      if (!prior.fresh) {
        if (prior.state === 'completed' && prior.result) return deps.viewThread(await deps.requireThread(prior.result))
        throw claudeAgentError('operation-unknown', 409, '此操作已提交但结果尚未确认，请核对原生会话，不要重复创建。')
      }
      try {
        let next: ThreadRecord
        if (action === 'fork') {
          if (!thread.nativeSessionId || !sdk.mutateSession) throw claudeAgentError('session-unavailable', 409)
          const result = await sdk.mutateSession(thread.nativeSessionId, thread.projectPath, { action: 'fork', title: value, messageId }, lifetime.signal)
          if (!result.sessionId || !/^[0-9a-f-]{36}$/i.test(result.sessionId)) throw claudeAgentError('operation-unknown', 503)
          // Record the native identity before indexing; a failed index never silently forks a second time.
          await store.finishMutation(raw.idempotencyKey, 'unknown', result.sessionId)
          const now = clock.now()
          next = await store.createThread({ ...thread, optionsRevision: 0, id: clock.newId(), title: value, titleSource: 'user', nativeSessionId: result.sessionId, forkedFrom: thread.id, archived: false, createdAt: now, updatedAt: now, lastRunId: null, lastRunStatus: null })
        } else {
          if(action==='delete'&&thread.nativeSessionId){if(!sdk.mutateSession)throw claudeAgentError('control-unavailable',503);await sdk.mutateSession(thread.nativeSessionId,thread.projectPath,{action:'delete'},lifetime.signal)}
          if ((action === 'rename' || action === 'tag') && thread.nativeSessionId) {
            if (!sdk.mutateSession) throw claudeAgentError('control-unavailable', 503)
            await sdk.mutateSession(thread.nativeSessionId, thread.projectPath, { action, value }, lifetime.signal)
          }
          next = await store.updateThread(threadId, action === 'rename' ? { title: value, titleSource: 'user' } : action === 'tag' ? { tag: value || null } : action==='delete'?{deleted:true,archived:true}:{ archived: action === 'archive' }, clock.now())
        }
        await store.finishMutation(raw.idempotencyKey, 'completed', next.id)
        return deps.viewThread(next)
      } catch (error) { await store.finishMutation(raw.idempotencyKey, 'unknown', null).catch(() => {}); throw error }
    }),
    filePreview: (threadId, path, signal) => inspect(threadId, { action: 'file', path: boundedName(path, 4096) }, signal) as Promise<FilePreview>,
    checkpoints: async threadId => { deps.ensureOpen(); await deps.requireThread(threadId); return store.listCheckpoints(threadId) },
    rewind: (threadId, raw, signal) => idle(threadId, async thread => {
      exact(raw, ['checkpointId', 'dryRun', 'idempotencyKey'])
      const id = boundedName(raw.checkpointId, 128)
      if (typeof raw.dryRun !== 'boolean') throw claudeAgentError('invalid-input', 400)
      const checkpoint = (await store.listCheckpoints(threadId)).find(value => value.id === id && value.nativeSessionId === thread.nativeSessionId)
      if (!checkpoint || !sdk.inspectSession) throw claudeAgentError('checkpoint-unavailable', 404)
      let key: string | undefined
      if (!raw.dryRun) {
        if (typeof raw.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(raw.idempotencyKey)) throw claudeAgentError('invalid-input', 400)
        key = raw.idempotencyKey
        const previous = await store.reserveMutation(key, threadId, 'rewind', id)
        if (!previous.fresh) {
          if (previous.state === 'completed' && previous.result) return JSON.parse(previous.result) as RewindPreview
          throw claudeAgentError('operation-unknown', 409)
        }
      }
      try {
        const result = await sdk.inspectSession({ ...await request(thread), options: { ...(thread.options ?? defaultSessionOptions), checkpointing: true } }, { action: 'rewind', messageId: id, dryRun: raw.dryRun }, hooks(threadId), combined(signal)) as RewindPreview
        if (key) await store.finishMutation(key, 'completed', JSON.stringify(result))
        return result
      } catch (error) { if (key) await store.finishMutation(key, 'unknown', null).catch(() => {}); throw error }
    }),
    async connectMcp(threadId) {
      deps.ensureOpen()
      if (jobs.size >= 100) { for (const [id, job] of jobs) if (job.view.status !== 'running') jobs.delete(id); if (jobs.size >= 100) throw claudeAgentError('too-many-requests', 429) }
      if (deps.active(threadId) || deps.starting.has(threadId) || deps.changing.has(threadId)) throw claudeAgentError('thread-busy', 409)
      deps.starting.add(threadId)
      let thread: ThreadRecord
      try { thread = await deps.requireThread(threadId); deps.ensureOpen(); if (!sdk.inspectSession) throw claudeAgentError('control-unavailable', 503) } catch (error) { deps.starting.delete(threadId); throw error }
      const id = clock.newId(), controller = new AbortController()
      const entry = { view: { id, threadId, status: 'running', result: null, error: null } as ConnectionJob, controller, done: Promise.resolve() }
      jobs.set(id, entry)
      entry.done = (async () => {
        try { const result = await sdk.inspectSession!(await request(thread), { action: 'mcp-connect' }, hooks(threadId), controller.signal) as CapabilitiesView; entry.view = { ...entry.view, status: controller.signal.aborted ? 'cancelled' : 'completed', result: controller.signal.aborted ? null : result } }
        catch (error) { entry.view = { ...entry.view, status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message.slice(0, 4000) : '连接失败' } }
        finally { deps.starting.delete(threadId) }
      })()
      return entry.view
    },
    connectionJob(threadId, id) { const job = jobs.get(id); if (!job || job.view.threadId !== threadId) throw claudeAgentError('operation-not-found', 404); return job.view },
    connectionJobs: threadId => [...jobs.values()].filter(job => job.view.threadId === threadId).map(job => job.view).slice(-10),
    cancelConnectionJob(threadId, id) { const view = service.connectionJob(threadId, id); jobs.get(id)!.controller.abort(); return view },
    waitConnectionJob: id => jobs.get(id)?.done ?? Promise.resolve(),
    interactions: threadId => [...pending.values()].filter(item => item.view.threadId === threadId).map(item => item.view),
    answerInteraction(threadId, id, raw) { const item = pending.get(id); if (!item || item.view.threadId !== threadId) throw claudeAgentError('interaction-resolved', 409); item.resolve(elicitationAnswer(item.view, raw)) },
  }
  return { service, hooks,
    track<T>(work: Promise<T>): Promise<T> { reservations.add(work); void work.finally(() => reservations.delete(work)).catch(() => {}); return work },
    busy: () => reservations.size > 0 || [...jobs.values()].some(job => job.view.status === 'running'),
    async close() { lifetime.abort(); for (const item of [...pending.values()]) item.resolve({ action: 'cancel' }); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...reservations, ...[...jobs.values()].map(job => job.done)]) },
  }
}

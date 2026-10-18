import { digest } from '../attachments.js'
import type { AttachmentData } from '../attachments.js'
import type { AttachmentUpload } from '../attachments.js'
import type { QueuedMessageView } from '../view.js'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Component } from '@nya/core'
import { listDirectory, parseDirectoryRequest } from '../directories.js'
import { claudeAgentError, defaultThreadTitle, promptTitle, validateRunControl, validateRunInput, validateThreadInput } from '../domain.js'
import type { ClaudeAgentClock } from '../domain.js'
import { applyRunEvent, emptyRunView } from '../events.js'
import { mergeRecentProjects, normalizeProjectPath } from '../projects.js'
import type { RecentProjectSource } from '../projects.js'
import { claudeAgentSdkServiceKey } from '../sdk/port.js'
import type { ClaudeAgentSdkPort, SdkRunHandle, SdkRunHooks } from '../sdk/port.js'
import { claudeAgentStoreServiceKey } from '../store/component.js'
import type { ClaudeAgentStorePort, RunRecord, ThreadRecord } from '../store/component.js'
import { createApprovalRegistry, decisionFor } from './approvals.js'
import { mergeSessionPermissions, permissionRuleLabels, validateSessionPermissions } from '../permissions.js'
import type { SessionPermissionSpec } from '../permissions.js'
import type { ApprovalView, ClaudeAgentRunStatus, DirectoryListingView, RecentModelsView, RecentProjectsView, RunChangedView, RunEventFrameView, RunEventView, RunLiveView, RunView, ThreadMessagesView, ThreadView } from '../view.js'
import type { CapabilitiesView } from '../view.js'
import type { SessionPermissionsView } from '../view.js'
import { createWorkspaceOperations } from './workspace.js'
import type { ClaudeAgentWorkspacePort } from './workspace.js'
import { defaultSessionOptions } from '../workspace.js'

export const claudeAgentRunsServiceKey = 'claude-agent.runs'
export const claudeAgentRunAdmissionServiceKey = 'claude-agent.run-admission'
export const claudeAgentRunChangedEvent = 'claude-agent.run.changed'
export const claudeAgentRunEventEvent = 'claude-agent.run.event'
declare module '@nya/core' {
  interface Events {
    'claude-agent.run.changed': (change: RunChangedView) => void
    'claude-agent.run.event': (frame: RunEventFrameView) => void
  }
}
export interface ClaudeAgentRunAdmissionPort {
  busy(): boolean
  /** Freezes new Runs while idle and returns the release; undefined when Runs are active. */
  pauseIfIdle(): (() => void) | undefined
  closeAdmission(): void
}
export interface ClaudeAgentRunsPort extends ClaudeAgentWorkspacePort {
  accountUsage(threadId?: string, cwd?: string, signal?: AbortSignal): Promise<import('../account.js').AccountUsageView>
  nativeSessions(threadId:string,offset:number,signal?:AbortSignal):Promise<readonly {sessionId:string;title:string;updatedAt:string}[]>
  importSession(threadId:string,input:unknown):Promise<ThreadView>
  beginAttachment(raw: Record<string,unknown>): Promise<AttachmentUpload>
  appendAttachment(id:string,raw:Record<string,unknown>):Promise<AttachmentUpload>
  discardAttachment(id:string):Promise<void>
  appendMessage(runId:string,input:unknown):Promise<QueuedMessageView>
  cancelMessage(runId:string,id:string):Promise<void>
  listMessages(runId:string):Promise<readonly QueuedMessageView[]>
  sessionPermissions(threadId: string): Promise<SessionPermissionsView>
  revokeSessionPermission(threadId: string, grantId: string): Promise<SessionPermissionsView>
  capabilities(threadId: string, signal?: AbortSignal): Promise<CapabilitiesView>
  controlRun(runId: string, input: unknown): Promise<void>
  createThread(input: unknown): Promise<ThreadView>
  listThreads(): Promise<readonly ThreadView[]>
  getThread(id: string): Promise<ThreadView | undefined>
  readThreadMessages(id: string, signal?: AbortSignal, offset?:number): Promise<ThreadMessagesView>
  listRuns(threadId: string): Promise<readonly RunView[]>
  startRun(threadId: string, input: unknown): Promise<RunView>
  getRun(id: string): Promise<RunView | undefined>
  /** Live or recently finished projection kept in memory; absent after a restart. */
  getRunView(id: string): RunLiveView | undefined
  /** Resolves after the Run has settled and its process exited, or when the signal aborts. */
  waitRun(id: string, signal?: AbortSignal): Promise<RunView | undefined>
  cancelRun(id: string): Promise<RunView | undefined>
  listPendingApprovals(threadId?: string): readonly ApprovalView[]
  resolveApproval(id: string, decision: unknown, answers: unknown): Promise<ApprovalView>
  /** Directories recently used by this application's threads or by the Claude environment, existing on this device, newest first. */
  listRecentProjects(signal?: AbortSignal): Promise<RecentProjectsView>
  /** Subdirectories of one directory on this device; `~` is the device's home. Stateless, cancelled with the request. */
  browseDirectory(params: { readonly path: string | null; readonly showHidden: string | null }, signal?: AbortSignal): Promise<DirectoryListingView>
  /** Model names recently requested or reported on this device, for input suggestions. */
  listRecentModels(): Promise<RecentModelsView>
}
export interface ClaudeAgentRunsOptions {
  readonly clock?: Partial<ClaudeAgentClock>
  readonly cancel?: { readonly interruptTimeoutMs?: number; readonly resultTimeoutMs?: number; readonly exitTimeoutMs?: number }
  /** Replaceable for tests; production checks the execution device's own file system. */
  readonly directoryExists?: (path: string) => Promise<boolean>
  readonly retainedViews?: number
  /** Home directory `~` expands to when browsing; defaults to the execution device's. */
  readonly homeDirectory?: string
  readonly recentProjectLimit?: number
}
interface ActiveRun {
  record: RunRecord
  handle: SdkRunHandle | undefined
  view: RunLiveView
  cancelRequested: boolean
  settled: Promise<void>
  readonly waiters: Set<() => void>
}
const settlesWithin = (promise: Promise<unknown> | undefined, ms: number): Promise<boolean> => new Promise(resolve => {
  if (!promise) { resolve(true); return }
  const timer = setTimeout(() => resolve(false), ms)
  const finish = () => { clearTimeout(timer); resolve(true) }
  promise.then(finish, finish)
})
const threadView = (record: ThreadRecord, pendingApprovals: number): ThreadView => Object.freeze({ schemaVersion: 1, ...(record.deleted?{deleted:true}:{}), permissionMode: record.permissionMode ?? 'default', id: record.id, projectPath: record.projectPath, title: record.title,
  optionsRevision: record.optionsRevision ?? 0, options: record.options ?? defaultSessionOptions, archived: record.archived ?? false, tag: record.tag ?? null, forkedFrom: record.forkedFrom ?? null,
  titleSource: record.titleSource, nativeSessionId: record.nativeSessionId, createdAt: record.createdAt, updatedAt: record.updatedAt,
  lastRun: record.lastRunId && record.lastRunStatus ? { id: record.lastRunId, status: record.lastRunStatus } : null, pendingApprovals })
const runView = (record: RunRecord): RunView => Object.freeze({ schemaVersion: 1, permissionMode: record.permissionMode ?? 'default', id: record.id, threadId: record.threadId, status: record.status, prompt: record.prompt, model: record.model,
  attachments: record.attachments ?? [], options: record.options, contextUsage: record.contextUsage ?? null,
  resolvedModel: record.resolvedModel, effort: record.effort, nativeSessionId: record.nativeSessionId, createdAt: record.createdAt, finishedAt: record.finishedAt, result: record.result, error: record.error })
const recentModelLimit = 12

/**
 * Admission (one active Run per thread), cancellation, approval bridging and the bounded live projection.
 * Durable facts go through the store; the agent's transcript stays in the Claude environment.
 */
export function createClaudeAgentRunsComponent(options: ClaudeAgentRunsOptions = {}): Component.Object<void, {
  [claudeAgentStoreServiceKey]: ClaudeAgentStorePort; [claudeAgentSdkServiceKey]: ClaudeAgentSdkPort
}> {
  const clock: ClaudeAgentClock = { now: options.clock?.now ?? (() => new Date().toISOString()), newId: options.clock?.newId ?? (() => randomUUID()) }
  const timeouts = { interrupt: options.cancel?.interruptTimeoutMs ?? 3_000, result: options.cancel?.resultTimeoutMs ?? 10_000, exit: options.cancel?.exitTimeoutMs ?? 5_000 }
  // Recent projects are deduplicated by the directory's real path (macOS /tmp and /var are links); threads keep the path the user gave.
  const resolveDirectory = options.directoryExists
    ? async (path: string) => (await options.directoryExists!(path)) ? path : undefined
    : async (path: string) => { try { const real = await realpath(path); return (await stat(real)).isDirectory() ? real : undefined } catch { return undefined } }
  const directoryExists = async (path: string) => (await resolveDirectory(path)) !== undefined
  const retainedViews = options.retainedViews ?? 64, recentProjectLimit = options.recentProjectLimit ?? 20
  const homeDirectory = options.homeDirectory ?? homedir()
  return { name: 'claude-agent-runs', inject: [claudeAgentStoreServiceKey, claudeAgentSdkServiceKey], apply(ctx, _config, deps) {
    const store = deps[claudeAgentStoreServiceKey], sdk = deps[claudeAgentSdkServiceKey]
    const nativeStarting=new Set<string>()
    const nativeBusy=(id:string)=>nativeStarting.has(id)||[...active.values()].some(run=>run.record.nativeSessionId===id)
    const active = new Map<string, ActiveRun>(), activeByThread = new Map<string, string>(), starting = new Set<string>()
    const views = new Map<string, RunLiveView>()
    const controlling = new Set<string>()
    const permissionChanges = new Set<string>(), permissionRecovery = new Set<string>()
    const proposedPermissions = new Map<string, SessionPermissionSpec>()
    const approvals = createApprovalRegistry()
    const writes = new Set<Promise<unknown>>(), admissions = new Set<Promise<unknown>>()
    let accepting = true, pauseCount = 0
    const track = (work: Promise<unknown>) => { writes.add(work); void work.catch(error => ctx.logger.warn('Claude Agent index write failed', { error })).finally(() => writes.delete(work)) }
    const ensureOpen = () => { if (!accepting || pauseCount > 0) throw claudeAgentError('service-unavailable', 503) }
    const admit = <T>(work: () => Promise<T>): Promise<T> => {
      const task = work(); admissions.add(task)
      void task.finally(() => admissions.delete(task)).catch(() => {})
      return task
    }
    const requireThread = async (id: string) => { const thread = await store.getThread(id); if (!thread || thread.deleted) throw claudeAgentError('thread-not-found', 404); return thread }
    const viewThread = (record: ThreadRecord) => threadView(record, approvals.pending(record.id).length)
    const workspace = createWorkspaceOperations({ store, sdk, clock, requireThread, viewThread, ensureOpen, starting, changing: permissionChanges, nativeBusy,
      active: threadId => { const id = activeByThread.get(threadId); return id ? active.get(id)?.handle : undefined } })
    /** The Claude environment's own title for the thread's session; user titles are never replaced and read failures keep the current title. */
    const claudeTitle = async (run: ActiveRun): Promise<string | undefined> => {
      if (!run.record.nativeSessionId) return undefined
      const thread = await store.getThread(run.record.threadId).catch(() => undefined)
      if (!thread || thread.titleSource === 'user') return undefined
      const info = await sdk.readSessionInfo(run.record.nativeSessionId, thread.projectPath).catch(() => undefined)
      return info?.title && info.title !== thread.title ? info.title : undefined
    }
    const retainView = (runId: string, view: RunLiveView) => {
      views.delete(runId); views.set(runId, view)
      for (const id of views.keys()) { if (views.size <= retainedViews) break; if (!active.has(id)) views.delete(id) }
    }
    const publishChange = (run: ActiveRun) => ctx.emit(claudeAgentRunChangedEvent, Object.freeze({ threadId: run.record.threadId, runId: run.record.id, status: run.record.status, seq: run.view.seq }))
    const applyEvent = (run: ActiveRun, event: RunEventView) => {
      run.view = applyRunEvent(run.view, event); retainView(run.record.id, run.view)
      ctx.emit(claudeAgentRunEventEvent, Object.freeze({ threadId: run.record.threadId, runId: run.record.id, seq: run.view.seq, event }))
    }
    const finishApproval = (run: ActiveRun, view: ApprovalView) => {
      track(store.updateApproval(view.id, { decision: view.decision ?? 'cancelled', answers: view.answers, resolvedAt: view.resolvedAt ?? clock.now() }))
      applyEvent(run, { type: 'approval-resolved', approval: view })
    }
    const settle = async (run: ActiveRun) => {
      const handle = run.handle!
      const outcome = await handle.result
      await handle.done
      const title = await claudeTitle(run)
      const now = clock.now()
      for (const view of approvals.denyAll(run.record.id, now, 'The run has ended.')) finishApproval(run, view)
      const status: ClaudeAgentRunStatus = run.cancelRequested ? 'cancelled' : outcome.kind === 'result' && !outcome.result.isError ? 'completed' : 'failed'
      const result = outcome.kind === 'result' ? outcome.result : null
      const error = outcome.kind === 'failed' ? outcome.error
        : outcome.result.isError ? { code: 'agent-error', message: outcome.result.text || outcome.result.errors?.join('\n') || 'The agent reported an error.' } : null
      run.record = { ...run.record, status, finishedAt: now, result, error }
      try {
        await store.updateRun(run.record.id, { status, finishedAt: now, result, error, nativeSessionId: run.record.nativeSessionId })
        await store.updateThread(run.record.threadId, { lastRunId: run.record.id, lastRunStatus: status, ...(title ? { title, titleSource: 'claude' } : {}) }, now)
      } catch (cause) { ctx.logger.warn('Claude Agent run settlement was not saved', { error: cause }) }
      active.delete(run.record.id)
      if (activeByThread.get(run.record.threadId) === run.record.id) activeByThread.delete(run.record.threadId)
      publishChange(run)
      for (const waiter of [...run.waiters]) waiter()
    }
    const launch = (record: RunRecord, thread: ThreadRecord, sessionPermissions: SessionPermissionSpec, attachments: readonly AttachmentData[] = []): ActiveRun => {
      const run: ActiveRun = { record, handle: undefined, view: emptyRunView(record.id, record.threadId), cancelRequested: false, settled: Promise.resolve(), waiters: new Set() }
      const checkpointIds = new Set<string>()
      const saveCheckpoints = () => { if (run.record.nativeSessionId) { for (const id of checkpointIds) track(store.saveCheckpoint({ id, threadId: record.threadId, runId: record.id, nativeSessionId: run.record.nativeSessionId, createdAt: clock.now() })); checkpointIds.clear() } }
      const hooks: SdkRunHooks = {
        ...workspace.hooks(record.threadId),
        onEvent(event) {
          if(event.type==='input')track(store.updateInput(event.message))
          if (event.type === 'context') {
            run.record = { ...run.record, contextUsage: event.context }
            track(store.updateRun(record.id, { contextUsage: event.context }))
          }
          if (event.type === 'checkpoint') { checkpointIds.add(event.messageId); saveCheckpoints() }
          if (event.type === 'init') {
            const session = run.record.nativeSessionId !== event.init.nativeSessionId, model = event.init.model && run.record.resolvedModel !== event.init.model
            if (session || model) {
              const patch = { ...(session ? { nativeSessionId: event.init.nativeSessionId } : {}), ...(model ? { resolvedModel: event.init.model } : {}) }
              run.record = { ...run.record, ...patch }
              track(store.updateRun(record.id, patch))
            }
            if (session) track(store.updateThread(record.threadId, { nativeSessionId: event.init.nativeSessionId }, clock.now()))
            saveCheckpoints()
          }
          applyEvent(run, event)
        },
        canUseTool(request) {
          if (run.cancelRequested || !accepting) return Promise.resolve({ behavior: 'deny', message: 'The run is no longer accepting tool requests.' })
          const reusable = request.reusablePermissions && run.record.nativeSessionId && !request.questions ? validateSessionPermissions(request.reusablePermissions) : undefined
          const scoped = { ...request, allowSessionAvailable: request.allowSessionAvailable && !!reusable,
            ...(request.allowSessionAvailable && !reusable ? { rememberUnavailableReason: 'Claude 尚未建立会话或未提供可复用的规则，此次只能单独确认。' } : {}) }
          const requested = approvals.request({ id: clock.newId(), runId: record.id, threadId: record.threadId, now: clock.now(), request: scoped })
          if (reusable) proposedPermissions.set(requested.view.id, reusable)
          track(store.recordApproval(requested.view))
          applyEvent(run, { type: 'approval-requested', approval: requested.view })
          const abort = () => { const cancelled = approvals.cancel(requested.view.id, clock.now()); if (cancelled) finishApproval(run, cancelled) }
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
          return requested.decision.finally(() => { proposedPermissions.delete(requested.view.id); request.signal.removeEventListener('abort', abort) })
        },
      }
      run.handle = sdk.openRun({ cwd: thread.projectPath, prompt: record.prompt, attachments, options: record.options, permissionMode: record.permissionMode ?? 'default', sessionPermissions, resume: thread.nativeSessionId, ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}) }, hooks)
      active.set(record.id, run); activeByThread.set(record.threadId, record.id)
      retainView(record.id, run.view)
      publishChange(run)
      run.settled = settle(run)
      return run
    }
    const cancellation = async (run: ActiveRun) => {
      const handle = run.handle!
      await settlesWithin(handle.interrupt(), timeouts.interrupt)
      if (!(await settlesWithin(handle.result, timeouts.result))) { handle.close(); return }
      if (!(await settlesWithin(handle.done, timeouts.exit))) handle.close()
    }
    const service: ClaudeAgentRunsPort = {
      ...workspace.service,
      nativeSessions:(id,offset,signal)=>admit(async()=>{ensureOpen();const thread=await requireThread(id);if(!sdk.listNativeSessions)throw claudeAgentError('history-unavailable',503);return sdk.listNativeSessions(thread.projectPath,offset,signal)}),
      importSession:(id,raw)=>admit(async()=>{
        ensureOpen();const thread=await requireThread(id)
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['sessionId'].includes(k)))throw claudeAgentError('invalid-input',400)
        const sessionId=(raw as {sessionId?:unknown}).sessionId;if(typeof sessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(sessionId))throw claudeAgentError('invalid-input',400)
        const prior=(await store.listThreads()).find(t=>t.nativeSessionId===sessionId&&t.projectPath===thread.projectPath);if(prior)return viewThread(prior)
        const info=await sdk.readSessionInfo(sessionId,thread.projectPath);if(!info)throw claudeAgentError('session-unavailable',404)
        const now=clock.now();ensureOpen();return viewThread(await store.createThread({id:clock.newId(),nativeSessionId:sessionId,projectPath:thread.projectPath,title:info.title??'Claude 会话',titleSource:'claude',createdAt:now,updatedAt:now,lastRunId:null,lastRunStatus:null}))
      }),
      beginAttachment: raw=>admit(async()=>{ensureOpen();return store.beginAttachment(raw)}),
      appendAttachment: (id,raw)=>admit(async()=>{ensureOpen();return store.appendAttachment(id,raw)}),
      discardAttachment: id=>admit(async()=>{ensureOpen();return store.discardAttachment(id)}),
      listMessages: async id=>{if(!await store.getRun(id))throw claudeAgentError('run-not-found',404);return store.listInputs(id)},
      appendMessage: (runId,raw)=>admit(async()=>{
        ensureOpen();const input=validateRunInput(raw),run=active.get(runId)
        if(!run&&!await store.getRun(runId))throw claudeAgentError('run-not-found',404)
        const assets=await store.readAttachments(input.attachmentIds??[]), attachments=assets.map(({data,...meta})=>meta)
        const message:QueuedMessageView={id:randomUUID(),runId,prompt:input.prompt,attachments,status:'queued',createdAt:clock.now()}
        const reserved=await store.reserveInput(message,input.idempotencyKey,digest(JSON.stringify({prompt:input.prompt,attachments})))
        if(!reserved.fresh)return reserved.message
        if(!run?.handle?.enqueue||run.cancelRequested){await store.updateInput({...message,status:'cancelled'});throw claudeAgentError('run-ended',409,'任务已结束，未执行此消息。请作为新任务发送。')}
        try{run.handle.enqueue(message,assets);return message}catch(error){await store.updateInput({...message,status:'cancelled'});throw error}
      }),
      cancelMessage:(runId,id)=>admit(async()=>{ensureOpen();const run=active.get(runId);if(!run?.handle?.cancelInput?.(id))throw claudeAgentError('input-already-sent',409,'此消息已发送或任务已结束，无法从队列移除。')}),
      accountUsage: (threadId, cwd, signal) => admit(async () => {
        ensureOpen()
        const thread = threadId ? await requireThread(threadId) : undefined
        const runId = threadId ? activeByThread.get(threadId) : undefined, run = runId ? active.get(runId) : undefined
        if (run && !run.cancelRequested) {
          if (!run.handle?.inspect) throw claudeAgentError('control-unavailable', 503)
          return await run.handle.inspect({ action: 'account' }) as import('../account.js').AccountUsageView
        }
        if (!sdk.readAccountUsage) throw claudeAgentError('account-unavailable', 503, '当前执行设备尚不支持账号与额度查询。')
        return sdk.readAccountUsage(thread?.projectPath ?? cwd, signal)
      }),
      updateOptions: (...args) => workspace.track(workspace.service.updateOptions(...args)),
      contextUsage: (...args) => workspace.track(workspace.service.contextUsage(...args)),
      subagents: (...args) => workspace.track(workspace.service.subagents(...args)),
      subagentMessages: (...args) => workspace.track(workspace.service.subagentMessages(...args)),
      manageThread: (...args) => workspace.track(workspace.service.manageThread(...args)),
      filePreview: (...args) => workspace.track(workspace.service.filePreview(...args)),
      checkpoints: (...args) => workspace.track(workspace.service.checkpoints(...args)),
      rewind: (...args) => workspace.track(workspace.service.rewind(...args)),
      connectMcp: (...args) => workspace.track(workspace.service.connectMcp(...args)),
      sessionPermissions: threadId => admit(async () => {
        ensureOpen(); await requireThread(threadId)
        return { schemaVersion: 1, threadId, grants: (await store.listSessionGrants(threadId)).map(grant => ({ id: grant.id, rules: permissionRuleLabels(grant.permissions), createdAt: grant.createdAt })), canRevoke: !activeByThread.has(threadId) && !starting.has(threadId) && !permissionChanges.has(threadId) }
      }),
      revokeSessionPermission: (threadId, grantId) => admit(async () => {
        ensureOpen()
        if (activeByThread.has(threadId) || starting.has(threadId)) throw claudeAgentError('permissions-active', 409, '请等待当前任务结束后再撤销会话授权。')
        if (permissionChanges.has(threadId)) throw claudeAgentError('permissions-changing', 409)
        permissionChanges.add(threadId)
        try { await requireThread(threadId); await store.revokeSessionGrant(threadId, grantId, clock.now()) }
        finally { permissionChanges.delete(threadId) }
        return service.sessionPermissions(threadId)
      }),
      capabilities: (threadId, signal) => admit(async () => {
        ensureOpen()
        const thread = await requireThread(threadId), runId = activeByThread.get(threadId), run = runId ? active.get(runId) : undefined
        if (run) {
          if (!run.handle?.capabilities || run.cancelRequested) throw claudeAgentError('control-unavailable', 409)
          return run.handle.capabilities()
        }
        if (!sdk.listCapabilities) throw claudeAgentError('control-unavailable', 503)
        return sdk.listCapabilities(thread.projectPath, signal)
      }),
      controlRun: (runId, raw) => admit(async () => {
        ensureOpen()
        const input = validateRunControl(raw), run = active.get(runId)
        if (!run?.handle?.control || run.cancelRequested) throw claudeAgentError('run-ended', 409)
        if (controlling.has(runId)) throw claudeAgentError('control-busy', 409)
        if (input.action === 'stop-task') {
          const task = run.view.tasks?.find(task => task.id === input.taskId)
          if (!task || !['running', 'pending', 'paused'].includes(task.status ?? '')) throw claudeAgentError('task-not-active', 409)
        }
        controlling.add(runId)
        try {
          if (input.action === 'mcp-toggle' || input.action === 'mcp-reconnect' || input.action === 'mcp-permission') {
            const snapshot = await run.handle.capabilities!()
            if (!snapshot.mcp.some(server => server.name === input.name)) throw claudeAgentError('mcp-not-found', 404)
          }
          if (!active.has(runId) || run.cancelRequested) throw claudeAgentError('run-ended', 409)
          await run.handle.control(input)
          if (input.action === 'mcp-set'){applyEvent(run,{type:'mcp-configuration',servers:input.servers});applyEvent(run,{type:'notice',notice:{code:'mcp-config',message:'MCP 配置已应用到当前任务；后续任务使用已保存的会话配置。'}})}
          if (input.action === 'permission-mode') {
            run.record = { ...run.record, permissionMode: input.mode }
            await store.updateRun(runId, { permissionMode: input.mode })
            await store.updateThread(run.record.threadId, { permissionMode: input.mode }, clock.now())
          }
        } finally { controlling.delete(runId) }
      }),
      createThread: raw => admit(async () => {
        ensureOpen()
        const input = validateThreadInput(raw)
        if (!(await directoryExists(input.projectPath))) throw claudeAgentError('project-path-missing', 404, `目录不存在或不是文件夹：${input.projectPath}`)
        ensureOpen()
        const now = clock.now()
        return viewThread(await store.createThread({ id: clock.newId(), projectPath: input.projectPath, title: input.title ?? defaultThreadTitle(input.projectPath),
          titleSource: input.title ? 'user' : 'default', nativeSessionId: null, createdAt: now, updatedAt: now, lastRunId: null, lastRunStatus: null }))
      }),
      listThreads: async () => (await store.listThreads()).map(viewThread),
      getThread: async id => { const thread = await store.getThread(id); return thread && !thread.deleted ? viewThread(thread) : undefined },
      async readThreadMessages(id, signal, offset = -1) {
        const thread = await requireThread(id)
        if (!thread.nativeSessionId) return { nativeSessionId: null, messages: [] }
        if(sdk.readSessionPage)return {nativeSessionId:thread.nativeSessionId,...await sdk.readSessionPage(thread.nativeSessionId,thread.projectPath,offset,signal)}
        return { nativeSessionId: thread.nativeSessionId, messages: await sdk.readSessionMessages(thread.nativeSessionId, thread.projectPath, signal) }
      },
      listRuns: async threadId => (await store.listRuns(threadId)).map(record => runView(active.get(record.id)?.record ?? record)),
      startRun: (threadId, raw) => admit(async () => {
        ensureOpen()
        const input = validateRunInput(raw)
        const thread = await requireThread(threadId)
        if (thread.archived) throw claudeAgentError('thread-archived', 409, '请先恢复已归档会话。')
        const assets = await store.readAttachments(input.attachmentIds ?? []), attachments = assets.map(({data,...meta})=>meta)
        const prior = await store.findRunByKey(threadId, input.idempotencyKey)
        if (prior) {
          if (prior.prompt !== input.prompt || JSON.stringify(prior.attachments??[])!==JSON.stringify(attachments)) throw claudeAgentError('idempotency-conflict', 409)
          return runView(active.get(prior.id)?.record ?? prior)
        }
        if (activeByThread.has(threadId) || starting.has(threadId) || thread.nativeSessionId && nativeBusy(thread.nativeSessionId)) throw claudeAgentError('run-active', 409, 'This thread already has a running task.')
        if (permissionChanges.has(threadId) || permissionRecovery.has(threadId)) throw claudeAgentError('permissions-changing', 409)
        const environment = sdk.environment()
        if (!environment.executable.path) throw claudeAgentError(environment.executable.error?.code ?? 'claude-binary-missing', 503, environment.executable.error?.message)
        starting.add(threadId);if(thread.nativeSessionId)nativeStarting.add(thread.nativeSessionId)
        try {
          ensureOpen()
          const sessionPermissions = mergeSessionPermissions((await store.listSessionGrants(threadId)).map(grant => grant.permissions))
          const now = clock.now()
          const permissionMode = input.permissionMode ?? thread.permissionMode ?? 'default'
          const record = await store.createRun({ attachments, options: thread.options ?? defaultSessionOptions, permissionMode, id: clock.newId(), threadId, idempotencyKey: input.idempotencyKey, status: 'running', prompt: input.prompt, model: input.model ?? null,
            resolvedModel: null, effort: input.effort ?? null, nativeSessionId: thread.nativeSessionId, createdAt: now, finishedAt: null, result: null, error: null })
          // A thread still named after its directory takes its first prompt as the title until the environment names the session.
          const named = thread.titleSource === 'default' ? promptTitle(input.prompt) : ''
          await store.updateThread(threadId, { permissionMode, lastRunId: record.id, lastRunStatus: 'running', ...(named ? { title: named, titleSource: 'prompt' } : {}) }, now)
          try { ensureOpen(); return runView(launch(record, thread, sessionPermissions, assets).record) }
          catch (error) {
            const failedAt = clock.now(), message = error instanceof Error ? error.message : 'The agent could not be started.'
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'agent-start-failed'
            await store.updateRun(record.id, { status: 'failed', finishedAt: failedAt, error: { code, message } })
            await store.updateThread(threadId, { lastRunId: record.id, lastRunStatus: 'failed' }, failedAt)
            throw error
          }
        } finally { starting.delete(threadId);if(thread.nativeSessionId)nativeStarting.delete(thread.nativeSessionId) }
      }),
      getRun: async id => { const current = active.get(id)?.record ?? await store.getRun(id); return current && runView(current) },
      getRunView: id => views.get(id),
      async waitRun(id, signal) {
        const run = active.get(id)
        if (!run) { const record = await store.getRun(id); return record && runView(record) }
        await new Promise<void>(resolve => {
          const done = () => { run.waiters.delete(done); signal?.removeEventListener('abort', done); resolve() }
          run.waiters.add(done); signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done()
        })
        return runView(run.record)
      },
      async cancelRun(id) {
        const run = active.get(id)
        if (!run) { const record = await store.getRun(id); return record && runView(record) }
        if (run.record.finishedAt !== null) return runView(run.record)
        if (!run.cancelRequested) {
          run.cancelRequested = true
          run.record = { ...run.record, status: 'cancelling' }
          track(store.updateRun(id, { status: 'cancelling' }))
          publishChange(run)
          for (const view of approvals.denyAll(id, clock.now(), 'User cancelled tool execution.')) finishApproval(run, view)
          void cancellation(run)
        }
        return runView(run.record)
      },
      listPendingApprovals: threadId => approvals.pending(threadId),
      async listRecentProjects(signal) {
        ensureOpen()
        // The environment's session list is best effort: when it cannot be read, thread directories alone are returned and flagged.
        const [threads, sessions] = await Promise.all([store.listThreads(), sdk.listSessionProjects(signal).then(list => ({ ok: true as const, list }), () => ({ ok: false as const, list: [] }))])
        if (signal?.aborted) throw claudeAgentError('cancelled', 499)
        const sources: RecentProjectSource[] = [...threads.map(thread => ({ path: thread.projectPath, lastUsedAt: thread.updatedAt, source: 'threads' as const })),
          ...sessions.list.map(session => ({ path: session.path, lastUsedAt: session.lastUsedAt, source: 'claude' as const }))]
        const existing = await Promise.all(sources.map(async source => { const path = await resolveDirectory(normalizeProjectPath(source.path)); return path ? [{ ...source, path }] : [] }))
        return Object.freeze({ schemaVersion: 1, projects: mergeRecentProjects(existing.flat(), recentProjectLimit), partial: !sessions.ok })
      },
      browseDirectory: (params, signal) => { ensureOpen(); return listDirectory(parseDirectoryRequest(params, homeDirectory), { signal }) },
      listRecentModels: async () => { ensureOpen(); return Object.freeze({ schemaVersion: 1, models: await store.listRecentModels(recentModelLimit) }) },
      resolveApproval: (id, decision, answers) => admit(async () => {
        ensureOpen()
        const pending = approvals.get(id)
        const run = pending && active.get(pending.runId)
        if (!run) throw claudeAgentError('approval-resolved', 409, 'This request has already been answered or is no longer pending.')
        decisionFor(pending!, decision, answers)
        const threadId = run.record.threadId
        if (permissionChanges.has(threadId)) throw claudeAgentError('permissions-changing', 409)
        permissionChanges.add(threadId)
        let saved = false
        try {
          if (decision === 'allow-session') {
            const permissions = proposedPermissions.get(id), thread = await requireThread(threadId)
            if (!permissions || !run.record.nativeSessionId) throw claudeAgentError('invalid-input', 400)
            await store.saveSessionGrant({ id, threadId, approvalId: id, permissions, nativeSessionId: run.record.nativeSessionId, projectPath: thread.projectPath, createdAt: clock.now() })
            saved = true
          }
          if (!approvals.get(id) || run.cancelRequested || !accepting) throw claudeAgentError('approval-resolved', 409)
          const view = approvals.resolve(id, decision, answers, clock.now())
          finishApproval(run, view)
          return view
        } catch (error) {
          if (saved) try { await store.revokeSessionGrant(threadId, id, clock.now()) } catch { permissionRecovery.add(threadId) }
          throw error
        } finally { permissionChanges.delete(threadId) }
      }),
    }
    const admission: ClaudeAgentRunAdmissionPort = {
      busy: () => active.size > 0 || starting.size > 0 || admissions.size > 0 || workspace.busy(),
      pauseIfIdle() {
        if (!accepting || admission.busy()) return undefined
        pauseCount++
        let released = false
        return () => { if (!released) { released = true; pauseCount-- } }
      },
      closeAdmission() { accepting = false },
    }
    ctx.effect(() => async () => {
      accepting = false
      const workspaceClosed = workspace.close()
      // An accepted start can still be persisting its index before it creates an SDK handle. Join that boundary first.
      await Promise.allSettled([...admissions])
      const runs = [...active.values()]
      await Promise.allSettled(runs.map(run => service.cancelRun(run.record.id)))
      await Promise.allSettled(runs.map(run => run.settled))
      await workspaceClosed
      await Promise.allSettled([...writes])
    }, 'cancel and join Claude Agent runs')
    ctx.provide(claudeAgentRunsServiceKey, service)
    ctx.provide(claudeAgentRunAdmissionServiceKey, admission)
  } }
}

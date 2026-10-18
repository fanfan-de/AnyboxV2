import type { Component } from '@nya/core'
import { assetOperations, migrateAssets } from './assets.js'
import type { AttachmentView } from '../attachments.js'
import type { QueuedMessageView } from '../view.js'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration, StorageRow } from '@anybox/storage-sqlite/port'
import { claudeAgentError, defaultThreadTitle } from '../domain.js'
import type { ApprovalOutcome, ApprovalView, ClaudeAgentEffort, ClaudeAgentRunStatus, RunErrorView, RunResultView, ThreadTitleSource } from '../view.js'
import type { PermissionModeView } from '../view.js'
import { mergeSessionPermissions, validateSessionPermissions } from '../permissions.js'
import type { SessionPermissionSpec } from '../permissions.js'
import { defaultSessionOptions, validateSessionOptions } from '../workspace.js'
import type { Checkpoint, ContextUsage, SessionOptions } from '../workspace.js'

export const claudeAgentStoreServiceKey = 'claude-agent.store'
export interface ThreadRecord {
  readonly deleted?: boolean
  readonly optionsRevision?: number
  readonly options?: SessionOptions
  readonly archived?: boolean
  readonly tag?: string | null
  readonly forkedFrom?: string | null
  readonly permissionMode?: PermissionModeView
  readonly id: string
  readonly projectPath: string
  readonly title: string
  readonly titleSource: ThreadTitleSource
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastRunId: string | null
  readonly lastRunStatus: ClaudeAgentRunStatus | null
}
export interface RunRecord {
  readonly attachments?: readonly AttachmentView[]
  readonly options?: SessionOptions
  readonly contextUsage?: ContextUsage | null
  readonly permissionMode?: PermissionModeView
  readonly id: string
  readonly threadId: string
  readonly idempotencyKey: string
  readonly status: ClaudeAgentRunStatus
  readonly prompt: string
  readonly model: string | null
  readonly resolvedModel: string | null
  readonly effort: ClaudeAgentEffort | null
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly finishedAt: string | null
  readonly result: RunResultView | null
  readonly error: RunErrorView | null
}
export type ThreadPatch = Partial<Pick<ThreadRecord, 'title' | 'titleSource' | 'nativeSessionId' | 'lastRunId' | 'lastRunStatus' | 'permissionMode' | 'options' | 'optionsRevision' | 'archived' | 'tag' | 'deleted'>>
export type RunPatch = Partial<Pick<RunRecord, 'status' | 'nativeSessionId' | 'resolvedModel' | 'finishedAt' | 'result' | 'error' | 'permissionMode' | 'contextUsage'>>
export interface ApprovalPatch { readonly decision: ApprovalOutcome; readonly answers: Readonly<Record<string, string>> | null; readonly resolvedAt: string }
export interface SessionGrantRecord {
  readonly id: string
  readonly threadId: string
  readonly nativeSessionId: string
  readonly projectPath: string
  readonly approvalId: string
  readonly permissions: SessionPermissionSpec
  readonly createdAt: string
}
/** Index only: transcripts live in the Claude environment and are read through the SDK. */
export interface ClaudeAgentStorePort extends ReturnType<typeof assetOperations> {
  reserveInput(message: QueuedMessageView, requestKey: string, fingerprint: string): Promise<{ fresh: boolean; message: QueuedMessageView }>
  updateInput(message: QueuedMessageView): Promise<void>
  listInputs(runId: string): Promise<readonly QueuedMessageView[]>
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>
  listCheckpoints(threadId: string): Promise<readonly Checkpoint[]>
  /** Reserve before invoking a native mutation. Unknown writes are observed, never replayed. */
  reserveMutation(id: string, threadId: string, action: string, input: string): Promise<{ readonly fresh: boolean; readonly state: string; readonly result: string | null }>
  finishMutation(id: string, state: 'completed' | 'unknown', result: string | null): Promise<void>
  listSessionGrants(threadId: string): Promise<readonly SessionGrantRecord[]>
  /** Atomically commits both the permission choice and its session grant before a tool is released. */
  saveSessionGrant(record: SessionGrantRecord): Promise<void>
  revokeSessionGrant(threadId: string, id: string, now: string): Promise<void>
  createThread(record: ThreadRecord): Promise<ThreadRecord>
  listThreads(): Promise<readonly ThreadRecord[]>
  getThread(id: string): Promise<ThreadRecord | undefined>
  updateThread(id: string, patch: ThreadPatch, updatedAt: string): Promise<ThreadRecord>
  createRun(record: RunRecord): Promise<RunRecord>
  findRunByKey(threadId: string, idempotencyKey: string): Promise<RunRecord | undefined>
  getRun(id: string): Promise<RunRecord | undefined>
  listRuns(threadId: string): Promise<readonly RunRecord[]>
  updateRun(id: string, patch: RunPatch): Promise<RunRecord>
  recordApproval(view: ApprovalView): Promise<void>
  updateApproval(id: string, patch: ApprovalPatch): Promise<void>
  listApprovals(runId: string): Promise<readonly ApprovalView[]>
  /** Distinct requested or reported model names of the newest Runs, newest first. */
  listRecentModels(limit: number): Promise<readonly string[]>
}
const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE claude_agent_threads (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL, native_session_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_run_id TEXT, last_run_status TEXT)`)
  tx.execute('CREATE INDEX claude_agent_threads_updated ON claude_agent_threads(updated_at)')
  tx.execute(`CREATE TABLE claude_agent_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES claude_agent_threads(id), idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, effort TEXT, native_session_id TEXT, created_at TEXT NOT NULL, finished_at TEXT,
    result_json TEXT, error_json TEXT, UNIQUE(thread_id, idempotency_key))`)
  tx.execute('CREATE INDEX claude_agent_runs_thread ON claude_agent_runs(thread_id, created_at)')
  tx.execute(`CREATE TABLE claude_agent_approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    tool_name TEXT NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL, decision TEXT, answers_json TEXT, requested_at TEXT NOT NULL, resolved_at TEXT)`)
  tx.execute('CREATE INDEX claude_agent_approvals_run ON claude_agent_approvals(run_id, requested_at)')
} }, { version: 2, up(tx) {
  tx.execute("ALTER TABLE claude_agent_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'default'")
  tx.execute('ALTER TABLE claude_agent_runs ADD COLUMN resolved_model TEXT')
  // Earlier threads whose title is not the directory name were titled by the user; those titles are never replaced.
  for (const row of tx.all('SELECT id, project_path, title FROM claude_agent_threads')) {
    if (String(row.title) !== defaultThreadTitle(String(row.project_path))) tx.execute("UPDATE claude_agent_threads SET title_source='user' WHERE id=?", [row.id])
  }
} }, { version: 3, up(tx) {
  tx.execute("ALTER TABLE claude_agent_threads ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'")
  tx.execute("ALTER TABLE claude_agent_runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'")
} }, { version: 4, up(tx) {
  tx.execute(`CREATE TABLE claude_agent_session_grants (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES claude_agent_threads(id),
    native_session_id TEXT NOT NULL, project_path TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE REFERENCES claude_agent_approvals(id),
    permissions_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)`)
  tx.execute('CREATE INDEX claude_agent_session_grants_thread ON claude_agent_session_grants(thread_id, created_at)')
} }, { version: 5, up(tx) {
  tx.execute("ALTER TABLE claude_agent_threads ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'")
  tx.execute('ALTER TABLE claude_agent_threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  tx.execute('ALTER TABLE claude_agent_threads ADD COLUMN tag TEXT')
  tx.execute('ALTER TABLE claude_agent_threads ADD COLUMN forked_from TEXT')
  tx.execute('ALTER TABLE claude_agent_threads ADD COLUMN options_revision INTEGER NOT NULL DEFAULT 0')
  tx.execute(`ALTER TABLE claude_agent_runs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{"checkpointing":false}'`)
  tx.execute('ALTER TABLE claude_agent_runs ADD COLUMN context_json TEXT')
  tx.execute('CREATE TABLE claude_agent_checkpoints (id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, native_session_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(thread_id,id))')
  tx.execute('CREATE TABLE claude_agent_mutations (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, result TEXT)')
} }, { version: 6, up: migrateAssets }]
const text = (value: unknown): string => String(value)
const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const json = <T>(value: unknown): T | null => value === null || value === undefined ? null : JSON.parse(String(value)) as T
const threadRow = (row: StorageRow): ThreadRecord => Object.freeze({ deleted: row.deleted === 1, optionsRevision: Number(row.options_revision ?? 0), options: validateSessionOptions(json(row.options_json) ?? defaultSessionOptions), archived: row.archived === 1, tag: nullable(row.tag), forkedFrom: nullable(row.forked_from), permissionMode: (nullable(row.permission_mode) ?? 'default') as PermissionModeView, id: text(row.id), projectPath: text(row.project_path), title: text(row.title), titleSource: text(row.title_source) as ThreadTitleSource,
  nativeSessionId: nullable(row.native_session_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), lastRunId: nullable(row.last_run_id), lastRunStatus: nullable(row.last_run_status) as ClaudeAgentRunStatus | null })
const runRow = (row: StorageRow): RunRecord => Object.freeze({ attachments: json<AttachmentView[]>(row.attachments_json) ?? [], options: validateSessionOptions(json(row.options_json) ?? defaultSessionOptions), contextUsage: json<ContextUsage>(row.context_json), permissionMode: (nullable(row.permission_mode) ?? 'default') as PermissionModeView, id: text(row.id), threadId: text(row.thread_id), idempotencyKey: text(row.idempotency_key), status: text(row.status) as ClaudeAgentRunStatus,
  prompt: text(row.prompt), model: nullable(row.model), resolvedModel: nullable(row.resolved_model), effort: nullable(row.effort) as ClaudeAgentEffort | null, nativeSessionId: nullable(row.native_session_id),
  createdAt: text(row.created_at), finishedAt: nullable(row.finished_at), result: json<RunResultView>(row.result_json), error: json<RunErrorView>(row.error_json) })
const approvalRow = (row: StorageRow): ApprovalView => Object.freeze({ ...(json<ApprovalView>(row.request_json) as ApprovalView), schemaVersion: 1 as const, id: text(row.id), runId: text(row.run_id),
  threadId: text(row.thread_id), toolUseId: text(row.tool_use_id), toolName: text(row.tool_name), kind: text(row.kind) as ApprovalView['kind'], requestedAt: text(row.requested_at),
  decision: nullable(row.decision) as ApprovalOutcome | null, answers: json<Record<string, string>>(row.answers_json), resolvedAt: nullable(row.resolved_at) })
const threadColumns = 'id, project_path, title, title_source, native_session_id, created_at, updated_at, last_run_id, last_run_status, permission_mode, options_json, archived, tag, forked_from, options_revision, deleted'
const runColumns = 'id, thread_id, idempotency_key, status, prompt, model, resolved_model, effort, native_session_id, created_at, finished_at, result_json, error_json, permission_mode, options_json, context_json, attachments_json'
const grantRow = (row: StorageRow): SessionGrantRecord => ({ id: text(row.id), threadId: text(row.thread_id), nativeSessionId: text(row.native_session_id), projectPath: text(row.project_path), approvalId: text(row.approval_id), permissions: validateSessionPermissions(json(row.permissions_json)), createdAt: text(row.created_at) })
const activeGrantsSql = `SELECT g.* FROM claude_agent_session_grants g JOIN claude_agent_threads t ON t.id=g.thread_id
  JOIN claude_agent_approvals a ON a.id=g.approval_id WHERE g.thread_id=? AND g.revoked_at IS NULL
  AND g.native_session_id=t.native_session_id AND g.project_path=t.project_path AND a.decision='allow-session'`

/** Owns the `claude-agent` migration domain on the shared business database. Runs never survive a process restart. */
export function createClaudeAgentStoreComponent(options: { now?: () => string } = {}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'claude-agent-store', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]
    await db.migrate('claude-agent', migrations)
    const interruptedAt = (options.now ?? (() => new Date().toISOString()))()
    await db.transaction(tx => {
      const error = JSON.stringify({ code: 'interrupted', message: 'The execution process restarted before this run finished.' })
      for (const row of tx.all('SELECT id,view_json FROM claude_agent_inputs')) { const view=JSON.parse(String(row.view_json)) as QueuedMessageView; if(['queued','sent'].includes(view.status))tx.execute('UPDATE claude_agent_inputs SET view_json=? WHERE id=?',[JSON.stringify({...view,status:'unknown'}),row.id]) }
      const rows = tx.all("SELECT id, thread_id FROM claude_agent_runs WHERE status IN ('running','cancelling')")
      for (const row of rows) {
        tx.execute("UPDATE claude_agent_runs SET status='interrupted', finished_at=?, error_json=? WHERE id=?", [interruptedAt, error, row.id])
        tx.execute("UPDATE claude_agent_threads SET last_run_status='interrupted', updated_at=? WHERE id=? AND last_run_id=?", [interruptedAt, row.thread_id, row.id])
        tx.execute("UPDATE claude_agent_approvals SET decision='cancelled', resolved_at=? WHERE run_id=? AND decision IS NULL", [interruptedAt, row.id])
      }
    })
    let accepting = true
    const pending = new Set<Promise<unknown>>()
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(claudeAgentError('service-unavailable', 503))
      const result = work(); pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const getThread = (id: string) => db.read(reader => { const row = reader.get(`SELECT ${threadColumns} FROM claude_agent_threads WHERE id=?`, [id]); return row && threadRow(row) })
    const getRun = (id: string) => db.read(reader => { const row = reader.get(`SELECT ${runColumns} FROM claude_agent_runs WHERE id=?`, [id]); return row && runRow(row) })
    const assets = assetOperations(db)
    const service: ClaudeAgentStorePort = {
      beginAttachment: raw => track(() => assets.beginAttachment(raw)),
      appendAttachment: (id, raw) => track(() => assets.appendAttachment(id,raw)),
      readAttachments: ids => track(() => assets.readAttachments(ids)),
      discardAttachment: id => track(() => assets.discardAttachment(id)),
      reserveInput: (message, key, fingerprint) => track(() => db.transaction(tx => {
        const prior=tx.get('SELECT * FROM claude_agent_inputs WHERE run_id=? AND request_key=?',[message.runId,key])
        if(prior){if(prior.fingerprint!==fingerprint)throw claudeAgentError('idempotency-conflict',409);return {fresh:false,message:JSON.parse(String(prior.view_json)) as QueuedMessageView}}
        tx.execute('INSERT INTO claude_agent_inputs (id,run_id,request_key,fingerprint,view_json) VALUES (?,?,?,?,?)',[message.id,message.runId,key,fingerprint,JSON.stringify(message)]);return {fresh:true,message}
      })),
      updateInput: message => track(() => db.transaction(tx=>{tx.execute('UPDATE claude_agent_inputs SET view_json=? WHERE id=?',[JSON.stringify(message),message.id])})),
      listInputs: runId => track(() => db.read(r=>r.all('SELECT view_json FROM claude_agent_inputs WHERE run_id=? ORDER BY rowid',[runId]).map(row=>JSON.parse(String(row.view_json)) as QueuedMessageView))),
      saveCheckpoint: value => track(() => db.transaction(tx => { tx.execute('INSERT OR IGNORE INTO claude_agent_checkpoints (id,thread_id,run_id,native_session_id,created_at) VALUES (?,?,?,?,?)', [value.id, value.threadId, value.runId, value.nativeSessionId, value.createdAt]) })),
      listCheckpoints: threadId => track(() => db.read(reader => reader.all('SELECT * FROM claude_agent_checkpoints WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 1000', [threadId]).map(row => ({ id: text(row.id), threadId: text(row.thread_id), runId: text(row.run_id), nativeSessionId: text(row.native_session_id), createdAt: text(row.created_at) })))),
      reserveMutation: (id, threadId, action, input) => track(() => db.transaction(tx => {
        const row = tx.get('SELECT * FROM claude_agent_mutations WHERE id=?', [id])
        if (row) { if (row.thread_id !== threadId || row.action !== action || row.input !== input) throw claudeAgentError('idempotency-conflict', 409); return { fresh: false, state: text(row.state), result: nullable(row.result) } }
        tx.execute("INSERT INTO claude_agent_mutations (id,thread_id,action,input,state) VALUES (?,?,?,?,'pending')", [id, threadId, action, input])
        return { fresh: true, state: 'pending', result: null }
      })),
      finishMutation: (id, state, result) => track(() => db.transaction(tx => { tx.execute('UPDATE claude_agent_mutations SET state=?,result=COALESCE(?,result) WHERE id=?', [state, result, id]) })),
      listSessionGrants: threadId => track(() => db.read(reader => reader.all(`${activeGrantsSql} ORDER BY g.created_at, g.id`, [threadId]).map(grantRow))),
      saveSessionGrant: record => track(async () => {
        const spec = validateSessionPermissions(record.permissions)
        await db.transaction(tx => {
          const thread = tx.get('SELECT native_session_id, project_path FROM claude_agent_threads WHERE id=?', [record.threadId])
          const approval = tx.get('SELECT thread_id, decision FROM claude_agent_approvals WHERE id=?', [record.approvalId])
          if (!thread || thread.native_session_id !== record.nativeSessionId || thread.project_path !== record.projectPath || !approval || approval.thread_id !== record.threadId || approval.decision !== null) throw claudeAgentError('approval-resolved', 409)
          const prior = tx.all(activeGrantsSql, [record.threadId]).map(grantRow)
          if (prior.length >= 200) throw claudeAgentError('permissions-limit', 409, '此会话的授权记录已达上限，请先撤销不再使用的规则。')
          mergeSessionPermissions([...prior.map(grant => grant.permissions), spec])
          tx.execute('INSERT INTO claude_agent_session_grants (id, thread_id, native_session_id, project_path, approval_id, permissions_json, created_at) VALUES (?,?,?,?,?,?,?)',
            [record.id, record.threadId, record.nativeSessionId, record.projectPath, record.approvalId, JSON.stringify(spec), record.createdAt])
          tx.execute("UPDATE claude_agent_approvals SET decision='allow-session', resolved_at=? WHERE id=?", [record.createdAt, record.approvalId])
        })
      }),
      revokeSessionGrant: (threadId, id, now) => track(async () => {
        await db.transaction(tx => {
          if (!tx.get('SELECT id FROM claude_agent_session_grants WHERE id=? AND thread_id=?', [id, threadId])) throw claudeAgentError('permission-not-found', 404)
          tx.execute('UPDATE claude_agent_session_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND thread_id=?', [now, id, threadId])
        })
      }),
      createThread: record => track(async () => {
        return db.transaction(tx => {
          if(record.nativeSessionId){const prior=tx.get(`SELECT ${threadColumns} FROM claude_agent_threads WHERE native_session_id=? AND deleted=0`,[record.nativeSessionId]);if(prior)return threadRow(prior)}
          tx.execute(`INSERT INTO claude_agent_threads (${threadColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [record.id, record.projectPath, record.title, record.titleSource, record.nativeSessionId, record.createdAt, record.updatedAt, record.lastRunId, record.lastRunStatus, record.permissionMode ?? 'default', JSON.stringify(record.options ?? defaultSessionOptions), record.archived ? 1 : 0, record.tag ?? null, record.forkedFrom ?? null, record.optionsRevision ?? 0, record.deleted ? 1 : 0]);return record })
      }),
      listThreads: () => track(() => db.read(reader => reader.all(`SELECT ${threadColumns} FROM claude_agent_threads WHERE deleted=0 ORDER BY updated_at DESC, id`).map(threadRow))),
      getThread: id => track(() => getThread(id)),
      updateThread: (id, patch, updatedAt) => track(async () => {
        const updated = await db.transaction(tx => {
          const row = tx.get(`SELECT ${threadColumns} FROM claude_agent_threads WHERE id=?`, [id])
          if (!row) throw claudeAgentError('thread-not-found', 404)
          const next: ThreadRecord = { ...threadRow(row), ...patch, updatedAt }
          if (patch.options && patch.optionsRevision !== Number(row.options_revision) + 1) throw claudeAgentError('settings-changed', 409, '会话设置已在另一页面修改，请重新打开面板后再保存。')
          tx.execute('UPDATE claude_agent_threads SET title=?, title_source=?, native_session_id=?, updated_at=?, last_run_id=?, last_run_status=?, permission_mode=?, options_json=?, archived=?, tag=?, options_revision=?, deleted=? WHERE id=?',
            [next.title, next.titleSource, next.nativeSessionId, next.updatedAt, next.lastRunId, next.lastRunStatus, next.permissionMode ?? 'default', JSON.stringify(next.options ?? defaultSessionOptions), next.archived ? 1 : 0, next.tag ?? null, next.optionsRevision ?? 0, next.deleted ? 1 : 0, id])
          return next
        })
        return Object.freeze(updated)
      }),
      createRun: record => track(async () => {
        await db.transaction(tx => {
          if (!tx.get('SELECT id FROM claude_agent_threads WHERE id=?', [record.threadId])) throw claudeAgentError('thread-not-found', 404)
          if (tx.get('SELECT id FROM claude_agent_runs WHERE thread_id=? AND idempotency_key=?', [record.threadId, record.idempotencyKey])) throw claudeAgentError('idempotency-conflict', 409)
          tx.execute(`INSERT INTO claude_agent_runs (${runColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [record.id, record.threadId, record.idempotencyKey, record.status, record.prompt,
            record.model, record.resolvedModel, record.effort, record.nativeSessionId, record.createdAt, record.finishedAt, record.result && JSON.stringify(record.result), record.error && JSON.stringify(record.error), record.permissionMode ?? 'default', JSON.stringify(record.options ?? defaultSessionOptions), record.contextUsage ? JSON.stringify(record.contextUsage) : null, JSON.stringify(record.attachments ?? [])])
        })
        return record
      }),
      findRunByKey: (threadId, key) => track(() => db.read(reader => { const row = reader.get(`SELECT ${runColumns} FROM claude_agent_runs WHERE thread_id=? AND idempotency_key=?`, [threadId, key]); return row && runRow(row) })),
      getRun: id => track(() => getRun(id)),
      listRuns: threadId => track(() => db.read(reader => reader.all(`SELECT ${runColumns} FROM claude_agent_runs WHERE thread_id=? ORDER BY created_at, id`, [threadId]).map(runRow))),
      updateRun: (id, patch) => track(async () => {
        const updated = await db.transaction(tx => {
          const row = tx.get(`SELECT ${runColumns} FROM claude_agent_runs WHERE id=?`, [id])
          if (!row) throw claudeAgentError('run-not-found', 404)
          const next: RunRecord = { ...runRow(row), ...patch }
          tx.execute('UPDATE claude_agent_runs SET status=?, native_session_id=?, resolved_model=?, finished_at=?, result_json=?, error_json=?, permission_mode=?, context_json=? WHERE id=?',
            [next.status, next.nativeSessionId, next.resolvedModel, next.finishedAt, next.result && JSON.stringify(next.result), next.error && JSON.stringify(next.error), next.permissionMode ?? 'default', next.contextUsage ? JSON.stringify(next.contextUsage) : null, id])
          return next
        })
        return Object.freeze(updated)
      }),
      recordApproval: view => track(async () => {
        const { id, runId, threadId, toolUseId, toolName, kind, requestedAt, decision, answers, resolvedAt, ...request } = view
        await db.transaction(tx => { tx.execute('INSERT INTO claude_agent_approvals (id, run_id, thread_id, tool_use_id, tool_name, kind, request_json, decision, answers_json, requested_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [id, runId, threadId, toolUseId, toolName, kind, JSON.stringify(request), decision, answers && JSON.stringify(answers), requestedAt, resolvedAt]) })
      }),
      updateApproval: (id, patch) => track(async () => {
        await db.transaction(tx => { tx.execute('UPDATE claude_agent_approvals SET decision=?, answers_json=?, resolved_at=? WHERE id=?', [patch.decision, patch.answers && JSON.stringify(patch.answers), patch.resolvedAt, id]) })
      }),
      listApprovals: runId => track(() => db.read(reader => reader.all('SELECT * FROM claude_agent_approvals WHERE run_id=? ORDER BY requested_at, id', [runId]).map(approvalRow))),
      listRecentModels: limit => track(() => db.read(reader => {
        const rows = reader.all('SELECT model, resolved_model FROM claude_agent_runs WHERE model IS NOT NULL OR resolved_model IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 200')
        const models: string[] = []
        for (const row of rows) for (const value of [row.model, row.resolved_model]) if (value !== null && value !== undefined && !models.includes(String(value))) models.push(String(value))
        return models.slice(0, limit)
      })),
    }
    ctx.effect(() => async () => { accepting = false; await Promise.allSettled([...pending]) }, 'join Claude Agent index writes')
    ctx.provide(claudeAgentStoreServiceKey, service)
  } }
}

import type { Component } from '@nya/core'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageRow } from '../../../../storage/port.js'
import { claudeAgentError, defaultThreadTitle } from '../domain.js'
import type { ApprovalOutcome, ApprovalView, ClaudeAgentEffort, ClaudeAgentRunStatus, RunErrorView, RunResultView, ThreadTitleSource } from '../view.js'

export const claudeAgentStoreServiceKey = 'claude-agent.store'
export interface ThreadRecord {
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
export type ThreadPatch = Partial<Pick<ThreadRecord, 'title' | 'titleSource' | 'nativeSessionId' | 'lastRunId' | 'lastRunStatus'>>
export type RunPatch = Partial<Pick<RunRecord, 'status' | 'nativeSessionId' | 'resolvedModel' | 'finishedAt' | 'result' | 'error'>>
export interface ApprovalPatch { readonly decision: ApprovalOutcome; readonly answers: Readonly<Record<string, string>> | null; readonly resolvedAt: string }
/** Index only: transcripts live in the Claude environment and are read through the SDK. */
export interface ClaudeAgentStorePort {
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
} }]
const text = (value: unknown): string => String(value)
const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const json = <T>(value: unknown): T | null => value === null || value === undefined ? null : JSON.parse(String(value)) as T
const threadRow = (row: StorageRow): ThreadRecord => Object.freeze({ id: text(row.id), projectPath: text(row.project_path), title: text(row.title), titleSource: text(row.title_source) as ThreadTitleSource,
  nativeSessionId: nullable(row.native_session_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), lastRunId: nullable(row.last_run_id), lastRunStatus: nullable(row.last_run_status) as ClaudeAgentRunStatus | null })
const runRow = (row: StorageRow): RunRecord => Object.freeze({ id: text(row.id), threadId: text(row.thread_id), idempotencyKey: text(row.idempotency_key), status: text(row.status) as ClaudeAgentRunStatus,
  prompt: text(row.prompt), model: nullable(row.model), resolvedModel: nullable(row.resolved_model), effort: nullable(row.effort) as ClaudeAgentEffort | null, nativeSessionId: nullable(row.native_session_id),
  createdAt: text(row.created_at), finishedAt: nullable(row.finished_at), result: json<RunResultView>(row.result_json), error: json<RunErrorView>(row.error_json) })
const approvalRow = (row: StorageRow): ApprovalView => Object.freeze({ ...(json<ApprovalView>(row.request_json) as ApprovalView), schemaVersion: 1 as const, id: text(row.id), runId: text(row.run_id),
  threadId: text(row.thread_id), toolUseId: text(row.tool_use_id), toolName: text(row.tool_name), kind: text(row.kind) as ApprovalView['kind'], requestedAt: text(row.requested_at),
  decision: nullable(row.decision) as ApprovalOutcome | null, answers: json<Record<string, string>>(row.answers_json), resolvedAt: nullable(row.resolved_at) })
const threadColumns = 'id, project_path, title, title_source, native_session_id, created_at, updated_at, last_run_id, last_run_status'
const runColumns = 'id, thread_id, idempotency_key, status, prompt, model, resolved_model, effort, native_session_id, created_at, finished_at, result_json, error_json'

/** Owns the `claude-agent` migration domain on the shared business database. Runs never survive a process restart. */
export function createClaudeAgentStoreComponent(options: { now?: () => string } = {}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: 'claude-agent-store', inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey]
    await db.migrate('claude-agent', migrations)
    const interruptedAt = (options.now ?? (() => new Date().toISOString()))()
    await db.transaction(tx => {
      const error = JSON.stringify({ code: 'interrupted', message: 'The execution process restarted before this run finished.' })
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
    const service: ClaudeAgentStorePort = {
      createThread: record => track(async () => {
        await db.transaction(tx => { tx.execute(`INSERT INTO claude_agent_threads (${threadColumns}) VALUES (?,?,?,?,?,?,?,?,?)`,
          [record.id, record.projectPath, record.title, record.titleSource, record.nativeSessionId, record.createdAt, record.updatedAt, record.lastRunId, record.lastRunStatus]) })
        return record
      }),
      listThreads: () => track(() => db.read(reader => reader.all(`SELECT ${threadColumns} FROM claude_agent_threads ORDER BY updated_at DESC, id`).map(threadRow))),
      getThread: id => track(() => getThread(id)),
      updateThread: (id, patch, updatedAt) => track(async () => {
        const updated = await db.transaction(tx => {
          const row = tx.get(`SELECT ${threadColumns} FROM claude_agent_threads WHERE id=?`, [id])
          if (!row) throw claudeAgentError('thread-not-found', 404)
          const next: ThreadRecord = { ...threadRow(row), ...patch, updatedAt }
          tx.execute('UPDATE claude_agent_threads SET title=?, title_source=?, native_session_id=?, updated_at=?, last_run_id=?, last_run_status=? WHERE id=?',
            [next.title, next.titleSource, next.nativeSessionId, next.updatedAt, next.lastRunId, next.lastRunStatus, id])
          return next
        })
        return Object.freeze(updated)
      }),
      createRun: record => track(async () => {
        await db.transaction(tx => {
          if (!tx.get('SELECT id FROM claude_agent_threads WHERE id=?', [record.threadId])) throw claudeAgentError('thread-not-found', 404)
          if (tx.get('SELECT id FROM claude_agent_runs WHERE thread_id=? AND idempotency_key=?', [record.threadId, record.idempotencyKey])) throw claudeAgentError('idempotency-conflict', 409)
          tx.execute(`INSERT INTO claude_agent_runs (${runColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [record.id, record.threadId, record.idempotencyKey, record.status, record.prompt,
            record.model, record.resolvedModel, record.effort, record.nativeSessionId, record.createdAt, record.finishedAt, record.result && JSON.stringify(record.result), record.error && JSON.stringify(record.error)])
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
          tx.execute('UPDATE claude_agent_runs SET status=?, native_session_id=?, resolved_model=?, finished_at=?, result_json=?, error_json=? WHERE id=?',
            [next.status, next.nativeSessionId, next.resolvedModel, next.finishedAt, next.result && JSON.stringify(next.result), next.error && JSON.stringify(next.error), id])
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

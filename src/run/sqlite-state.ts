import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { LLMPlan, LLMSnapshot } from '../llm/port.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../storage/port.js'
import {
  assemblePath, treeError, createRun, createSession, requestCancellation, settleRun, validateRunInput,
} from './domain.js'
import type { Run, RunInput, RunOutcome, Session, ConversationNode, NodePage, NodeQuery, RunQuery } from './domain.js'
import { advanceExecution, initialRunExecution, parseRunExecution, parseRunEvent } from './execution.js'
import type { ActiveRunEvent, RunEvent, RunExecution } from './execution.js'

export const stateServiceKey = 'harness.state'

export interface StatePort {
  createSession(id: string, projectId: string, agentId: string, now: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  findAcceptedRun(input: RunInput): Promise<Run | undefined>
  acceptRun(id: string, input: RunInput, now: string,
    prompts: readonly PromptSnapshot[], plan: LLMPlan): Promise<{ readonly run: Run; readonly created: boolean }>
  getRun(id: string): Promise<Run | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunPrompts(id: string): Promise<readonly PromptSnapshot[] | undefined>
  /** The native plan exists only while this process owns the accepted Run. */
  getRunPlan(id: string): Promise<LLMPlan | undefined>
  getRunExecution(id: string): Promise<RunExecution | undefined>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
  recordRunEvent(id: string, event: ActiveRunEvent, at: string): Promise<RunExecution | undefined>
  requestCancellation(id: string, now: string): Promise<Run | undefined>
  settleRun(id: string, outcome: RunOutcome, now: string): Promise<Run>
}

const migrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE harness_sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES harness_projects(id),
      agent_id TEXT NOT NULL, created_at TEXT NOT NULL, turns_json TEXT NOT NULL
    )`)
    tx.execute('CREATE INDEX harness_sessions_project ON harness_sessions(project_id, created_at, id)')
    tx.execute(`CREATE TABLE harness_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES harness_sessions(id),
      idempotency_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      prompts_json TEXT NOT NULL, llm_snapshot_json TEXT NOT NULL,
      output TEXT, error TEXT, error_category TEXT,
      UNIQUE(session_id, idempotency_key)
    )`)
    tx.execute('CREATE INDEX harness_runs_session ON harness_runs(session_id, created_at, id)')
  },
}, {
  version: 2,
  up(tx) {
    tx.execute(`ALTER TABLE harness_runs ADD COLUMN execution_json TEXT NOT NULL DEFAULT '${JSON.stringify(initialRunExecution)}'`)
    tx.execute(`CREATE TABLE harness_run_events (
      run_id TEXT NOT NULL REFERENCES harness_runs(id), seq INTEGER NOT NULL,
      at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, seq)
    )`)
    tx.execute(`UPDATE harness_runs SET execution_json = ? WHERE status NOT IN ('running', 'cancelling')`,
      [JSON.stringify({ ...initialRunExecution, phase: 'terminal' })])
  },
}, {
  version: 3,
  up(tx) {
    tx.execute('CREATE UNIQUE INDEX harness_runs_identity ON harness_runs(session_id, id)')
    tx.execute(`CREATE TABLE harness_nodes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES harness_sessions(id), parent_id TEXT,
      input TEXT NOT NULL, output TEXT NOT NULL, source_run_id TEXT UNIQUE,
      CHECK(parent_id IS NULL OR parent_id != id),
      UNIQUE(session_id, id),
      FOREIGN KEY(session_id, parent_id) REFERENCES harness_nodes(session_id, id),
      FOREIGN KEY(session_id, source_run_id) REFERENCES harness_runs(session_id, id)
    )`)
    tx.execute('CREATE INDEX harness_nodes_children ON harness_nodes(session_id, parent_id, seq)')
    tx.execute("ALTER TABLE harness_runs ADD COLUMN history_kind TEXT NOT NULL DEFAULT 'legacy-unknown'")
    tx.execute('ALTER TABLE harness_runs ADD COLUMN parent_node_id TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN result_node_id TEXT REFERENCES harness_nodes(id)')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN context_version TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    for (const row of tx.all('SELECT id, turns_json FROM harness_sessions')) {
      const sessionId = required(row, 'id')
      const turns: unknown = JSON.parse(required(row, 'turns_json'))
      if (!Array.isArray(turns)) throw new Error('invalid legacy turns')
      let parent: string | null = null
      for (const [index, turn] of turns.entries()) {
        if (!turn || typeof turn.input !== 'string' || typeof turn.output !== 'string') throw new Error('invalid legacy turn')
        const id = `legacy:${sessionId.length}:${sessionId}:${index}`
        tx.execute('INSERT INTO harness_nodes (id, session_id, parent_id, input, output) VALUES (?, ?, ?, ?, ?)',
          [id, sessionId, parent, turn.input, turn.output])
        parent = id
      }
    }
    tx.execute('ALTER TABLE harness_sessions DROP COLUMN turns_json')
    tx.execute(`CREATE TRIGGER harness_nodes_immutable BEFORE UPDATE ON harness_nodes
      BEGIN SELECT RAISE(ABORT, 'conversation nodes are immutable'); END`)
    tx.execute(`CREATE TRIGGER harness_nodes_retained BEFORE DELETE ON harness_nodes
      BEGIN SELECT RAISE(ABORT, 'conversation nodes cannot be deleted'); END`)
    tx.execute(`CREATE TRIGGER harness_nodes_source BEFORE INSERT ON harness_nodes
      WHEN NEW.source_run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM harness_runs WHERE id = NEW.source_run_id AND session_id = NEW.session_id
          AND status = 'completed' AND history_kind = 'tree' AND parent_node_id IS NEW.parent_id
          AND input = NEW.input AND output = NEW.output)
      BEGIN SELECT RAISE(ABORT, 'invalid node source'); END`)
    tx.execute(`CREATE TRIGGER harness_runs_history_insert BEFORE INSERT ON harness_runs
      WHEN NEW.history_kind != 'tree' OR NEW.context_version IS NOT 'dialogue-v1'
        OR NEW.result_node_id IS NOT NULL
        OR (NEW.parent_node_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM harness_nodes WHERE id = NEW.parent_node_id AND session_id = NEW.session_id))
      BEGIN SELECT RAISE(ABORT, 'invalid Run history'); END`)
    tx.execute(`CREATE TRIGGER harness_runs_history_immutable
      BEFORE UPDATE OF session_id, input, idempotency_key, history_kind, parent_node_id, context_version ON harness_runs
      BEGIN SELECT RAISE(ABORT, 'Run history is immutable'); END`)
    tx.execute(`CREATE TRIGGER harness_runs_result BEFORE UPDATE OF result_node_id ON harness_runs
      WHEN NEW.result_node_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM harness_nodes WHERE id = NEW.result_node_id AND session_id = NEW.session_id
          AND source_run_id = NEW.id AND parent_id IS NEW.parent_node_id
          AND input = NEW.input AND output = NEW.output)
      BEGIN SELECT RAISE(ABORT, 'invalid Run result'); END`)
    tx.execute(`CREATE TRIGGER harness_runs_result_immutable BEFORE UPDATE OF result_node_id ON harness_runs
      WHEN OLD.result_node_id IS NOT NULL AND NEW.result_node_id IS NOT OLD.result_node_id
      BEGIN SELECT RAISE(ABORT, 'Run result is immutable'); END`)
  },
}]

function required(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`invalid stored run state: ${key}`)
  return value
}

function optional(row: StorageRow, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`invalid stored run state: ${key}`)
  return value
}

function sessionFromRow(row: StorageRow): Session {
  return Object.freeze({
    id: required(row, 'id'), projectId: required(row, 'project_id'),
    agentId: required(row, 'agent_id'), createdAt: required(row, 'created_at'),
  })
}

function nodeFromRow(row: StorageRow): ConversationNode {
  return Object.freeze({ id: required(row, 'id'), sessionId: required(row, 'session_id'),
    parentId: optional(row, 'parent_id') ?? null, input: required(row, 'input'), output: required(row, 'output'),
    sourceRunId: optional(row, 'source_run_id') ?? null })
}

function requireSession(reader: StorageReader, id: string): void {
  if (!reader.get('SELECT id FROM harness_sessions WHERE id = ?', [id])) throw new Error(`unknown session ${id}`)
}

function nodePath(reader: StorageReader, sessionId: string, id: string | null): readonly ConversationNode[] {
  requireSession(reader, sessionId)
  const ancestors: ConversationNode[] = []
  const seen = new Set<string>()
  let current = id
  while (current !== null) {
    if (seen.has(current)) throw treeError('invalid-history')
    seen.add(current)
    const row = reader.get('SELECT * FROM harness_nodes WHERE session_id = ? AND id = ?', [sessionId, current])
    if (!row) throw treeError(ancestors.length ? 'invalid-history' : 'node-not-found')
    const node = nodeFromRow(row)
    ancestors.push(node)
    current = node.parentId
  }
  return assemblePath(sessionId, id, ancestors)
}

function promptsFromRow(row: StorageRow): readonly PromptSnapshot[] {
  const prompts: unknown = JSON.parse(required(row, 'prompts_json'))
  if (!Array.isArray(prompts) || prompts.some(item => !item || typeof item.versionId !== 'string' ||
    typeof item.documentId !== 'string' || typeof item.kind !== 'string' ||
    typeof item.role !== 'string' || typeof item.content !== 'string')) {
    throw new Error('invalid stored Run prompts')
  }
  return Object.freeze(prompts.map(item => Object.freeze({ ...item }))) as readonly PromptSnapshot[]
}

function runFromRow(row: StorageRow): Run {
  const snapshot: unknown = JSON.parse(required(row, 'llm_snapshot_json'))
  if (!snapshot || typeof snapshot !== 'object' ||
    !('profileId' in snapshot) || typeof snapshot.profileId !== 'string' ||
    !('configVersion' in snapshot) || typeof snapshot.configVersion !== 'string') {
    throw new Error('invalid stored Run model snapshot')
  }
  const prompts = promptsFromRow(row)
  return Object.freeze({
    id: required(row, 'id'), sessionId: required(row, 'session_id'),
    input: required(row, 'input'), idempotencyKey: required(row, 'idempotency_key'),
    status: required(row, 'status') as Run['status'],
    history: required(row, 'history_kind') === 'tree'
      ? Object.freeze({ kind: 'tree' as const, parentNodeId: optional(row, 'parent_node_id') ?? null })
      : Object.freeze({ kind: 'legacy-unknown' as const }),
    contextVersion: optional(row, 'context_version') as Run['contextVersion'] ?? null,
    revision: Number(row.revision),
    ...(optional(row, 'result_node_id') ? { resultNodeId: optional(row, 'result_node_id') } : {}),
    createdAt: required(row, 'created_at'), updatedAt: required(row, 'updated_at'),
    promptVersionIds: Object.freeze(prompts.map(prompt => prompt.versionId)),
    llmSnapshot: Object.freeze({ profileId: snapshot.profileId, configVersion: snapshot.configVersion }) satisfies LLMSnapshot,
    ...(optional(row, 'output') === undefined ? {} : { output: optional(row, 'output') }),
    ...(optional(row, 'error') === undefined ? {} : { error: optional(row, 'error') }),
    ...(optional(row, 'error_category') === undefined ? {} : { errorCategory: optional(row, 'error_category') as Run['errorCategory'] }),
  })
}

function getRun(reader: StorageReader, id: string): Run | undefined {
  const row = reader.get('SELECT * FROM harness_runs WHERE id = ?', [id])
  return row ? runFromRow(row) : undefined
}

function accepted(reader: StorageReader, input: RunInput): Run | undefined {
  const session = reader.get('SELECT id FROM harness_sessions WHERE id = ?', [input.sessionId])
  if (!session) throw new Error(`unknown session ${input.sessionId}`)
  const prior = reader.get('SELECT * FROM harness_runs WHERE session_id = ? AND idempotency_key = ?',
    [input.sessionId, input.idempotencyKey])
  if (prior) {
    const run = runFromRow(prior)
    if (run.input !== input.input || run.history.kind !== 'tree' || run.history.parentNodeId !== input.parentNodeId) throw treeError('idempotency-conflict')
    return run
  }
  return undefined
}

/** One database-backed owner for all projects' Session and Run state. */
export function createSqliteStateComponent(inputs: RuntimeInputs): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-sqlite-state',
    inject: [localStorageServiceKey, projectServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey]
      await db.migrate('run-state', migrations)
      // A previous process cannot own an in-flight call. Never replay its side effects.
      await db.transaction(tx => {
        for (const row of tx.all("SELECT id, execution_json FROM harness_runs WHERE status IN ('running', 'cancelling')")) {
          const id = required(row, 'id')
          const prior = parseRunExecution(required(row, 'execution_json'))
          const at = inputs.now()
          const event = { kind: 'interrupted' as const, previousPhase: prior.phase }
          const next = advanceExecution(prior, event)
          tx.execute("UPDATE harness_runs SET status = 'interrupted', updated_at = ?, execution_json = ?, revision = revision + 1 WHERE id = ?",
            [at, JSON.stringify(next), id])
          tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
            [id, next.revision, at, JSON.stringify(event)])
        }
      })
      const plans = new Map<string, LLMPlan>()
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      ctx.effect(() => async () => {
        accepting = false
        await Promise.allSettled([...pending])
        plans.clear()
      }, 'join persistent state operations')
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(new Error('state is closing'))
        const result = work()
        pending.add(result)
        void result.finally(() => pending.delete(result)).catch(() => {})
        return result
      }
      const service: StatePort = {
        createSession(id, projectId, agentId, now) {
          return track(() => db.transaction(tx => {
            if (!tx.get('SELECT id FROM harness_projects WHERE id = ?', [projectId])) {
              throw new Error(`unknown project ${projectId}`)
            }
            const session = createSession(id, projectId, agentId, now)
            tx.execute('INSERT INTO harness_sessions (id, project_id, agent_id, created_at) VALUES (?, ?, ?, ?)',
              [id, projectId, agentId, now])
            return session
          }))
        },
        getSession(id) {
          return track(() => db.read(reader => {
            const row = reader.get('SELECT * FROM harness_sessions WHERE id = ?', [id])
            return row ? sessionFromRow(row) : undefined
          }))
        },
        listSessions(projectId) {
          return track(() => db.read(reader => Object.freeze(reader.all(
            'SELECT * FROM harness_sessions WHERE project_id = ? ORDER BY created_at, id', [projectId],
          ).map(sessionFromRow))))
        },
        getNode(sessionId, id) {
          return track(() => db.read(reader => {
            requireSession(reader, sessionId)
            const row = reader.get('SELECT * FROM harness_nodes WHERE session_id = ? AND id = ?', [sessionId, id])
            return row ? nodeFromRow(row) : undefined
          }))
        },
        getNodePath(sessionId, id) { return track(() => db.read(reader => nodePath(reader, sessionId, id))) },
        listNodes(sessionId, parentId, query = {}) {
          return track(() => db.read(reader => {
            nodePath(reader, sessionId, parentId)
            const limit = query.limit ?? 50
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid node page limit')
            let after = 0
            if (query.cursor !== undefined) {
              const row = reader.get('SELECT seq FROM harness_nodes WHERE session_id = ? AND parent_id IS ? AND id = ?',
                [sessionId, parentId, query.cursor])
              if (!row) throw new TypeError('invalid node cursor')
              after = Number(row.seq)
            }
            const rows = reader.all('SELECT * FROM harness_nodes WHERE session_id = ? AND parent_id IS ? AND seq > ? ORDER BY seq LIMIT ?',
              [sessionId, parentId, after, limit + 1])
            const nodes = Object.freeze(rows.slice(0, limit).map(nodeFromRow))
            return Object.freeze({ nodes, ...(rows.length > limit ? { nextCursor: nodes.at(-1)!.id } : {}) })
          }))
        },
        getRunByKey(sessionId, key) {
          return track(() => db.read(reader => {
            requireSession(reader, sessionId)
            const row = reader.get('SELECT * FROM harness_runs WHERE session_id = ? AND idempotency_key = ?', [sessionId, key])
            return row ? runFromRow(row) : undefined
          }))
        },
        findAcceptedRun(raw) {
          return track(() => db.read(reader => accepted(reader, validateRunInput(raw))))
        },
        acceptRun(id, raw, now, prompts, plan) {
          return track(async () => {
            const input = validateRunInput(raw)
            const result = await db.transaction(tx => {
              const prior = accepted(tx, input)
              if (prior) return { run: prior, created: false }
              nodePath(tx, input.sessionId, input.parentNodeId)
              const run = createRun(id, input, prompts, plan, now)
              tx.execute(`INSERT INTO harness_runs (
                id, session_id, idempotency_key, input, status, created_at, updated_at,
                prompts_json, llm_snapshot_json, history_kind, parent_node_id, context_version
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id, input.sessionId, input.idempotencyKey, input.input, run.status, now, now,
                JSON.stringify(prompts), JSON.stringify(plan.snapshot), 'tree', input.parentNodeId, 'dialogue-v1',
              ])
              return { run, created: true }
            })
            if (result.created) plans.set(result.run.id, plan)
            return result
          })
        },
        getRun(id) { return track(() => db.read(reader => getRun(reader, id))) },
        listRuns(sessionId, query = {}) {
          return track(() => db.read(reader => {
            if (!reader.get('SELECT id FROM harness_sessions WHERE id = ?', [sessionId])) {
              throw new Error(`unknown session ${sessionId}`)
            }
            return Object.freeze(reader.all(
              'SELECT * FROM harness_runs WHERE session_id = ? ORDER BY created_at, id', [sessionId],
            ).map(runFromRow).filter(run => (!query.active || run.status === 'running' || run.status === 'cancelling') &&
              (query.parentNodeId === undefined || (run.history.kind === 'tree' && run.history.parentNodeId === query.parentNodeId))))
          }))
        },
        getRunPrompts(id) {
          return track(() => db.read(reader => {
            const row = reader.get('SELECT prompts_json FROM harness_runs WHERE id = ?', [id])
            return row ? promptsFromRow(row) : undefined
          }))
        },
        getRunPlan(id) { return track(async () => plans.get(id)) },
        getRunExecution(id) {
          return track(() => db.read(reader => {
            const row = reader.get('SELECT execution_json FROM harness_runs WHERE id = ?', [id])
            return row ? parseRunExecution(required(row, 'execution_json')) : undefined
          }))
        },
        getRunEvents(id, afterSeq = 0) {
          return track(() => db.read(reader => {
            if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('invalid event cursor')
            if (!reader.get('SELECT id FROM harness_runs WHERE id = ?', [id])) return undefined
            return Object.freeze(reader.all(
              'SELECT seq, at, payload_json FROM harness_run_events WHERE run_id = ? AND seq > ? ORDER BY seq', [id, afterSeq],
            ).map(row => parseRunEvent(required(row, 'payload_json'), Number(row.seq), required(row, 'at'))))
          }))
        },
        recordRunEvent(id, event, at) {
          return track(() => db.transaction(tx => {
            const row = tx.get('SELECT status, execution_json FROM harness_runs WHERE id = ?', [id])
            if (!row) throw new Error(`unknown run ${id}`)
            const status = required(row, 'status')
            if (status !== 'running' && status !== 'cancelling') return undefined
            if (status !== 'running' && (event.kind === 'model-started' || event.kind === 'tool-started')) return undefined
            const next = advanceExecution(parseRunExecution(required(row, 'execution_json')), event)
            tx.execute('UPDATE harness_runs SET execution_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
              [JSON.stringify(next), at, id])
            tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
              [id, next.revision, at, JSON.stringify(event)])
            return next
          }))
        },
        requestCancellation(id, now) {
          return track(() => db.transaction(tx => {
            const run = getRun(tx, id)
            if (!run) return undefined
            const next = requestCancellation(run, now)
            if (next !== run) tx.execute('UPDATE harness_runs SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
              [next.status, next.updatedAt, id])
            return getRun(tx, id)
          }))
        },
        settleRun(id, outcome, now) {
          return track(async () => {
            const next = await db.transaction(tx => {
              const run = getRun(tx, id)
              if (!run) throw new Error(`unknown run ${id}`)
              const next = settleRun(run, outcome, now)
              if (next === run) return run
              const row = tx.get('SELECT execution_json FROM harness_runs WHERE id = ?', [id])!
              const execution = advanceExecution(parseRunExecution(required(row, 'execution_json')),
                { kind: 'terminal', status: next.status, ...(next.errorCategory ? { errorCategory: next.errorCategory } : {}) })
              const event = { kind: 'terminal', status: next.status,
                ...(next.errorCategory ? { errorCategory: next.errorCategory } : {}) }
              tx.execute(`UPDATE harness_runs SET status = ?, updated_at = ?, output = ?, error = ?, error_category = ?,
                execution_json = ?, revision = revision + 1 WHERE id = ?`, [next.status, next.updatedAt, next.output ?? null,
                next.error ?? null, next.errorCategory ?? null, JSON.stringify(execution), id])
              tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
                [id, execution.revision, now, JSON.stringify(event)])
              if (next.status === 'completed') {
                if (run.history.kind !== 'tree') throw treeError('invalid-history')
                const nodeId = inputs.newId()
                tx.execute('INSERT INTO harness_nodes (id, session_id, parent_id, input, output, source_run_id) VALUES (?, ?, ?, ?, ?, ?)',
                  [nodeId, run.sessionId, run.history.parentNodeId, run.input, next.output!, run.id])
                tx.execute('UPDATE harness_runs SET result_node_id = ? WHERE id = ?', [nodeId, run.id])
              }
              return getRun(tx, id)!
            })
            if (next.status !== 'running' && next.status !== 'cancelling') plans.delete(id)
            return next
          })
        },
      }
      ctx.provide(stateServiceKey, service)
    },
  }
}

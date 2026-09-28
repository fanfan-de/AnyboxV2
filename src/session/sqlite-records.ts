/** SQLite implementation owned by the Session component; no runtime model plans or Nya services. */
import type { RuntimeInputs } from '../contracts.js'
import type { ExecutionSnapshot } from '@anybox/models'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../storage/port.js'
import { assemblePath, treeError, createSession } from './domain.js'
import type { Session, ConversationNode } from './domain.js'
import { createRun, requestCancellation, settleRun, validateRunInput } from '../run/domain.js'
import type { Run, RunInput } from '../run/domain.js'
import { advanceExecution, initialRunExecution, parseRunExecution, parseRunEvent } from '../run/execution.js'
import type { SessionPort, SessionRunPort } from './port.js'

type SessionRecords = Omit<SessionPort, 'createSession'> & SessionRunPort & {
  createSession(id: string, projectId: string, agentId: string, now: string, modelId?: string | null): Promise<Session>
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
}, {
  version: 4,
  up(tx) {
    tx.execute('ALTER TABLE harness_sessions ADD COLUMN model_id TEXT')
    tx.execute('ALTER TABLE harness_runs RENAME COLUMN llm_snapshot_json TO model_snapshot_json')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN model_id TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN requested_model_id TEXT')
    tx.execute(`CREATE TRIGGER harness_runs_model_immutable
      BEFORE UPDATE OF model_snapshot_json, model_id, requested_model_id ON harness_runs
      BEGIN SELECT RAISE(ABORT, 'Run model selection is immutable'); END`)
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
    agentId: required(row, 'agent_id'), modelId: optional(row, 'model_id') ?? null, createdAt: required(row, 'created_at'),
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
  const snapshot: unknown = JSON.parse(required(row, 'model_snapshot_json'))
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid stored Run model snapshot')
  const value = snapshot as Record<string, unknown>
  let modelSnapshot: ExecutionSnapshot | null = null
  let legacyModelSnapshot: Run['legacyModelSnapshot']
  if (typeof value.profileId === 'string' && typeof value.configVersion === 'string') {
    legacyModelSnapshot = Object.freeze({ profileId: value.profileId, configVersion: value.configVersion })
  } else {
    for (const key of ['modelId', 'modelVersionId', 'providerId', 'providerVersionId', 'remoteModelId', 'protocolId', 'protocolVersion']) {
      if (typeof value[key] !== 'string') throw new Error('invalid stored Run model snapshot')
    }
    if (!Number.isSafeInteger(value.modelRevision) || !Number.isSafeInteger(value.providerRevision) ||
      !value.options || typeof value.options !== 'object' || Array.isArray(value.options)) throw new Error('invalid stored Run model snapshot')
    modelSnapshot = Object.freeze({ modelId: value.modelId as string, modelRevision: value.modelRevision as number,
      modelVersionId: value.modelVersionId as string, providerId: value.providerId as string,
      providerRevision: value.providerRevision as number, providerVersionId: value.providerVersionId as string,
      remoteModelId: value.remoteModelId as string, protocolId: value.protocolId as string,
      protocolVersion: value.protocolVersion as string, options: Object.freeze(value.options) })
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
    modelId: optional(row, 'model_id') ?? null, requestedModelId: optional(row, 'requested_model_id') ?? null,
    modelSnapshot, ...(legacyModelSnapshot ? { legacyModelSnapshot } : {}),
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
    if (run.input !== input.input || run.history.kind !== 'tree' || run.history.parentNodeId !== input.parentNodeId || run.requestedModelId !== (input.modelId ?? null)) throw treeError('idempotency-conflict')
    return run
  }
  return undefined
}

/** Retain the historical run-state ledger and table names so existing databases need no data rewrite. */
export async function openSqliteSessionRecords(
  db: LocalStoragePort,
  inputs: RuntimeInputs,
  notify: (run: Pick<Run, 'id' | 'sessionId' | 'revision'>) => Promise<void>,
): Promise<SessionRecords> {
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

  const records: SessionRecords = {
    createSession(id, projectId, agentId, now, modelId = null) {
      return db.transaction(tx => {
        if (!tx.get('SELECT id FROM harness_projects WHERE id = ?', [projectId])) {
          throw new Error(`unknown project ${projectId}`)
        }
        const session = createSession(id, projectId, agentId, now, modelId)
        tx.execute('INSERT INTO harness_sessions (id, project_id, agent_id, created_at, model_id) VALUES (?, ?, ?, ?, ?)',
          [id, projectId, agentId, now, modelId])
        return session
      })
    },
    selectSessionModel(sessionId, modelId) {
      return db.transaction(tx => {
        requireSession(tx, sessionId)
        tx.execute('UPDATE harness_sessions SET model_id = ? WHERE id = ?', [modelId, sessionId])
        return sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [sessionId])!)
      })
    },
    getSession(id) {
      return db.read(reader => {
        const row = reader.get('SELECT * FROM harness_sessions WHERE id = ?', [id])
        return row ? sessionFromRow(row) : undefined
      })
    },
    listSessions(projectId) {
      return db.read(reader => Object.freeze(reader.all(
        'SELECT * FROM harness_sessions WHERE project_id = ? ORDER BY created_at, id', [projectId],
      ).map(sessionFromRow)))
    },
    getNode(sessionId, id) {
      return db.read(reader => {
        requireSession(reader, sessionId)
        const row = reader.get('SELECT * FROM harness_nodes WHERE session_id = ? AND id = ?', [sessionId, id])
        return row ? nodeFromRow(row) : undefined
      })
    },
    getNodePath(sessionId, id) { return db.read(reader => nodePath(reader, sessionId, id)) },
    listNodes(sessionId, parentId, query = {}) {
      return db.read(reader => {
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
      })
    },
    getRunByKey(sessionId, key) {
      return db.read(reader => {
        requireSession(reader, sessionId)
        const row = reader.get('SELECT * FROM harness_runs WHERE session_id = ? AND idempotency_key = ?', [sessionId, key])
        return row ? runFromRow(row) : undefined
      })
    },
    findAcceptedRun(raw) {
      return db.read(reader => accepted(reader, validateRunInput(raw)))
    },
    async registerRun(id, raw, now, prompts, model) {
      const input = validateRunInput(raw)
      const result = await db.transaction(tx => {
        const prior = accepted(tx, input)
        if (prior) return { run: prior, created: false }
        nodePath(tx, input.sessionId, input.parentNodeId)
        const run = createRun(id, input, prompts, model, now)
        tx.execute(`INSERT INTO harness_runs (
          id, session_id, idempotency_key, input, status, created_at, updated_at,
          prompts_json, model_snapshot_json, history_kind, parent_node_id, context_version, model_id, requested_model_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          id, input.sessionId, input.idempotencyKey, input.input, run.status, now, now,
          JSON.stringify(prompts), JSON.stringify(run.modelSnapshot), 'tree', input.parentNodeId, 'dialogue-v1', run.modelId, run.requestedModelId,
        ])
        return { run, created: true }
      })
      if (result.created) {
        await notify(result.run)
      }
      return result
    },
    getRun(id) { return db.read(reader => getRun(reader, id)) },
    listRuns(sessionId, query = {}) {
      return db.read(reader => {
        if (!reader.get('SELECT id FROM harness_sessions WHERE id = ?', [sessionId])) {
          throw new Error(`unknown session ${sessionId}`)
        }
        return Object.freeze(reader.all(
          'SELECT * FROM harness_runs WHERE session_id = ? ORDER BY created_at, id', [sessionId],
        ).map(runFromRow).filter(run => (!query.active || run.status === 'running' || run.status === 'cancelling') &&
          (query.parentNodeId === undefined || (run.history.kind === 'tree' && run.history.parentNodeId === query.parentNodeId))))
      })
    },
    loadRunContext(id) {
      return db.read(reader => {
        const row = reader.get('SELECT * FROM harness_runs WHERE id = ?', [id])
        if (!row) return undefined
        const run = runFromRow(row)
        if (run.history.kind !== 'tree' || run.contextVersion !== 'dialogue-v1') throw treeError('invalid-history')
        const session = reader.get('SELECT project_id FROM harness_sessions WHERE id = ?', [run.sessionId])
        if (!session) throw new Error('missing Run session')
        return Object.freeze({ run, projectId: required(session, 'project_id'),
          history: nodePath(reader, run.sessionId, run.history.parentNodeId), prompts: promptsFromRow(row) })
      })
    },
    getRunExecution(id) {
      return db.read(reader => {
        const row = reader.get('SELECT execution_json FROM harness_runs WHERE id = ?', [id])
        return row ? parseRunExecution(required(row, 'execution_json')) : undefined
      })
    },
    getRunEvents(id, afterSeq = 0) {
      return db.read(reader => {
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('invalid event cursor')
        if (!reader.get('SELECT id FROM harness_runs WHERE id = ?', [id])) return undefined
        return Object.freeze(reader.all(
          'SELECT seq, at, payload_json FROM harness_run_events WHERE run_id = ? AND seq > ? ORDER BY seq', [id, afterSeq],
        ).map(row => parseRunEvent(required(row, 'payload_json'), Number(row.seq), required(row, 'at'))))
      })
    },
    async recordRunEvent(id, event, at) {
      const result = await db.transaction(tx => {
        const row = tx.get('SELECT session_id, revision, status, execution_json FROM harness_runs WHERE id = ?', [id])
        if (!row) throw new Error(`unknown run ${id}`)
        const status = required(row, 'status')
        if (status !== 'running' && status !== 'cancelling') return undefined
        if (status !== 'running' && (event.kind === 'model-started' || event.kind === 'tool-started')) return undefined
        const next = advanceExecution(parseRunExecution(required(row, 'execution_json')), event)
        tx.execute('UPDATE harness_runs SET execution_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
          [JSON.stringify(next), at, id])
        tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
          [id, next.revision, at, JSON.stringify(event)])
        return { next, run: { id, sessionId: required(row, 'session_id'), revision: Number(row.revision) + 1 } }
      })
      if (result) await notify(result.run)
      return result?.next
    },
    async requestCancellation(id, now) {
      let changed = false
      const result = await db.transaction(tx => {
        const run = getRun(tx, id)
        if (!run) return undefined
        const next = requestCancellation(run, now)
        if (next !== run) {
          tx.execute('UPDATE harness_runs SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
            [next.status, next.updatedAt, id])
          changed = true
        }
        return getRun(tx, id)
      })
      if (changed && result) await notify(result)
      return result
    },
    async settleRun(id, outcome, now) {
      let changed = false
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
        changed = true
        return getRun(tx, id)!
      })
      if (changed) await notify(next)
      return next
    },
  }
  return records
}

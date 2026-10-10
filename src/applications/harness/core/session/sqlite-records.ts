import type { ProjectFilesPort } from '../project-files/port.js'
import { validateFileBatch } from '../project-files/domain.js'
import type { FileRef } from '../project-files/domain.js'
import type { ComputerOperationsPort } from '../computer/operations-port.js'
import { needsComputer } from '../computer/operations-domain.js'
import { validateToolBatch, toolOutputBytes } from '../run/domain.js'
/** SQLite implementation owned by the Session component; no runtime model plans or Nya services. */
import type { RuntimeInputs } from '../contracts.js'
import { isDeepStrictEqual } from 'node:util'
import type { ImageAssetsPort, ImageRef } from '../image/port.js'
import { inputImages, inputFiles } from '../run/program.js'
import type { NativeModelSnapshot, JsonValue } from '@anybox/models'
import type { LegacyExecutionSnapshot } from '../run/legacy-snapshot.js'
import type { NativeHistory, NativeInitialization, NativeRunInput, ProtocolBindingSnapshot, ProtocolRecord, StoredProtocolRecord, RunResumeState, RunResumeRecord } from '../run/program.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow, StorageTransaction } from '../../../../storage/port.js'
import { assemblePath, treeError, createSession, deriveSessionTitle, resolveSessionModel, sessionDefaultsConflict, agentToolsConflict } from './domain.js'
import type { Session, SessionDefaults, AgentToolsSelection, ConversationNode } from './domain.js'
import { createToolSelection, defaultToolIds, legacyToolSelection } from '../tool/catalog.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
import { requestCancellation, settleRun, validateRunInput } from '../run/domain.js'
import type { Run, RunInput } from '../run/domain.js'
import { advanceExecution, initialRunExecution, parseRunExecution, parseRunEvent } from '../run/execution.js'
import type { RunEventData } from '../run/execution.js'
import type { SessionPort, SessionRunPort } from './port.js'

type SavedSessionDefaults = Pick<SessionDefaults, 'agentId' | 'modelId' | 'revision'>
type SessionRecords = Omit<SessionPort, 'createSession' | 'getSessionDefaults' | 'setSessionDefaults' | 'importImage' | 'getImage' | 'renewImages' | 'searchProjectFiles' | 'previewProjectFile' | 'prepareProjectFiles' | 'getFileSnapshot' | 'renewProjectFiles' |
  'openProjectFileTree' | 'readProjectFileTreePage' | 'closeProjectFileTree' | 'onProjectFileTreeRetired'> & Omit<SessionRunPort, 'describeImages' | 'readFileSnapshots'> & {
  createSession(id: string, projectId: string, agentId: string, now: string, modelId?: string, fallbackModelId?: string | null): Promise<Session>
  getSessionDefaults(agentId: string): Promise<SavedSessionDefaults>
  setSessionDefaults(agentId: string, modelId: string | null, expectedRevision: number): Promise<SavedSessionDefaults>
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
}, {
  version: 5,
  up(tx) {
    tx.execute("ALTER TABLE harness_sessions ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'dialogue-v1'")
    tx.execute('ALTER TABLE harness_sessions ADD COLUMN protocol_id TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN binding_json TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN native_input_json TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN initialization_id TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN parent_context_ref TEXT')
    tx.execute('ALTER TABLE harness_runs ADD COLUMN protocol_checkpoint_json TEXT')
    tx.execute('ALTER TABLE harness_nodes ADD COLUMN context_ref TEXT REFERENCES harness_native_contexts(id)')
    tx.execute(`CREATE TABLE harness_native_initializations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES harness_sessions(id),
      protocol_id TEXT NOT NULL, payload_json TEXT NOT NULL
    )`)
    tx.execute(`CREATE TABLE harness_native_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES harness_runs(id), protocol_id TEXT NOT NULL,
      exchange_id TEXT, kind TEXT NOT NULL, format_version INTEGER NOT NULL, payload_json TEXT NOT NULL
    )`)
    tx.execute('CREATE INDEX harness_native_records_run ON harness_native_records(run_id, seq)')
    tx.execute(`CREATE TABLE harness_run_operations (
      run_id TEXT NOT NULL REFERENCES harness_runs(id), id TEXT NOT NULL, kind TEXT NOT NULL,
      intent_json TEXT NOT NULL, tool_json TEXT, status TEXT NOT NULL, observation_json TEXT,
      PRIMARY KEY(run_id, id)
    )`)
    tx.execute(`CREATE TABLE harness_native_contexts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES harness_sessions(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES harness_runs(id), protocol_id TEXT NOT NULL,
      parent_ref TEXT REFERENCES harness_native_contexts(id),
      initialization_id TEXT NOT NULL REFERENCES harness_native_initializations(id), checkpoint_json TEXT NOT NULL
    )`)
    tx.execute(`CREATE TABLE harness_native_results (
      node_id TEXT NOT NULL REFERENCES harness_nodes(id), record_id TEXT NOT NULL REFERENCES harness_native_records(id),
      ordinal INTEGER NOT NULL, PRIMARY KEY(node_id, record_id), UNIQUE(node_id, ordinal)
    )`)
    tx.execute('DROP TRIGGER harness_runs_history_insert')
    tx.execute(`CREATE TRIGGER harness_runs_history_insert BEFORE INSERT ON harness_runs
      WHEN NEW.history_kind != 'tree' OR NEW.context_version IS NOT 'native-local-v1'
        OR NEW.result_node_id IS NOT NULL OR NEW.binding_json IS NULL OR NEW.native_input_json IS NULL
        OR NEW.initialization_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM harness_sessions WHERE id = NEW.session_id AND history_mode = 'native-local-v1')
        OR (NEW.parent_node_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM harness_nodes WHERE id = NEW.parent_node_id AND session_id = NEW.session_id
            AND context_ref = NEW.parent_context_ref))
      BEGIN SELECT RAISE(ABORT, 'invalid native Run history'); END`)
    tx.execute(`CREATE TRIGGER harness_sessions_binding_immutable BEFORE UPDATE OF history_mode, protocol_id ON harness_sessions
      WHEN NEW.history_mode IS NOT OLD.history_mode OR (OLD.protocol_id IS NOT NULL AND NEW.protocol_id IS NOT OLD.protocol_id)
      BEGIN SELECT RAISE(ABORT, 'Session protocol binding is immutable'); END`)
    tx.execute(`CREATE TRIGGER harness_runs_native_immutable
      BEFORE UPDATE OF binding_json, native_input_json, initialization_id, parent_context_ref ON harness_runs
      BEGIN SELECT RAISE(ABORT, 'native Run input is immutable'); END`)
    for (const table of ['harness_native_initializations', 'harness_native_records', 'harness_native_contexts', 'harness_native_results']) {
      tx.execute(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'native records are immutable'); END`)
      tx.execute(`CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'native records are retained'); END`)
    }
  },
}, {
  version: 6,
  up(tx) { tx.execute('ALTER TABLE harness_native_records ADD COLUMN resource_refs_json TEXT') },
}, {
  version: 7,
  up(tx) {
    tx.execute('ALTER TABLE harness_sessions ADD COLUMN archived_at TEXT')
    tx.execute('CREATE INDEX harness_sessions_archived ON harness_sessions(archived_at DESC, id) WHERE archived_at IS NOT NULL')
  },
}, {
  version: 8,
  up(tx) {
    tx.execute(`CREATE TABLE harness_session_defaults (
      agent_id TEXT PRIMARY KEY, model_id TEXT,
      revision INTEGER NOT NULL CHECK(revision > 0)
    )`)
  },
}, {
  version: 9,
  up(tx) {
    tx.execute('ALTER TABLE harness_sessions ADD COLUMN tool_selection_json TEXT')
    tx.execute('UPDATE harness_sessions SET tool_selection_json = ?', [JSON.stringify(legacyToolSelection)])
    tx.execute(`CREATE TABLE harness_agent_tool_settings (
      agent_id TEXT PRIMARY KEY, tool_ids_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0)
    )`)
    tx.execute(`CREATE TRIGGER harness_sessions_tools_immutable BEFORE UPDATE OF tool_selection_json ON harness_sessions
      BEGIN SELECT RAISE(ABORT, 'Session tools are immutable'); END`)
  },
}, {
  version: 10,
  up(tx) {
    tx.execute(`CREATE TABLE harness_run_resumes (
      run_id TEXT PRIMARY KEY REFERENCES harness_runs(id), state_json TEXT NOT NULL
    )`)
  },
}]

const initialResumeState: RunResumeState = Object.freeze({ schemaVersion: 1, runOwnerEpoch: 1, revision: 0,
  stage: 'model-pending', totalToolOutputBytes: 0 })

function resumeError(code: string): Error { return Object.assign(new Error(code), { code }) }
function resumeState(reader: StorageReader, runId: string): RunResumeState | undefined {
  const row = reader.get('SELECT state_json FROM harness_run_resumes WHERE run_id = ?', [runId])
  if (!row) return undefined
  const value = JSON.parse(required(row, 'state_json')) as RunResumeState
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.runOwnerEpoch) || value.runOwnerEpoch < 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.totalToolOutputBytes) || value.totalToolOutputBytes < 0 ||
    !['model-pending', 'response', 'cleanup', 'settling'].includes(value.stage)) throw resumeError('invalid-run-resume')
  if (value.batch && (!value.batch.id || value.batch.operationIds.length !== value.batch.requests.length ||
    new Set(value.batch.operationIds).size !== value.batch.operationIds.length || value.batch.operationIds.some(id => typeof id !== 'string' || !id))) throw resumeError('invalid-run-resume')
  if (value.batch) validateToolBatch(value.batch.requests)
  return Object.freeze(value)
}
function ownedResume(reader: StorageReader, id: string, epoch?: number): RunResumeState | undefined {
  const state = resumeState(reader, id)
  if (state && (epoch ?? 1) !== state.runOwnerEpoch) throw resumeError('stale-run-owner')
  return state
}
function updateResume(tx: StorageTransaction, id: string, prior: RunResumeState, patch: Partial<RunResumeState>): RunResumeState {
  const next = Object.freeze({ ...prior, ...patch, revision: prior.revision + 1 })
  tx.execute('UPDATE harness_run_resumes SET state_json = ? WHERE run_id = ?', [serialize(next), id])
  return next
}
function runResume(reader: StorageReader, id: string): RunResumeRecord | undefined {
  const state = resumeState(reader, id), row = reader.get('SELECT * FROM harness_runs WHERE id = ?', [id])
  if (!state || !row) return undefined
  const run = runFromRow(row), session = reader.get('SELECT project_id FROM harness_sessions WHERE id = ?', [run.sessionId])!
  const initialization = reader.get('SELECT payload_json FROM harness_native_initializations WHERE id = ?', [required(row, 'initialization_id')])!
  const history = run.history.kind === 'tree' ? nativeHistory(reader, run.sessionId, run.history.parentNodeId) : undefined
  return Object.freeze({ run, projectId: required(session, 'project_id'), initialization: JSON.parse(required(initialization, 'payload_json')) as NativeInitialization,
    ...(history ? { history } : {}), records: protocolRecords(reader, id), state })
}
function cleanupOutputBytes(intent: JsonValue, result?: JsonValue): number {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) ||
    !['tool-process-cleanup', 'computer-scope-cleanup'].includes(String((intent as Record<string, JsonValue>).kind)) ||
    !result || typeof result !== 'object' || Array.isArray(result)) return 0
  const processes = (result as Record<string, JsonValue>).processes
  return Array.isArray(processes) ? processes.reduce((total, process) => {
    if (!process || typeof process !== 'object' || Array.isArray(process)) return total
    const output = (process as Record<string, JsonValue>).output
    return total + (typeof output === 'string' ? Buffer.byteLength(output, 'utf8') : 0)
  }, 0) : 0
}

function readAgentTools(reader: StorageReader, agentId: string): AgentToolsSelection {
  const row = reader.get('SELECT tool_ids_json, revision FROM harness_agent_tool_settings WHERE agent_id = ?', [agentId])
  if (!row) return Object.freeze({ agentId, toolIds: Object.freeze([...defaultToolIds]), revision: 0 })
  const toolIds: unknown = JSON.parse(required(row, 'tool_ids_json'))
  if (!Array.isArray(toolIds) || toolIds.some(id => typeof id !== 'string' || !id) || new Set(toolIds).size !== toolIds.length ||
    typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('invalid stored Agent tool settings')
  return Object.freeze({ agentId, toolIds: Object.freeze(toolIds as string[]), revision: row.revision })
}

function readSessionDefaults(reader: StorageReader, agentId: string): SavedSessionDefaults {
  const row = reader.get('SELECT model_id, revision FROM harness_session_defaults WHERE agent_id = ?', [agentId])
  if (!row) return Object.freeze({ agentId, modelId: null, revision: 0 })
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('invalid stored session defaults revision')
  return Object.freeze({ agentId, modelId: optional(row, 'model_id') ?? null, revision: row.revision })
}

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

/** Validate JSON before serialization: SDK instances, cycles, handles and undefined are not durable data. */
function serialize(value: unknown): string {
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item) throw new Error('invalid serializable record')
    if (seen.has(item)) throw new Error('cyclic record')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('invalid record object')
    seen.add(item)
    for (const value of Array.isArray(item) ? item : Object.values(item)) visit(value)
    seen.delete(item)
  }
  visit(value)
  return JSON.stringify(value)
}

function checkedBinding(value: ProtocolBindingSnapshot): ProtocolBindingSnapshot {
  if (!value || ['protocolId', 'generationId', 'driverVersion', 'loopVersion'].some(key => typeof value[key as keyof ProtocolBindingSnapshot] !== 'string' || !value[key as keyof ProtocolBindingSnapshot]) ||
    !Number.isSafeInteger(value.recordFormatVersion) || value.recordFormatVersion < 1 || !Number.isSafeInteger(value.viewSchemaVersion) || value.viewSchemaVersion < 1) throw treeError('invalid-history')
  serialize(value)
  return value
}

function protocolRecords(reader: StorageReader, runId: string): readonly StoredProtocolRecord[] {
  return Object.freeze(reader.all('SELECT * FROM harness_native_records WHERE run_id = ? ORDER BY seq', [runId]).map(row => Object.freeze({
    id: required(row, 'id'), runId: required(row, 'run_id'), protocolId: required(row, 'protocol_id'),
    kind: required(row, 'kind') as ProtocolRecord['kind'], formatVersion: Number(row.format_version),
    ...(optional(row, 'exchange_id') ? { exchangeId: required(row, 'exchange_id') } : {}),
    payload: JSON.parse(required(row, 'payload_json')) as JsonValue,
    ...(optional(row, 'resource_refs_json') ? { resourceRefs: JSON.parse(required(row, 'resource_refs_json')) } : {}),
  })))
}

function insertRecords(tx: StorageTransaction, run: Run, records: readonly ProtocolRecord[] = []): void {
  if (!run.protocolBinding && records.length) throw treeError('invalid-history')
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id || !['request', 'response', 'checkpoint', 'diagnostic'].includes(record.kind) ||
      !Number.isSafeInteger(record.formatVersion) || record.formatVersion < 1 || (record.exchangeId !== undefined && (typeof record.exchangeId !== 'string' || !record.exchangeId))) throw treeError('invalid-history')
    const payload = serialize(record.payload)
    if (record.resourceRefs !== undefined && (record.formatVersion !== 2 || record.kind !== 'request' || !Array.isArray(record.resourceRefs))) throw treeError('invalid-history')
    const resourceIds = new Set<string>()
    for (const ref of record.resourceRefs ?? []) {
      const toolImages = tx.all('SELECT observation_json FROM harness_run_operations WHERE run_id = ? AND observation_json IS NOT NULL', [run.id])
        .flatMap(row => {
          const observed = JSON.parse(required(row, 'observation_json')) as { tool?: { images?: readonly ImageRef[] } }
          return observed.tool?.images ?? []
        })
      const image = [...run.images, ...toolImages].find(image => image.assetId === ref.id)
      if (!image || resourceIds.has(ref.id) || !isDeepStrictEqual(ref, {
        id: image.assetId, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mediaType,
      })) throw treeError('invalid-history')
      resourceIds.add(ref.id)
    }
    const resources = record.resourceRefs === undefined ? null : serialize(record.resourceRefs)
    const previous = tx.get('SELECT * FROM harness_native_records WHERE id = ?', [record.id])
    if (previous) {
      if (required(previous, 'run_id') !== run.id || required(previous, 'protocol_id') !== run.protocolBinding!.protocolId ||
        required(previous, 'kind') !== record.kind || Number(previous.format_version) !== record.formatVersion ||
        (optional(previous, 'exchange_id') ?? undefined) !== record.exchangeId || required(previous, 'payload_json') !== payload ||
        (optional(previous, 'resource_refs_json') ?? null) !== resources) throw treeError('invalid-history')
      continue
    }
    tx.execute('INSERT INTO harness_native_records (id, run_id, protocol_id, exchange_id, kind, format_version, payload_json, resource_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [record.id, run.id, run.protocolBinding!.protocolId, record.exchangeId ?? null, record.kind, record.formatVersion, payload, resources])
  }
}

function appendEvent(tx: StorageTransaction, runId: string, event: RunEventData, at: string): void {
  const row = tx.get('SELECT execution_json FROM harness_runs WHERE id = ?', [runId])!
  const next = advanceExecution(parseRunExecution(required(row, 'execution_json')), event)
  tx.execute('UPDATE harness_runs SET execution_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', [serialize(next), at, runId])
  tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)', [runId, next.revision, at, serialize(event)])
}

function nativeHistory(reader: StorageReader, sessionId: string, parentNodeId: string | null): NativeHistory | undefined {
  const session = reader.get('SELECT * FROM harness_sessions WHERE id = ?', [sessionId])
  if (!session) throw new Error(`unknown session ${sessionId}`)
  if (required(session, 'history_mode') !== 'native-local-v1') throw treeError('legacy-session-readonly')
  const nodes = nodePath(reader, sessionId, parentNodeId)
  if (!parentNodeId) return undefined
  let expectedParent: string | null = null
  let initializationId: string | undefined
  const records: StoredProtocolRecord[] = []
  let lastContext: StorageRow | undefined
  let lastRun: Run | undefined
  const seen = new Set<string>()
  for (const node of nodes) {
    const stored = reader.get('SELECT context_ref FROM harness_nodes WHERE id = ?', [node.id])!
    const contextId = optional(stored, 'context_ref')
    if (!contextId || seen.has(contextId)) throw treeError('invalid-history')
    seen.add(contextId)
    const context = reader.get('SELECT * FROM harness_native_contexts WHERE id = ?', [contextId])
    const run = node.sourceRunId ? getRun(reader, node.sourceRunId) : undefined
    if (!context || !run || run.status !== 'completed' || run.contextVersion !== 'native-local-v1' || !run.protocolBinding || run.modelSnapshot?.schemaVersion !== 3 ||
      required(context, 'session_id') !== sessionId || required(context, 'run_id') !== run.id || required(context, 'protocol_id') !== optional(session, 'protocol_id') ||
      run.protocolBinding.protocolId !== required(context, 'protocol_id') || (optional(context, 'parent_ref') ?? null) !== expectedParent) throw treeError('invalid-history')
    const init = required(context, 'initialization_id')
    if (initializationId && initializationId !== init) throw treeError('invalid-history')
    initializationId = init
    const savedRecords = protocolRecords(reader, run.id)
    if (!savedRecords.length || savedRecords.some(record => record.protocolId !== run.protocolBinding!.protocolId || record.formatVersion !== run.protocolBinding!.recordFormatVersion)) throw treeError('invalid-history')
    records.push(...savedRecords)
    expectedParent = contextId
    lastContext = context; lastRun = run
  }
  const initialization = reader.get('SELECT * FROM harness_native_initializations WHERE id = ?', [initializationId!])
  if (!initialization || required(initialization, 'session_id') !== sessionId || required(initialization, 'protocol_id') !== lastRun!.protocolBinding!.protocolId) throw treeError('invalid-history')
  return Object.freeze({ contextRef: expectedParent!, initialization: JSON.parse(required(initialization, 'payload_json')) as NativeInitialization,
    modelSnapshot: lastRun!.modelSnapshot as NativeModelSnapshot, binding: lastRun!.protocolBinding!, records: Object.freeze(records),
    checkpoint: JSON.parse(required(lastContext!, 'checkpoint_json')) as JsonValue })
}

function sessionTitle(reader: StorageReader, sessionId: string, historyMode: Session['historyMode']): string | null {
  if (historyMode === 'dialogue-v1') {
    const first = reader.get('SELECT input FROM harness_nodes WHERE session_id = ? AND parent_id IS NULL ORDER BY seq LIMIT 1', [sessionId])
    return first ? deriveSessionTitle(required(first, 'input')) : null
  }
  // Run rows are retained; rowid preserves admission order even when timestamps and IDs do not.
  const first = reader.get('SELECT input, native_input_json FROM harness_runs WHERE session_id = ? ORDER BY rowid LIMIT 1', [sessionId])
  if (!first) return null
  const title = deriveSessionTitle(required(first, 'input'))
  if (title) return title
  const nativeInput = optional(first, 'native_input_json')
  return deriveSessionTitle('', storedImages(nativeInput).length, storedFiles(nativeInput).length)
}

function sessionFromRow(row: StorageRow, reader: StorageReader): Session {
  const id = required(row, 'id'), historyMode = required(row, 'history_mode') as Session['historyMode']
  return Object.freeze({
    id, title: sessionTitle(reader, id, historyMode), projectId: required(row, 'project_id'),
    archivedAt: optional(row, 'archived_at') ?? null,
    agentId: required(row, 'agent_id'), modelId: optional(row, 'model_id') ?? null, createdAt: required(row, 'created_at'),
    toolSelection: row.tool_selection_json === null ? legacyToolSelection : Object.freeze(JSON.parse(required(row, 'tool_selection_json')) as ToolSelectionSnapshot),
    historyMode, protocolId: optional(row, 'protocol_id') ?? null,
  })
}

function nodeFromRow(row: StorageRow, reader: StorageReader): ConversationNode {
  const runId = optional(row, 'source_run_id')
  const run = runId ? reader.get('SELECT native_input_json FROM harness_runs WHERE id = ?', [runId]) : undefined
  const images = storedImages(run ? optional(run, 'native_input_json') : undefined)
  return Object.freeze({ id: required(row, 'id'), sessionId: required(row, 'session_id'),
    parentId: optional(row, 'parent_id') ?? null, input: required(row, 'input'), images, files: storedFiles(run ? optional(run, 'native_input_json') : undefined), output: required(row, 'output'),
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
    const node = nodeFromRow(row, reader)
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

function storedImages(json: string | undefined): readonly ImageRef[] {
  if (!json) return Object.freeze([])
  const input = JSON.parse(json) as NativeRunInput
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3) throw treeError('invalid-history')
  const images = inputImages(input)
  if (!Array.isArray(images)) throw treeError('invalid-history')
  return Object.freeze(images.map(image => Object.freeze({ ...image })))
}

function storedFiles(json: string | undefined): readonly FileRef[] {
  if (!json) return Object.freeze([])
  const input = JSON.parse(json) as NativeRunInput
  if (![1, 2, 3].includes(input.schemaVersion)) throw treeError('invalid-history')
  const files = inputFiles(input)
  if (!Array.isArray(files)) throw treeError('invalid-history')
  try { validateFileBatch(files) } catch { throw treeError('invalid-history') }
  return Object.freeze(files.map(file => Object.freeze({ ...file })))
}

function runFromRow(row: StorageRow): Run {
  const snapshot: unknown = JSON.parse(required(row, 'model_snapshot_json'))
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid stored Run model snapshot')
  const value = snapshot as Record<string, unknown>
  let modelSnapshot: LegacyExecutionSnapshot | NativeModelSnapshot | null = null
  let legacyModelSnapshot: Run['legacyModelSnapshot']
  if (typeof value.profileId === 'string' && typeof value.configVersion === 'string') {
    legacyModelSnapshot = Object.freeze({ profileId: value.profileId, configVersion: value.configVersion })
  } else if (value.schemaVersion === 3) {
    for (const key of ['modelId', 'modelDefinitionId', 'providerDefinitionId', 'modelDefinitionVersionId', 'modelVersionId', 'providerId', 'providerVersionId', 'remoteModelId', 'protocolId', 'protocolVersion', 'registrationGenerationId', 'historyScopeEpoch']) {
      if (typeof value[key] !== 'string' || !value[key]) throw new Error('invalid native model snapshot')
    }
    if (!Number.isSafeInteger(value.modelRevision) || !Number.isSafeInteger(value.providerRevision) || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw new Error('invalid native model parameters')
    const parameters = value.parameters as Record<string, unknown>
    if (parameters.protocolId !== value.protocolId || parameters.formatVersion !== 1 || !parameters.value || typeof parameters.value !== 'object' || Array.isArray(parameters.value)) throw new Error('invalid native model parameters')
    modelSnapshot = Object.freeze(value) as unknown as NativeModelSnapshot
  } else {
    for (const key of ['modelId', 'modelVersionId', 'providerId', 'providerVersionId', 'remoteModelId', 'protocolId', 'protocolVersion']) {
      if (typeof value[key] !== 'string') throw new Error('invalid stored Run model snapshot')
    }
    if (!Number.isSafeInteger(value.modelRevision) || !Number.isSafeInteger(value.providerRevision) ||
      !value.options || typeof value.options !== 'object' || Array.isArray(value.options)) throw new Error('invalid stored Run model snapshot')
    if (value.schemaVersion !== undefined && value.schemaVersion !== 2) throw new Error('invalid stored Run model snapshot')
    if (value.schemaVersion === 2 && ['modelDefinitionId', 'providerDefinitionId', 'modelDefinitionVersionId'].some(key => typeof value[key] !== 'string')) throw new Error('invalid stored Run model snapshot')
    modelSnapshot = Object.freeze({ ...(value.schemaVersion === 2 ? { schemaVersion: 2 as const,
      modelDefinitionId: value.modelDefinitionId as string, providerDefinitionId: value.providerDefinitionId as string,
      modelDefinitionVersionId: value.modelDefinitionVersionId as string } : {}), modelId: value.modelId as string, modelRevision: value.modelRevision as number,
      modelVersionId: value.modelVersionId as string, providerId: value.providerId as string,
      providerRevision: value.providerRevision as number, providerVersionId: value.providerVersionId as string,
      remoteModelId: value.remoteModelId as string, protocolId: value.protocolId as string,
      protocolVersion: value.protocolVersion as string, options: Object.freeze(value.options) as Readonly<Record<string, JsonValue>> })
  }
  const prompts = promptsFromRow(row)
  return Object.freeze({
    id: required(row, 'id'), sessionId: required(row, 'session_id'),
    input: required(row, 'input'), idempotencyKey: required(row, 'idempotency_key'),
    images: storedImages(optional(row, 'native_input_json')),
    files: storedFiles(optional(row, 'native_input_json')),
    status: required(row, 'status') as Run['status'],
    history: required(row, 'history_kind') === 'tree'
      ? Object.freeze({ kind: 'tree' as const, parentNodeId: optional(row, 'parent_node_id') ?? null })
      : Object.freeze({ kind: 'legacy-unknown' as const }),
    contextVersion: optional(row, 'context_version') as Run['contextVersion'] ?? null,
    revision: Number(row.revision),
    ...(optional(row, 'result_node_id') ? { resultNodeId: optional(row, 'result_node_id') } : {}),
    createdAt: required(row, 'created_at'), updatedAt: required(row, 'updated_at'),
    promptVersionIds: Object.freeze(prompts.map(prompt => prompt.versionId)),
    promptSnapshots: Object.freeze(prompts),
    modelId: optional(row, 'model_id') ?? null, requestedModelId: optional(row, 'requested_model_id') ?? null,
    modelSnapshot,
    ...(optional(row, 'binding_json') ? { protocolBinding: JSON.parse(required(row, 'binding_json')) as ProtocolBindingSnapshot } : {}),
    ...(optional(row, 'native_input_json') ? { nativeInput: JSON.parse(required(row, 'native_input_json')) as NativeRunInput } : {}),
    ...(legacyModelSnapshot ? { legacyModelSnapshot } : {}),
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
    if (run.input !== input.input || run.history.kind !== 'tree' || run.history.parentNodeId !== input.parentNodeId || run.requestedModelId !== (input.modelId ?? null) ||
      !isDeepStrictEqual(run.files.map(file => file.snapshotId), (input.files ?? []).map(file => file.snapshotId)) ||
      !isDeepStrictEqual(run.images.map(image => image.assetId), (input.images ?? []).map(image => image.assetId))) throw treeError('idempotency-conflict')
    return run
  }
  return undefined
}

/** Retain the historical run-state ledger and table names so existing databases need no data rewrite. */
export async function openSqliteSessionRecords(
  db: LocalStoragePort,
  inputs: RuntimeInputs,
  notify: (run: Pick<Run, 'id' | 'sessionId' | 'revision'>) => Promise<void>,
  images: ImageAssetsPort,
  files: ProjectFilesPort,
  computers: ComputerOperationsPort,
): Promise<SessionRecords> {
  await db.migrate('run-state', migrations)
  // Only a committed protocol response authorizes tool-stage takeover. A pending model request cannot be replayed.
  await db.transaction(tx => {
    for (const row of tx.all("SELECT id, execution_json FROM harness_runs WHERE status IN ('running', 'cancelling')")) {
      const id = required(row, 'id')
      const resume = resumeState(tx, id)
      if (resume?.protocolCursor !== undefined && resume.stage !== 'model-pending') continue
      const prior = parseRunExecution(required(row, 'execution_json'))
      const at = inputs.now()
      const event = { kind: 'interrupted' as const, previousPhase: prior.phase }
      const next = advanceExecution(prior, event)
      // The model exchange cannot resume, but any independent computer scope still requires cancellation and exit.
      computers.requestCancelIn(tx, id)
      tx.execute("UPDATE harness_runs SET status = 'interrupted', updated_at = ?, execution_json = ?, revision = revision + 1 WHERE id = ?",
        [at, JSON.stringify(next), id])
      tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
        [id, next.revision, at, JSON.stringify(event)])
    }
  })

  const records: SessionRecords = {
    getAgentTools: agentId => db.read(reader => readAgentTools(reader, agentId)),
    setAgentTools(agentId, input) {
      return db.transaction(tx => {
        const current = readAgentTools(tx, agentId)
        if (current.revision !== input.expectedRevision) throw agentToolsConflict()
        const selection = createToolSelection(input.toolIds), toolIds = selection.tools.map(tool => tool.toolId)
        const revision = current.revision + 1
        tx.execute(`INSERT INTO harness_agent_tool_settings (agent_id, tool_ids_json, revision) VALUES (?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET tool_ids_json = excluded.tool_ids_json, revision = excluded.revision`,
          [agentId, serialize(toolIds), revision])
        return Object.freeze({ agentId, toolIds: Object.freeze(toolIds), revision })
      })
    },
    getSessionDefaults: agentId => db.read(reader => readSessionDefaults(reader, agentId)),
    setSessionDefaults(agentId, modelId, expectedRevision) {
      return db.transaction(tx => {
        const current = readSessionDefaults(tx, agentId)
        if (current.revision !== expectedRevision) throw sessionDefaultsConflict()
        const revision = current.revision + 1
        tx.execute(`INSERT INTO harness_session_defaults (agent_id, model_id, revision) VALUES (?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET model_id = excluded.model_id, revision = excluded.revision`, [agentId, modelId, revision])
        return Object.freeze({ agentId, modelId, revision })
      })
    },
    createSession(id, projectId, agentId, now, requestedModelId, fallbackModelId = null) {
      return db.transaction(tx => {
        if (!tx.get('SELECT id FROM harness_projects WHERE id = ?', [projectId])) {
          throw new Error(`unknown project ${projectId}`)
        }
        const modelId = resolveSessionModel(requestedModelId, readSessionDefaults(tx, agentId).modelId, fallbackModelId)
        const toolSelection = createToolSelection(readAgentTools(tx, agentId).toolIds)
        const session = createSession(id, projectId, agentId, now, modelId, toolSelection)
        tx.execute("INSERT INTO harness_sessions (id, project_id, agent_id, created_at, model_id, history_mode, tool_selection_json) VALUES (?, ?, ?, ?, ?, 'native-local-v1', ?)",
          [id, projectId, agentId, now, modelId, serialize(toolSelection)])
        return session
      })
    },
    selectSessionModel(sessionId, modelId, protocolId) {
      return db.transaction(tx => {
        requireSession(tx, sessionId)
        const session = sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [sessionId])!, tx)
        if (session.archivedAt !== null) throw treeError('session-archived')
        if (session.historyMode !== 'native-local-v1') throw treeError('legacy-session-readonly')
        if (session.protocolId && session.protocolId !== protocolId) throw treeError('protocol-mismatch')
        tx.execute('UPDATE harness_sessions SET model_id = ? WHERE id = ?', [modelId, sessionId])
        return sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [sessionId])!, tx)
      })
    },
    archiveSession(id) {
      return db.transaction(tx => {
        requireSession(tx, id)
        const session = sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [id])!, tx)
        if (session.archivedAt !== null) return session
        if (tx.get("SELECT id FROM harness_runs WHERE session_id = ? AND status IN ('running', 'cancelling') LIMIT 1", [id])) {
          throw treeError('session-has-active-runs')
        }
        tx.execute('UPDATE harness_sessions SET archived_at = ? WHERE id = ?', [inputs.now(), id])
        return sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [id])!, tx)
      })
    },
    restoreSession(id) {
      return db.transaction(tx => {
        requireSession(tx, id)
        tx.execute('UPDATE harness_sessions SET archived_at = NULL WHERE id = ?', [id])
        return sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [id])!, tx)
      })
    },
    listArchivedSessions() {
      return db.read(reader => Object.freeze(reader.all(
        'SELECT * FROM harness_sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id',
      ).map(row => sessionFromRow(row, reader))))
    },
    getSession(id) {
      return db.read(reader => {
        const row = reader.get('SELECT * FROM harness_sessions WHERE id = ?', [id])
        return row ? sessionFromRow(row, reader) : undefined
      })
    },
    listSessions(projectId) {
      return db.read(reader => Object.freeze(reader.all(
        'SELECT * FROM harness_sessions WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at, id', [projectId],
      ).map(row => sessionFromRow(row, reader))))
    },
    getNode(sessionId, id) {
      return db.read(reader => {
        requireSession(reader, sessionId)
        const row = reader.get('SELECT * FROM harness_nodes WHERE session_id = ? AND id = ?', [sessionId, id])
        return row ? nodeFromRow(row, reader) : undefined
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
        const nodes = Object.freeze(rows.slice(0, limit).map(row => nodeFromRow(row, reader)))
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
    async registerRun(id, raw, now, prompts, model, native) {
      const input = validateRunInput(raw)
      const result = await db.transaction(tx => {
        const prior = accepted(tx, input)
        if (prior) return { run: prior, created: false }
        const session = sessionFromRow(tx.get('SELECT * FROM harness_sessions WHERE id = ?', [input.sessionId])!, tx)
        if (session.archivedAt !== null) throw treeError('session-archived')
        if (session.historyMode !== 'native-local-v1') throw treeError('legacy-session-readonly')
        if (!native || model.schemaVersion !== 3) throw treeError('invalid-history')
        if (native.initialization.schemaVersion === 2 && !isDeepStrictEqual(native.initialization.toolSelection, session.toolSelection)) throw treeError('history-incompatible')
        const binding = checkedBinding(native.binding)
        if (binding.protocolId !== model.protocolId || (session.protocolId && session.protocolId !== binding.protocolId)) throw treeError('protocol-mismatch')
        nodePath(tx, input.sessionId, input.parentNodeId)
        const parent = input.parentNodeId === null ? undefined : tx.get('SELECT context_ref FROM harness_nodes WHERE id = ?', [input.parentNodeId])
        if ((parent ? optional(parent, 'context_ref') ?? null : null) !== native.parentContextRef) throw treeError('invalid-history')
        const savedInitialization = tx.get('SELECT * FROM harness_native_initializations WHERE session_id = ?', [input.sessionId])
        let initializationId: string
        if (native.parentContextRef) {
          const context = tx.get('SELECT * FROM harness_native_contexts WHERE id = ?', [native.parentContextRef])
          if (!context || required(context, 'session_id') !== input.sessionId || required(context, 'protocol_id') !== binding.protocolId) throw treeError('invalid-history')
          initializationId = required(context, 'initialization_id')
          if (!savedInitialization || required(savedInitialization, 'id') !== initializationId) throw treeError('invalid-history')
        } else if (savedInitialization) {
          initializationId = required(savedInitialization, 'id')
        } else {
          initializationId = inputs.newId()
          tx.execute('INSERT INTO harness_native_initializations (id, session_id, protocol_id, payload_json) VALUES (?, ?, ?, ?)',
            [initializationId, input.sessionId, binding.protocolId, serialize(native.initialization)])
        }
        if (savedInitialization && (required(savedInitialization, 'protocol_id') !== binding.protocolId || required(savedInitialization, 'payload_json') !== serialize(native.initialization))) throw treeError('history-incompatible')
        if (native.input.raw !== input.input || ![1, 2, 3].includes(native.input.schemaVersion) ||
          !isDeepStrictEqual(inputFiles(native.input).map(file => file.snapshotId), (input.files ?? []).map(file => file.snapshotId)) ||
          !isDeepStrictEqual(inputImages(native.input).map(image => image.assetId), (input.images ?? []).map(image => image.assetId))) throw treeError('invalid-history')
        if (inputImages(native.input).length) images.retainIn(tx, input.sessionId, `run-input:${id}`, inputImages(native.input))
        if (inputFiles(native.input).some(file => file.projectId !== session.projectId)) throw treeError('invalid-history')
        if (inputFiles(native.input).length) files.retainIn(tx, input.sessionId, `run-input:${id}`, inputFiles(native.input))
        const execution = { ...initialRunExecution, phase: 'active' }
        tx.execute('UPDATE harness_sessions SET protocol_id = ? WHERE id = ? AND protocol_id IS NULL', [binding.protocolId, input.sessionId])
        tx.execute(`INSERT INTO harness_runs (
          id, session_id, idempotency_key, input, status, created_at, updated_at,
          prompts_json, model_snapshot_json, history_kind, parent_node_id, context_version, model_id, requested_model_id,
          binding_json, native_input_json, initialization_id, parent_context_ref, execution_json
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 'tree', ?, 'native-local-v1', ?, ?, ?, ?, ?, ?, ?)`, [
          id, input.sessionId, input.idempotencyKey, input.input, now, now,
          serialize(prompts), serialize(model), input.parentNodeId, model.modelId, input.modelId ?? null,
          serialize(binding), serialize(native.input), initializationId, native.parentContextRef, serialize(execution),
        ])
        tx.execute('INSERT INTO harness_run_resumes (run_id, state_json) VALUES (?, ?)', [id, serialize(initialResumeState)])
        return { run: getRun(tx, id)!, created: true }
      })
      if (result.created) await notify(result.run)
      return result
    },
    loadNativeInitialization(sessionId) { return db.read(reader => {
      const session = reader.get('SELECT * FROM harness_sessions WHERE id = ?', [sessionId])
      if (!session) throw new Error(`unknown session ${sessionId}`)
      if (required(session, 'history_mode') !== 'native-local-v1') throw treeError('legacy-session-readonly')
      const initialization = reader.get('SELECT * FROM harness_native_initializations WHERE session_id = ?', [sessionId])
      if (!initialization) return undefined
      if (required(initialization, 'protocol_id') !== optional(session, 'protocol_id')) throw treeError('invalid-history')
      return Object.freeze(JSON.parse(required(initialization, 'payload_json')) as NativeInitialization)
    }) },
    loadNativeHistory(sessionId, parentNodeId) { return db.read(reader => nativeHistory(reader, sessionId, parentNodeId)) },
    getRunRecords(id) { return db.read(reader => { if (!getRun(reader, id)) throw new Error(`unknown run ${id}`); return protocolRecords(reader, id) }) },
    loadRunResume(id) { return db.read(reader => runResume(reader, id)) },
    listRunResumes() { return db.read(reader => Object.freeze(reader.all(`SELECT r.id FROM harness_runs r
      JOIN harness_run_resumes c ON c.run_id = r.id WHERE r.status IN ('running', 'cancelling') ORDER BY r.created_at, r.id`)
      .map(row => runResume(reader, required(row, 'id'))!).filter(resume => resume.state.protocolCursor !== undefined && resume.state.stage !== 'model-pending'))) },
    claimRunResume(id, expectedEpoch, at) {
      return db.transaction(tx => {
        const resume = runResume(tx, id)
        if (!resume || !['running', 'cancelling'].includes(resume.run.status) || resume.state.protocolCursor === undefined || resume.state.stage === 'model-pending') throw resumeError('run-not-resumable')
        if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch !== resume.state.runOwnerEpoch) throw resumeError('stale-run-owner')
        const epoch = expectedEpoch + 1
        computers.claimRunIn(tx, id, epoch)
        updateResume(tx, id, resume.state, { runOwnerEpoch: epoch })
        tx.execute('UPDATE harness_runs SET updated_at = ? WHERE id = ?', [at, id])
        return runResume(tx, id)!
      })
    },
    saveRunResume(id, ownerEpoch, patch, at) {
      return db.transaction(tx => {
        const run = getRun(tx, id), prior = ownedResume(tx, id, ownerEpoch)
        if (!run || !prior || !['running', 'cancelling'].includes(run.status)) throw resumeError('run-not-resumable')
        if (patch.stage && !['model-pending', 'response', 'cleanup', 'settling'].includes(patch.stage)) throw resumeError('invalid-run-resume')
        if (patch.batch) {
          const batch = patch.batch
          validateToolBatch(batch.requests)
          if (!batch.id || batch.operationIds.length !== batch.requests.length || new Set(batch.operationIds).size !== batch.operationIds.length ||
            batch.operationIds.some(id => typeof id !== 'string' || !id)) throw resumeError('invalid-run-resume')
          if (prior.batch?.id === batch.id && !isDeepStrictEqual(prior.batch, batch)) throw resumeError('run-resume-conflict')
        }
        const savedPatch = { ...patch }
        if (patch.settlement) {
          insertRecords(tx, run, patch.settlement.records)
          const { records: _records, ...settlement } = patch.settlement
          if (prior.settlement && !isDeepStrictEqual(prior.settlement, settlement)) throw resumeError('run-resume-conflict')
          savedPatch.settlement = settlement
          if (settlement.checkpoint !== undefined) tx.execute('UPDATE harness_runs SET protocol_checkpoint_json = ? WHERE id = ?', [serialize(settlement.checkpoint), id])
        }
        if (Object.entries(savedPatch).every(([key, value]) => isDeepStrictEqual(prior[key as keyof RunResumeState], value))) return runResume(tx, id)!
        updateResume(tx, id, prior, savedPatch)
        tx.execute('UPDATE harness_runs SET updated_at = ? WHERE id = ?', [at, id])
        return runResume(tx, id)!
      })
    },
    getRunOperation(runId, id) { return db.read(reader => {
      const row = reader.get('SELECT * FROM harness_run_operations WHERE run_id = ? AND id = ?', [runId, id])
      if (!row) return undefined
      return Object.freeze({ start: { id, kind: required(row, 'kind') as 'model' | 'operation' | 'tool', intent: JSON.parse(required(row, 'intent_json')) as JsonValue,
        ...(optional(row, 'tool_json') ? { tool: JSON.parse(required(row, 'tool_json')) } : {}),
        ...(required(row, 'kind') === 'operation' && ['tool-process-cleanup', 'computer-scope-cleanup'].includes(JSON.parse(required(row, 'intent_json'))?.kind) ? { cleanup: true as const } : {}) },
        ...(optional(row, 'observation_json') ? { observation: JSON.parse(required(row, 'observation_json')) } : {}) })
    }) },
    async startOperation(runId, operation, at, ownerEpoch) {
      const result = await db.transaction(tx => {
        const resume = ownedResume(tx, runId, ownerEpoch)
        const run = getRun(tx, runId)
        if (!run) throw new Error(`unknown run ${runId}`)
        if (operation.cleanup !== undefined && (operation.cleanup !== true || operation.kind !== 'operation')) throw treeError('invalid-history')
        if (run.status !== 'running' && !(run.status === 'cancelling' && operation.cleanup === true)) return undefined
        if (run.contextVersion !== 'native-local-v1' || !operation.id || !['model', 'operation', 'tool'].includes(operation.kind)) throw treeError('invalid-history')
        if (operation.kind === 'tool' && !operation.tool) throw new Error('missing tool request')
        const prior = tx.get('SELECT * FROM harness_run_operations WHERE run_id = ? AND id = ?', [runId, operation.id])
        if (prior) {
          if (required(prior, 'kind') !== operation.kind || !isDeepStrictEqual(JSON.parse(required(prior, 'intent_json')), operation.intent) ||
            !isDeepStrictEqual(optional(prior, 'tool_json') ? JSON.parse(required(prior, 'tool_json')) : null, operation.tool ?? null)) throw resumeError('operation-intent-conflict')
          insertRecords(tx, run, operation.records)
          return run
        }
        if (operation.tool && needsComputer(operation.tool)) {
          const initializationRow = tx.get('SELECT payload_json FROM harness_native_initializations WHERE id = (SELECT initialization_id FROM harness_runs WHERE id = ?)', [runId])
          if (!initializationRow) throw treeError('invalid-history')
          const initialization = JSON.parse(required(initializationRow, 'payload_json')) as NativeInitialization
          validateToolBatch([operation.tool], initialization.tools)
          const selection = initialization.schemaVersion === 2 ? initialization.toolSelection : legacyToolSelection
          const tool = selection.tools.find(tool => tool.definition.name === operation.tool!.name)
          if (!tool) throw treeError('invalid-history')
          const session = tx.get('SELECT project_id FROM harness_sessions WHERE id = ?', [run.sessionId])!
          computers.acceptIn(tx, { operationId: operation.id, runId, sessionId: run.sessionId,
            projectId: required(session, 'project_id'), request: operation.tool, tool, runOwnerEpoch: resume?.runOwnerEpoch ?? 1 })
        }
        tx.execute('INSERT INTO harness_run_operations (run_id, id, kind, intent_json, tool_json, status) VALUES (?, ?, ?, ?, ?, ?)',
          [runId, operation.id, operation.kind, serialize(operation.intent), operation.tool ? serialize(operation.tool) : null, 'started'])
        insertRecords(tx, run, operation.records)
        if (resume && operation.kind === 'model') updateResume(tx, runId, resume, { stage: 'model-pending' })
        appendEvent(tx, runId, operation.kind === 'tool' ? { kind: 'tool-started', call: operation.tool! }
          : { kind: 'operation-started', operationId: operation.id, operationKind: operation.kind }, at)
        return getRun(tx, runId)!
      })
      if (result) await notify(result)
      return result !== undefined
    },
    async observeOperation(runId, operationId, observation, at, ownerEpoch) {
      const result = await db.transaction(tx => {
        const resume = ownedResume(tx, runId, ownerEpoch)
        const run = getRun(tx, runId)
        const operation = tx.get('SELECT * FROM harness_run_operations WHERE run_id = ? AND id = ?', [runId, operationId])
        if (!run || !operation) throw new Error('invalid operation observation')
        if (required(operation, 'status') !== 'started') {
          if (!isDeepStrictEqual(JSON.parse(required(operation, 'observation_json')), observation)) throw resumeError('operation-observation-conflict')
          return run
        }
        if (run.status !== 'running' && run.status !== 'cancelling') throw new Error('invalid operation observation')
        if (observation.tool && 'images' in observation.tool && observation.tool.images?.length) {
          images.retainIn(tx, run.sessionId, `run-tool:${runId}:${operationId}`, observation.tool.images)
        }
        insertRecords(tx, run, observation.records)
        tx.execute('UPDATE harness_run_operations SET status = ?, observation_json = ? WHERE run_id = ? AND id = ?',
          [observation.kind, serialize(observation), runId, operationId])
        computers.observeIn(tx, operationId, JSON.parse(serialize(observation)) as JsonValue)
        if (observation.checkpoint !== undefined) tx.execute('UPDATE harness_runs SET protocol_checkpoint_json = ? WHERE id = ?', [serialize(observation.checkpoint), runId])
        if (resume) {
          const bytes = (observation.tool ? toolOutputBytes(observation.tool) : 0) + cleanupOutputBytes(JSON.parse(required(operation, 'intent_json')) as JsonValue, observation.result)
          updateResume(tx, runId, resume, { totalToolOutputBytes: resume.totalToolOutputBytes + bytes,
            ...(observation.protocolCursor === undefined ? {} : { stage: 'response', protocolCursor: observation.protocolCursor }) })
        }
        let event: RunEventData
        const toolJson = optional(operation, 'tool_json')
        if (toolJson) {
          const tool = JSON.parse(toolJson) as import('../run/domain.js').ValidatedToolRequest
          if (observation.tool && observation.tool.name !== tool.name) throw new Error('tool observation mismatch')
          if (observation.kind === 'value' && observation.tool) event = { kind: 'tool-observed', requestId: tool.id, ...observation.tool }
          else event = { kind: 'tool-failed', requestId: tool.id, name: tool.name,
            category: observation.errorCategory ?? 'tool-unavailable',
            ...(observation.tool ? { result: observation.tool.result } : {}),
            ...(observation.tool && 'images' in observation.tool && observation.tool.images?.length ? { images: observation.tool.images } : {}) }
        } else event = observation.kind === 'value' ? { kind: 'operation-observed', operationId, ...(observation.result === undefined ? {} : { result: observation.result }) }
          : { kind: 'operation-failed', operationId, category: observation.errorCategory ?? 'provider-failure', ...(observation.result === undefined ? {} : { result: observation.result }) }
        appendEvent(tx, runId, event, at)
        return getRun(tx, runId)!
      })
      await notify(result)
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
        if (run.history.kind !== 'tree') throw treeError('invalid-history')
        const session = reader.get('SELECT project_id FROM harness_sessions WHERE id = ?', [run.sessionId])
        if (!session) throw new Error('missing Run session')
        return Object.freeze({ run, projectId: required(session, 'project_id') })
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
    async requestCancellation(id, now) {
      let changed = false
      const result = await db.transaction(tx => {
        const run = getRun(tx, id)
        if (!run) return undefined
        const next = requestCancellation(run, now)
        if (next !== run) {
          computers.requestCancelIn(tx, id)
          tx.execute('UPDATE harness_runs SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
            [next.status, next.updatedAt, id])
          changed = true
        }
        return getRun(tx, id)
      })
      if (changed && result) await notify(result)
      return result
    },
    async settleRun(id, outcome, now, ownerEpoch) {
      let changed = false
      const next = await db.transaction(tx => {
        ownedResume(tx, id, ownerEpoch)
        const run = getRun(tx, id)
        if (!run) throw new Error(`unknown run ${id}`)
        const next = settleRun(run, outcome, now)
        if (next === run) return run
        insertRecords(tx, run, outcome.records)
        if (next.status === 'completed') {
          if (run.contextVersion !== 'native-local-v1' || outcome.kind !== 'completed' || !outcome.resultRecordIds?.length || outcome.checkpoint === undefined ||
            tx.get("SELECT id FROM harness_run_operations WHERE run_id = ? AND status = 'started'", [id])) throw treeError('invalid-history')
          const ids = new Set<string>()
          for (const recordId of outcome.resultRecordIds) {
            const record = tx.get('SELECT run_id, kind FROM harness_native_records WHERE id = ?', [recordId])
            if (ids.has(recordId) || !record || required(record, 'run_id') !== id || required(record, 'kind') === 'diagnostic') throw treeError('invalid-history')
            ids.add(recordId)
          }
        }
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
          if (outcome.kind !== 'completed') throw treeError('invalid-history')
          const nodeId = inputs.newId(), contextId = inputs.newId()
          const origin = tx.get('SELECT initialization_id, parent_context_ref FROM harness_runs WHERE id = ?', [id])!
          tx.execute('INSERT INTO harness_native_contexts (id, session_id, run_id, protocol_id, parent_ref, initialization_id, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [contextId, run.sessionId, run.id, run.protocolBinding!.protocolId, optional(origin, 'parent_context_ref') ?? null, required(origin, 'initialization_id'), serialize(outcome.checkpoint)])
          tx.execute('INSERT INTO harness_nodes (id, session_id, parent_id, input, output, source_run_id, context_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [nodeId, run.sessionId, run.history.parentNodeId, run.input, next.output!, run.id, contextId])
          for (const [ordinal, recordId] of outcome.resultRecordIds!.entries()) tx.execute('INSERT INTO harness_native_results (node_id, record_id, ordinal) VALUES (?, ?, ?)', [nodeId, recordId, ordinal])
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

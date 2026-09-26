import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { LLMPlan, LLMSnapshot } from '../llm/port.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../storage/port.js'
import {
  appendTurn, createRun, createSession, requestCancellation, settleRun, validateRunInput,
} from './domain.js'
import type { Run, RunInput, RunOutcome, Session } from './domain.js'
import { advanceExecution, initialRunExecution, parseRunExecution } from './execution.js'
import type { ActiveRunEvent, RunEvent, RunExecution } from './execution.js'

export const stateServiceKey = 'harness.state'

export interface StatePort {
  createSession(id: string, projectId: string, agentId: string, now: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  findAcceptedRun(input: RunInput): Promise<Run | undefined>
  acceptRun(id: string, input: RunInput, now: string,
    prompts: readonly PromptSnapshot[], plan: LLMPlan): Promise<{ readonly run: Run; readonly created: boolean }>
  getRun(id: string): Promise<Run | undefined>
  listRuns(sessionId: string): Promise<readonly Run[]>
  getRunPrompts(id: string): Promise<readonly PromptSnapshot[] | undefined>
  /** The native plan exists only while this process owns the accepted Run. */
  getRunPlan(id: string): Promise<LLMPlan | undefined>
  getRunExecution(id: string): Promise<RunExecution | undefined>
  getRunEvents(id: string): Promise<readonly RunEvent[] | undefined>
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
  const turns: unknown = JSON.parse(required(row, 'turns_json'))
  if (!Array.isArray(turns) || turns.some(turn => !turn || typeof turn.input !== 'string' || typeof turn.output !== 'string')) {
    throw new Error('invalid stored session turns')
  }
  return Object.freeze({
    id: required(row, 'id'), projectId: required(row, 'project_id'),
    agentId: required(row, 'agent_id'), createdAt: required(row, 'created_at'),
    turns: Object.freeze(turns.map(turn => Object.freeze({ input: turn.input, output: turn.output }))),
  })
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
    if (run.input !== input.input) throw new Error('idempotency key already used with different input')
    return run
  }
  if (reader.get("SELECT id FROM harness_runs WHERE session_id = ? AND status IN ('running', 'cancelling') LIMIT 1",
    [input.sessionId])) throw new Error('session already has an active run')
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
          tx.execute("UPDATE harness_runs SET status = 'interrupted', updated_at = ?, execution_json = ? WHERE id = ?",
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
            tx.execute('INSERT INTO harness_sessions (id, project_id, agent_id, created_at, turns_json) VALUES (?, ?, ?, ?, ?)',
              [id, projectId, agentId, now, '[]'])
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
        findAcceptedRun(raw) {
          return track(() => db.read(reader => accepted(reader, validateRunInput(raw))))
        },
        acceptRun(id, raw, now, prompts, plan) {
          return track(async () => {
            const input = validateRunInput(raw)
            const result = await db.transaction(tx => {
              const prior = accepted(tx, input)
              if (prior) return { run: prior, created: false }
              const run = createRun(id, input, prompts, plan, now)
              tx.execute(`INSERT INTO harness_runs (
                id, session_id, idempotency_key, input, status, created_at, updated_at,
                prompts_json, llm_snapshot_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id, input.sessionId, input.idempotencyKey, input.input, run.status, now, now,
                JSON.stringify(prompts), JSON.stringify(plan.snapshot),
              ])
              return { run, created: true }
            })
            if (result.created) plans.set(result.run.id, plan)
            return result
          })
        },
        getRun(id) { return track(() => db.read(reader => getRun(reader, id))) },
        listRuns(sessionId) {
          return track(() => db.read(reader => {
            if (!reader.get('SELECT id FROM harness_sessions WHERE id = ?', [sessionId])) {
              throw new Error(`unknown session ${sessionId}`)
            }
            return Object.freeze(reader.all(
              'SELECT * FROM harness_runs WHERE session_id = ? ORDER BY created_at, id', [sessionId],
            ).map(runFromRow))
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
        getRunEvents(id) {
          return track(() => db.read(reader => {
            if (!reader.get('SELECT id FROM harness_runs WHERE id = ?', [id])) return undefined
            return Object.freeze(reader.all(
              'SELECT seq, at, payload_json FROM harness_run_events WHERE run_id = ? ORDER BY seq', [id],
            ).map(row => Object.freeze({
              ...(JSON.parse(required(row, 'payload_json')) as ActiveRunEvent),
              seq: Number(row.seq), at: required(row, 'at'),
            }) as RunEvent))
          }))
        },
        recordRunEvent(id, event, at) {
          return track(() => db.transaction(tx => {
            const row = tx.get('SELECT status, execution_json FROM harness_runs WHERE id = ?', [id])
            if (!row) throw new Error(`unknown run ${id}`)
            const status = required(row, 'status')
            if (status !== 'running' && status !== 'cancelling') return undefined
            if (status !== 'running' && (event.kind === 'model-started' || event.kind === 'bash-started')) return undefined
            const next = advanceExecution(parseRunExecution(required(row, 'execution_json')), event)
            tx.execute('UPDATE harness_runs SET execution_json = ?, updated_at = ? WHERE id = ?',
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
            if (next !== run) tx.execute('UPDATE harness_runs SET status = ?, updated_at = ? WHERE id = ?',
              [next.status, next.updatedAt, id])
            return next
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
                execution_json = ? WHERE id = ?`, [next.status, next.updatedAt, next.output ?? null,
                next.error ?? null, next.errorCategory ?? null, JSON.stringify(execution), id])
              tx.execute('INSERT INTO harness_run_events (run_id, seq, at, payload_json) VALUES (?, ?, ?, ?)',
                [id, execution.revision, now, JSON.stringify(event)])
              if (next.status === 'completed') {
                const row = tx.get('SELECT * FROM harness_sessions WHERE id = ?', [run.sessionId])
                if (!row) throw new Error(`unknown session ${run.sessionId}`)
                const session = appendTurn(sessionFromRow(row), run.input, next.output!)
                tx.execute('UPDATE harness_sessions SET turns_json = ? WHERE id = ?',
                  [JSON.stringify(session.turns), session.id])
              }
              return next
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

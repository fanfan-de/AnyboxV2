import type { StorageMigration, StorageReader, StorageTransaction } from '@anybox/storage-sqlite/port'
import { environmentError, environmentToolKey, validateEnvironmentGrants } from './contracts.js'
import type { AgentGrants, EnvironmentGrant, GrantChange } from './contracts.js'

export const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE environment_authority (singleton INTEGER PRIMARY KEY CHECK (singleton=1), owner TEXT NOT NULL)')
  tx.execute('CREATE TABLE environment_agent_grants (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, grants_json TEXT NOT NULL)')
  tx.execute('CREATE TABLE environment_grant_changes (request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL)')
  tx.execute(`CREATE TABLE environment_admissions (agent_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    owner TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved','sent','exited','unknown')),
    PRIMARY KEY (agent_id, operation_id))`)
  tx.execute(`CREATE TABLE environment_admission_tools (agent_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    tool_key TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(agent_id,operation_id,tool_key))`)
  tx.execute('CREATE INDEX environment_uses_by_tool ON environment_admission_tools(agent_id,tool_key,generation)')
  tx.execute('CREATE TABLE environment_change_operations (request_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(request_id,operation_id))')
} }, { version: 2, up(tx) {
  tx.execute("ALTER TABLE environment_admissions ADD COLUMN resource_kind TEXT NOT NULL DEFAULT 'provider'")
  tx.execute('CREATE INDEX environment_changes_by_agent ON environment_grant_changes(agent_id,revision)')
} }, { version: 3, up(tx) {
  tx.execute("CREATE INDEX environment_outstanding_scopes ON environment_admissions(operation_id) WHERE resource_kind='run-scope' AND state<>'exited'")
} }]

export function assertOwner(reader: StorageReader, owner: string): void {
  if (reader.get('SELECT owner FROM environment_authority WHERE singleton=1')?.owner !== owner) throw environmentError('environment-owner-changed', 503)
}

export function readGrants(reader: StorageReader, agentId: string): AgentGrants {
  const row = reader.get('SELECT revision,grants_json FROM environment_agent_grants WHERE agent_id=?', [agentId])
  if (!row) return Object.freeze({ agentId, revision: 0, grants: Object.freeze([]) })
  const revision = row.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw environmentError('environment-ledger-invalid', 503)
  const grants = validateEnvironmentGrants(JSON.parse(String(row.grants_json)))
  if (grants.some(grant => grant.generation > revision)) throw environmentError('environment-ledger-invalid', 503)
  return Object.freeze({ agentId, revision, grants })
}

export function writeGrants(tx: StorageTransaction, value: AgentGrants): void {
  tx.execute(`INSERT INTO environment_agent_grants (agent_id,revision,grants_json) VALUES(?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision, grants_json=excluded.grants_json`,
    [value.agentId, value.revision, JSON.stringify(value.grants)])
}

export function changeState(reader: StorageReader, requestId: string): GrantChange | undefined {
  const row = reader.get('SELECT agent_id,revision FROM environment_grant_changes WHERE request_id=?', [requestId])
  if (!row) return undefined
  const counts = reader.get(`SELECT count(*) AS affected, count(CASE WHEN a.state IN ('reserved','sent') THEN 1 END) AS pending,
    count(CASE WHEN a.state IS NULL OR a.state='unknown' THEN 1 END) AS uncertain FROM environment_change_operations c
    LEFT JOIN environment_admissions a ON a.agent_id=? AND a.operation_id=c.operation_id WHERE c.request_id=?`, [row.agent_id, requestId])!
  const affectedCount = Number(counts.affected), pendingCount = Number(counts.pending), unknownCount = Number(counts.uncertain)
  const state = unknownCount ? 'exit-unknown' : pendingCount ? 'draining' : 'completed'
  return { agentId: String(row.agent_id), revision: Number(row.revision), requestId, state, affectedCount, pendingCount, unknownCount }
}

export function rememberAffected(tx: StorageTransaction, requestId: string, agentId: string, grant: EnvironmentGrant): void {
  tx.execute(`INSERT OR IGNORE INTO environment_change_operations(request_id,operation_id)
    SELECT ?, operation_id FROM environment_admission_tools WHERE agent_id=? AND tool_key=? AND generation=?`,
    [requestId, agentId, environmentToolKey(grant.tool), grant.generation])
}

export function hasUnknown(reader: StorageReader, agentId: string, key: string): boolean {
  return !!reader.get(`SELECT 1 FROM environment_admission_tools u JOIN environment_admissions a
    ON a.agent_id=u.agent_id AND a.operation_id=u.operation_id WHERE u.agent_id=? AND u.tool_key=? AND a.state='unknown'
    AND a.resource_kind<>'model-transport' LIMIT 1`, [agentId,key])
}

export function markExited(tx: StorageTransaction, agentId: string, operationId: string, owner: string, exited: boolean): void {
  assertOwner(tx, owner)
  tx.execute('UPDATE environment_admissions SET state=? WHERE agent_id=? AND operation_id=?', [exited ? 'exited' : 'unknown', agentId, operationId])
  if (exited) tx.execute('DELETE FROM environment_admission_tools WHERE agent_id=? AND operation_id=?', [agentId,operationId])
}

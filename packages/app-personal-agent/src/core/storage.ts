import { failure } from '@anybox/application-api/node'
import type { StorageReader, StorageTransaction, StorageMigration } from '@anybox/storage-sqlite'
import type { Agent, Work, Run, Artifact } from '../contracts.js'

export const personalAgentMigrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE personal_agent_agents (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  tx.execute('CREATE TABLE personal_agent_works (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_work_id TEXT, record TEXT NOT NULL)')
  tx.execute('CREATE INDEX personal_agent_works_agent ON personal_agent_works(agent_id)')
  tx.execute('CREATE INDEX personal_agent_works_source ON personal_agent_works(source_work_id)')
  tx.execute('CREATE TABLE personal_agent_runs (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, record TEXT NOT NULL)')
  tx.execute('CREATE INDEX personal_agent_runs_work ON personal_agent_runs(work_id)')
  tx.execute('CREATE TABLE personal_agent_artifacts (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, record TEXT NOT NULL)')
  tx.execute('CREATE INDEX personal_agent_artifacts_work ON personal_agent_artifacts(work_id)')
  tx.execute('CREATE TABLE personal_agent_preferences (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
} }]

type Table = 'agents' | 'works' | 'runs' | 'artifacts'
function parse<Value>(value: unknown): Value { if (typeof value !== 'string') throw failure(500, 'storage-invalid'); return JSON.parse(value) as Value }
export function all<Value>(reader: StorageReader, table: Table, field?: 'work_id' | 'source_work_id', value?: string): Value[] {
  return reader.all(`SELECT record FROM personal_agent_${table}${field ? ` WHERE ${field} = ?` : ''} ORDER BY rowid`, field ? [value!] : []).map(row => parse<Value>(row.record))
}
export function get<Value>(reader: StorageReader, table: Table, id: string): Value {
  const row = reader.get(`SELECT record FROM personal_agent_${table} WHERE id = ?`, [id])
  if (!row) throw failure(404, 'not-found')
  return parse<Value>(row.record)
}
export function putAgent(tx: StorageTransaction, agent: Agent): void {
  tx.execute('INSERT INTO personal_agent_agents(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', [agent.id, JSON.stringify(agent)])
}
export function putWork(tx: StorageTransaction, work: Work): void {
  tx.execute('INSERT INTO personal_agent_works(id,agent_id,source_work_id,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', [work.id, work.agentId, work.sourceWorkId, JSON.stringify(work)])
}
export function putRun(tx: StorageTransaction, run: Run): void {
  tx.execute('INSERT INTO personal_agent_runs(id,work_id,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record', [run.id, run.workId, JSON.stringify(run)])
}
export function putArtifact(tx: StorageTransaction, artifact: Artifact): void {
  tx.execute('INSERT INTO personal_agent_artifacts(id,work_id,record) VALUES(?,?,?)', [artifact.id, artifact.workId, JSON.stringify(artifact)])
}
export function preferred(reader: StorageReader): string | null { const value = reader.get('SELECT value FROM personal_agent_preferences WHERE name = ?', ['preferred-agent'])?.value; return typeof value === 'string' ? value : null }
export function putPreferred(tx: StorageTransaction, id: string): void { tx.execute('INSERT INTO personal_agent_preferences(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', ['preferred-agent', id]) }

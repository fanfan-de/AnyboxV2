import type { StorageMigration, StorageReader, StorageRow } from '@anybox/storage-sqlite/port'
import { validateToolDescriptor } from '@anybox/tool-api'
import { connectionInput, maxTools, mcpError, record, resourceKey } from './contracts.js'
import type { McpConnectionConfig, McpConnectionStatus, McpTool } from './contracts.js'

export type McpConnection = McpConnectionConfig & {
  readonly id: string
  readonly resourceKey: string
  readonly revision: number
  readonly status: McpConnectionStatus
  readonly tools: readonly McpTool[]
  readonly error?: string
}

export const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE mcp_connections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL, revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('unverified','ready','unavailable','disabled')),
    tools_json TEXT NOT NULL, error TEXT)`)
  tx.execute("CREATE UNIQUE INDEX mcp_active_endpoint ON mcp_connections(endpoint) WHERE status<>'disabled'")
  tx.execute(`CREATE TABLE mcp_operations (
    scope_id TEXT NOT NULL, operation_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
    endpoint TEXT NOT NULL, native_name TEXT NOT NULL, request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('sent','exited','unknown')), PRIMARY KEY(scope_id,operation_id))`)
  tx.execute("CREATE INDEX mcp_unknown_operations ON mcp_operations(endpoint,native_name) WHERE state='unknown'")
} }, { version: 2, up(tx) {
  // Keep the original HTTP identities. Stdio stores an opaque launch identity in the endpoint key.
  tx.execute('ALTER TABLE mcp_connections ADD COLUMN stdio_json TEXT')
  tx.execute(`CREATE TABLE mcp_stdio_processes (
    launch_id TEXT PRIMARY KEY, resource_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('owned','unknown')))`)
  tx.execute("CREATE INDEX mcp_stdio_unknown_resource ON mcp_stdio_processes(resource_key) WHERE state='unknown'")
} }]

export function connectionFromRow(row: StorageRow): McpConnection {
  const revision = Number(row.revision)
  const contents = JSON.parse(String(row.tools_json)) as unknown
  if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id) || !Number.isSafeInteger(revision) || revision < 0 ||
    row.status !== 'unverified' && row.status !== 'ready' && row.status !== 'unavailable' && row.status !== 'disabled' ||
    !Array.isArray(contents) || contents.length > maxTools) throw mcpError('mcp-invalid-storage', 503)
  const tools = contents.map(entry => {
    if (!record(entry) || typeof entry.nativeName !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.nativeName)) {
      throw mcpError('mcp-invalid-storage', 503)
    }
    const descriptor = validateToolDescriptor(entry)
    if (descriptor.toolId !== `mcp.${row.id}.${entry.nativeName}`) throw mcpError('mcp-invalid-storage', 503)
    return Object.freeze({ ...descriptor, nativeName: entry.nativeName })
  })
  const config = connectionInput(row.stdio_json === null ? { name: row.name, endpoint: row.endpoint } :
    { ...JSON.parse(String(row.stdio_json)), name: row.name, transport: 'stdio' })
  const key = resourceKey(config)
  if (key !== row.endpoint) throw mcpError('mcp-invalid-storage', 503)
  return Object.freeze({ id: row.id, revision, status: row.status,
    ...config, resourceKey: key, tools: Object.freeze(tools),
    ...(typeof row.error === 'string' ? { error: row.error } : {}) })
}

export function unknownKey(endpoint: string, nativeName: string): string {
  return JSON.stringify([endpoint, nativeName])
}

export function unknownOperations(reader: StorageReader): Set<string> {
  return new Set(reader.all("SELECT DISTINCT endpoint,native_name FROM mcp_operations WHERE state='unknown'")
    .map(row => unknownKey(String(row.endpoint), String(row.native_name))))
}

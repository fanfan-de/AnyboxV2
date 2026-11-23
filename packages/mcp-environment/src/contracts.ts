import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { validateToolDescriptor } from '@anybox/tool-api'
import type { JsonValue, ToolDescriptor } from '@anybox/tool-api'

export const mcpEnvironmentId = 'mcp'
export const mcpEnvironmentVersion = '1'
export const maxTools = 256

export function mcpError(code: string, status: number, category = 'unavailable') {
  return Object.assign(new Error(code), { name: 'McpEnvironmentError', code, status, category })
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface McpHttpConnection {
  readonly name: string
  readonly transport: 'http'
  readonly endpoint: string
}

export interface McpStdioConnection {
  readonly name: string
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export type McpConnectionInput = Omit<McpHttpConnection, 'transport'> & { readonly transport?: 'http' } |
  Omit<McpStdioConnection, 'args' | 'cwd'> & { readonly args?: readonly string[]; readonly cwd?: string }
export type McpConnectionConfig = McpHttpConnection | McpStdioConnection

export type McpConnectionStatus = 'unverified' | 'ready' | 'unavailable' | 'disabled'

export type McpConnectionView = McpConnectionConfig & {
  readonly id: string
  readonly targetId: string
  readonly status: McpConnectionStatus
  readonly toolCount: number
  readonly error?: string
}

export interface McpTool extends ToolDescriptor {
  readonly nativeName: string
}

export function connectionInput(input: unknown): McpConnectionConfig {
  if (!record(input) || typeof input.name !== 'string' || !input.name.trim() ||
    input.name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(input.name)) throw mcpError('mcp-invalid-connection', 400)
  const name = input.name.trim()
  if (input.transport === 'stdio') {
    const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value)
    const cwd = input.cwd === undefined ? process.cwd() : input.cwd
    const args = input.args === undefined ? [] : input.args
    if (Object.keys(input).some(key => !['name', 'transport', 'command', 'args', 'cwd'].includes(key)) ||
      !absolute(input.command) || !absolute(cwd) || !Array.isArray(args) || args.length > 128 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) ||
      Buffer.byteLength(JSON.stringify(args), 'utf8') > 32_768) throw mcpError('mcp-invalid-stdio', 400)
    return { name, transport: 'stdio', command: resolve(input.command), args: Object.freeze([...args]), cwd: resolve(cwd) }
  }
  if (input.transport !== undefined && input.transport !== 'http' ||
    Object.keys(input).some(key => !['name', 'transport', 'endpoint'].includes(key)) || typeof input.endpoint !== 'string' ||
    input.endpoint.length > 2048) throw mcpError('mcp-invalid-connection', 400)
  if (!/^https?:\/\//i.test(input.endpoint) || /[\x00-\x20\x7f?#]/.test(input.endpoint)) throw mcpError('mcp-invalid-endpoint', 400)
  let endpoint: URL
  try { endpoint = new URL(input.endpoint) } catch { throw mcpError('mcp-invalid-endpoint', 400) }
  const loopback = endpoint.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname)
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
    endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw mcpError('mcp-invalid-endpoint', 400)
  return { name, transport: 'http', endpoint: endpoint.href }
}

export function targetId(connectionId: string) { return `${connectionId}@1` }

function hash(data: string) { return createHash('sha256').update(data).digest('hex') }

export function resourceKey(connection: McpConnectionConfig): string {
  return connection.transport === 'http' ? connection.endpoint :
    `stdio:${hash(JSON.stringify([connection.command, connection.args, connection.cwd]))}`
}

function canonical(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw mcpError('mcp-invalid-json', 502)
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Object.freeze(value.map(item => canonical(item, depth + 1)))
  if (!record(value)) throw mcpError('mcp-invalid-json', 502)
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)])))
}

function checkSchema(schema: unknown, budget: { remaining: number }): void {
  if (--budget.remaining < 0) throw mcpError('mcp-unsupported-schema', 502)
  if (typeof schema === 'boolean') return
  if (!record(schema) || schema.pattern !== undefined || schema.$schema !== undefined &&
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw mcpError('mcp-unsupported-schema', 502)
  if (record(schema.properties)) for (const child of Object.values(schema.properties)) checkSchema(child, budget)
  for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] !== undefined) checkSchema(schema[key], budget)
  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    const children = schema[key]
    if (Array.isArray(children)) for (const child of children) checkSchema(child, budget)
  }
}

export function normalizeTools(connection: { readonly name: string; readonly id: string }, list: readonly unknown[]): readonly McpTool[] {
  const names = new Set<string>()
  const tools: McpTool[] = []
  for (const entry of list) {
    if (!record(entry) || typeof entry.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.name) || names.has(entry.name)) {
      throw mcpError('mcp-invalid-tool-list', 502)
    }
    names.add(entry.name)
    if (!record(entry.inputSchema) || entry.inputSchema.type !== 'object' ||
      record(entry.execution) && entry.execution.taskSupport === 'required') continue
    const digest = hash(JSON.stringify([connection.id, entry.name]))
    const connectionLabel = connection.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 13)
    const toolLabel = entry.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 18)
    const description = typeof entry.description === 'string' ? entry.description.slice(0, 2000) : ''
    try {
      checkSchema(entry.inputSchema, { remaining: 96 })
      const definition = Object.freeze({ name: `mcp_${connectionLabel}_${toolLabel}_${digest.slice(0, 24)}`,
        description: `[${connection.name}] ${description || entry.name}`,
        parameters: canonical(entry.inputSchema) as Readonly<Record<string, JsonValue>> })
      if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 16_384) continue
      const descriptor = validateToolDescriptor({ toolId: `mcp.${connection.id}.${entry.name}`,
        version: hash(JSON.stringify([mcpEnvironmentVersion, entry.name, definition])), definition })
      tools.push(Object.freeze({ ...descriptor, nativeName: entry.name }))
    } catch (error) {
      if (!(error instanceof Error)) throw error
      // A schema outside the supported subset never enters the delegable catalog.
    }
  }
  return Object.freeze(tools.sort((a, b) => a.toolId.localeCompare(b.toolId, 'en')))
}

export function normalizeResult(value: unknown): JsonValue {
  if (!record(value) || !Array.isArray(value.content) && !record(value.structuredContent) ||
    value.isError !== undefined && typeof value.isError !== 'boolean') throw mcpError('mcp-invalid-tool-result', 502)
  const content = Array.isArray(value.content) ? value.content.map(item => {
    if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') throw mcpError('mcp-unsupported-tool-result', 502)
    return { type: 'text', text: item.text }
  }) : []
  const result = canonical({ content, ...(value.isError === true ? { isError: true } : {}),
    ...(record(value.structuredContent) ? { structuredContent: value.structuredContent } : {}) })
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262_144) throw mcpError('mcp-tool-result-too-large', 502)
  return result
}

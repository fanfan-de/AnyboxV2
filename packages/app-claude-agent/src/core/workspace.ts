import { claudeAgentError, validModelIdentifier } from './domain.js'
import { defaultSessionOptions } from './view.js'
export { defaultSessionOptions } from './view.js'

/** Application-owned data. Authentication remains in the user's native Claude environment. */
export type McpConnection = { readonly type: 'http' | 'sse'; readonly url: string } | { readonly type: 'stdio'; readonly command: string; readonly args: readonly string[] }
export interface SessionOptions {
  readonly maxBudgetUsd: number | null
  readonly maxTurns: number | null
  readonly fallbackModel: string | null
  readonly checkpointing: boolean
  readonly mcpServers: Readonly<Record<string, McpConnection>>
}
export interface ContextUsage {
  readonly details?: readonly {readonly group:string;readonly name:string;readonly tokens:number}[]
  readonly schemaVersion: 1
  readonly model: string
  readonly totalTokens: number
  readonly maxTokens: number
  readonly percentage: number
  readonly estimated: boolean
  readonly categories: readonly { readonly name: string; readonly tokens: number; readonly kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
}
export interface FilePreview { readonly encoding?: 'utf-8'|'base64'; readonly mime?: string; readonly path: string; readonly contents: string; readonly truncated: boolean }
export interface Checkpoint { readonly id: string; readonly threadId: string; readonly runId: string; readonly nativeSessionId: string; readonly createdAt: string }
export interface RewindPreview { readonly canRewind: boolean; readonly error: string | null; readonly files: readonly string[]; readonly insertions: number; readonly deletions: number; readonly skippedLinks: number }
export interface ElicitationField { readonly name: string; readonly title: string; readonly type: 'string' | 'number' | 'integer' | 'boolean'; readonly required: boolean; readonly choices?: readonly string[] }
export interface ElicitationView { readonly id: string; readonly threadId: string; readonly serverName: string; readonly message: string; readonly mode: 'form' | 'url'; readonly url: string | null; readonly fields: readonly ElicitationField[] }
export interface ElicitationAnswer { readonly action: 'accept' | 'decline' | 'cancel'; readonly content?: Readonly<Record<string, string | number | boolean>> }
export type SessionInspection = { readonly action: 'account' } | { readonly action: 'context'; readonly detail?: 'summary' | 'full' } | { readonly action: 'file'; readonly path: string } | { readonly action: 'rewind'; readonly messageId: string; readonly dryRun: boolean } | { readonly action: 'mcp-connect' }
export type SessionInspectionResult = import('./account.js').AccountUsageView | ContextUsage | FilePreview | RewindPreview | import('./view.js').CapabilitiesView
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw claudeAgentError('invalid-input', 400)
}
export function boundedName(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw claudeAgentError('invalid-input', 400)
  return value.trim()
}
export function validateSessionOptions(raw: unknown): SessionOptions {
  exact(raw, ['maxBudgetUsd', 'maxTurns', 'fallbackModel', 'checkpointing', 'mcpServers'])
  const { maxBudgetUsd, maxTurns, fallbackModel, checkpointing, mcpServers } = { ...defaultSessionOptions, ...raw }
  if (maxBudgetUsd !== null && (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 10000)) throw claudeAgentError('invalid-input', 400)
  if (maxTurns !== null && (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10000)) throw claudeAgentError('invalid-input', 400)
  if (fallbackModel !== null && (typeof fallbackModel !== 'string' || !validModelIdentifier(fallbackModel))) throw claudeAgentError('invalid-input', 400)
  if (typeof checkpointing !== 'boolean' || !object(mcpServers) || Object.keys(mcpServers).length > 30) throw claudeAgentError('invalid-input', 400)
  const servers: Record<string, McpConnection> = Object.create(null) as Record<string, McpConnection>
  for (const [name, connection] of Object.entries(mcpServers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name) || !object(connection)) throw claudeAgentError('invalid-input', 400)
    if (connection.type === 'stdio') {
      exact(connection, ['type', 'command', 'args'])
      const command = boundedName(connection.command, 4096)
      if (!Array.isArray(connection.args) || connection.args.length > 50 || connection.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw claudeAgentError('invalid-input', 400)
      servers[name] = { type: 'stdio', command, args: [...connection.args] as string[] }
    } else {
      exact(connection, ['type', 'url'])
      if (connection.type !== 'http' && connection.type !== 'sse') throw claudeAgentError('invalid-input', 400)
      const url = new URL(boundedName(connection.url, 4096))
      if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw claudeAgentError('invalid-input', 400, '使用 HTTPS 或本机 HTTP 地址；凭据请通过 Claude 原生认证管理。')
      servers[name] = { type: connection.type, url: url.href }
    }
  }
  if (JSON.stringify(servers).length > 32768) throw claudeAgentError('request-too-large', 413)
  return { maxBudgetUsd, maxTurns, fallbackModel, checkpointing, mcpServers: Object.fromEntries(Object.entries(servers)) }
}
export function elicitationAnswer(view: ElicitationView, raw: unknown): ElicitationAnswer {
  exact(raw, ['action', 'content'])
  if (!['accept', 'decline', 'cancel'].includes(String(raw.action))) throw claudeAgentError('invalid-input', 400)
  const action = raw.action as ElicitationAnswer['action']
  if (action !== 'accept' || view.mode === 'url') { if (raw.content !== undefined) throw claudeAgentError('invalid-input', 400); return { action } }
  if (!object(raw.content)) throw claudeAgentError('invalid-input', 400)
  const content: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>
  if (Object.keys(raw.content).some(name => !view.fields.some(field => field.name === name))) throw claudeAgentError('invalid-input', 400)
  for (const field of view.fields) {
    const value = raw.content[field.name]
    if (value === undefined) { if (field.required) throw claudeAgentError('invalid-input', 400); continue }
    if (field.type === 'string' ? typeof value !== 'string' || value.length > 8000 || field.required && !value.trim() || field.choices && !field.choices.includes(value) : field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value)) throw claudeAgentError('invalid-input', 400)
    content[field.name] = value as string | number | boolean
  }
  return { action, content }
}

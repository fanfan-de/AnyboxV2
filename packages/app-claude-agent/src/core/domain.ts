import { validateSessionOptions } from './workspace.js'
import { basename, isAbsolute } from 'node:path'
import { claudeAgentEfforts } from './view.js'
import type { ClaudeAgentEffort } from './view.js'
import { permissionModes } from './view.js'
import type { PermissionModeView, RunControlInput } from './view.js'

/** Stable failure codes; HTTP maps `status` and the browser maps `code` to copy. Messages may be shown verbatim. */
export interface ClaudeAgentFailure extends Error { readonly code: string; readonly status: number }
export function claudeAgentError(code: string, status: number, message = code): ClaudeAgentFailure {
  return Object.assign(new Error(message), { name: 'ClaudeAgentError', code, status })
}
export function isClaudeAgentError(error: unknown): error is ClaudeAgentFailure {
  return error instanceof Error && error.name === 'ClaudeAgentError' && 'code' in error && 'status' in error
}
/** Time and identity are explicit inputs so decisions stay pure and tests stay deterministic. */
export interface ClaudeAgentClock { now(): string; newId(): string }

export const promptLimit = 256 * 1024
export const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/
/** Claude aliases include context suffixes (`sonnet[1m]`); provider model IDs may contain paths or version markers. */
export const validModelIdentifier = (value: string): boolean => /^[A-Za-z0-9._:/@+\[\]-]{1,100}$/.test(value)

export interface ThreadInput { readonly projectPath: string; readonly title?: string }
export interface RunInput { readonly attachmentIds?: readonly string[]; readonly prompt: string; readonly idempotencyKey: string; readonly model?: string; readonly effort?: ClaudeAgentEffort; readonly permissionMode?: PermissionModeView }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const optionalText = (value: unknown, limit: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit) throw claudeAgentError('invalid-input', 400)
  const trimmed = value.trim()
  return trimmed || undefined
}
/** The project directory is an absolute path on the execution device; existence is checked by the owner of that device. */
export function validateThreadInput(raw: unknown): ThreadInput {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['projectPath', 'title'].includes(key))) throw claudeAgentError('invalid-input', 400)
  const projectPath = raw.projectPath
  if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0') || projectPath.length > 4096 || !isAbsolute(projectPath.trim())) {
    throw claudeAgentError('project-path-invalid', 400, 'Project directory must be an absolute path on the execution device.')
  }
  const title = optionalText(raw.title, 200)
  return Object.freeze({ projectPath: projectPath.trim(), ...(title ? { title } : {}) })
}
export function defaultThreadTitle(projectPath: string): string {
  return basename(projectPath) || projectPath
}
export const promptTitleLimit = 60
/** First non-empty line of a prompt, whitespace collapsed, at most 60 characters; empty when the prompt has no text. */
export function promptTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/).map(entry => entry.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return line.length > promptTitleLimit ? `${line.slice(0, promptTitleLimit - 1)}…` : line
}
export function validateRunInput(raw: unknown): RunInput {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['prompt', 'idempotencyKey', 'model', 'effort', 'permissionMode', 'attachmentIds'].includes(key))) throw claudeAgentError('invalid-input', 400)
  const { prompt, idempotencyKey, model, effort } = raw
  if (typeof prompt !== 'string' || (!prompt.trim() && !(Array.isArray(raw.attachmentIds) && raw.attachmentIds.length)) || prompt.includes('\0')) throw claudeAgentError('invalid-input', 400, 'A prompt is required.')
  if (prompt.length > promptLimit) throw claudeAgentError('request-too-large', 413)
  if (typeof idempotencyKey !== 'string' || !idempotencyKeyPattern.test(idempotencyKey)) throw claudeAgentError('invalid-input', 400)
  const modelValue = optionalText(model, 100)
  if (modelValue !== undefined && !validModelIdentifier(modelValue)) throw claudeAgentError('invalid-input', 400)
  if (effort !== undefined && effort !== null && !claudeAgentEfforts.includes(effort as ClaudeAgentEffort)) throw claudeAgentError('invalid-input', 400)
  const attachmentIds = raw.attachmentIds
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))) throw claudeAgentError('attachment-invalid',400)
  const permissionMode = raw.permissionMode === undefined ? undefined : validatePermissionMode(raw.permissionMode)
  return Object.freeze({ prompt, idempotencyKey, ...(attachmentIds ? { attachmentIds: attachmentIds as string[] } : {}), ...(modelValue ? { model: modelValue } : {}), ...(effort ? { effort: effort as ClaudeAgentEffort } : {}), ...(permissionMode ? { permissionMode } : {}) })
}
export function validatePermissionMode(value: unknown): PermissionModeView {
  if (!permissionModes.includes(value as PermissionModeView)) throw claudeAgentError('invalid-input', 400)
  return value as PermissionModeView
}
export function validateRunControl(raw: unknown): RunControlInput {
  if (!isRecord(raw)) throw claudeAgentError('invalid-input', 400)
  if (raw.action === 'mcp-set') { if(Object.keys(raw).some(k=>!['action','servers'].includes(k)))throw claudeAgentError('invalid-input',400);return {action:'mcp-set',servers:validateSessionOptions({mcpServers:raw.servers}).mcpServers} }
  if (raw.action === 'mcp-permission') { if(Object.keys(raw).some(k=>!['action','name','mode'].includes(k))||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>256||!['default','auto',null].includes(raw.mode as string|null))throw claudeAgentError('invalid-input',400);return {action:'mcp-permission',name:raw.name,mode:raw.mode as 'default'|'auto'|null} }
  if (raw.action === 'background-tasks') { if(Object.keys(raw).some(k=>!['action','toolUseId'].includes(k))||raw.toolUseId!==undefined&&(typeof raw.toolUseId!=='string'||raw.toolUseId.length>256))throw claudeAgentError('invalid-input',400);return {action:'background-tasks',...(raw.toolUseId?{toolUseId:String(raw.toolUseId)}:{})} }
  const keys = raw.action === 'permission-mode' ? ['action', 'mode'] : raw.action === 'reload-skills' ? ['action'] : raw.action === 'mcp-toggle' ? ['action', 'name', 'enabled'] : raw.action === 'mcp-reconnect' ? ['action', 'name'] : raw.action === 'stop-task' ? ['action', 'taskId'] : []
  if (!keys.length || Object.keys(raw).some(key => !keys.includes(key))) throw claudeAgentError('invalid-input', 400)
  if (raw.action === 'permission-mode') return { action: raw.action, mode: validatePermissionMode(raw.mode) }
  if (raw.action === 'reload-skills') return { action: raw.action }
  const name = raw.action === 'stop-task' ? raw.taskId : raw.name
  if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\x00-\x1f]/.test(name)) throw claudeAgentError('invalid-input', 400)
  if (raw.action === 'mcp-toggle') { if (typeof raw.enabled !== 'boolean') throw claudeAgentError('invalid-input', 400); return { action: raw.action, name, enabled: raw.enabled } }
  return raw.action === 'stop-task' ? { action: raw.action, taskId: name } : { action: 'mcp-reconnect', name }
}

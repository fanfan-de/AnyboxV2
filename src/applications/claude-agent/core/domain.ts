import { basename, isAbsolute } from 'node:path'
import { claudeAgentEfforts } from './view.js'
import type { ClaudeAgentEffort } from './view.js'

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
const modelPattern = /^[A-Za-z0-9._:-]{1,100}$/

export interface ThreadInput { readonly projectPath: string; readonly title?: string }
export interface RunInput { readonly prompt: string; readonly idempotencyKey: string; readonly model?: string; readonly effort?: ClaudeAgentEffort }

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
export function validateRunInput(raw: unknown): RunInput {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['prompt', 'idempotencyKey', 'model', 'effort'].includes(key))) throw claudeAgentError('invalid-input', 400)
  const { prompt, idempotencyKey, model, effort } = raw
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) throw claudeAgentError('invalid-input', 400, 'A prompt is required.')
  if (prompt.length > promptLimit) throw claudeAgentError('request-too-large', 413)
  if (typeof idempotencyKey !== 'string' || !idempotencyKeyPattern.test(idempotencyKey)) throw claudeAgentError('invalid-input', 400)
  const modelValue = optionalText(model, 100)
  if (modelValue !== undefined && !modelPattern.test(modelValue)) throw claudeAgentError('invalid-input', 400)
  if (effort !== undefined && effort !== null && !claudeAgentEfforts.includes(effort as ClaudeAgentEffort)) throw claudeAgentError('invalid-input', 400)
  return Object.freeze({ prompt, idempotencyKey, ...(modelValue ? { model: modelValue } : {}), ...(effort ? { effort: effort as ClaudeAgentEffort } : {}) })
}

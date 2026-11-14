import type { JsonValue } from '@anybox/tool-api'
import { validateLibraryArguments } from './contracts/index.js'

export interface FileToolRequest {
  readonly operation: 'read' | 'image' | 'write' | 'edit' | 'glob' | 'grep'
  readonly args: Readonly<Record<string, JsonValue>>
  readonly absolutePaths: boolean
  readonly detectImages: boolean
  readonly allowComplexGlob: boolean
}
/** Source naming/parameter conventions are resolved before entering resource components. */
export function adaptFileToolCall(name: string, raw: unknown): FileToolRequest {
  const args = validateLibraryArguments(name, raw)
  const absolutePaths = name.startsWith('claude_code_')
  const suffix = name.replace(/^(claude_code_|deepseek_harness_|codex_)/, '').toLowerCase()
  if (!['read', 'read_image', 'view_image', 'write', 'edit', 'glob', 'grep'].includes(suffix)) throw new TypeError('unsupported file tool')
  const operation = suffix === 'read_image' || suffix === 'view_image' ? 'image' : suffix as FileToolRequest['operation']
  const normalized: Record<string, JsonValue> = { ...args }
  if (suffix === 'view_image') normalized.file_path = args.path
  if (operation === 'grep') {
    const filter = absolutePaths ? args.glob : args.include
    delete normalized.include
    if (filter !== undefined) normalized.glob = filter
    normalized.output_mode = absolutePaths ? args.output_mode ?? 'files_with_matches' : 'content'
    normalized.head_limit = args.head_limit ?? (absolutePaths ? 100 : 250)
    normalized.only_matching = absolutePaths && args['-o'] === true
  }
  return { operation, args: normalized, absolutePaths, detectImages: absolutePaths && operation === 'read', allowComplexGlob: absolutePaths }
}
export type AdaptedProcessCall =
  | { readonly operation: 'execute'; readonly input: { readonly command: string; readonly workdir?: string; readonly shell?: string; readonly login?: boolean; readonly yieldTimeMs?: number; readonly maxOutputTokens?: number } }
  | { readonly operation: 'write'; readonly input: { readonly sessionId: number; readonly chars?: string; readonly yieldTimeMs?: number; readonly maxOutputTokens?: number } }
  | { readonly operation: 'foreground'; readonly input: { readonly command: string; readonly timeoutMs?: number; readonly workdir?: string } }
export function adaptProcessToolCall(name: string, raw: unknown): AdaptedProcessCall {
  const args = validateLibraryArguments(name, raw)
  if (name === 'codex_exec_command') return { operation: 'execute', input: {
    command: String(args.cmd), ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
    ...(typeof args.shell === 'string' ? { shell: args.shell } : {}), ...(typeof args.login === 'boolean' ? { login: args.login } : {}),
    ...(typeof args.yield_time_ms === 'number' ? { yieldTimeMs: args.yield_time_ms } : {}),
    ...(typeof args.max_output_tokens === 'number' ? { maxOutputTokens: args.max_output_tokens } : {}),
  } }
  if (name === 'codex_write_stdin') return { operation: 'write', input: {
    sessionId: Number(args.session_id), ...(typeof args.chars === 'string' ? { chars: args.chars } : {}),
    ...(typeof args.yield_time_ms === 'number' ? { yieldTimeMs: args.yield_time_ms } : {}),
    ...(typeof args.max_output_tokens === 'number' ? { maxOutputTokens: args.max_output_tokens } : {}),
  } }
  if (name !== 'claude_code_Bash' && name !== 'deepseek_harness_bash') throw new TypeError('unsupported process tool')
  return { operation: 'foreground', input: { command: String(args.command),
    ...(typeof (args.timeout ?? args.timeoutMs) === 'number' ? { timeoutMs: Number(args.timeout ?? args.timeoutMs) } : {}),
    ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
  } }
}

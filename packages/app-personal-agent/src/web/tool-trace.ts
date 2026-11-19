import type { RunView, RunEventView, ToolTrace, LibraryToolTrace } from './client-types.js'
import { isBashTrace, isApplyPatchTrace, isLibraryToolTrace } from './client-types.js'
import type { JsonValue } from '@anybox/models'
import type { ApplyPatchResult } from '@anybox/computer-tools/apply-patch-types'

const resultObject = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : {}

/** Frozen presentation adapters for the existing source contracts, including historical plans. */
const builtinPresentations = new Set([
  'codex_exec_command', 'codex_write_stdin', 'codex_apply_patch', 'codex_view_image', 'codex_update_plan',
  'claude_code_Bash', 'claude_code_Read', 'claude_code_Write', 'claude_code_Edit', 'claude_code_Glob', 'claude_code_Grep', 'claude_code_TodoWrite',
  'deepseek_harness_bash', 'deepseek_harness_read', 'deepseek_harness_read_image', 'deepseek_harness_write', 'deepseek_harness_edit', 'deepseek_harness_glob', 'deepseek_harness_grep', 'deepseek_harness_todo_write',
])

function libraryState(name: string, result: JsonValue): ToolTrace['state'] {
  // Arbitrary environment JSON is business data. Its successful observation is authoritative.
  if (!builtinPresentations.has(name)) return 'completed'
  const value = resultObject(result)
  if (value.status === 'applied' || value.status === 'partial' || value.status === 'rejected' || value.status === 'cancelled') return value.status
  if (value.status === 'error' || value.error || value.timed_out === true || typeof value.exit_code === 'number' && value.exit_code !== 0 || value.signal) return 'failed'
  return 'completed'
}

export function isPatchResult(value: unknown): value is ApplyPatchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (!['applied', 'rejected', 'partial', 'cancelled'].includes(String(result.status)) || !Array.isArray(result.changes) || !Array.isArray(result.pending)) return false
  const entry = (item: unknown, kinds: readonly string[]) => item !== null && typeof item === 'object' && !Array.isArray(item) &&
    'kind' in item && kinds.includes(String(item.kind)) && 'path' in item && typeof item.path === 'string'
  return result.changes.every(item => entry(item, ['added', 'updated', 'deleted'])) && result.pending.every(item => entry(item, ['add', 'update', 'delete']))
}

function genericTrace(call: ToolTrace, result: JsonValue): LibraryToolTrace {
  return { id: call.id, name: call.name, state: libraryState(call.name, result), result,
    arguments: isBashTrace(call) ? { command: call.command } : isApplyPatchTrace(call) ? { patch: call.patch } : call.arguments,
    ...(call.category === undefined ? {} : { category: call.category }),
    ...(call.eventIndex === undefined ? {} : { eventIndex: call.eventIndex }),
    ...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
    ...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }) }
}

/** Event order identifies batches; request IDs may be reused by later model calls. */
export function toolTrace(run: Pick<RunView, 'status'>, events: readonly RunEventView[]): readonly ToolTrace[] {
  const calls: ToolTrace[] = []
  const timestamp = (at: unknown): string | undefined => typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : undefined
  const latest = (id: string, name: ToolTrace['name']) =>
    [...calls].reverse().find(call => call.id === id && call.name === name)
  for (const [eventIndex, event] of events.entries()) {
    if (event.kind === 'model-tool-calls') {
      for (const call of event.calls) calls.push({ ...call, state: 'queued', eventIndex })
    } else if (event.kind === 'tool-started') {
      const call = latest(event.requestId, event.name)
      if (call?.state === 'queued') {
        call.state = 'running'
        call.startedAt = timestamp(event.at)
      }
      else if (call?.state !== 'running') calls.push('command' in event
        ? { id: event.requestId, name: 'bash', command: event.command, state: 'running', eventIndex, startedAt: timestamp(event.at) }
        : 'patch' in event
          ? { id: event.requestId, name: 'apply_patch', patch: event.patch, patchTruncated: event.patchTruncated, state: 'running', eventIndex, startedAt: timestamp(event.at) }
          : { id: event.requestId, name: event.name, arguments: event.arguments, state: 'running', eventIndex, startedAt: timestamp(event.at) })
    } else if (event.kind === 'tool-observed') {
      const call = latest(event.requestId, event.name)
      if (!call || call.state !== 'running') continue
      call.finishedAt = timestamp(event.at)
      if (isBashTrace(call) && 'stdout' in event) {
        call.state = event.exitCode === 0 ? 'completed' : 'failed'
        call.exitCode = event.exitCode
        call.signal = event.signal
        call.stdout = event.stdout
        call.stderr = event.stderr
        call.truncated = event.truncated
      } else if (isApplyPatchTrace(call) && 'result' in event && isPatchResult(event.result)) {
        call.state = event.result.status
        call.result = event.result
      } else if (isLibraryToolTrace(call) && 'result' in event) {
        const result = event.result as unknown as JsonValue
        call.state = libraryState(call.name, result); call.result = result; call.images = 'images' in event ? event.images : undefined
      } else if ('result' in event) {
        const generic = genericTrace(call, event.result as unknown as JsonValue)
        if ('images' in event) generic.images = event.images
        calls[calls.indexOf(call)] = generic
      }
    } else if (event.kind === 'tool-failed') {
      const call = latest(event.requestId, event.name)
      if (!call) continue
      call.state = 'failed'
      call.category = event.category
      call.finishedAt = timestamp(event.at) ?? call.finishedAt
      if (isApplyPatchTrace(call) && isPatchResult(event.result)) call.result = event.result
      else if (isLibraryToolTrace(call)) {
        if (event.result !== undefined) call.result = event.result as unknown as JsonValue
        if ('images' in event && event.images !== undefined) call.images = event.images
      } else if (event.result !== undefined) {
        const generic = genericTrace(call, event.result as unknown as JsonValue)
        generic.state = 'failed'
        if ('images' in event) generic.images = event.images
        calls[calls.indexOf(call)] = generic
      }
    } else if ((event.kind === 'operation-observed' || event.kind === 'operation-failed') && event.processes) {
      for (const closed of event.processes) {
        for (const call of calls) {
          if (!isLibraryToolTrace(call)) continue
          if (call.name !== 'codex_exec_command' && call.name !== 'codex_write_stdin') continue
          const value = resultObject(call.result)
          const sessionId = call.name === 'codex_write_stdin' ? call.arguments.session_id : value.session_id
          if (sessionId !== closed.sessionId) continue
          call.result = { ...value, output: [typeof value.output === 'string' ? value.output : '', closed.output].filter(Boolean).join(''),
            exit_code: closed.exitCode, signal: closed.signal, truncated: value.truncated === true || closed.truncated,
            terminated: closed.terminated, timed_out: closed.timedOut, closed: true, ...(closed.error ? { error: closed.error } : {}) }
          call.finishedAt = timestamp(event.at) ?? call.finishedAt
          if (closed.timedOut || closed.error || closed.exitCode !== 0 && !closed.terminated) call.state = 'failed'
        }
      }
    }
  }
  for (const call of calls) {
    if (run.status === 'cancelled' || run.status === 'interrupted') {
      if (call.state === 'queued' || call.state === 'running') {
        call.state = run.status
      }
    } else if (run.status === 'failed') {
      if (call.state === 'queued') call.state = 'skipped'
      else if (call.state === 'running') call.state = 'failed'
    }
  }
  return calls
}

import type { RunView, RunEventView, ToolTrace, LibraryToolName } from './client-types.js'
import type { JsonValue } from '@anybox/models'

const resultObject = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : {}

function libraryState(result: JsonValue): ToolTrace['state'] {
  const value = resultObject(result)
  if (value.status === 'applied' || value.status === 'partial' || value.status === 'rejected' || value.status === 'cancelled') return value.status
  if (value.status === 'error' || value.error || value.timed_out === true || typeof value.exit_code === 'number' && value.exit_code !== 0 || value.signal) return 'failed'
  return 'completed'
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
      else if (call?.state !== 'running') calls.push(event.name === 'bash'
        ? { id: event.requestId, name: 'bash', command: event.command, state: 'running', eventIndex, startedAt: timestamp(event.at) }
        : event.name === 'apply_patch'
          ? { id: event.requestId, name: 'apply_patch', patch: event.patch, patchTruncated: event.patchTruncated, state: 'running', eventIndex, startedAt: timestamp(event.at) }
          : { id: event.requestId, name: event.name, arguments: event.arguments, state: 'running', eventIndex, startedAt: timestamp(event.at) })
    } else if (event.kind === 'tool-observed') {
      const call = latest(event.requestId, event.name)
      if (!call || call.state !== 'running') continue
      call.finishedAt = timestamp(event.at)
      if (call.name === 'bash' && event.name === 'bash') {
        call.state = event.exitCode === 0 ? 'completed' : 'failed'
        call.exitCode = event.exitCode
        call.signal = event.signal
        call.stdout = event.stdout
        call.stderr = event.stderr
        call.truncated = event.truncated
      } else if (call.name === 'apply_patch' && event.name === 'apply_patch') {
        call.state = event.result.status
        call.result = event.result
      } else if (call.name !== 'bash' && call.name !== 'apply_patch' && event.name !== 'bash' && event.name !== 'apply_patch') {
        call.state = libraryState(event.result); call.result = event.result; call.images = event.images
      }
    } else if (event.kind === 'tool-failed') {
      const call = latest(event.requestId, event.name)
      if (!call) continue
      call.state = 'failed'
      call.category = event.category
      call.finishedAt = timestamp(event.at) ?? call.finishedAt
      if (call.name === 'apply_patch' && event.name === 'apply_patch' && event.result) call.result = event.result
      else if (call.name !== 'bash' && call.name !== 'apply_patch' && event.name !== 'bash' && event.name !== 'apply_patch') {
        const failed = event as Extract<RunEventView, { kind: 'tool-failed'; name: LibraryToolName }>
        if (failed.result !== undefined) call.result = failed.result
        if (failed.images !== undefined) call.images = failed.images
      }
    } else if ((event.kind === 'operation-observed' || event.kind === 'operation-failed') && event.processes) {
      for (const closed of event.processes) {
        for (const call of calls) {
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

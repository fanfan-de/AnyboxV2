import type { RunView, RunEventView, ToolTrace } from './client-types.js'

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
        : { id: event.requestId, name: 'apply_patch', patch: event.patch, patchTruncated: event.patchTruncated, state: 'running', eventIndex, startedAt: timestamp(event.at) })
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
      }
    } else if (event.kind === 'tool-failed') {
      const call = latest(event.requestId, event.name)
      if (!call) continue
      call.state = 'failed'
      call.category = event.category
      call.finishedAt = timestamp(event.at) ?? call.finishedAt
      if (call.name === 'apply_patch' && event.result) call.result = event.result
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

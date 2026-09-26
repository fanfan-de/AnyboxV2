import type { RunView, RunEventView, ToolTrace } from './client-types.js'

/** Event order identifies batches; request IDs may be reused by later model calls. */
export function toolTrace(run: Pick<RunView, 'status'>, events: readonly RunEventView[]): readonly ToolTrace[] {
  const calls: ToolTrace[] = []
  const latest = (id: string, name: ToolTrace['name']) =>
    [...calls].reverse().find(call => call.id === id && call.name === name)
  for (const event of events) {
    if (event.kind === 'model-tool-calls') {
      for (const call of event.calls) calls.push({ ...call, state: 'queued' })
    } else if (event.kind === 'tool-started') {
      const call = latest(event.requestId, event.name)
      if (call?.state === 'queued') call.state = 'running'
    } else if (event.kind === 'tool-observed') {
      const call = latest(event.requestId, event.name)
      if (!call || call.state !== 'running') continue
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
      if (call.name === 'apply_patch' && event.result) call.result = event.result
    }
  }
  for (const call of calls) {
    if (run.status === 'cancelled' || run.status === 'interrupted') {
      if (call.state === 'queued' || call.state === 'running') call.state = run.status
    } else if (run.status === 'failed') {
      if (call.state === 'queued') call.state = 'skipped'
      else if (call.state === 'running') call.state = 'failed'
    }
  }
  return calls
}

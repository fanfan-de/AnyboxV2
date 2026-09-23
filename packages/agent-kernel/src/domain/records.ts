import type { RunEvent, RunEventType, ToolCall } from '@anybox/agent-contracts'
import type { StateData } from '@anybox/agent-contracts/spi'

/** Deterministic draft operation; the caller owns the draft and supplies the timestamp. */
export function appendEvent(data: StateData, runId: string, type: RunEventType, status: string,
  createdAt: string, refs: Pick<RunEvent, 'stepId' | 'attemptId' | 'toolCallId'> = {}) {
  const run = data.runs.get(runId)!
  const seq = run.lastEventSeq + 1
  const events = data.events.get(runId) ?? []
  events.push({ runId, seq, type, status, createdAt, ...refs })
  data.events.set(runId, events)
  data.runs.set(runId, { ...run, lastEventSeq: seq })
}

/** Deterministic draft operation; IDs are allocated by the execution boundary. */
export function appendToolResult(state: StateData, call: ToolCall, id: string, createdAt: string) {
  state.messages.set(id, { id, runId: call.runId, sessionId: state.runs.get(call.runId)!.sessionId,
    role: 'tool', content: [{ type: 'tool-result', toolCallId: call.request.toolCallId, outcome: call.outcome! }],
    createdAt })
}

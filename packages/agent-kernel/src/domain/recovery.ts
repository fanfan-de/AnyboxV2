import type { KernelError } from '@anybox/agent-contracts'
import type { StateData, StateSnapshot } from '@anybox/agent-contracts/spi'
import { cloneState } from './state.js'
import { terminal } from '../shared/utils.js'
import { finishRunDraft, settleExecutionDraft } from './settlement.js'

/** Pure transition: no I/O, clock, random IDs, model calls or mutation of the input. */
export function planRecovery(snapshot: StateSnapshot, recoveredAt: string): {
  readonly state: StateData; readonly interruptedRunIds: readonly string[]
} {
  const state = cloneState(snapshot)
  const interruptedRunIds = [...state.runs.values()].filter(run => !terminal(run)).map(run => run.id)
  const error: KernelError = { code: 'INTERRUPTED', message: 'previous execution owner stopped before settlement' }
  for (const runId of interruptedRunIds) {
    settleExecutionDraft(state, runId, {
      endedAt: recoveredAt, status: 'failed', uncertainError: error, attemptError: error,
      // Kernel-created tool IDs are globally unique. Recovery keeps its existing message namespace.
      toolResultMessageIds: new Map([...state.toolCalls.values()]
        .filter(call => call.runId === runId && (call.status === 'pending' || call.status === 'running'))
        .map(call => [call.id, `recovered:${call.id}`])),
    })
    finishRunDraft(state, { ...state.runs.get(runId)!, status: 'interrupted', endedAt: recoveredAt, error })
  }
  return { state, interruptedRunIds }
}

import type { RunSnapshot, Step } from '@anybox/agent-contracts'
import type { StateSnapshot } from '@anybox/agent-contracts/spi'
import { fault } from '../shared/errors.js'

export function executionRun(state: StateSnapshot, runId: string, allowCancelling = false): RunSnapshot {
  const run = state.runs.get(runId)
  if (!run) throw fault('NOT_FOUND', 'run not found')
  if (run.status !== 'running' && !(allowCancelling && run.status === 'cancelling')) {
    throw fault('CONFLICT', 'run does not accept execution changes')
  }
  return run
}

export function executionStep(state: StateSnapshot, runId: string, stepId: string): Step {
  const step = state.steps.get(stepId)
  if (!step || step.runId !== runId) throw fault('CONFLICT', 'step does not belong to this run')
  return step
}

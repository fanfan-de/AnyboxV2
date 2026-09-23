import type { RunEvent, RunEventType } from '@anybox/agent-contracts'
import type { StateData } from '@anybox/agent-contracts/spi'
import { appendEvent as appendEventDraft } from '../../domain/records.js'

/** Called inside the same transaction as the referenced record changes. */
export function appendEvent(data: StateData, runId: string, type: RunEventType, status: string,
  refs: Pick<RunEvent, 'stepId' | 'attemptId' | 'toolCallId'> = {}) {
  appendEventDraft(data, runId, type, status, new Date().toISOString(), refs)
}

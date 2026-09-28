import type {} from '@nya/core'
import type { ModelEvent } from '@anybox/models'

/** Ephemeral progress only. Clients must use durable Run state for final output. */
export interface RunModelEvent {
  readonly sessionId: string
  readonly runId: string
  readonly event: ModelEvent
}

export const runModelEvent = 'harness.run-model-event'

/** A committed change hint. Durable Run state and RunEvent records remain the source of truth. */
export interface RunChange {
  readonly sessionId: string
  readonly runId: string
  readonly revision: number
}

export const runChangedEvent = 'harness.run.changed'

declare module '@nya/core' {
  interface Events {
    /** Listeners enqueue notifications only; they must not wait for clients or start Run work. */
    'harness.run.changed': (change: RunChange) => void
    /** Listeners synchronously enqueue into a bounded queue; never await a client. */
    'harness.run-model-event': (progress: RunModelEvent) => void
  }
}

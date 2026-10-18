import type {} from '@nya/core'
import type { ProtocolViewFrame } from './program.js'

export interface RunViewEvent {
  readonly sessionId: string
  readonly runId: string
  readonly sequence: number
  readonly frame: ProtocolViewFrame
}
export const runViewEvent = 'harness.run-view'
/** A committed change hint; Session remains the owner of every durable fact. */
export interface RunChange {
  readonly sessionId: string
  readonly runId: string
  readonly revision: number
}
export const runChangedEvent = 'harness.run.changed'
declare module '@nya/core' {
  interface Events {
    'harness.run.changed': (change: RunChange) => void
    'harness.run-view': (progress: RunViewEvent) => void
  }
}

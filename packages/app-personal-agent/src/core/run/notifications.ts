import type {} from '@nya/core'
import type { ProtocolViewFrame } from './program.js'

export interface RunViewEvent {
  readonly sessionId: string
  readonly runId: string
  readonly sequence: number
  readonly frame: ProtocolViewFrame
}
export const runViewEvent = 'personal-agent.run-view'
/** A committed change hint; Session remains the owner of every durable fact. */
export interface RunChange {
  readonly sessionId: string
  readonly runId: string
  readonly revision: number
}
export const runChangedEvent = 'personal-agent.run.changed'
declare module '@nya/core' {
  interface Events {
    'personal-agent.run.changed': (change: RunChange) => void
    'personal-agent.run-view': (progress: RunViewEvent) => void
  }
}

import type { StateData, StateSnapshot } from '@anybox/agent-contracts/spi'

export interface StateTransition<T> {
  readonly state: StateData
  readonly value: T
}

/** Materialize an isolated, owned draft from a read-only snapshot, including readonly event arrays. */
export function cloneState(snapshot: StateSnapshot): StateData {
  return structuredClone({ ...snapshot,
    sessions: new Map(snapshot.sessions), messages: new Map(snapshot.messages), runs: new Map(snapshot.runs),
    requests: new Map(snapshot.requests), steps: new Map(snapshot.steps), attempts: new Map(snapshot.attempts),
    toolCalls: new Map(snapshot.toolCalls),
    events: new Map([...snapshot.events].map(([runId, events]) => [runId, [...events]])),
  })
}

import type { StateData } from '@anybox/agent-contracts/spi'
import { fault } from '../../shared/errors.js'

export const stateCollections = ['sessions', 'messages', 'runs', 'requests', 'steps', 'attempts', 'toolCalls', 'events'] as const

export const emptyState = (): StateData => ({ sessions: new Map(), messages: new Map(), runs: new Map(), requests: new Map(),
  steps: new Map(), attempts: new Map(), toolCalls: new Map(), events: new Map() })

/** Persist only plain data. Undefined object properties are intentionally omitted like optional fields. */
function assertPlain(value: unknown, seen = new Set<object>()): void {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || seen.has(value)) throw fault('INVALID_ARGUMENT', 'state must contain finite acyclic JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fault('INVALID_ARGUMENT', 'state records must be plain objects')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) throw fault('INVALID_ARGUMENT', 'state arrays cannot contain undefined')
      assertPlain(value[i], seen)
    }
  } else for (const item of Object.values(value)) assertPlain(item, seen)
  seen.delete(value)
}

export function encodeState(state: StateData): string {
  const value = { version: 1, agent: state.agent, definition: state.definition,
    ...Object.fromEntries(stateCollections.map(key => {
      if (!(state[key] instanceof Map)) throw fault('INVALID_ARGUMENT', `state.${key} must be a Map`)
      return [key, [...state[key]]]
    })) }
  assertPlain(value)
  return JSON.stringify(value)
}

/** Pure decoding and structural validation. Unknown schema versions are never overwritten. */
export function decodeState(payload: string): StateData {
  const value: unknown = JSON.parse(payload)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('STATE_FAILED', 'invalid stored state')
  const document = value as Record<string, unknown>
  if (document.version !== 1) throw fault('STATE_FAILED', 'unsupported state format version')
  const state = emptyState()
  for (const key of stateCollections) {
    const pairs = document[key]
    if (!Array.isArray(pairs)) throw fault('STATE_FAILED', `invalid stored ${key}`)
    const entries = new Map<string, unknown>()
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || entries.has(pair[0])
        || !pair[1] || typeof pair[1] !== 'object') throw fault('STATE_FAILED', `invalid stored ${key} entry`)
      if (key !== 'requests' && key !== 'events' && pair[1].id !== pair[0]) throw fault('STATE_FAILED', 'stored identity does not match key')
      if (key === 'events' && !Array.isArray(pair[1])) throw fault('STATE_FAILED', 'invalid stored events')
      entries.set(pair[0], pair[1])
    }
    Object.assign(state, { [key]: entries })
  }
  if (document.agent !== undefined) {
    if (!document.agent || typeof document.agent !== 'object' || typeof (document.agent as { id?: unknown }).id !== 'string') throw fault('STATE_FAILED', 'invalid stored agent')
    state.agent = document.agent as StateData['agent']
  }
  if (document.definition !== undefined) state.definition = document.definition as StateData['definition']
  for (const run of state.runs.values()) {
    if (!state.sessions.has(run.sessionId) || !state.messages.has(run.inputMessageId)
      || !['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      || !Number.isSafeInteger(run.lastEventSeq) || run.lastEventSeq < 0) throw fault('STATE_FAILED', 'invalid stored run')
    const events = state.events.get(run.id) ?? []
    if (events.length !== run.lastEventSeq || events.some((event, index) => event.runId !== run.id || event.seq !== index + 1)) {
      throw fault('STATE_FAILED', 'stored event sequence is inconsistent')
    }
  }
  for (const step of state.steps.values()) {
    if (!state.runs.has(step.runId) || !state.attempts.has(step.attemptId)) throw fault('STATE_FAILED', 'orphaned stored step')
  }
  for (const call of state.toolCalls.values()) {
    if (!state.runs.has(call.runId) || !state.steps.has(call.stepId)) throw fault('STATE_FAILED', 'orphaned stored tool call')
  }
  return state
}

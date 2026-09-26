import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { validateToolBatch } from './domain.js'
import type { RunFailureCategory, RunStatus, ValidatedToolRequest, ToolObservation } from './domain.js'

export type RunPhase = 'ready-model' | 'model-in-flight' | 'ready-tool' | 'tool-in-flight' | 'terminal'

export interface RunExecution {
  readonly phase: RunPhase
  readonly revision: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly nextToolIndex: number
  readonly batch: readonly ValidatedToolRequest[]
}

export type RunEventData =
  | { readonly kind: 'model-started' }
  | { readonly kind: 'model-tool-calls'; readonly calls: readonly ValidatedToolRequest[] }
  | { readonly kind: 'tool-started'; readonly call: ValidatedToolRequest }
  | ({ readonly kind: 'tool-observed'; readonly requestId: string } & ToolObservation)
  | { readonly kind: 'tool-failed'; readonly name: ValidatedToolRequest['name']; readonly requestId: string; readonly category: RunFailureCategory; readonly result?: ApplyPatchResult }
  | { readonly kind: 'terminal'; readonly status: RunStatus; readonly errorCategory?: RunFailureCategory }
  | { readonly kind: 'interrupted'; readonly previousPhase: RunPhase }

export type RunEvent = RunEventData & { readonly seq: number; readonly at: string }
export type ActiveRunEvent = Exclude<RunEventData, { readonly kind: 'terminal' | 'interrupted' }>

export const initialRunExecution: RunExecution = Object.freeze({
  phase: 'ready-model', revision: 0, modelCalls: 0, toolCalls: 0, nextToolIndex: 0, batch: Object.freeze([]),
})

/** Each event advances the durable phase and revision before an external operation may start. */
export function advanceExecution(current: RunExecution, event: RunEventData): RunExecution {
  const invalid = (): never => { throw new Error(`invalid Run transition: ${current.phase} + ${event.kind}`) }
  const revision = current.revision + 1
  switch (event.kind) {
    case 'model-started':
      if (current.phase !== 'ready-model') return invalid()
      return Object.freeze({ ...current, phase: 'model-in-flight', modelCalls: current.modelCalls + 1, revision })
    case 'model-tool-calls':
      if (current.phase !== 'model-in-flight' || event.calls.length === 0) return invalid()
      return Object.freeze({ ...current, phase: 'ready-tool', batch: Object.freeze([...event.calls]),
        nextToolIndex: 0, revision })
    case 'tool-started':
      if (current.phase !== 'ready-tool' ||
        current.batch[current.nextToolIndex]?.id !== event.call.id ||
        current.batch[current.nextToolIndex]?.name !== event.call.name) return invalid()
      return Object.freeze({ ...current, phase: 'tool-in-flight', toolCalls: current.toolCalls + 1, revision })
    case 'tool-observed': {
      if (current.phase !== 'tool-in-flight' ||
        current.batch[current.nextToolIndex]?.id !== event.requestId ||
        current.batch[current.nextToolIndex]?.name !== event.name) return invalid()
      const nextToolIndex = current.nextToolIndex + 1
      return Object.freeze({ ...current, phase: nextToolIndex === current.batch.length ? 'ready-model' : 'ready-tool',
        batch: nextToolIndex === current.batch.length ? Object.freeze([]) : current.batch,
        nextToolIndex: nextToolIndex === current.batch.length ? 0 : nextToolIndex, revision })
    }
    case 'tool-failed':
      if (current.phase !== 'tool-in-flight' ||
        current.batch[current.nextToolIndex]?.id !== event.requestId ||
        current.batch[current.nextToolIndex]?.name !== event.name) return invalid()
      return Object.freeze({ ...current, revision })
    case 'terminal':
    case 'interrupted':
      if (current.phase === 'terminal') return invalid()
      return Object.freeze({ ...current, phase: 'terminal', batch: Object.freeze([]), nextToolIndex: 0, revision })
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid stored Run data')
  return value as Record<string, unknown>
}

const phases = ['ready-model', 'model-in-flight', 'ready-tool', 'tool-in-flight', 'terminal']
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Read the retired Bash-only format, but always return the current writable shape. */
export function parseRunExecution(raw: string): RunExecution {
  const value = object(JSON.parse(raw))
  const count = value.toolCalls ?? value.bashCalls
  if (!phases.includes(String(value.phase)) || !integer(value.revision) || !integer(value.modelCalls) ||
    !integer(count) || !integer(value.nextToolIndex) || !Array.isArray(value.batch)) {
    throw new Error('invalid stored Run execution')
  }
  const batch = value.batch.length ? validateToolBatch(value.batch) : Object.freeze([])
  if (value.nextToolIndex > batch.length) throw new Error('invalid stored tool index')
  return Object.freeze({ phase: value.phase as RunPhase, revision: value.revision,
    modelCalls: value.modelCalls, toolCalls: count, nextToolIndex: value.nextToolIndex, batch })
}

/** Compatibility stays at the persistence boundary; there is no legacy event writer. */
export function parseRunEvent(raw: string, seq: number, at: string): RunEvent {
  const stored = object(JSON.parse(raw))
  const legacy = typeof stored.kind === 'string' && ['bash-started', 'bash-observed', 'bash-failed'].includes(stored.kind)
  const value = legacy ? { ...stored, kind: String(stored.kind).replace('bash-', 'tool-'), name: 'bash' } : stored
  if (!integer(seq) || seq === 0 || typeof at !== 'string') throw new Error('invalid stored event position')
  let event: RunEventData
  switch (value.kind) {
    case 'model-started': event = { kind: value.kind }; break
    case 'model-tool-calls': event = { kind: value.kind, calls: validateToolBatch(value.calls) }; break
    case 'tool-started': event = { kind: value.kind, call: validateToolBatch([value.call])[0]! }; break
    case 'tool-observed':
    case 'tool-failed': {
      if ((value.name !== 'bash' && value.name !== 'apply_patch') || typeof value.requestId !== 'string' || !value.requestId) {
        throw new Error('invalid stored tool event')
      }
      if (value.kind === 'tool-failed') {
        if (typeof value.category !== 'string') throw new Error('invalid stored tool failure')
        event = { kind: value.kind, name: value.name, requestId: value.requestId,
          category: value.category as RunFailureCategory,
          ...(value.result === undefined ? {} : { result: object(value.result) as unknown as ApplyPatchResult }) }
      } else {
        object(value.result)
        event = { kind: value.kind, name: value.name, requestId: value.requestId, result: value.result } as RunEventData
      }
      break
    }
    case 'terminal':
      if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(String(value.status))) throw new Error('invalid stored terminal event')
      event = { kind: value.kind, status: value.status as RunStatus,
        ...(typeof value.errorCategory === 'string' ? { errorCategory: value.errorCategory as RunFailureCategory } : {}) }
      break
    case 'interrupted':
      if (!phases.includes(String(value.previousPhase))) throw new Error('invalid stored interruption')
      event = { kind: value.kind, previousPhase: value.previousPhase as RunPhase }; break
    default: throw new Error('invalid stored Run event')
  }
  return Object.freeze({ ...event, seq, at })
}

import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { validateToolBatch } from './domain.js'
import type { RunFailureCategory, RunStatus, ValidatedToolRequest, ToolObservation } from './domain.js'

export type RunPhase = 'active' | 'ready-model' | 'model-in-flight' | 'ready-tool' | 'tool-in-flight' | 'terminal'

export interface RunExecution {
  readonly phase: RunPhase
  readonly revision: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly nextToolIndex: number
  readonly batch: readonly ValidatedToolRequest[]
}

export type RunEventData =
  | { readonly kind: 'operation-started'; readonly operationId: string; readonly operationKind: 'model' | 'operation' }
  | { readonly kind: 'operation-observed'; readonly operationId: string }
  | { readonly kind: 'operation-failed'; readonly operationId: string; readonly category: RunFailureCategory }
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

/** Current writes validate operation facts; old model/tool phases exist only in the reader. */
export function advanceExecution(current: RunExecution, event: RunEventData): RunExecution {
  if (current.phase === 'terminal') throw new Error('Run is already terminal')
  const revision = current.revision + 1
  if (event.kind === 'terminal' || event.kind === 'interrupted') {
    return Object.freeze({ ...current, phase: 'terminal', batch: Object.freeze([]), nextToolIndex: 0, revision })
  }
  if (current.phase !== 'active' || event.kind === 'model-started' || event.kind === 'model-tool-calls') throw new Error('legacy Run execution is read-only')
  return Object.freeze({ ...current, revision,
    modelCalls: current.modelCalls + (event.kind === 'operation-started' && event.operationKind === 'model' ? 1 : 0),
    toolCalls: current.toolCalls + (event.kind === 'tool-started' ? 1 : 0) })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid stored Run data')
  return value as Record<string, unknown>
}

const phases = ['active', 'ready-model', 'model-in-flight', 'ready-tool', 'tool-in-flight', 'terminal']
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
    case 'operation-started':
      if (typeof value.operationId !== 'string' || (value.operationKind !== 'model' && value.operationKind !== 'operation')) throw new Error('invalid operation event')
      event = { kind: value.kind, operationId: value.operationId, operationKind: value.operationKind }; break
    case 'operation-observed':
      if (typeof value.operationId !== 'string') throw new Error('invalid operation event')
      event = { kind: value.kind, operationId: value.operationId }; break
    case 'operation-failed':
      if (typeof value.operationId !== 'string' || typeof value.category !== 'string') throw new Error('invalid operation event')
      event = { kind: value.kind, operationId: value.operationId, category: value.category as RunFailureCategory }; break
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

import type { BashResult } from '../tool/bash-component.js'
import type { RunFailureCategory, RunStatus, ValidatedBashRequest } from './domain.js'

export type RunPhase = 'ready-model' | 'model-in-flight' | 'ready-tool' | 'tool-in-flight' | 'terminal'

export interface RunExecution {
  readonly phase: RunPhase
  readonly revision: number
  readonly modelCalls: number
  readonly bashCalls: number
  readonly nextToolIndex: number
  readonly batch: readonly ValidatedBashRequest[]
}

export type RunEventData =
  | { readonly kind: 'model-started' }
  | { readonly kind: 'model-tool-calls'; readonly calls: readonly ValidatedBashRequest[] }
  | { readonly kind: 'bash-started'; readonly call: ValidatedBashRequest }
  | { readonly kind: 'bash-observed'; readonly requestId: string; readonly result: BashResult }
  | { readonly kind: 'bash-failed'; readonly requestId: string; readonly category: RunFailureCategory }
  | { readonly kind: 'terminal'; readonly status: RunStatus; readonly errorCategory?: RunFailureCategory }
  | { readonly kind: 'interrupted'; readonly previousPhase: RunPhase }

export type RunEvent = RunEventData & { readonly seq: number; readonly at: string }
export type ActiveRunEvent = Exclude<RunEventData, { readonly kind: 'terminal' | 'interrupted' }>

export const initialRunExecution: RunExecution = Object.freeze({
  phase: 'ready-model', revision: 0, modelCalls: 0, bashCalls: 0, nextToolIndex: 0, batch: Object.freeze([]),
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
    case 'bash-started':
      if (current.phase !== 'ready-tool' ||
        current.batch[current.nextToolIndex]?.id !== event.call.id) return invalid()
      return Object.freeze({ ...current, phase: 'tool-in-flight', bashCalls: current.bashCalls + 1, revision })
    case 'bash-observed': {
      if (current.phase !== 'tool-in-flight' ||
        current.batch[current.nextToolIndex]?.id !== event.requestId) return invalid()
      const nextToolIndex = current.nextToolIndex + 1
      return Object.freeze({ ...current, phase: nextToolIndex === current.batch.length ? 'ready-model' : 'ready-tool',
        batch: nextToolIndex === current.batch.length ? Object.freeze([]) : current.batch,
        nextToolIndex: nextToolIndex === current.batch.length ? 0 : nextToolIndex, revision })
    }
    case 'bash-failed':
      if (current.phase !== 'tool-in-flight' ||
        current.batch[current.nextToolIndex]?.id !== event.requestId) return invalid()
      return Object.freeze({ ...current, revision })
    case 'terminal':
    case 'interrupted':
      if (current.phase === 'terminal') return invalid()
      return Object.freeze({ ...current, phase: 'terminal', batch: Object.freeze([]), nextToolIndex: 0, revision })
  }
}

export function parseRunExecution(raw: string): RunExecution {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' ||
    !('phase' in value) || !['ready-model', 'model-in-flight', 'ready-tool', 'tool-in-flight', 'terminal'].includes(String(value.phase)) ||
    !('revision' in value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !('modelCalls' in value) || !Number.isSafeInteger(value.modelCalls) ||
    !('bashCalls' in value) || !Number.isSafeInteger(value.bashCalls) ||
    !('nextToolIndex' in value) || !Number.isSafeInteger(value.nextToolIndex) ||
    !('batch' in value) || !Array.isArray(value.batch)) {
    throw new Error('invalid stored Run execution')
  }
  return value as unknown as RunExecution
}

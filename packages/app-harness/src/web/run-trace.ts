import type { RunEventView, RunView, ToolTrace } from './client-types.js'
import { toolTrace } from './tool-trace.js'

export type OperationTraceState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recorded'
export interface OperationTraceStep {
  readonly kind: 'model' | 'operation'
  readonly id: string
  readonly eventIndex: number
  readonly state: OperationTraceState
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly category?: string
  /** Retired model-started events have no matching exit observation. */
  readonly legacy: boolean
}
export interface ToolTraceStep {
  readonly kind: 'tool'
  readonly id: string
  readonly eventIndex: number
  readonly call: ToolTrace
}
export type RunTraceStep = OperationTraceStep | ToolTraceStep
export interface RunTrace {
  readonly steps: readonly RunTraceStep[]
  readonly counts: Readonly<{ modelCalls: number; toolCalls: number }>
  readonly modelName?: string
  readonly protocolId?: string
  readonly createdAt: string
  readonly finishedAt?: string
  readonly elapsedMs?: number
  readonly legacy: boolean
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : undefined
}

/** Unknown timestamps and clocks that move backwards never produce a duration. */
export function traceElapsed(start: string | undefined, end: string | undefined): number | undefined {
  if (!timestamp(start) || !timestamp(end)) return undefined
  const elapsed = Date.parse(end!) - Date.parse(start!)
  return elapsed >= 0 ? elapsed : undefined
}

export function formatTraceDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60_000) return `${Number((milliseconds / 1000).toFixed(1))} s`
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`
}

/** Derive display facts from durable events without reading private protocol records. */
export function runTrace(run: RunView, events: readonly RunEventView[]): RunTrace {
  const active = run.status === 'running' || run.status === 'cancelling'
  const terminalAt = timestamp([...events].reverse().find(event => event.kind === 'terminal')?.at)
  // Recovery records when interruption was detected, not when the process exited.
  const finishedAt = active || run.status === 'interrupted' ? undefined : timestamp(run.updatedAt) ?? terminalAt
  const operations: OperationTraceStep[] = []
  let modelCalls = 0, toolCalls = 0
  for (const [eventIndex, event] of events.entries()) {
    if (event.kind === 'operation-started') {
      if (event.operationKind === 'model') modelCalls++
      operations.push({ kind: event.operationKind, id: event.operationId, eventIndex, state: 'running',
        startedAt: timestamp(event.at), legacy: false })
    } else if (event.kind === 'model-started') {
      modelCalls++
      operations.push({ kind: 'model', id: `legacy-model-${eventIndex}`, eventIndex, state: 'recorded',
        startedAt: timestamp(event.at), legacy: true })
    } else if (event.kind === 'operation-observed' || event.kind === 'operation-failed') {
      let index = operations.length - 1
      while (index >= 0 && (operations[index]!.legacy || operations[index]!.id !== event.operationId)) index--
      const operation = operations[index]
      if (!operation) continue
      operations[index] = { ...operation, state: event.kind === 'operation-observed' ? 'completed' : 'failed',
        finishedAt: timestamp(event.at), ...(event.kind === 'operation-failed' ? { category: event.category } : {}) }
    } else if (event.kind === 'tool-started') toolCalls++
  }
  const settledOperations = operations.map(operation => {
    if (operation.state !== 'running' || active) return operation
    // A completed Run with a missing observation cannot establish operation success.
    const state: OperationTraceState = run.status === 'cancelled' || run.status === 'interrupted' ? run.status
      : run.status === 'failed' ? 'failed' : 'recorded'
    return { ...operation, state }
  })
  const tools: ToolTraceStep[] = toolTrace(run, events).map((call, index) => ({
    kind: 'tool', id: call.id, eventIndex: call.eventIndex ?? events.length + index, call,
  }))
  const modelName = run.modelSnapshot?.remoteModelId || undefined
  const protocolId = run.protocolBinding?.protocolId || run.modelSnapshot?.protocolId || undefined
  const elapsedMs = traceElapsed(run.createdAt, finishedAt)
  return {
    steps: [...settledOperations, ...tools].sort((a, b) => a.eventIndex - b.eventIndex),
    counts: { modelCalls, toolCalls },
    ...(modelName ? { modelName } : {}), ...(protocolId ? { protocolId } : {}),
    createdAt: run.createdAt, ...(finishedAt ? { finishedAt } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    legacy: run.history.kind === 'legacy-unknown',
  }
}

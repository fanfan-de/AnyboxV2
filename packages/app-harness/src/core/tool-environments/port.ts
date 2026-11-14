import type { ToolEnvironment } from '@anybox/tool-api'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'

export interface ToolEnvironmentRunContext {
  readonly runId: string
  readonly runOwnerEpoch: number
  readonly signal: AbortSignal
  readonly resuming?: boolean
}

export interface ToolEnvironmentRun {
  execute(request: ValidatedToolRequest, operationId: string, resuming?: boolean): OwnedCall<ToolObservation>
  hasResources(): boolean
  /** Computer compatibility metadata; other environments need not expose process semantics. */
  hasProcesses(): boolean
  cancel(): Promise<void>
  close(): OwnedCall<JsonValue>
}

export interface ToolEnvironmentRegistry {
  snapshot(environmentIds: readonly string[], computerToolIds?: readonly string[]): ToolEnvironmentSnapshot
  validate(snapshot: ToolEnvironmentSnapshot): ToolEnvironmentSnapshot
  openRun(snapshot: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext, overrides?: readonly ToolEnvironment[]): ToolEnvironmentRun
  readonly environments: readonly ToolEnvironment[]
}

import type { ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor } from '@anybox/tool-api'
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
  cancel(): Promise<void>
  close(): OwnedCall<JsonValue>
}

/** Pure selection and history policy owned by the environment's trusted adapter. */
export interface ToolEnvironmentCatalogEntry {
  readonly descriptor: ToolEnvironmentDescriptor
  readonly historyTools?: readonly ToolDescriptor[]
  readonly validateSelection?: (tools: readonly ToolDescriptor[]) => void
}

export interface ToolEnvironmentCatalog {
  snapshot(environmentIds: readonly string[], toolIdsByEnvironment?: Readonly<Record<string, readonly string[]>>): ToolEnvironmentSnapshot
  validate(snapshot: ToolEnvironmentSnapshot): ToolEnvironmentSnapshot
  bind(providers: readonly ToolEnvironment[]): ToolEnvironmentRegistry
  readonly environments: readonly ToolEnvironmentDescriptor[]
}

/** Executable providers bound once to the current component dependency generation. */
export interface ToolEnvironmentRegistry {
  openRun(snapshot: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext): ToolEnvironmentRun
}

/** Trusted assembly contributes dependencies without introducing another resource owner. */
export interface ToolEnvironmentRuntimeBinding {
  readonly inject: readonly string[]
  bind(deps: Readonly<Record<string, unknown>>): ToolEnvironmentRegistry
}

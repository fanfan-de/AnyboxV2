import type { ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor } from '@anybox/tool-api'
import type { JsonValue, ToolCall, ToolRequest, ToolEnvironmentResult, ToolEnvironmentScope, ToolEnvironmentScopeContext } from '@anybox/tool-api'
import type { StorageReader } from '@anybox/storage-sqlite/port'
import type { ToolPreferences, ToolPreferencesByTarget } from './bindings.js'
import type { EnvironmentTool } from './contracts.js'
import type { ToolEnvironmentSnapshot } from './snapshot.js'

export interface ToolObservation extends ToolEnvironmentResult { readonly name: string }
export type ToolScopeTarget = Pick<EnvironmentTool, 'environmentId' | 'targetId'>

export interface ToolEnvironmentRunContext {
  readonly runId: string
  readonly runOwnerEpoch: number
  readonly signal: AbortSignal
  readonly resuming?: boolean
  readonly lazyScopes?: boolean
}

export interface ToolEnvironmentRun {
  execute(request: ToolRequest, operationId: string, resuming?: boolean, target?: ToolScopeTarget): ToolCall<ToolObservation>
  /** Open a scope after admission. False proves preflight refused before entering the provider. */
  openTarget(target: ToolScopeTarget): boolean
  /** Reopen an admitted target through an adapter that can observe its original scope. */
  restoreTarget(target: ToolScopeTarget): void
  hasResources(): boolean
  cancel(): Promise<void>
  close(onTargetExit?: (target: ToolScopeTarget, proven: boolean) => void | Promise<void>): ToolCall<JsonValue>
}

export interface TargetedToolEnvironmentTarget {
  readonly targetId: string
  readonly name?: string
  /** Stable identity used by preferences across revisions of this target. */
  readonly selectionId: string
  readonly tools: readonly ToolDescriptor[]
}

export interface TargetedToolEnvironment {
  readonly environmentId: string
  readonly version: string
  readonly recovery?: 'observe-existing'
  targets(reader?: StorageReader): readonly TargetedToolEnvironmentTarget[]
  openTargetScope(targetId: string, context: ToolEnvironmentScopeContext): ToolEnvironmentScope
  /** Must observe the original scope, including unknown exits, without opening replacement resources. */
  restoreTargetScope?(targetId: string, context: ToolEnvironmentScopeContext): ToolEnvironmentScope
}

/** Pure selection and history policy owned by the environment's trusted adapter. */
export interface ToolEnvironmentCatalogEntry {
  readonly descriptor: ToolEnvironmentDescriptor
  readonly targets?: (reader?: StorageReader) => readonly TargetedToolEnvironmentTarget[]
  readonly historyTools?: readonly ToolDescriptor[]
  readonly validateSelection?: (tools: readonly ToolDescriptor[]) => void
}

export interface ToolEnvironmentCatalog {
  isTargeted(environmentId: string): boolean
  targets(environmentId: string, reader?: StorageReader): readonly TargetedToolEnvironmentTarget[]
  snapshot(environmentIds: readonly string[], toolIdsByEnvironment?: ToolPreferences, toolIdsByTarget?: ToolPreferencesByTarget, reader?: StorageReader): ToolEnvironmentSnapshot
  validate(snapshot: ToolEnvironmentSnapshot, reader?: StorageReader): ToolEnvironmentSnapshot
  bind(providers: readonly ToolEnvironment[], targetedProviders?: readonly TargetedToolEnvironment[]): ToolEnvironmentRegistry
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

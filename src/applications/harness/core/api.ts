/** Public, serializable transport projections. No execution handles or private recovery records. */
import type { FileRef } from './project-files/domain.js'
import type { Model, Provider, NativeModelSnapshot, ProviderTemplate } from '@anybox/models'
import type { LegacyExecutionSnapshot } from './run/legacy-snapshot.js'
import type { ApplyPatchResult } from './tool/apply-patch-types.js'
import type { ImageRef } from './image/port.js'
export type { ImageRef } from './image/port.js'

export interface AgentView { readonly id: string; readonly harnessName?: string }
export interface SessionView {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly modelId: string | null
  readonly protocolId: string | null
  readonly historyMode: 'dialogue-v1' | 'native-local-v1'
  readonly archivedAt: string | null
  readonly createdAt: string
}
export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface ProjectView {
  readonly instanceId?: string
  readonly harnessName?: string
  readonly id: string
  readonly path: string
  readonly name: string
  readonly available: boolean
}
export interface RunView {
  readonly modelId: string | null
  readonly requestedModelId: string | null
  readonly updatedAt?: string
  readonly legacyModelSnapshot?: Readonly<{ profileId: string; configVersion: string }>
  readonly modelSnapshot: LegacyExecutionSnapshot | NativeModelSnapshot | null
  readonly protocolBinding?: { readonly protocolId: string; readonly viewSchemaVersion: number }
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly images?: readonly ImageRef[]
  readonly files?: readonly FileRef[]
  readonly status: RunStatus
  readonly resultNodeId?: string
  readonly history: { readonly kind: 'tree'; readonly parentNodeId: string | null } | { readonly kind: 'legacy-unknown' }
  readonly revision: number
  readonly createdAt: string
  readonly output?: string
  readonly error?: string
  readonly errorCategory?: string
}
export type ToolCallView =
  | { readonly id: string; readonly name: 'bash'; readonly command: string }
  | { readonly id: string; readonly name: 'apply_patch'; readonly patch: string; readonly patchTruncated: boolean }
export type RunEventView = { readonly seq: number; readonly at: string } & (
  | { readonly kind: 'operation-started'; readonly operationId: string; readonly operationKind: 'model' | 'operation' }
  | { readonly kind: 'operation-observed'; readonly operationId: string }
  | { readonly kind: 'operation-failed'; readonly operationId: string; readonly category: string }
  | { readonly kind: 'model-started' | 'terminal' | 'interrupted' }
  | { readonly kind: 'model-tool-calls'; readonly calls: readonly ToolCallView[] }
  | ({ readonly kind: 'tool-started'; readonly requestId: string } & ToolCallView)
  | { readonly kind: 'tool-observed'; readonly name: 'bash'; readonly requestId: string;
      readonly exitCode: number | null; readonly signal: string | null; readonly stdout: string;
      readonly stderr: string; readonly truncated: boolean }
  | { readonly kind: 'tool-observed'; readonly name: 'apply_patch'; readonly requestId: string;
      readonly result: ApplyPatchResult }
  | { readonly kind: 'tool-failed'; readonly name: 'bash' | 'apply_patch'; readonly requestId: string;
      readonly category: string; readonly result?: ApplyPatchResult }
)
/** Connection recipes are resolved by the trusted host against installed protocols. */
export interface DirectoryProvider extends Provider { readonly connections: readonly ProviderTemplate[] }
export interface DirectoryModel extends Model { readonly connections: readonly ProviderTemplate[] }

export interface NodeView {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly input: string
  readonly images?: readonly ImageRef[]
  readonly files?: readonly FileRef[]
  readonly output: string
  readonly sourceRunId: string | null
}
export interface NodePage { readonly nodes: readonly NodeView[]; readonly nextCursor?: string }

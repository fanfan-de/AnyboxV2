import type { JsonValue, ToolCall, ToolDescriptor, ToolImageRef } from './index.js'

/** A provider-owned execution scope. Its identity is independent of any Agent implementation. */
export interface ToolEnvironmentScopeContext {
  readonly scopeId: string
  readonly ownerEpoch: number
  readonly signal: AbortSignal
}

export interface ToolEnvironmentRequest {
  readonly operationId: string
  readonly toolId: string
  readonly version: string
  readonly arguments: Readonly<Record<string, JsonValue>>
  /** Observe the original operation only. A missing or unknown operation MUST NOT be executed again. */
  readonly resuming: boolean
}

export interface ToolEnvironmentResult {
  readonly result: JsonValue
  readonly images?: readonly ToolImageRef[]
}

export interface ToolEnvironmentScope {
  /** Synchronously acquires the returned call; its done promise covers all operation resources. */
  execute(request: ToolEnvironmentRequest): ToolCall<ToolEnvironmentResult>
  /** Requests cancellation and waits for accepted work to actually exit. */
  cancel(reason?: string): Promise<void>
  /** Closes the scope even when its signal is aborted; done includes every retained resource. */
  close(): ToolCall<JsonValue>
  /** Whether this scope owns work or retained resources requiring a close receipt. */
  hasResources(): boolean
}

/** Pure capability declaration; describing an environment never acquires execution resources. */
export interface ToolEnvironmentDescriptor {
  readonly environmentId: string
  readonly version: string
  readonly tools: readonly ToolDescriptor[]
  /** Only providers with explicit original-operation lookup may receive resuming requests. */
  readonly recovery?: 'observe-existing'
}

/** Trusted executable provider. Opening a scope does not execute a tool or replay earlier work. */
export interface ToolEnvironment extends ToolEnvironmentDescriptor {
  openScope(context: ToolEnvironmentScopeContext): ToolEnvironmentScope
}

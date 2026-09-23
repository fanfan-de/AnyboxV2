import type { KernelError, ToolDefinition, ToolCall, ToolOutcome } from '../index.js'

export interface ToolCallHandle {
  readonly result: Promise<ToolOutcome>
  readonly done: Promise<void>
  cancel(reason?: KernelError): void
}
export interface ToolService {
  /** Immutable catalog for this service generation. */
  definitions(): readonly ToolDefinition[]
  call(request: ToolCall): ToolCallHandle
}

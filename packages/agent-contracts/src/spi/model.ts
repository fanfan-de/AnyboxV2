import type { KernelError, Message, ModelRef, TextPart, AssistantPart, ToolDefinition } from '../index.js'

export interface ModelRequest {
  readonly runId: string
  readonly attemptId: string
  readonly model: ModelRef
  readonly instructions: string
  readonly history: readonly Message[]
  readonly input: readonly TextPart[]
  readonly maxOutputBytes: number
  /** Ordered messages after this Run's input; history precedes input. */
  readonly continuation?: readonly Message[]
  readonly tools?: readonly ToolDefinition[]
}
export interface ModelOutput { readonly content: readonly AssistantPart[] }
export interface ModelCallHandle {
  readonly result: Promise<ModelOutput>
  /** 业务失败不导致 done 拒绝；仅实际调用清理失败会拒绝。 */
  readonly done: Promise<void>
  /** 只请求停止，必须另等 done；不能靠 Promise.race 冒充停止。 */
  cancel(reason?: KernelError): void
}
export interface ModelService { call(request: ModelRequest): ModelCallHandle }

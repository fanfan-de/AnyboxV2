/** Browser-safe, derived views. Recovery records and credentials never belong here. */
export interface ProtocolCitation {
  readonly start: number
  readonly end: number
  readonly url: string
  readonly title?: string
}
export const protocolViewSchemaVersion = 2 as const
export interface ProtocolSummaryPart { readonly id: string; readonly text: string }
export interface ProtocolSource { readonly url: string; readonly title?: string }
export interface NativeToolRequest {
  readonly id: string
  readonly requestId?: string
  readonly name: string
  /** Literal JSON text; native identities inside arguments are never resource identifiers. */
  readonly arguments: string
}
export type ResponsesMessagePart =
  | { readonly id: string; readonly type: 'output_text'; readonly text: string; readonly citations?: readonly ProtocolCitation[] }
  | { readonly id: string; readonly type: 'refusal'; readonly text: string }
export type ResponsesViewBlock =
  | { readonly id: string; readonly type: 'responses.message'; readonly phase?: 'commentary' | 'final_answer' | 'unknown'; readonly status?: string; readonly content: readonly ResponsesMessagePart[] }
  | { readonly id: string; readonly type: 'responses.reasoning'; readonly summary: readonly ProtocolSummaryPart[] }
  | (NativeToolRequest & { readonly type: 'responses.function_call'; readonly status?: string })
  | { readonly id: string; readonly type: 'responses.web_search_call'; readonly status?: string; readonly action?: string; readonly query?: string; readonly sources?: readonly ProtocolSource[] }
export type AnthropicViewBlock =
  | { readonly id: string; readonly type: 'anthropic.text'; readonly text: string; readonly citations?: readonly ProtocolCitation[] }
  | { readonly id: string; readonly type: 'anthropic.thinking'; readonly text: string }
  | { readonly id: string; readonly type: 'anthropic.redacted_thinking' }
  | (NativeToolRequest & { readonly type: 'anthropic.tool_use' | 'anthropic.server_tool_use' })
  | { readonly id: string; readonly type: 'anthropic.web_search_tool_result'; readonly requestId?: string; readonly status: 'completed' | 'failed'; readonly sources: readonly ProtocolSource[]; readonly errorCode?: string }
export type ChatViewBlock =
  | { readonly id: string; readonly type: 'chat.content' | 'chat.reasoning_content' | 'chat.refusal'; readonly text: string }
  | (NativeToolRequest & { readonly type: 'chat.tool_call' })
export interface GeminiTextPart { readonly id: string; readonly type: 'text'; readonly text: string; readonly citations?: readonly ProtocolCitation[] }
export type GeminiViewBlock =
  | { readonly id: string; readonly type: 'gemini.model_output'; readonly content: readonly GeminiTextPart[] }
  | { readonly id: string; readonly type: 'gemini.thought'; readonly summary: readonly ProtocolSummaryPart[] }
  | (NativeToolRequest & { readonly type: 'gemini.function_call' })
export type HarnessViewBlock = { readonly id: string; readonly type: 'harness.display_limit' | 'harness.unsupported'; readonly text: string }
export type ProtocolViewBlock = ResponsesViewBlock | AnthropicViewBlock | ChatViewBlock | GeminiViewBlock | HarnessViewBlock
interface NativeStateFlags { readonly diagnostic?: boolean; readonly partial?: boolean }
export type ProtocolNativeState =
  | (NativeStateFlags & { readonly type: 'responses.state'; readonly status?: string; readonly incompleteReason?: string; readonly errorCode?: string })
  | (NativeStateFlags & { readonly type: 'anthropic.state'; readonly stopReason?: string; readonly stopSequence?: string; readonly stopDetailsType?: string; readonly errorCode?: string })
  | (NativeStateFlags & { readonly type: 'chat.state'; readonly finishReason?: string; readonly errorCode?: string })
  | (NativeStateFlags & { readonly type: 'gemini.state'; readonly status?: string; readonly stage?: string; readonly eventType?: string; readonly errorCode?: string })
export interface ProtocolViewInput {
  readonly id: string
  readonly role: 'system' | 'context' | 'user'
  readonly text: string
}
export interface ProtocolViewExchange {
  readonly id: string
  readonly inputs?: readonly ProtocolViewInput[]
  readonly blocks: readonly ProtocolViewBlock[]
  readonly nativeState?: ProtocolNativeState
}
export interface ProtocolViewSnapshot {
  readonly envelopeVersion: 1
  readonly protocolId: string
  readonly viewSchemaVersion: 2
  readonly sessionId: string
  readonly runId: string
  /** View revision is independent of the durable Run revision. */
  readonly viewRevision: number
  readonly status: 'provisional' | 'committed'
  readonly exchanges: readonly ProtocolViewExchange[]
}
/** Replacement frames make missed deltas recoverable without a replay log. */
export interface ProtocolViewFrame {
  readonly sessionId: string
  readonly runId: string
  readonly snapshot: ProtocolViewSnapshot
}

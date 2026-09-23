import type { MessageId, SessionId, RunId, ModelAttemptId, Timestamp } from './identity.js'
import type { JsonValue } from './identity.js'
import type { ToolOutcome } from './tool.js'

export interface TextPart { readonly type: 'text'; readonly text: string }
export interface ToolCallPart {
  readonly type: 'tool-call'
  /** Protocol call ID, unique within this Run. Internal ToolCall.id is kernel-generated. */
  readonly toolCallId: string
  readonly toolId: string
  readonly input: JsonValue
}
export interface ToolResultPart {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly outcome: ToolOutcome
}
export type AssistantPart = TextPart | ToolCallPart
export type ContentPart = AssistantPart | ToolResultPart

interface MessageBase {
  readonly id: MessageId
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly createdAt: Timestamp
}
export type Message = MessageBase & (
  | { readonly role: 'user'; readonly content: readonly TextPart[] }
  | { readonly role: 'assistant'; readonly modelAttemptId: ModelAttemptId; readonly content: readonly AssistantPart[] }
  | { readonly role: 'tool'; readonly content: readonly ToolResultPart[] }
)

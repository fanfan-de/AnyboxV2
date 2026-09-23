export type JsonValue = null | boolean | number | string | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }
export type AgentDefinitionId = string
export type AgentId = string
export type SessionId = string
export type RunId = string
export type MessageId = string
export type ModelAttemptId = string
export type Timestamp = string
export type Revision = number

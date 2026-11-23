export type PromptKind = 'agent-instruction' | 'task-template' | 'context'
export type PromptRole = 'system' | 'developer' | 'user'

/** Original model instructions and legacy context or template inputs saved in a Run. */
export interface PromptSnapshot {
  readonly versionId: string
  readonly documentId: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
}

/** Browser-safe, derived views. Recovery records and credentials never belong here. */
export interface ProtocolCitation {
  readonly start: number
  readonly end: number
  readonly url: string
  readonly title?: string
}
export type ProtocolViewBlock =
  | { readonly id: string; readonly kind: 'text' | 'reasoning'; readonly text: string; readonly citations?: readonly ProtocolCitation[] }
  | { readonly id: string; readonly kind: 'tool'; readonly label: string; readonly status: string; readonly detail?: string; readonly requestId?: string }
  | { readonly id: string; readonly kind: 'status'; readonly text: string }
export interface ProtocolViewExchange {
  readonly id: string
  readonly blocks: readonly ProtocolViewBlock[]
}
export interface ProtocolViewSnapshot {
  readonly envelopeVersion: 1
  readonly protocolId: string
  readonly viewSchemaVersion: 1
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

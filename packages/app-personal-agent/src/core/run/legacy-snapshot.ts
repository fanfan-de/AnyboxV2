import type { JsonValue } from '@anybox/models'
/** Read-only snapshots written before native execution. Never accepted by Run admission. */
export interface LegacyExecutionSnapshot {
  readonly schemaVersion?: 2
  readonly modelDefinitionId?: string
  readonly providerDefinitionId?: string
  readonly modelDefinitionVersionId?: string
  readonly modelId: string
  readonly modelRevision: number
  readonly modelVersionId: string
  readonly providerId: string
  readonly providerRevision: number
  readonly providerVersionId: string
  readonly remoteModelId: string
  readonly protocolId: string
  readonly protocolVersion: string
  readonly options: Readonly<Record<string, JsonValue>>
}

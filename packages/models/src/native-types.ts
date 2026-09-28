import type { DeclaredCapabilities, EffectiveCapabilities, JsonValue, ModelQuery, ProtocolConnection, ProtocolDescriptor, ProtocolOperation, ProviderConnectionInput, RunnableModelSummary } from './types.js';

export type NativeObject = Readonly<Record<string, JsonValue>>;
export interface NativeParameters { readonly protocolId: string; readonly formatVersion: 1; readonly value: NativeObject }
/** Read-only representation for an extension whose old settings need a converter. */
export interface LegacyParameters { readonly protocolId: string; readonly formatVersion: 0; readonly value: NativeObject }
export type StoredParameters = NativeParameters | LegacyParameters;
export type LegacyParameterConverter = (value: NativeObject) => NativeObject;
export interface NativeModelSnapshot {
  readonly schemaVersion: 3;
  readonly modelDefinitionId: string;
  readonly providerDefinitionId: string;
  readonly modelDefinitionVersionId: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly modelVersionId: string;
  readonly providerId: string;
  readonly providerRevision: number;
  readonly providerVersionId: string;
  readonly remoteModelId: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly registrationGenerationId: string;
  readonly historyScopeEpoch: string;
  readonly parameters: NativeParameters;
  readonly capabilities: EffectiveCapabilities;
}
export interface NativeRecordDraft {
  readonly id: string;
  readonly exchangeId: string;
  readonly protocolId: string;
  readonly recordFormatVersion: 1;
  readonly kind: 'request' | 'response' | 'diagnostic';
  /** Requests store the newly appended intent, never a duplicate of the whole history. */
  readonly payload: JsonValue;
}
export interface NativeRestoreMetadata {
  readonly protocolId: string;
  readonly recordFormatVersion: 1;
  readonly modelSnapshot: NativeModelSnapshot;
}
/** The host resolves the immutable parent path before opening; never persist this expanded array per node. */
export interface NativeRestoreState extends NativeRestoreMetadata { readonly records: readonly NativeRecordDraft[] }
export interface NativeReply<R extends NativeObject = NativeObject> { readonly exchangeId: string; readonly response: R; readonly records: readonly NativeRecordDraft[] }
export interface NativeExitReport {
  /** Only records produced by this execution, not records supplied through restore. */
  readonly records: readonly NativeRecordDraft[];
  readonly restoreState?: NativeRestoreMetadata;
  readonly cleanup: 'succeeded' | 'failed';
}
export interface NativeRequestRecipe<I extends NativeObject = NativeObject> {
  readonly protocolId: string;
  readonly exchangeId: string;
  readonly intent: I;
  readonly precedingRecordId: string | null;
}
export interface PreparedNativeExchange<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly exchangeId: string;
  readonly request: NativeRequestRecipe<I>;
  readonly record: NativeRecordDraft;
  start(onEvent?: (event: E) => void): ProtocolOperation<NativeReply<R>>;
}
export interface NativeExecution<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly snapshot: NativeModelSnapshot;
  readonly capabilities: EffectiveCapabilities;
  readonly signal: AbortSignal;
  prepareExchange(intent: I): PreparedNativeExchange<I, R, E>;
  close(): Promise<NativeExitReport>;
}
export interface NativeProtocolLease<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly protocolId: string;
  readonly generationId: string;
  readonly protocolVersion: string;
  readonly signal: AbortSignal;
  /** Phantom variance only: concrete bindings keep their native I/R/E types. */
  readonly types?: { readonly intent: I; readonly response: R; readonly event: E };
  release(): void;
}
export interface OpenNativeModelInput<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly modelId: string;
  readonly lease: NativeProtocolLease<I, R, E>;
  readonly restore?: NativeRestoreState;
  readonly requirements?: { readonly tools?: boolean; readonly streaming?: boolean; readonly reasoning?: boolean };
  readonly signal?: AbortSignal;
}
export interface ModelsService {
  list(query?: ModelQuery): readonly RunnableModelSummary[];
  get(modelId: string): RunnableModelSummary | undefined;
  openNative<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject>(input: OpenNativeModelInput<I, R, E>): Promise<NativeExecution<I, R, E>>;
}
/** Driver state is private to one execution. Native requests and responses remain protocol-shaped. */
export interface NativeProtocol<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly descriptor: ProtocolDescriptor;
  validateProvider(provider: ProviderConnectionInput): void;
  validateParameters(parameters: NativeObject, declared: DeclaredCapabilities): void;
  effectiveCapabilities(declared: DeclaredCapabilities, parameters: NativeObject): EffectiveCapabilities;
  initialParameters?(outputLimit?: number): NativeObject;
  restore(records: readonly NativeRecordDraft[]): NativeObject;
  prepare(input: { readonly state: NativeObject; readonly intent: I; readonly remoteModelId: string; readonly parameters: NativeObject; readonly capabilities: EffectiveCapabilities }): NativeObject;
  exchange(input: ProtocolConnection & { readonly request: NativeObject; readonly onEvent: (event: E) => void }): ProtocolOperation<R>;
  commit(input: { readonly state: NativeObject; readonly intent: I; readonly request: NativeObject; readonly response: R }): NativeObject;
  discover?(input: ProtocolConnection): ProtocolOperation<readonly import('./types.js').DiscoveredModel[]>;
  check?(input: ProtocolConnection): ProtocolOperation<void>;
}
export interface ProtocolRegistration<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly generationId: string;
  readonly protocolVersion: string;
  readonly signal: AbortSignal;
  acquire(): NativeProtocolLease<I, R, E>;
  unregister(): Promise<void>;
}
export interface ModelsProtocolsService {
  register<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject>(protocol: NativeProtocol<I, R, E>): ProtocolRegistration<I, R, E>;
  acquire(protocolId: string): NativeProtocolLease;
}

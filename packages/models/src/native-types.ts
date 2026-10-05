import type { DeclaredCapabilities, EffectiveCapabilities, JsonValue, ModelQuery, ProtocolConnection, ProtocolDescriptor, ProtocolOperation, ProviderConnectionInput, RunnableModelSummary } from './types.js';

export type NativeObject = Readonly<Record<string, JsonValue>>;
export type NativeResponseMode = 'stream' | 'complete';
export interface NativeExchangeOptions {
  readonly resourceRefs?: readonly NativeImageResourceRef[];
  readonly responseMode?: NativeResponseMode;
}
export interface GenerateTextInput {
  readonly modelId: string;
  readonly instruction?: string;
  readonly input: string;
  readonly signal?: AbortSignal;
}
export interface GenerateTextResult {
  readonly text: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly protocolId: string;
}
export interface NativeTextGenerationAdapter<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject> {
  createIntent(input: { readonly instruction?: string; readonly input: string }): I;
  validateParameters(parameters: NativeObject): void;
  readText(response: R): string;
}
export interface NativeImageResourceRef {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}
/** Per-execution trusted port. Neither the reader nor its handles enter records. */
export interface NativeResourceResolver {
  read(resource: NativeImageResourceRef, options: { readonly signal: AbortSignal }): ProtocolOperation<Uint8Array>;
}
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
  readonly recordFormatVersion: 1 | 2;
  readonly kind: 'request' | 'response' | 'diagnostic';
  /** Requests store the newly appended intent, never a duplicate of the whole history. */
  readonly payload: JsonValue;
  readonly resourceRefs?: readonly NativeImageResourceRef[];
}
export interface NativeRestoreMetadata {
  readonly protocolId: string;
  readonly recordFormatVersion: 1 | 2;
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
  readonly resourceRefs?: readonly NativeImageResourceRef[];
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
  readonly recordFormatVersion: 1 | 2;
  prepareExchange(intent: I, options?: NativeExchangeOptions): PreparedNativeExchange<I, R, E>;
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
  readonly requirements?: { readonly tools?: boolean; readonly streaming?: boolean; readonly reasoning?: boolean; readonly imageInput?: boolean };
  readonly resources?: NativeResourceResolver;
  readonly signal?: AbortSignal;
}
export interface ModelsService {
  list(query?: ModelQuery): readonly RunnableModelSummary[];
  get(modelId: string): RunnableModelSummary | undefined;
  generateText(input: GenerateTextInput): ProtocolOperation<GenerateTextResult>;
  openNative<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject>(input: OpenNativeModelInput<I, R, E>): Promise<NativeExecution<I, R, E>>;
}
/** Driver state is private to one execution. Native requests and responses remain protocol-shaped. */
export interface NativeProtocol<I extends NativeObject = NativeObject, R extends NativeObject = NativeObject, E extends NativeObject = NativeObject> {
  readonly descriptor: ProtocolDescriptor;
  readonly recordFormatVersion?: 1 | 2;
  readonly textGeneration?: NativeTextGenerationAdapter<I, R>;
  canRestoreVersion?(version: string): boolean;
  /** Reads only recognized image positions, never arbitrary strings or JSON keys. */
  resourceIds?(intentOrRequest: NativeObject): readonly string[];
  validateProvider(provider: ProviderConnectionInput): void;
  validateParameters(parameters: NativeObject, declared: DeclaredCapabilities): void;
  effectiveCapabilities(declared: DeclaredCapabilities, parameters: NativeObject): EffectiveCapabilities;
  initialParameters?(outputLimit?: number): NativeObject;
  restore(records: readonly NativeRecordDraft[]): NativeObject;
  prepare(input: { readonly state: NativeObject; readonly intent: I; readonly remoteModelId: string; readonly parameters: NativeObject; readonly capabilities: EffectiveCapabilities; readonly responseMode?: NativeResponseMode }): NativeObject;
  exchange(input: ProtocolConnection & { readonly request: NativeObject; readonly onEvent: (event: E) => void; readonly resources?: NativeResourceResolver; readonly resourceRefs?: readonly NativeImageResourceRef[] }): ProtocolOperation<R>;
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

/** All public values are protocol-neutral and contain no credentials. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Support = 'supported' | 'unsupported' | 'unknown';
export interface Capability { readonly support: Support }
export interface ReasoningCapability extends Capability {
  readonly efforts?: readonly string[];
  readonly modes?: readonly string[];
  readonly budget?: { readonly min: number; readonly max: number };
}
export interface DeclaredCapabilities {
  readonly tools: Capability;
  readonly streaming: Capability;
  readonly imageInput: Capability;
  readonly reasoning: ReasoningCapability;
}
export interface EffectiveCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly imageInput: false;
  readonly reasoning: ReasoningCapability;
}
export interface CommonGenerationOptions { readonly temperature?: number; readonly maxOutputTokens?: number }
export interface GenerationOptions extends CommonGenerationOptions { readonly protocol?: Readonly<Record<string, JsonValue>> }
export interface ModelRequirements { readonly tools?: boolean; readonly streaming?: boolean; readonly reasoning?: boolean }
export interface ToolDefinition { readonly name: string; readonly description?: string; readonly parameters: Readonly<Record<string, JsonValue>> }
export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: JsonValue }
export type ModelMessage =
  | { readonly role: 'system' | 'developer' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly content: string };
export interface ModelUsage { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
export interface ModelResult {
  readonly status: 'completed' | 'incomplete' | 'refused';
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: ModelUsage;
}
export type ModelEvent =
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'reasoning-summary-delta'; readonly delta: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string };
export interface ModelCall {
  readonly result: Promise<ModelResult>;
  readonly done: Promise<void>;
  cancel(reason?: string): void;
}
export interface Versioned { readonly id: string; readonly revision: number; readonly versionId: string; readonly createdAt: string; readonly updatedAt: string }
export type SourceRef =
  | { readonly kind: 'user' }
  | { readonly kind: 'external'; readonly sourceId: string; readonly providerId: string; readonly modelId?: string; readonly sourceVersion: string | null };
export interface SourceProviderIdentity { readonly sourceId: string; readonly providerId: string }
export interface ConnectionHints { readonly baseUrl?: string; readonly protocolIds: readonly string[] }
export interface ReasoningControl { readonly kind: 'toggle' | 'effort' | 'budget'; readonly values?: readonly string[]; readonly min?: number; readonly max?: number }
export interface ModelControls { readonly temperature: Support; readonly structuredOutput?: Support; readonly reasoning?: readonly ReasoningControl[] }
export interface ModelCostTier { readonly contextMin?: number; readonly contextMax?: number; readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number; readonly reasoning?: number }
export interface ModelCost { readonly currency: 'USD'; readonly unit: 'million-tokens'; readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number; readonly reasoning?: number; readonly tiers?: readonly ModelCostTier[] }
export interface ProviderInput { readonly name: string; readonly documentationUrl?: string; readonly connectionHints: ConnectionHints }
export interface Provider extends Versioned, ProviderInput { readonly source: SourceRef; readonly state: 'present' | 'missing' | 'unresolved' }
export interface ModelInput {
  readonly providerId: string;
  readonly remoteModelId: string;
  readonly name: string;
  readonly description?: string;
  readonly family?: string;
  readonly releaseDate?: string;
  readonly lastUpdated?: string;
  readonly status?: string;
  readonly openWeights?: boolean;
  readonly modelType?: string;
  readonly capabilities: DeclaredCapabilities;
  readonly controls: ModelControls;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly limits: { readonly context?: number; readonly input?: number; readonly output?: number };
  readonly cost?: ModelCost;
  readonly connectionHints: ConnectionHints;
}
export interface Model extends Versioned, ModelInput { readonly source: SourceRef; readonly state: 'present' | 'missing' | 'unresolved' }
export interface ProviderConnectionInput {
  readonly providerDefinitionId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly protocolId: string;
  readonly baseUrl: string;
  readonly auth: 'none' | 'api-key';
  readonly timeoutMs: number;
}
export interface ConnectionSyncState {
  readonly connectionId: string;
  readonly state: 'pending' | 'ready' | 'failed';
  readonly targetSourceVersion: string | null;
  readonly syncedSourceVersion: string | null;
  readonly error?: string;
}
export interface ProviderConnection extends Versioned, ProviderConnectionInput { readonly credentialConfigured: boolean; readonly sync?: ConnectionSyncState }
/** Credential references belong only to the trusted store and private execution boundary. */
export interface ProviderConnectionRecord extends Versioned, ProviderConnectionInput { readonly credentialRef: string | null }
export interface ModelConfigurationInput {
  readonly modelDefinitionId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly capabilities: DeclaredCapabilities;
  readonly defaults: GenerationOptions;
  readonly baseline: boolean;
}
export interface ModelConfiguration extends Versioned, ModelConfigurationInput { readonly modelDefinitionVersionId: string; readonly remoteModelId: string }
export interface RunnableModelSummary extends ModelConfiguration {
  readonly providerDefinitionId: string;
  readonly source: SourceRef;
  readonly available: boolean;
  readonly unavailableReason?: 'disabled' | 'provider-disabled' | 'protocol-unavailable' | 'credential-missing' | 'invalid-configuration';
  readonly effectiveCapabilities?: EffectiveCapabilities;
}
export interface ModelQuery { readonly connectionId?: string; readonly available?: boolean }
export interface DefinitionQuery { readonly sourceId?: string; readonly providerId?: string; readonly search?: string; readonly includeMissing?: boolean; readonly includeDeprecated?: boolean; readonly textOnly?: boolean }
export interface ConnectionModel extends Model { readonly configurationId?: string; readonly available: boolean; readonly unavailableReason?: string }
export interface SourceState { readonly sourceId: string; readonly snapshotVersion: string; readonly fetchedAt: number }
export interface SourceSnapshot extends SourceState { readonly schemaVersion: 2; readonly providers: readonly Provider[]; readonly models: readonly Model[] }
export interface SourceCommitResult { readonly accepted: boolean; readonly source: SourceState; readonly connections: readonly ConnectionSyncState[] }
export interface ModelsSourceDataService {
  accepted(sourceId: string): SourceSnapshot | undefined;
  accept(snapshot: SourceSnapshot, options?: { readonly confirmed?: boolean }): Promise<SourceCommitResult>;
}
export interface ExecutionSnapshot {
  /** Optional only when reading historical snapshots. New executions always write 2. */
  readonly schemaVersion?: 2;
  readonly modelDefinitionId?: string;
  readonly providerDefinitionId?: string;
  readonly modelDefinitionVersionId?: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly modelVersionId: string;
  readonly providerId: string;
  readonly providerRevision: number;
  readonly providerVersionId: string;
  readonly remoteModelId: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly options: GenerationOptions;
}
export interface ModelExecution {
  readonly snapshot: ExecutionSnapshot;
  readonly capabilities: EffectiveCapabilities;
  generate(input: { readonly messages: readonly ModelMessage[]; readonly onEvent?: (event: ModelEvent) => void }): ModelCall;
  close(): Promise<void>;
}
export interface OpenModelInput {
  readonly modelId: string;
  readonly history?: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly requirements?: ModelRequirements;
  readonly options?: CommonGenerationOptions;
  readonly signal?: AbortSignal;
}
export interface ModelsService {
  list(query?: ModelQuery): readonly RunnableModelSummary[];
  get(modelId: string): RunnableModelSummary | undefined;
  open(input: OpenModelInput): Promise<ModelExecution>;
}
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly type: 'string' | 'number' | 'boolean' | 'enum';
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly values?: readonly (string | number | boolean)[];
  readonly description?: string;
  /** New-form initialization only; saved options remain explicit. */
  readonly defaultValue?: string | number | boolean;
}
export interface ProtocolDescriptor {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly connectionFields: readonly FormField[];
  readonly modelFields: readonly FormField[];
  readonly supportsDiscovery: boolean;
  readonly supportsCheck: boolean;
  readonly sourceMappings?: readonly { readonly sourceId: string; readonly providerId: string; readonly protocolIds: readonly string[] }[];
}
export interface DiscoveredModel {
  readonly remoteModelId: string;
  readonly name: string;
  readonly suggestedCapabilities?: Partial<DeclaredCapabilities>;
}
export interface ModelsSettingsService {
  protocols(): readonly ProtocolDescriptor[];
  providers(query?: DefinitionQuery): readonly Provider[];
  providerHistory(id: string): readonly Provider[];
  models(query?: DefinitionQuery): readonly Model[];
  modelHistory(id: string): readonly Model[];
  createProvider(input: ProviderInput & { readonly id?: string }): Promise<Provider>;
  updateProvider(id: string, input: Partial<ProviderInput>, expectedRevision: number): Promise<Provider>;
  createModel(input: ModelInput & { readonly id?: string }): Promise<Model>;
  updateModel(id: string, input: Partial<Omit<ModelInput, 'providerId'>>, expectedRevision: number): Promise<Model>;
  connections(): readonly ProviderConnection[];
  connectionHistory(id: string): readonly ProviderConnection[];
  configurations(connectionId?: string): readonly ModelConfiguration[];
  configurationHistory(id: string): readonly ModelConfiguration[];
  connectionModels(connectionId: string): readonly ConnectionModel[];
  createConnection(input: ProviderConnectionInput & { readonly id?: string; readonly apiKey?: string }): Promise<ProviderConnection>;
  updateConnection(id: string, input: Partial<Omit<ProviderConnectionInput, 'protocolId' | 'providerDefinitionId'>>, expectedRevision: number): Promise<ProviderConnection>;
  /** Removes current connection/configurations; preserves history and already opened executions. */
  deleteConnection(id: string, expectedRevision: number): Promise<void>;
  setApiKey(id: string, apiKey: string, expectedRevision: number): Promise<ProviderConnection>;
  deleteApiKey(id: string, expectedRevision: number): Promise<ProviderConnection>;
  retryConnection(id: string): Promise<ProviderConnection>;
  createConfiguration(input: ModelConfigurationInput & { readonly id?: string }): Promise<ModelConfiguration>;
  updateConfiguration(id: string, input: Partial<Omit<ModelConfigurationInput, 'connectionId' | 'modelDefinitionId' | 'baseline'>>, expectedRevision: number): Promise<ModelConfiguration>;
  discoverModels(connectionId: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  checkConnection(connectionId: string, signal?: AbortSignal): Promise<void>;
}
export interface CredentialIntent { readonly id: string; readonly providerId: string; readonly slotId: string; readonly createdAt: string }
export interface VersionChange<T extends Versioned> { readonly record: T; readonly expectedRevision: number | null }
export interface StoreChange {
  readonly providers?: readonly VersionChange<Provider>[];
  readonly models?: readonly VersionChange<Model>[];
  readonly connection?: VersionChange<ProviderConnectionRecord>;
  readonly deleteConnection?: { readonly id: string; readonly expectedRevision: number };
  readonly configurations?: readonly VersionChange<ModelConfiguration>[];
  readonly sources?: readonly SourceState[];
  readonly syncStates?: readonly ConnectionSyncState[];
  readonly syncGuards?: readonly { readonly connectionId: string; readonly targetSourceVersion: string | null }[];
  readonly addIntents?: readonly CredentialIntent[];
  readonly removeIntentIds?: readonly string[];
}
export interface ModelsStore {
  providers(): readonly Provider[];
  provider(id: string): Provider | undefined;
  providerHistory(id: string): readonly Provider[];
  models(): readonly Model[];
  model(id: string): Model | undefined;
  modelHistory(id: string): readonly Model[];
  connections(): readonly ProviderConnectionRecord[];
  connection(id: string): ProviderConnectionRecord | undefined;
  connectionHistory(id: string): readonly ProviderConnectionRecord[];
  configurations(): readonly ModelConfiguration[];
  configuration(id: string): ModelConfiguration | undefined;
  configurationHistory(id: string): readonly ModelConfiguration[];
  sources(): readonly SourceState[];
  syncState(connectionId: string): ConnectionSyncState | undefined;
  intents(): readonly CredentialIntent[];
  commit(change: StoreChange): Promise<void>;
}
export interface ModelsVault {
  read(slotId: string, signal?: AbortSignal): Promise<string | undefined>;
  write(slotId: string, value: string, signal?: AbortSignal): Promise<void>;
  delete(slotId: string, signal?: AbortSignal): Promise<void>;
}
/** Protocol operations must settle done only after all resources have exited. */
export interface ProtocolOperation<T> {
  readonly result: Promise<T>;
  readonly done: Promise<void>;
  cancel(reason?: string): void;
}
export interface ProtocolConnection { readonly provider: ProviderConnectionInput; readonly credential?: string; readonly signal: AbortSignal }
export interface ProtocolCallInput extends ProtocolConnection {
  readonly remoteModelId: string;
  readonly options: GenerationOptions;
  readonly capabilities: EffectiveCapabilities;
  readonly messages: readonly ModelMessage[];
  readonly newMessages: readonly ModelMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly continuation?: unknown;
  readonly onEvent: (event: ModelEvent) => void;
}
export interface ProtocolOutcome { readonly result: ModelResult; readonly continuation?: unknown }
export interface ModelProtocol {
  readonly descriptor: ProtocolDescriptor;
  validateProvider(provider: ProviderConnectionInput): void;
  validateOptions(options: GenerationOptions, capabilities: DeclaredCapabilities): void;
  effectiveCapabilities(declared: DeclaredCapabilities, options: GenerationOptions): EffectiveCapabilities;
  call(input: ProtocolCallInput): ProtocolOperation<ProtocolOutcome>;
  discover?(input: ProtocolConnection): ProtocolOperation<readonly DiscoveredModel[]>;
  check?(input: ProtocolConnection): ProtocolOperation<void>;
}
export interface ProtocolRegistration { unregister(): Promise<void> }
export interface ModelsProtocolsService { register(protocol: ModelProtocol): ProtocolRegistration }
export const modelsServiceKey = 'models';
export const modelsSettingsServiceKey = 'models.settings';
export const modelsProtocolsServiceKey = 'models.protocols';
export const modelsStoreServiceKey = 'models.store';
export const modelsVaultServiceKey = 'models.vault';

export const modelsSourceDataServiceKey = 'models.source-data';

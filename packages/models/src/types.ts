import type { StoredParameters } from './native-types.js';
export type { ModelsService, ModelsProtocolsService, ProtocolRegistration } from './native-types.js';
/** Settings and record values are serializable; trusted protocol connection ports are kept out of browser DTOs. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Support = 'supported' | 'unsupported' | 'unknown';
export interface Capability { readonly support: Support }
export interface ReasoningCapability extends Capability {
  readonly efforts?: readonly string[];
  readonly modes?: readonly string[];
  readonly budget?: { readonly min: number; readonly max: number };
}
export interface DeclaredCapabilities {
  readonly webSearch?: Capability;
  readonly tools: Capability;
  readonly streaming: Capability;
  readonly imageInput: Capability;
  readonly reasoning: ReasoningCapability;
}
export interface EffectiveCapabilities {
  readonly webSearch: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly imageInput: boolean;
  readonly reasoning: ReasoningCapability;
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
export interface ProviderSettingsInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly protocolId: string;
  readonly baseUrl: string;
  readonly auth: 'none' | 'api-key';
  readonly timeoutMs: number;
}
export interface ProviderSyncState {
  readonly providerId: string;
  readonly state: 'pending' | 'ready' | 'failed';
  readonly targetSourceVersion: string | null;
  readonly syncedSourceVersion: string | null;
  readonly error?: string;
}
/** The settings ID is the provider definition ID. */
export interface ProviderSettings extends Versioned, ProviderSettingsInput { readonly credentialConfigured: boolean; readonly sync?: ProviderSyncState }
/** Credential references belong only to the trusted store and private execution boundary. */
export interface ProviderSettingsRecord extends Versioned, ProviderSettingsInput {
  readonly credentialRef: string | null;
  readonly historyScopeEpoch: string;
  /** Retains the account scope recorded in existing native histories after migration. */
  readonly restoreScopeId: string;
}
export interface ModelSettingsInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly capabilities: DeclaredCapabilities;
  readonly parameters: StoredParameters;
}
/** The settings ID is the model definition ID. Existing sessions retain their runtime model ID. */
export interface ModelSettings extends Versioned, ModelSettingsInput {
  readonly runtimeModelId: string;
  readonly providerId: string;
  readonly modelDefinitionVersionId: string;
  readonly remoteModelId: string;
}
export interface RunnableModelSummary extends Omit<ModelSettings, 'runtimeModelId'> {
  readonly modelDefinitionId: string;
  readonly source: SourceRef;
  /** Definition metadata pinned by modelDefinitionVersionId; absent when that history is unavailable. */
  readonly limits?: ModelInput['limits'];
  readonly available: boolean;
  readonly unavailableReason?: 'disabled' | 'provider-disabled' | 'protocol-unavailable' | 'credential-missing' | 'invalid-configuration';
  readonly effectiveCapabilities?: EffectiveCapabilities;
}
export interface ModelQuery { readonly providerId?: string; readonly available?: boolean }
export interface DefinitionQuery { readonly sourceId?: string; readonly providerId?: string; readonly search?: string; readonly includeMissing?: boolean; readonly includeDeprecated?: boolean; readonly textOnly?: boolean }
export interface ProviderModel extends Model { readonly runtimeModelId?: string; readonly available: boolean; readonly unavailableReason?: string }
export interface SourceState { readonly sourceId: string; readonly snapshotVersion: string; readonly fetchedAt: number }
export interface SourceSnapshot extends SourceState { readonly schemaVersion: 2; readonly providers: readonly Provider[]; readonly models: readonly Model[] }
export interface SourceCommitResult { readonly accepted: boolean; readonly source: SourceState; readonly providers: readonly ProviderSyncState[] }
export interface ModelsSourceDataService {
  accepted(sourceId: string): SourceSnapshot | undefined;
  accept(snapshot: SourceSnapshot, options?: { readonly confirmed?: boolean }): Promise<SourceCommitResult>;
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
  readonly responseModes?: readonly import('./native-types.js').NativeResponseMode[];
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
  configuredProviders(): readonly ProviderSettings[];
  providerSettingsHistory(id: string): readonly ProviderSettings[];
  modelSettings(providerId?: string): readonly ModelSettings[];
  modelSettingsHistory(id: string): readonly ModelSettings[];
  providerModels(providerId: string): readonly ProviderModel[];
  createProviderSettings(input: ProviderSettingsInput & { readonly providerId: string; readonly apiKey?: string }): Promise<ProviderSettings>;
  updateProviderSettings(id: string, input: Partial<Omit<ProviderSettingsInput, 'protocolId'>>, expectedRevision: number): Promise<ProviderSettings>;
  /** Removes local provider and model settings; preserves definitions, history and open executions. */
  deleteProviderSettings(id: string, expectedRevision: number): Promise<void>;
  setApiKey(id: string, apiKey: string, expectedRevision: number): Promise<ProviderSettings>;
  deleteApiKey(id: string, expectedRevision: number): Promise<ProviderSettings>;
  retryProviderSettings(id: string): Promise<ProviderSettings>;
  createModelSettings(input: ModelSettingsInput & { readonly modelId: string }): Promise<ModelSettings>;
  updateModelSettings(id: string, input: Partial<ModelSettingsInput>, expectedRevision: number): Promise<ModelSettings>;
  discoverModels(providerId: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  checkProvider(providerId: string, signal?: AbortSignal): Promise<void>;
}
export interface CredentialIntent { readonly id: string; readonly providerId: string; readonly slotId: string; readonly createdAt: string }
export interface VersionChange<T extends Versioned> { readonly record: T; readonly expectedRevision: number | null }
export interface StoreChange {
  readonly providers?: readonly VersionChange<Provider>[];
  readonly models?: readonly VersionChange<Model>[];
  readonly providerSettings?: VersionChange<ProviderSettingsRecord>;
  readonly deleteProviderSettings?: { readonly id: string; readonly expectedRevision: number };
  readonly modelSettings?: readonly VersionChange<ModelSettings>[];
  readonly sources?: readonly SourceState[];
  readonly syncStates?: readonly ProviderSyncState[];
  readonly syncGuards?: readonly { readonly providerId: string; readonly targetSourceVersion: string | null }[];
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
  configuredProviders(): readonly ProviderSettingsRecord[];
  providerSettings(id: string): ProviderSettingsRecord | undefined;
  providerSettingsHistory(id: string): readonly ProviderSettingsRecord[];
  configuredModels(): readonly ModelSettings[];
  modelSettings(id: string): ModelSettings | undefined;
  runtimeModelSettings(runtimeModelId: string): ModelSettings | undefined;
  modelSettingsHistory(id: string): readonly ModelSettings[];
  modelRuntimeIdExists(runtimeModelId: string): boolean;
  sources(): readonly SourceState[];
  syncState(providerId: string): ProviderSyncState | undefined;
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
export interface ProtocolConnection { readonly managedSend?: import('./native-types.js').NativeManagedSend; readonly provider: ProviderSettingsInput; readonly credential?: string; readonly signal: AbortSignal }
export const modelsServiceKey = 'models';
export const modelsSettingsServiceKey = 'models.settings';
export const modelsProtocolsServiceKey = 'models.protocols';
export const modelsStoreServiceKey = 'models.store';
export const modelsVaultServiceKey = 'models.vault';

export const modelsSourceDataServiceKey = 'models.source-data';

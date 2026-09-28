import type { CatalogProviderRef } from './catalog-types.js';

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
export interface ProviderInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly protocolId: string;
  readonly baseUrl: string;
  readonly auth: 'none' | 'api-key';
  readonly timeoutMs: number;
  readonly catalogRef?: CatalogProviderRef | null;
}
export interface ProviderView extends Versioned, ProviderInput { readonly credentialConfigured: boolean }
export interface ModelInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly providerId: string;
  readonly remoteModelId: string;
  readonly capabilities: DeclaredCapabilities;
  readonly defaults: GenerationOptions;
}
export interface ModelRecord extends Versioned, ModelInput {}
export interface ModelSummary extends ModelRecord {
  readonly available: boolean;
  readonly unavailableReason?: 'disabled' | 'provider-disabled' | 'protocol-unavailable' | 'credential-missing' | 'invalid-configuration';
  readonly effectiveCapabilities?: EffectiveCapabilities;
}
export interface ModelQuery { readonly providerId?: string; readonly available?: boolean }
export interface ExecutionSnapshot {
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
  list(query?: ModelQuery): readonly ModelSummary[];
  get(modelId: string): ModelSummary | undefined;
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
}
export interface DiscoveredModel {
  readonly remoteModelId: string;
  readonly name: string;
  readonly suggestedCapabilities?: Partial<DeclaredCapabilities>;
}
export interface ModelsSettingsService {
  protocols(): readonly ProtocolDescriptor[];
  providers(): readonly ProviderView[];
  providerHistory(providerId: string): readonly ProviderView[];
  models(providerId?: string): readonly ModelRecord[];
  modelHistory(modelId: string): readonly ModelRecord[];
  createProvider(input: ProviderInput & { readonly id?: string; readonly apiKey?: string }): Promise<ProviderView>;
  updateProvider(providerId: string, input: Partial<Omit<ProviderInput, 'protocolId'>>, expectedRevision: number): Promise<ProviderView>;
  setApiKey(providerId: string, apiKey: string, expectedRevision: number): Promise<ProviderView>;
  deleteApiKey(providerId: string, expectedRevision: number): Promise<ProviderView>;
  createModel(input: ModelInput & { readonly id?: string }): Promise<ModelRecord>;
  updateModel(modelId: string, input: Partial<Omit<ModelInput, 'providerId'>>, expectedRevision: number): Promise<ModelRecord>;
  discoverModels(providerId: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  checkConnection(providerId: string, signal?: AbortSignal): Promise<void>;
}
/** Trusted storage port. Not exposed through settings, snapshots, or host UI DTOs. */
export interface ProviderRecord extends Versioned, ProviderInput { readonly credentialRef: string | null }
export interface CredentialIntent { readonly id: string; readonly providerId: string; readonly slotId: string; readonly createdAt: string }
export interface StoreChange {
  readonly provider?: { readonly record: ProviderRecord; readonly expectedRevision: number | null };
  readonly model?: { readonly record: ModelRecord; readonly expectedRevision: number | null };
  readonly addIntents?: readonly CredentialIntent[];
  readonly removeIntentIds?: readonly string[];
}
export interface ModelsStore {
  providers(): readonly ProviderRecord[];
  provider(id: string): ProviderRecord | undefined;
  providerHistory(id: string): readonly ProviderRecord[];
  models(): readonly ModelRecord[];
  model(id: string): ModelRecord | undefined;
  modelHistory(id: string): readonly ModelRecord[];
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
export interface ProtocolConnection { readonly provider: ProviderInput; readonly credential?: string; readonly signal: AbortSignal }
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
  validateProvider(provider: ProviderInput): void;
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

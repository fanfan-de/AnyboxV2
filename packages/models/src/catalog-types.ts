import type { DeclaredCapabilities, Support } from './types.js';

/** Public catalog identities never refer to an account or a local configuration. */
export interface CatalogProviderRef { readonly sourceId: string; readonly providerId: string }
export type CatalogRef = CatalogProviderRef;
export interface CatalogConnectionHints {
  readonly baseUrl?: string;
  readonly protocolIds: readonly string[];
}
export interface CatalogProvider {
  readonly sourceId: string;
  readonly id: string;
  readonly name: string;
  readonly documentationUrl?: string;
  readonly connectionHints: CatalogConnectionHints;
}
export interface CatalogReasoningControl {
  readonly kind: 'toggle' | 'effort' | 'budget';
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}
export interface CatalogModelControls {
  readonly temperature: Support;
  readonly structuredOutput?: Support;
  readonly reasoning?: readonly CatalogReasoningControl[];
}
export interface CatalogCost {
  readonly currency: 'USD';
  readonly unit: 'million-tokens';
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly tiers?: readonly CatalogCostTier[];
}
export interface CatalogCostTier {
  readonly contextMin?: number;
  readonly contextMax?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}
export interface CatalogModel {
  readonly sourceId: string;
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
  readonly suggestedCapabilities: DeclaredCapabilities;
  readonly controls: CatalogModelControls;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly limits: { readonly context?: number; readonly input?: number; readonly output?: number };
  /** USD per million tokens. These are catalog estimates, not an account quote. */
  readonly cost?: CatalogCost;
  readonly connectionHints: CatalogConnectionHints;
}
export interface CatalogSnapshot {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly snapshotVersion: string;
  readonly fetchedAt: number;
  readonly providers: readonly CatalogProvider[];
  readonly models: readonly CatalogModel[];
}
export interface CatalogOperation<T> {
  readonly result: Promise<T>;
  readonly done: Promise<void>;
  cancel(reason?: string): void;
}
export type CatalogSourceResult =
  | { readonly status: 'modified'; readonly snapshot: CatalogSnapshot; readonly etag?: string }
  | { readonly status: 'not-modified'; readonly etag?: string };
export interface ModelsCatalogSource {
  /** Stable namespace includes the source endpoint so caches cannot cross sources. */
  readonly id: string;
  readonly cacheKey: string;
  fetch(input: { readonly etag?: string; readonly signal: AbortSignal }): CatalogOperation<CatalogSourceResult>;
}
export interface CatalogCacheRecord {
  readonly cacheKey: string;
  readonly snapshot: CatalogSnapshot;
  readonly checkedAt: number;
  readonly etag?: string;
}
export interface CatalogCacheStatus {
  readonly persistence: 'sqlite' | 'memory';
  readonly error?: 'storage-unavailable';
}
export interface ModelsCatalogCache {
  status(): CatalogCacheStatus;
  read(cacheKey: string): CatalogCacheRecord | undefined;
  /** Atomic replacement. Once committed, late cancellation cannot undo it. */
  write(record: CatalogCacheRecord): Promise<void>;
}
export interface CatalogStatus {
  readonly sourceId: string;
  readonly snapshotVersion: string;
  readonly fetchedAt: number;
  readonly origin: 'bundled' | 'cache' | 'network';
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly checkedAt?: number;
  readonly nextRefreshAt?: number;
  readonly cache: CatalogCacheStatus;
  readonly error?: 'unavailable' | 'invalid-response' | 'storage-unavailable' | 'cleanup-failure' | 'timeout';
}
export interface CatalogModelQuery {
  readonly sourceId?: string;
  readonly providerId?: string;
  readonly search?: string;
  readonly textOnly?: boolean;
  readonly includeDeprecated?: boolean;
}
export interface ModelsCatalogService {
  status(): CatalogStatus;
  providers(query?: { readonly search?: string }): readonly CatalogProvider[];
  models(query?: CatalogModelQuery): readonly CatalogModel[];
  provider(ref: CatalogRef): CatalogProvider | undefined;
  model(ref: CatalogRef, modelId: string): CatalogModel | undefined;
  getModel(providerId: string, remoteModelId: string): CatalogModel | undefined;
  /** Resolves only after actual source exit and the admitted cache commit. */
  refresh(signal?: AbortSignal): Promise<CatalogStatus>;
}
export const modelsCatalogServiceKey = 'models.catalog';
export const modelsCatalogSourceServiceKey = 'models.catalog-source';
export const modelsCatalogCacheServiceKey = 'models.catalog-cache';

import type { ConnectionSyncState, SourceSnapshot } from './types.js';

export interface CatalogOperation<T> {
  readonly result: Promise<T>;
  readonly done: Promise<void>;
  cancel(reason?: string): void;
}
export type CatalogSourceResult =
  | { readonly status: 'modified'; readonly snapshot: SourceSnapshot; readonly etag?: string }
  | { readonly status: 'not-modified'; readonly etag?: string };
export interface ModelsCatalogSource {
  /** Stable namespace includes the source endpoint so caches cannot cross sources. */
  readonly id: string;
  readonly cacheKey: string;
  fetch(input: { readonly etag?: string; readonly signal: AbortSignal }): CatalogOperation<CatalogSourceResult>;
}
export interface CatalogCacheRecord {
  readonly cacheKey: string;
  readonly snapshot: SourceSnapshot;
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
  readonly origin: 'bundled' | 'cache' | 'network' | 'store';
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly checkedAt?: number;
  readonly nextRefreshAt?: number;
  readonly connections?: readonly ConnectionSyncState[];
  readonly cache: CatalogCacheStatus;
  readonly error?: 'unavailable' | 'invalid-response' | 'storage-unavailable' | 'cleanup-failure' | 'timeout';
}
export interface ModelsCatalogService {
  status(): CatalogStatus;
  refresh(signal?: AbortSignal): Promise<CatalogStatus>;
}
export const modelsCatalogServiceKey = 'models.catalog';
export const modelsCatalogSourceServiceKey = 'models.catalog-source';
export const modelsCatalogCacheServiceKey = 'models.catalog-cache';

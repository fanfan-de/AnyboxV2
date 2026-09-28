import type { Component } from '@nya/core';
import { immutable } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { abortLink, deferred, joinOperation, throwAborted } from './lifecycle.js';
import { catalogSnapshotVersion, validateCatalogSnapshot } from './catalog-domain.js';
import { loadBundledModelsDevCatalog } from './catalog-builtin.js';
import { modelsSourceDataServiceKey } from './types.js';
import type { ConnectionSyncState, ModelsSourceDataService, SourceSnapshot } from './types.js';
import { modelsCatalogCacheServiceKey, modelsCatalogServiceKey, modelsCatalogSourceServiceKey } from './catalog-types.js';
import type { CatalogCacheRecord, CatalogStatus, ModelsCatalogCache, ModelsCatalogService, ModelsCatalogSource } from './catalog-types.js';

export interface CatalogScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ModelsCatalogOptions {
  readonly bundledSnapshot?: SourceSnapshot;
  readonly autoRefresh?: boolean;
  readonly refreshIntervalMs?: number;
  readonly retryIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly scheduler?: CatalogScheduler;
}
const defaultScheduler: CatalogScheduler = {
  now: Date.now,
  setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
type Dependencies = { 'models.catalog-source': ModelsCatalogSource; 'models.catalog-cache': ModelsCatalogCache; 'models.source-data': ModelsSourceDataService };
type Active = { readonly controller: AbortController; readonly done: Promise<void>; phase: 'fetching' | 'committing' };

function createCatalogRuntime(source: ModelsCatalogSource, cache: ModelsCatalogCache, sourceData: ModelsSourceDataService, options: ModelsCatalogOptions) {
  const scheduler = options.scheduler ?? defaultScheduler;
  const refreshInterval = options.refreshIntervalMs ?? 24 * 60 * 60 * 1000;
  const retryInterval = options.retryIntervalMs ?? 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const automatic = options.autoRefresh !== false;
  for (const duration of [refreshInterval, retryInterval, timeoutMs]) if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) throw modelsError('invalid-config');
  if (!source.id || !source.cacheKey) throw modelsError('invalid-config');
  const empty: SourceSnapshot = { schemaVersion: 2, sourceId: source.id, snapshotVersion: catalogSnapshotVersion([], []), fetchedAt: 0, providers: [], models: [] };
  let snapshot = options.bundledSnapshot ?? (source.id === 'models.dev' ? loadBundledModelsDevCatalog() : empty);
  validateCatalogSnapshot(snapshot);
  if (snapshot.sourceId !== source.id) throw modelsError('invalid-config');
  snapshot = immutable(snapshot);
  let origin: CatalogStatus['origin'] = 'bundled', checkedAt: number | undefined, etag: string | undefined;
  let connections: readonly ConnectionSyncState[] = [];
  let lastError: CatalogStatus['error'], accepting = true, cleanupFailed = false;
  let active: Active | undefined, initializing: Promise<void> | undefined, closing: Promise<void> | undefined;
  let scheduled: unknown, nextRefreshAt: number | undefined;
  const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
  const stale = () => checkedAt === undefined || checkedAt > scheduler.now() || scheduler.now() - checkedAt >= refreshInterval;
  const view = (): CatalogStatus => immutable({ sourceId: source.id, snapshotVersion: snapshot.snapshotVersion, fetchedAt: snapshot.fetchedAt, origin,
    refreshing: !!active, stale: stale(), ...(checkedAt !== undefined ? { checkedAt } : {}), ...(nextRefreshAt !== undefined ? { nextRefreshAt } : {}),
    connections, cache: cache.status(), ...(lastError ? { error: lastError } : {}) });
  const status = (): CatalogStatus => { assertOpen(); return view(); };
  const clearSchedule = () => {
    if (scheduled !== undefined) scheduler.clearTimeout(scheduled);
    scheduled = undefined; nextRefreshAt = undefined;
  };
  const schedule = (at: number) => {
    clearSchedule();
    if (!automatic || !accepting) return;
    nextRefreshAt = at;
    scheduled = scheduler.setTimeout(() => {
      scheduled = undefined; nextRefreshAt = undefined;
      if (!accepting || active) return;
      void refresh().catch(() => {});
    }, Math.max(0, Math.min(2_147_483_647, at - scheduler.now())));
  };
  const scheduleNormally = () => schedule(stale() ? scheduler.now() : checkedAt! + refreshInterval);
  const accepted = () => {
    const value = sourceData.accepted(source.id);
    if (value) { validateCatalogSnapshot(value); if (value.sourceId !== source.id) throw modelsError('invalid-response'); }
    return value;
  };
  const publish = (fallback: SourceSnapshot) => { snapshot = immutable(accepted() ?? fallback); };
  const initialize = () => {
    if (initializing) return initializing;
    initializing = Promise.resolve().then(async () => {
      let cached: CatalogCacheRecord | undefined;
      try {
        cached = cache.read(source.cacheKey);
        if (cached) {
          validateCatalogSnapshot(cached.snapshot);
          if (cached.cacheKey !== source.cacheKey || cached.snapshot.sourceId !== source.id || !Number.isFinite(cached.checkedAt) || cached.checkedAt < 0) throw modelsError('invalid-response');
        }
      } catch { cached = undefined; lastError = 'storage-unavailable'; }
      const stored = accepted();
      // An accepted source ledger remains authoritative across catalog restarts.
      if (stored) { snapshot = immutable(stored); origin = 'store'; }
      let candidate = options.bundledSnapshot ?? (source.id === 'models.dev' ? loadBundledModelsDevCatalog() : empty);
      let candidateOrigin: CatalogStatus['origin'] = 'bundled';
      if (cached && cached.snapshot.fetchedAt >= candidate.fetchedAt) { candidate = cached.snapshot; candidateOrigin = 'cache'; }
      const newer = !stored || candidate.fetchedAt > stored.fetchedAt;
      const same = stored?.snapshotVersion === candidate.snapshotVersion;
      if (newer || same) {
        try {
          const outcome = await sourceData.accept(candidate);
          connections = immutable(outcome.connections);
          publish(candidate);
          if (outcome.accepted || same) origin = candidateOrigin;
        } catch (error) {
          const normalized = normalizeError(error);
          lastError = normalized.code === 'storage-unavailable' ? 'storage-unavailable' : 'unavailable';
          if (stored) snapshot = immutable(stored);
        }
      }
      // A cache validator is safe only for the data accepted by the shared store.
      if (cached?.snapshot.snapshotVersion === snapshot.snapshotVersion) { checkedAt = cached.checkedAt; etag = cached.etag; }
      else { checkedAt = undefined; etag = undefined; }
    });
    return initializing;
  };
  const refresh = (signal?: AbortSignal): Promise<CatalogStatus> => {
    try { assertOpen(); if (signal !== undefined && !(signal instanceof AbortSignal)) throw modelsError('invalid-config'); if (active) throw modelsError('busy'); }
    catch (error) { return Promise.reject(error); }
    clearSchedule();
    const controller = new AbortController(), done = deferred<void>(), unlink = abortLink(signal, controller);
    const owned: Active = { controller, done: done.promise, phase: 'fetching' };
    active = owned;
    let timedOut = false;
    const timer = scheduler.setTimeout(() => { if (owned.phase === 'fetching') { timedOut = true; controller.abort(); } }, timeoutMs);
    let success = false, failed = false;
    const result = Promise.resolve().then(async () => {
      try {
        throwAborted(controller.signal);
        const outcome = await joinOperation(source.fetch({ ...(etag ? { etag } : {}), signal: controller.signal }), controller.signal);
        throwAborted(controller.signal);
        if (!accepting) throw modelsError('cancelled');
        let candidate = snapshot, candidateEtag = outcome.etag;
        if (outcome.status === 'modified') {
          validateCatalogSnapshot(outcome.snapshot);
          if (outcome.snapshot.sourceId !== source.id) throw modelsError('invalid-response');
          candidate = immutable(outcome.snapshot);
        } else if (outcome.status === 'not-modified') {
          if (!etag) throw modelsError('invalid-response');
          candidateEtag ??= etag;
        } else throw modelsError('invalid-response');
        const now = scheduler.now();
        // All work after this boundary is admitted, including shared data and model initialization.
        throwAborted(controller.signal); owned.phase = 'committing'; scheduler.clearTimeout(timer);
        await cache.write({ cacheKey: source.cacheKey, snapshot: candidate, checkedAt: now, ...(candidateEtag ? { etag: candidateEtag } : {}) });
        const committed = await sourceData.accept(candidate, { confirmed: outcome.status === 'modified' });
        connections = immutable(committed.connections);
        publish(candidate);
        const matching = snapshot.snapshotVersion === candidate.snapshotVersion;
        etag = matching ? candidateEtag : undefined; checkedAt = matching ? now : undefined;
        origin = matching ? 'network' : 'store'; lastError = undefined; success = true;
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === 'cleanup-failure') { cleanupFailed = true; lastError = 'cleanup-failure'; failed = true; throw normalized; }
        if (controller.signal.aborted && owned.phase === 'fetching') {
          if (timedOut) { lastError = 'timeout'; failed = true; throw modelsError('timeout'); }
          throw modelsError('cancelled');
        }
        lastError = normalized.code === 'invalid-response' ? 'invalid-response' : normalized.code === 'storage-unavailable' ? 'storage-unavailable' : 'unavailable';
        failed = true; throw normalized;
      } finally {
        scheduler.clearTimeout(timer); unlink();
        if (active === owned) active = undefined;
        if (accepting) {
          if (failed) schedule(scheduler.now() + retryInterval);
          else if (success) scheduleNormally();
          else schedule(scheduler.now() + refreshInterval);
        }
        done.resolve();
      }
      return view();
    });
    void result.catch(() => {});
    return result;
  };
  const service: ModelsCatalogService = { status, refresh };
  const start = () => { if (automatic) scheduleNormally(); };
  const close = () => {
    if (closing) return closing;
    accepting = false; clearSchedule();
    const pending = active;
    pending?.controller.abort();
    closing = Promise.resolve().then(async () => {
      await initializing;
      await pending?.done;
      if (cleanupFailed) throw modelsError('cleanup-failure');
    });
    void closing.catch(() => {});
    return closing;
  };
  return { service, initialize, start, close };
}
export function createModelsCatalogComponent(options: ModelsCatalogOptions = {}): Component.Object<void, Dependencies> {
  return {
    name: 'models-catalog', inject: [modelsCatalogSourceServiceKey, modelsCatalogCacheServiceKey, modelsSourceDataServiceKey],
    async apply(ctx, _config, deps) {
      const runtime = createCatalogRuntime(deps[modelsCatalogSourceServiceKey], deps[modelsCatalogCacheServiceKey], deps[modelsSourceDataServiceKey], options);
      ctx.effect(() => () => runtime.close(), 'stop catalog refreshes and join source exit, cache, definition and configuration commits');
      await runtime.initialize();
      ctx.provide(modelsCatalogServiceKey, runtime.service);
      runtime.start();
    },
  };
}

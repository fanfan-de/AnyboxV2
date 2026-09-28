import type { Component } from '@nya/core';
import { modelsError, normalizeError } from './errors.js';
import { normalizeModelsDevCatalog } from './catalog-domain.js';
import { modelsCatalogSourceServiceKey } from './catalog-types.js';
import type { CatalogOperation, CatalogSourceResult, ModelsCatalogSource } from './catalog-types.js';

export const modelsDevCatalogUrl = 'https://models.dev/api.json?type=all';
export interface ModelsDevCatalogSourceOptions {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}
const maxBytes = 32 * 1024 * 1024;

function sourceRuntime(options: ModelsDevCatalogSourceOptions) {
  if (!options || options.fetch !== undefined && typeof options.fetch !== 'function' || options.now !== undefined && typeof options.now !== 'function') throw modelsError('invalid-config');
  let url: URL;
  try { url = new URL(options.url ?? modelsDevCatalogUrl); } catch { throw modelsError('invalid-config'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw modelsError('invalid-config');
  url.searchParams.set('type', 'all');
  const endpoint = url.toString(), fetch = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  let accepting = true, closing: Promise<void> | undefined, cleanupFailed = false;
  const operations = new Set<CatalogOperation<CatalogSourceResult>>();
  const source: ModelsCatalogSource = Object.freeze({
    id: 'models.dev', cacheKey: `models.dev:${endpoint}`,
    fetch(input: { readonly etag?: string; readonly signal: AbortSignal }) {
      if (!accepting) throw modelsError('closed');
      if (!(input.signal instanceof AbortSignal) || input.etag !== undefined && (typeof input.etag !== 'string' || /[\r\n]/u.test(input.etag))) throw modelsError('invalid-config');
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let ended = false, failedCleanup = false;
      let cancellation: Promise<void> | undefined;
      const cancelReader = (): Promise<void> => {
        if (cancellation) return cancellation;
        if (!reader || ended) return Promise.resolve();
        try { cancellation = reader.cancel().catch(() => { failedCleanup = true; }); }
        catch { failedCleanup = true; cancellation = Promise.resolve(); }
        return cancellation;
      };
      const cancel = () => { void cancelReader(); controller.abort(); };
      input.signal.addEventListener('abort', cancel, { once: true });
      if (input.signal.aborted) cancel();
      let resolve!: (value: CatalogSourceResult) => void, reject!: (error: unknown) => void;
      const result = new Promise<CatalogSourceResult>((yes, no) => { resolve = yes; reject = no; });
      const done = (async () => {
        try {
          if (controller.signal.aborted) throw modelsError('cancelled');
          let response: Response;
          try {
            response = await fetch(endpoint, {
              method: 'GET', headers: { Accept: 'application/json', ...(input.etag ? { 'If-None-Match': input.etag } : {}) },
              credentials: 'omit', signal: controller.signal,
            });
          } catch { throw modelsError(controller.signal.aborted ? 'cancelled' : 'unavailable'); }
          reader = response.body?.getReader();
          if (controller.signal.aborted) throw modelsError('cancelled');
          const etag = response.headers.get('etag') ?? undefined;
          if (response.status === 304) {
            if (!input.etag) throw modelsError('invalid-response');
            resolve({ status: 'not-modified', ...(etag ? { etag } : {}) });
            return;
          }
          if (!response.ok) throw modelsError('unavailable');
          const size = Number(response.headers.get('content-length'));
          if (size > maxBytes || !reader) throw modelsError('invalid-response');
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let bytes = 0, body = '';
          while (true) {
            let part: ReadableStreamReadResult<Uint8Array>;
            try { part = await reader.read(); } catch {
              ended = true;
              throw modelsError(controller.signal.aborted ? 'cancelled' : 'unavailable');
            }
            if (controller.signal.aborted) throw modelsError('cancelled');
            if (part.done) { ended = true; body += decoder.decode(); break; }
            bytes += part.value.byteLength;
            if (bytes > maxBytes) throw modelsError('invalid-response');
            body += decoder.decode(part.value, { stream: true });
          }
          let data: unknown;
          try { data = JSON.parse(body); } catch { throw modelsError('invalid-response'); }
          const snapshot = normalizeModelsDevCatalog(data, source.id, now());
          if (controller.signal.aborted) throw modelsError('cancelled');
          resolve({ status: 'modified', snapshot, ...(etag ? { etag } : {}) });
        } catch (error) {
          const normalized = normalizeError(error, 'invalid-response');
          reject(controller.signal.aborted ? modelsError('cancelled') : normalized);
        } finally {
          await cancelReader();
          try { reader?.releaseLock(); } catch { failedCleanup = true; }
          reader = undefined;
          input.signal.removeEventListener('abort', cancel);
          if (failedCleanup) { cleanupFailed = true; throw modelsError('cleanup-failure'); }
        }
      })();
      const operation = Object.freeze({ result, done, cancel });
      operations.add(operation);
      void result.catch(() => {});
      void done.finally(() => operations.delete(operation)).catch(() => {});
      return operation;
    },
  });
  const close = () => {
    if (closing) return closing;
    accepting = false;
    for (const operation of operations) operation.cancel();
    closing = Promise.allSettled([...operations].map(operation => operation.done)).then(outcomes => {
      if (cleanupFailed || outcomes.some(outcome => outcome.status === 'rejected')) throw modelsError('cleanup-failure');
    });
    void closing.catch(() => {});
    return closing;
  };
  return { source, close };
}
export function createModelsDevCatalogSource(options: ModelsDevCatalogSourceOptions = {}): ModelsCatalogSource {
  return sourceRuntime(options).source;
}
export function createModelsDevCatalogSourceComponent(options: ModelsDevCatalogSourceOptions = {}): Component.Object<void> {
  return {
    name: 'models-catalog-source',
    apply(ctx) {
      const runtime = sourceRuntime(options);
      ctx.effect(() => () => runtime.close(), 'cancel catalog fetches and join HTTP reader exit');
      ctx.provide(modelsCatalogSourceServiceKey, runtime.source);
    },
  };
}

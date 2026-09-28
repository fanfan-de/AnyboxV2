import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Component } from '@nya/core';
import { immutable } from './domain.js';
import { modelsError } from './errors.js';
import { readCatalogSnapshot, validateCatalogSnapshot } from './catalog-domain.js';
import { modelsCatalogCacheServiceKey } from './catalog-types.js';
import type { CatalogCacheRecord, CatalogCacheStatus, ModelsCatalogCache } from './catalog-types.js';

export interface ModelsCatalogCacheOptions {
  readonly path: string;
  /** Catalogs contain no credentials. Fallback is visible through status(). */
  readonly fallbackToMemory?: boolean;
  /** Host-owned databases cannot become a catalog cache, including path aliases. */
  readonly reservedPaths?: readonly string[];
}
function validateRecord(input: unknown): asserts input is CatalogCacheRecord {
  if (!input || typeof input !== 'object') throw modelsError('invalid-response');
  const value = input as CatalogCacheRecord;
  if (typeof value.cacheKey !== 'string' || !value.cacheKey || !Number.isFinite(value.checkedAt) || value.checkedAt < 0 || value.etag !== undefined && (typeof value.etag !== 'string' || /[\r\n]/u.test(value.etag))) throw modelsError('invalid-response');
  validateCatalogSnapshot(value.snapshot);
}
function memoryRuntime(error?: 'storage-unavailable') {
  let accepting = true;
  const entries = new Map<string, CatalogCacheRecord>();
  const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
  const cache: ModelsCatalogCache = {
    status() { assertOpen(); return { persistence: 'memory', ...(error ? { error } : {}) }; },
    read(key) { assertOpen(); return entries.has(key) ? immutable(entries.get(key)!) : undefined; },
    write(input) {
      try { assertOpen(); validateRecord(input); entries.set(input.cacheKey, immutable(input)); return Promise.resolve(); }
      catch (failure) { return Promise.reject(failure); }
    },
  };
  return { cache, close: async () => { accepting = false; entries.clear(); } };
}
export function createMemoryModelsCatalogCache(): ModelsCatalogCache { return memoryRuntime().cache; }

function canonicalPath(input: string) {
  const absolute = resolve(input);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
}
function reserved(path: string, paths: readonly string[]): boolean {
  return paths.some(input => {
    const other = resolve(input);
    if (path === other) return true;
    try {
      let existing = other;
      const suffix: string[] = [];
      while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) break;
        suffix.unshift(basename(existing)); existing = parent;
      }
      if (join(realpathSync(existing), ...suffix) === path) return true;
      const left = statSync(path), right = statSync(other);
      return left.dev === right.dev && left.ino === right.ino;
    } catch { return false; }
  });
}
function initialize(db: DatabaseSync) {
  db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) throw modelsError('storage-unavailable');
      db.exec('CREATE TABLE catalog_cache (cache_key TEXT PRIMARY KEY, record TEXT NOT NULL); PRAGMA user_version = 1');
    } else if (version !== 1) throw modelsError('storage-unavailable');
    db.prepare('SELECT cache_key, record FROM catalog_cache LIMIT 0').all();
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* Closing this connection releases the failed initialization. */ }
    throw modelsError('storage-unavailable');
  }
}
function sqliteRuntime(db: DatabaseSync) {
  let accepting = true, tail = Promise.resolve(), storageError: 'storage-unavailable' | undefined;
  const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
  const cache: ModelsCatalogCache = {
    status(): CatalogCacheStatus { assertOpen(); return { persistence: 'sqlite', ...(storageError ? { error: storageError } : {}) }; },
    read(key) {
      assertOpen();
      try {
        const row = db.prepare('SELECT record FROM catalog_cache WHERE cache_key = ?').get(key);
        if (!row) return undefined;
        const stored = JSON.parse(String(row.record)) as Record<string, unknown>;
        const value: unknown = { ...stored, snapshot: readCatalogSnapshot(stored.snapshot) };
        validateRecord(value);
        if (value.cacheKey !== key) throw modelsError('invalid-response');
        return immutable(value);
      } catch { storageError = 'storage-unavailable'; throw modelsError('storage-unavailable'); }
    },
    write(input) {
      let record: CatalogCacheRecord;
      try { assertOpen(); validateRecord(input); record = immutable(input); }
      catch (error) { return Promise.reject(error); }
      const result = tail.then(() => {
        let begun = false;
        try {
          db.exec('BEGIN IMMEDIATE'); begun = true;
          db.prepare('INSERT INTO catalog_cache (cache_key, record) VALUES (?, ?) ON CONFLICT(cache_key) DO UPDATE SET record = excluded.record')
            .run(record.cacheKey, JSON.stringify(record));
          db.exec('COMMIT'); storageError = undefined;
        } catch {
          if (begun) { try { db.exec('ROLLBACK'); } catch { /* Report the failed storage operation below. */ } }
          storageError = 'storage-unavailable'; throw modelsError('storage-unavailable');
        }
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
  return { cache, close: async () => {
    accepting = false;
    await tail;
    try { db.close(); } catch { throw modelsError('cleanup-failure'); }
  } };
}
export function createModelsCatalogCacheComponent(options: ModelsCatalogCacheOptions): Component.Object<void> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:' || options.reservedPaths !== undefined && (!Array.isArray(options.reservedPaths) || options.reservedPaths.some(path => typeof path !== 'string' || !path.trim()))) throw modelsError('invalid-config');
  return {
    name: 'models-catalog-cache',
    apply(ctx) {
      let db: DatabaseSync | undefined;
      let runtime: ReturnType<typeof memoryRuntime> | ReturnType<typeof sqliteRuntime>;
      let path: string | undefined;
      try { path = canonicalPath(options.path); } catch { /* An unavailable location uses the explicitly visible fallback below. */ }
      if (reserved(path ?? resolve(options.path), options.reservedPaths ?? [])) throw modelsError('invalid-config');
      try { if (!path) throw modelsError('storage-unavailable'); db = new DatabaseSync(path); initialize(db); runtime = sqliteRuntime(db); }
      catch {
        if (db) { try { db.close(); } catch { throw modelsError('cleanup-failure'); } }
        if (options.fallbackToMemory === false) throw modelsError('storage-unavailable');
        runtime = memoryRuntime('storage-unavailable');
      }
      ctx.effect(() => () => runtime.close(), 'join catalog cache writes and release cache storage');
      ctx.provide(modelsCatalogCacheServiceKey, runtime.cache);
    },
  };
}

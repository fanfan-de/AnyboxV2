import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Component } from '@nya/core';
import { modelsError, normalizeError } from './errors.js';
import { modelsStoreServiceKey } from './types.js';
import type { CredentialIntent, ModelRecord, ModelsStore, ProviderRecord, StoreChange, Versioned } from './types.js';

export interface ModelsStoreOptions { readonly path: string }

function canonicalPath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input === ':memory:') throw modelsError('invalid-config');
  const absolute = resolve(input);
  try {
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  } catch { throw modelsError('storage-unavailable'); }
}

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw modelsError('invalid-config');
}

function validateVersion(record: Versioned, current: Versioned | undefined, expected: number | null): void {
  requiredString(record.id);
  requiredString(record.versionId);
  requiredString(record.createdAt);
  requiredString(record.updatedAt);
  if (expected === null ? current !== undefined : current?.revision !== expected) throw modelsError('conflict');
  if (!Number.isSafeInteger(record.revision) || record.revision !== (current?.revision ?? 0) + 1 ||
      (current && record.createdAt !== current.createdAt)) throw modelsError('invalid-config');
}

/** Pick fields rather than allowing an accidental apiKey property into persisted configuration. */
function providerRecord(record: ProviderRecord): ProviderRecord {
  return {
    id: record.id, revision: record.revision, versionId: record.versionId, createdAt: record.createdAt,
    updatedAt: record.updatedAt, name: record.name, enabled: record.enabled, protocolId: record.protocolId,
    baseUrl: record.baseUrl, auth: record.auth, timeoutMs: record.timeoutMs, credentialRef: record.credentialRef,
    ...(record.catalogRef === undefined ? {} : { catalogRef: record.catalogRef }),
  };
}

function modelRecord(record: ModelRecord): ModelRecord {
  return {
    id: record.id, revision: record.revision, versionId: record.versionId, createdAt: record.createdAt,
    updatedAt: record.updatedAt, name: record.name, enabled: record.enabled, providerId: record.providerId,
    remoteModelId: record.remoteModelId, capabilities: record.capabilities, defaults: record.defaults,
  };
}

function intentRecord(record: CredentialIntent): CredentialIntent {
  return { id: record.id, providerId: record.providerId, slotId: record.slotId, createdAt: record.createdAt };
}

function initialize(db: DatabaseSync): void {
  // EXCLUSIVE mode retains SQLite's OS lock until close, including between commits.
  // The OS releases it after a process crash; there is no stale application lock to remove.
  db.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) throw modelsError('storage-unavailable');
      db.exec(`
        CREATE TABLE providers (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE provider_versions (
          provider_id TEXT NOT NULL, revision INTEGER NOT NULL, version_id TEXT NOT NULL UNIQUE,
          record TEXT NOT NULL, PRIMARY KEY (provider_id, revision));
        CREATE TABLE models (
          id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id),
          revision INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE model_versions (
          model_id TEXT NOT NULL, revision INTEGER NOT NULL, version_id TEXT NOT NULL UNIQUE,
          record TEXT NOT NULL, PRIMARY KEY (model_id, revision));
        CREATE TABLE credential_intents (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    } else if (version !== 1) throw modelsError('storage-unavailable');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { throw modelsError('storage-unavailable'); }
    throw error;
  }
}

/** Owns a private database. Data loading has no dependency on installed protocols. */
export function createModelsStoreComponent(options: ModelsStoreOptions): Component.Object<void> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:') {
    throw modelsError('invalid-config');
  }
  return {
    name: 'models-store',
    apply(ctx) {
      let db: DatabaseSync;
      try { db = new DatabaseSync(canonicalPath(options.path)); } catch { throw modelsError('storage-unavailable'); }
      try { initialize(db); } catch {
        try { db.close(); } catch { /* Initialization has already failed. */ }
        throw modelsError('storage-unavailable');
      }
      let accepting = true;
      let tail: Promise<void> = Promise.resolve();
      const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
      const readOne = <T>(sql: string, id: string): T | undefined => {
        try {
          const row = db.prepare(sql).get(id);
          return row ? JSON.parse(String(row.record)) as T : undefined;
        } catch { throw modelsError('storage-unavailable'); }
      };
      const readMany = <T>(sql: string, values: readonly string[] = []): readonly T[] => {
        try { return db.prepare(sql).all(...values).map(row => JSON.parse(String(row.record)) as T); }
        catch { throw modelsError('storage-unavailable'); }
      };
      const getProvider = (id: string) => readOne<ProviderRecord>('SELECT record FROM providers WHERE id = ?', id);
      const getModel = (id: string) => readOne<ModelRecord>('SELECT record FROM models WHERE id = ?', id);
      const commit = (change: StoreChange) => {
        let begun = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          begun = true;
          if (change.provider) {
            const { record, expectedRevision } = change.provider;
            const current = getProvider(record.id);
            validateVersion(record, current, expectedRevision);
            if (current && record.protocolId !== current.protocolId) throw modelsError('invalid-config');
            const encoded = JSON.stringify(record);
            db.prepare('INSERT INTO provider_versions (provider_id, revision, version_id, record) VALUES (?, ?, ?, ?)')
              .run(record.id, record.revision, record.versionId, encoded);
            db.prepare(`INSERT INTO providers (id, revision, record) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record = excluded.record`)
              .run(record.id, record.revision, encoded);
          }
          if (change.model) {
            const { record, expectedRevision } = change.model;
            const current = getModel(record.id);
            validateVersion(record, current, expectedRevision);
            if (current && record.providerId !== current.providerId) throw modelsError('invalid-config');
            if (!getProvider(record.providerId)) throw modelsError('not-found');
            const encoded = JSON.stringify(record);
            db.prepare('INSERT INTO model_versions (model_id, revision, version_id, record) VALUES (?, ?, ?, ?)')
              .run(record.id, record.revision, record.versionId, encoded);
            db.prepare(`INSERT INTO models (id, provider_id, revision, record) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record = excluded.record`)
              .run(record.id, record.providerId, record.revision, encoded);
          }
          for (const intent of change.addIntents ?? []) {
            for (const value of [intent.id, intent.providerId, intent.slotId, intent.createdAt]) requiredString(value);
            db.prepare('INSERT INTO credential_intents (id, record) VALUES (?, ?)').run(intent.id, JSON.stringify(intent));
          }
          for (const id of change.removeIntentIds ?? []) db.prepare('DELETE FROM credential_intents WHERE id = ?').run(id);
          db.exec('COMMIT');
        } catch (error) {
          if (begun) {
            try { db.exec('ROLLBACK'); } catch { throw modelsError('storage-unavailable'); }
          }
          throw normalizeError(error, 'storage-unavailable');
        }
      };
      const service: ModelsStore = {
        providers() { assertOpen(); return readMany('SELECT record FROM providers ORDER BY id'); },
        provider(id) { assertOpen(); return getProvider(id); },
        providerHistory(id) { assertOpen(); return readMany('SELECT record FROM provider_versions WHERE provider_id = ? ORDER BY revision', [id]); },
        models() { assertOpen(); return readMany('SELECT record FROM models ORDER BY id'); },
        model(id) { assertOpen(); return getModel(id); },
        modelHistory(id) { assertOpen(); return readMany('SELECT record FROM model_versions WHERE model_id = ? ORDER BY revision', [id]); },
        intents() { assertOpen(); return readMany('SELECT record FROM credential_intents ORDER BY id'); },
        commit(input) {
          let change: StoreChange;
          try {
            assertOpen();
            // Snapshot before queueing; callers cannot mutate an admitted write.
            change = structuredClone({
              ...(input.provider ? { provider: { record: providerRecord(input.provider.record), expectedRevision: input.provider.expectedRevision } } : {}),
              ...(input.model ? { model: { record: modelRecord(input.model.record), expectedRevision: input.model.expectedRevision } } : {}),
              addIntents: input.addIntents?.map(intentRecord), removeIntentIds: input.removeIntentIds,
            });
          } catch (error) { return Promise.reject(normalizeError(error, 'invalid-config')); }
          const result = tail.then(() => commit(change));
          tail = result.then(() => {}, () => {});
          return result;
        },
      };
      ctx.effect(() => async () => {
        accepting = false;
        await tail;
        try { db.close(); } catch { throw modelsError('cleanup-failure'); }
      }, 'join models storage and release SQLite ownership');
      ctx.provide(modelsStoreServiceKey, service);
    },
  };
}

import { migrateLegacyParameters } from './legacy-parameters.js';
import { validateParameters } from './domain.js';
import { connectionRecord, configurationRecord, intentRecord, modelRecord, normalizeStoreChange, providerRecord, requiredString, sourceIdentity, sourceState, syncState, validateVersion, versionFields } from './store-domain.js';
import type { LegacyParameterConverter, NativeObject } from './native-types.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Component } from '@nya/core';
import type { ModelsJsonSnapshot } from './json-store-domain.js';
import { modelsError, normalizeError } from './errors.js';
import { externalProviderId } from './identity.js';
import { modelsStoreServiceKey } from './types.js';
import type {
  ConnectionHints, ConnectionSyncState, CredentialIntent, DeclaredCapabilities,
  Model, ModelConfiguration, ModelsStore, Provider, ProviderConnectionRecord, SourceRef, SourceState,
  StoreChange, Versioned,
} from './types.js';

export interface ModelsStoreOptions { readonly path: string; readonly legacyParameterConverters?: Readonly<Record<string, LegacyParameterConverter>> }

function canonicalPath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input === ':memory:') throw modelsError('invalid-config');
  const absolute = resolve(input);
  try {
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  } catch { throw modelsError('storage-unavailable'); }
}
function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE provider_definitions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      source_id TEXT, external_provider_id TEXT, record TEXT NOT NULL, UNIQUE(source_id, external_provider_id));
    CREATE TABLE provider_definition_versions (provider_id TEXT NOT NULL, revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(provider_id, revision));
    CREATE TABLE model_definitions (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider_definitions(id),
      revision INTEGER NOT NULL, source_id TEXT, external_provider_id TEXT, external_model_id TEXT, record TEXT NOT NULL,
      UNIQUE(source_id, external_provider_id, external_model_id));
    CREATE TABLE model_definition_versions (model_id TEXT NOT NULL, revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(model_id, revision));
    CREATE TABLE connections (id TEXT PRIMARY KEY, provider_definition_id TEXT NOT NULL REFERENCES provider_definitions(id),
      revision INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE connection_versions (connection_id TEXT NOT NULL, revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(connection_id, revision));
    CREATE TABLE configurations (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
      model_definition_id TEXT NOT NULL REFERENCES model_definitions(id), baseline INTEGER NOT NULL,
      revision INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE UNIQUE INDEX configuration_baseline ON configurations(connection_id, model_definition_id) WHERE baseline=1;
    CREATE TABLE configuration_versions (configuration_id TEXT NOT NULL, revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(configuration_id, revision));
    CREATE TABLE sources (source_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE connection_sync_states (connection_id TEXT PRIMARY KEY REFERENCES connections(id), record TEXT NOT NULL);
  `);
}
interface LegacyProvider extends Versioned {
  readonly name: string; readonly enabled: boolean; readonly protocolId: string; readonly baseUrl: string;
  readonly auth: 'none' | 'api-key'; readonly timeoutMs: number; readonly credentialRef: string | null;
  readonly catalogRef?: { readonly sourceId: string; readonly providerId: string } | null;
}
interface LegacyModel extends Versioned {
  readonly providerId: string; readonly remoteModelId: string; readonly name: string; readonly enabled: boolean;
  readonly capabilities: DeclaredCapabilities; readonly defaults: NativeObject;
}
function migratedId(kind: 'provider' | 'model', id: string): string {
  return `${kind}-user-migrated-${createHash('sha256').update(JSON.stringify([id])).digest('hex')}`;
}
function migrateV1(db: DatabaseSync, converters: Readonly<Record<string, LegacyParameterConverter>>): void {
  // Exact historical records remain archived. Future writes only target v2 structures.
  db.exec(`ALTER TABLE providers RENAME TO legacy_providers; ALTER TABLE provider_versions RENAME TO legacy_provider_versions;
    ALTER TABLE models RENAME TO legacy_models; ALTER TABLE model_versions RENAME TO legacy_model_versions;`);
  createSchema(db);
  const rows = <T>(sql: string) => db.prepare(sql).all().map(row => JSON.parse(String(row.record)) as T);
  const legacyProviders = rows<LegacyProvider>('SELECT record FROM legacy_providers ORDER BY id');
  const legacyModels = rows<LegacyModel>('SELECT record FROM legacy_models ORDER BY id');
  const providerVersions = rows<LegacyProvider>('SELECT record FROM legacy_provider_versions ORDER BY provider_id, revision');
  const modelVersions = rows<LegacyModel>('SELECT record FROM legacy_model_versions ORDER BY model_id, revision');
  const definitions = new Map<string, Provider>(), connections = new Map<string, ProviderConnectionRecord>();
  const toConnection = (legacy: LegacyProvider): ProviderConnectionRecord => {
    versionFields(legacy);
    const ref = legacy.catalogRef;
    if (ref !== undefined && ref !== null) { requiredString(ref.sourceId); requiredString(ref.providerId); }
    const id = ref ? externalProviderId(ref.sourceId, ref.providerId) : migratedId('provider', legacy.id);
    if (!definitions.has(id)) definitions.set(id, providerRecord({
      id, revision: 1, versionId: `migrated-definition-${id}`, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt,
      name: ref ? ref.providerId : legacy.name,
      source: ref ? { kind: 'external', sourceId: ref.sourceId, providerId: ref.providerId, sourceVersion: null } : { kind: 'user' },
      state: ref ? 'unresolved' : 'present',
      connectionHints: ref ? { protocolIds: [] } : { baseUrl: legacy.baseUrl, protocolIds: [legacy.protocolId] },
    }));
    return connectionRecord({ ...legacy, providerDefinitionId: id, historyScopeEpoch: randomUUID() });
  };
  for (const legacy of legacyProviders) connections.set(legacy.id, toConnection(legacy));
  const histories = providerVersions.map(toConnection);
  for (const current of connections.values()) {
    if (!histories.some(record => record.id === current.id && record.revision === current.revision)) histories.push(current);
  }
  for (const record of definitions.values()) {
    const external = record.source.kind === 'external' ? record.source : undefined, encoded = JSON.stringify(record);
    db.prepare('INSERT INTO provider_definitions(id,revision,source_id,external_provider_id,record) VALUES(?,?,?,?,?)')
      .run(record.id, record.revision, external?.sourceId ?? null, external?.providerId ?? null, encoded);
    db.prepare('INSERT INTO provider_definition_versions(provider_id,revision,version_id,record) VALUES(?,?,?,?)')
      .run(record.id, record.revision, record.versionId, encoded);
  }
  for (const record of connections.values()) db.prepare('INSERT INTO connections(id,provider_definition_id,revision,record) VALUES(?,?,?,?)')
    .run(record.id, record.providerDefinitionId, record.revision, JSON.stringify(record));
  for (const record of histories) {
    if (!connections.has(record.id)) throw modelsError('invalid-config');
    db.prepare('INSERT INTO connection_versions(connection_id,revision,version_id,record) VALUES(?,?,?,?)')
      .run(record.id, record.revision, record.versionId, JSON.stringify(record));
  }
  const toDefinition = (legacy: LegacyModel): Model => {
    const connection = connections.get(legacy.providerId);
    if (!connection) throw modelsError('not-found');
    return modelRecord({ ...versionFields(legacy), id: migratedId('model', legacy.id), versionId: `migrated-definition-${legacy.versionId}`,
      providerId: connection.providerDefinitionId, remoteModelId: legacy.remoteModelId, name: legacy.name,
      source: { kind: 'user' }, state: 'present', capabilities: legacy.capabilities, controls: { temperature: 'unknown' },
      modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [connection.protocolId] } });
  };
  const toConfiguration = (legacy: LegacyModel, definition = toDefinition(legacy)): ModelConfiguration => configurationRecord({
    ...legacy, connectionId: legacy.providerId, modelDefinitionId: definition.id, modelDefinitionVersionId: definition.versionId, baseline: true, parameters: migrateLegacyParameters(connections.get(legacy.providerId)!.protocolId, legacy.defaults, converters) });
  const modelHistory = [...modelVersions];
  for (const legacy of legacyModels) {
    if (!modelHistory.some(record => record.id === legacy.id && record.revision === legacy.revision)) modelHistory.push(legacy);
    const record = toDefinition(legacy);
    db.prepare('INSERT INTO model_definitions(id,provider_id,revision,record) VALUES(?,?,?,?)').run(record.id, record.providerId, record.revision, JSON.stringify(record));
  }
  for (const legacy of modelHistory) {
    if (!legacyModels.some(current => current.id === legacy.id)) throw modelsError('invalid-config');
    const definition = toDefinition(legacy), record = toConfiguration(legacy, definition);
    db.prepare('INSERT INTO model_definition_versions(model_id,revision,version_id,record) VALUES(?,?,?,?)')
      .run(definition.id, definition.revision, definition.versionId, JSON.stringify(definition));
    db.prepare('INSERT INTO configuration_versions(configuration_id,revision,version_id,record) VALUES(?,?,?,?)')
      .run(record.id, record.revision, record.versionId, JSON.stringify(record));
  }
  for (const legacy of legacyModels) {
    const record = toConfiguration(legacy);
    db.prepare('INSERT INTO configurations(id,connection_id,model_definition_id,baseline,revision,record) VALUES(?,?,?,?,?,?)')
      .run(record.id, record.connectionId, record.modelDefinitionId, 1, record.revision, JSON.stringify(record));
  }
}
function initialize(db: DatabaseSync, converters: Readonly<Record<string, LegacyParameterConverter>>): void {
  // EXCLUSIVE mode retains the OS lock between commits; process death releases it.
  db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) throw modelsError('storage-unavailable');
      createSchema(db); db.exec('CREATE TABLE credential_intents(id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    } else if (version === 1) migrateV1(db, converters);
    else if (version !== 2 && version !== 3) throw modelsError('storage-unavailable');
    const connections = new Map<string, ProviderConnectionRecord>();
    for (const row of db.prepare('SELECT id,record FROM connections').all()) {
      const record = JSON.parse(String(row.record)) as ProviderConnectionRecord;
      if (version === 3 && !record.historyScopeEpoch) throw modelsError('storage-unavailable');
      const next = { ...record, historyScopeEpoch: record.historyScopeEpoch ?? randomUUID() }; connections.set(next.id, next);
      if (version !== 3) db.prepare('UPDATE connections SET record=? WHERE id=?').run(JSON.stringify(next), next.id);
    }
    for (const row of db.prepare('SELECT id,record FROM configurations').all()) {
      const record = JSON.parse(String(row.record)) as ModelConfiguration & { defaults?: NativeObject };
      const { defaults, ...rest } = record;
      const connection = connections.get(record.connectionId); if (!connection) throw modelsError('storage-unavailable');
      const parameters = record.parameters?.formatVersion === 1 ? record.parameters : migrateLegacyParameters(connection.protocolId, record.parameters?.value ?? defaults ?? {}, converters);
      validateParameters(parameters);
      if (!record.parameters || record.parameters.formatVersion !== parameters.formatVersion) db.prepare('UPDATE configurations SET record=? WHERE id=?').run(JSON.stringify({ ...rest, parameters }), record.id);
    }
    db.exec('PRAGMA user_version=3; COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { throw modelsError('storage-unavailable'); } throw error; }
}

/** Owns definitions, connections, runnable configurations, and their exclusive SQLite migration. */
export function createModelsStoreComponent(options: ModelsStoreOptions): Component.Object<void> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:') throw modelsError('invalid-config');
  return { name: 'models-store', apply(ctx) {
    let db: DatabaseSync;
    try { db = new DatabaseSync(canonicalPath(options.path)); } catch { throw modelsError('storage-unavailable'); }
    try { initialize(db, options.legacyParameterConverters ?? {}); } catch {
      try { db.close(); } catch { /* Already failed initialization. */ } throw modelsError('storage-unavailable');
    }
    let accepting = true, tail: Promise<void> = Promise.resolve();
    // SQL shapes are fixed by this adapter. Reuse bytecode while keeping one
    // synchronous transaction for the complete source/configuration change.
    const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
    const prepare = (sql: string) => {
      let statement = statements.get(sql);
      if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
      return statement;
    };
    const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
    const one = <T>(sql: string, id: string): T | undefined => {
      try { const row = prepare(sql).get(id); return row ? JSON.parse(String(row.record)) as T : undefined; }
      catch { throw modelsError('storage-unavailable'); }
    };
    const many = <T>(sql: string, values: readonly string[] = []): readonly T[] => {
      try { return prepare(sql).all(...values).map(row => JSON.parse(String(row.record)) as T); }
      catch { throw modelsError('storage-unavailable'); }
    };
    const provider = (id: string) => one<Provider>('SELECT record FROM provider_definitions WHERE id=?', id);
    const model = (id: string) => one<Model>('SELECT record FROM model_definitions WHERE id=?', id);
    const connection = (id: string) => one<ProviderConnectionRecord>('SELECT record FROM connections WHERE id=?', id);
    const configuration = (id: string) => one<ModelConfiguration>('SELECT record FROM configurations WHERE id=?', id);
    const synced = (id: string) => one<ConnectionSyncState>('SELECT record FROM connection_sync_states WHERE connection_id=?', id);
    const version = (table: string, key: string, record: Versioned, encoded: string) => {
      prepare(`INSERT INTO ${table}(${key},revision,version_id,record) VALUES(?,?,?,?)`).run(record.id, record.revision, record.versionId, encoded);
    };
    const commit = (change: StoreChange) => {
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        for (const guard of change.syncGuards ?? []) {
          if ((synced(guard.connectionId)?.targetSourceVersion ?? null) !== guard.targetSourceVersion) throw modelsError('conflict');
        }
        for (const { record, expectedRevision } of change.providers ?? []) {
          const current = provider(record.id); validateVersion(record, current, expectedRevision);
          if (current && sourceIdentity(current.source) !== sourceIdentity(record.source)) throw modelsError('invalid-config');
          const external = record.source.kind === 'external' ? record.source : undefined;
          if (external) {
            const owner = prepare('SELECT id FROM provider_definitions WHERE source_id=? AND external_provider_id=?').get(external.sourceId, external.providerId);
            if (owner && owner.id !== record.id) throw modelsError('conflict');
          }
          const encoded = JSON.stringify(record); version('provider_definition_versions', 'provider_id', record, encoded);
          prepare(`INSERT INTO provider_definitions(id,revision,source_id,external_provider_id,record) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
            .run(record.id, record.revision, external?.sourceId ?? null, external?.providerId ?? null, encoded);
        }
        for (const { record, expectedRevision } of change.models ?? []) {
          const current = model(record.id); validateVersion(record, current, expectedRevision);
          if (current && (record.providerId !== current.providerId || sourceIdentity(record.source) !== sourceIdentity(current.source))) throw modelsError('invalid-config');
          const parent = provider(record.providerId);
          if (!parent) throw modelsError('not-found');
          const external = record.source.kind === 'external' ? record.source : undefined;
          if (external) {
            if (parent.source.kind !== 'external' || parent.source.sourceId !== external.sourceId || parent.source.providerId !== external.providerId) throw modelsError('invalid-config');
            const owner = prepare('SELECT id FROM model_definitions WHERE source_id=? AND external_provider_id=? AND external_model_id=?')
              .get(external.sourceId, external.providerId, external.modelId!);
            if (owner && owner.id !== record.id) throw modelsError('conflict');
          }
          const encoded = JSON.stringify(record); version('model_definition_versions', 'model_id', record, encoded);
          prepare(`INSERT INTO model_definitions(id,provider_id,revision,source_id,external_provider_id,external_model_id,record) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
            .run(record.id, record.providerId, record.revision, external?.sourceId ?? null, external?.providerId ?? null, external?.modelId ?? null, encoded);
        }
        if (change.connection) {
          const { record, expectedRevision } = change.connection, current = connection(record.id);
          validateVersion(record, current, expectedRevision);
          if (!current && prepare('SELECT 1 FROM connection_versions WHERE connection_id=? LIMIT 1').get(record.id)) throw modelsError('conflict');
          if (current && (record.protocolId !== current.protocolId || record.providerDefinitionId !== current.providerDefinitionId)) throw modelsError('invalid-config');
          if (!provider(record.providerDefinitionId)) throw modelsError('not-found');
          const encoded = JSON.stringify(record); version('connection_versions', 'connection_id', record, encoded);
          prepare(`INSERT INTO connections(id,provider_definition_id,revision,record) VALUES(?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`).run(record.id, record.providerDefinitionId, record.revision, encoded);
        }
        for (const { record, expectedRevision } of change.configurations ?? []) {
          const current = configuration(record.id); validateVersion(record, current, expectedRevision);
          if (!current && prepare('SELECT 1 FROM configuration_versions WHERE configuration_id=? LIMIT 1').get(record.id)) throw modelsError('conflict');
          if (current && (record.connectionId !== current.connectionId || record.modelDefinitionId !== current.modelDefinitionId || record.baseline !== current.baseline)) throw modelsError('invalid-config');
          const owner = connection(record.connectionId), definition = model(record.modelDefinitionId);
          if (!owner || !definition) throw modelsError('not-found');
          if (owner.providerDefinitionId !== definition.providerId) throw modelsError('invalid-config');
          const pinned = one<Model>('SELECT record FROM model_definition_versions WHERE version_id=?', record.modelDefinitionVersionId);
          if (!pinned || pinned.id !== record.modelDefinitionId || pinned.remoteModelId !== record.remoteModelId) throw modelsError('invalid-config');
          if (record.baseline) {
            const existing = prepare('SELECT id FROM configurations WHERE connection_id=? AND model_definition_id=? AND baseline=1')
              .get(record.connectionId, record.modelDefinitionId);
            if (existing && existing.id !== record.id) throw modelsError('conflict');
          }
          const encoded = JSON.stringify(record); version('configuration_versions', 'configuration_id', record, encoded);
          prepare(`INSERT INTO configurations(id,connection_id,model_definition_id,baseline,revision,record) VALUES(?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
            .run(record.id, record.connectionId, record.modelDefinitionId, record.baseline ? 1 : 0, record.revision, encoded);
        }
        for (const record of change.sources ?? []) prepare('INSERT INTO sources(source_id,record) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET record=excluded.record')
          .run(record.sourceId, JSON.stringify(record));
        for (const record of change.syncStates ?? []) {
          if (!connection(record.connectionId)) throw modelsError('not-found');
          prepare('INSERT INTO connection_sync_states(connection_id,record) VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET record=excluded.record')
            .run(record.connectionId, JSON.stringify(record));
        }
        for (const record of change.addIntents ?? []) prepare('INSERT INTO credential_intents(id,record) VALUES(?,?)').run(record.id, JSON.stringify(record));
        for (const id of change.removeIntentIds ?? []) prepare('DELETE FROM credential_intents WHERE id=?').run(id);
        if (change.deleteConnection) {
          const { id, expectedRevision } = change.deleteConnection, current = connection(id);
          if (!current) throw modelsError('not-found');
          if (current.revision !== expectedRevision) throw modelsError('conflict');
          // Immutable versions remain available to historical snapshots; remove only current rows.
          prepare('DELETE FROM configurations WHERE connection_id=?').run(id);
          prepare('DELETE FROM connection_sync_states WHERE connection_id=?').run(id);
          prepare('DELETE FROM connections WHERE id=?').run(id);
        }
        db.exec('COMMIT');
      } catch (error) {
        if (begun) { try { db.exec('ROLLBACK'); } catch { throw modelsError('storage-unavailable'); } }
        throw normalizeError(error, 'storage-unavailable');
      }
    };
    const service: ModelsStore = {
      providers() { assertOpen(); return many('SELECT record FROM provider_definitions ORDER BY id'); },
      provider(id) { assertOpen(); return provider(id); },
      providerHistory(id) { assertOpen(); return many('SELECT record FROM provider_definition_versions WHERE provider_id=? ORDER BY revision', [id]); },
      models() { assertOpen(); return many('SELECT record FROM model_definitions ORDER BY id'); },
      model(id) { assertOpen(); return model(id); },
      modelHistory(id) { assertOpen(); return many('SELECT record FROM model_definition_versions WHERE model_id=? ORDER BY revision', [id]); },
      connections() { assertOpen(); return many('SELECT record FROM connections ORDER BY id'); },
      connection(id) { assertOpen(); return connection(id); },
      connectionHistory(id) { assertOpen(); return many('SELECT record FROM connection_versions WHERE connection_id=? ORDER BY revision', [id]); },
      configurations() { assertOpen(); return many('SELECT record FROM configurations ORDER BY id'); },
      configuration(id) { assertOpen(); return configuration(id); },
      configurationHistory(id) { assertOpen(); return many<ModelConfiguration & { defaults?: NativeObject }>('SELECT record FROM configuration_versions WHERE configuration_id=? ORDER BY revision', [id]).map(value => {
        if (value.parameters) return value;
        const parent = connection(value.connectionId) ?? one<ProviderConnectionRecord>('SELECT record FROM connection_versions WHERE connection_id=? ORDER BY revision DESC LIMIT 1', value.connectionId);
        const { defaults, ...rest } = value;
        return { ...rest, parameters: migrateLegacyParameters(parent?.protocolId ?? 'unknown', defaults ?? {}, options.legacyParameterConverters) };
      }); },
      sources() { assertOpen(); return many('SELECT record FROM sources ORDER BY source_id'); },
      syncState(id) { assertOpen(); return synced(id); },
      intents() { assertOpen(); return many('SELECT record FROM credential_intents ORDER BY id'); },
      commit(input) {
        let change: StoreChange;
        try {
          assertOpen();
          change = normalizeStoreChange(input);
        } catch (error) { return Promise.reject(normalizeError(error, 'invalid-config')); }
        const result = tail.then(() => commit(change)); tail = result.then(() => {}, () => {}); return result;
      },
    };
    ctx.effect(() => async () => { accepting = false; await tail; try { db.close(); } catch { throw modelsError('cleanup-failure'); } finally { statements.clear(); } },
      'join models storage and release SQLite ownership');
    ctx.provide(modelsStoreServiceKey, service);
  } };
}

/** Finite legacy reader: keeps SQLite exclusive ownership through migration and export. */
export function readModelsSqliteSnapshot(options: ModelsStoreOptions): ModelsJsonSnapshot {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(canonicalPath(options.path));
    initialize(db, options.legacyParameterConverters ?? {});
    const rows = <T>(table: string): T[] => db!.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(String(row.record)) as T);
    const providers = rows<Provider>('provider_definitions').map(providerRecord), models = rows<Model>('model_definitions').map(modelRecord);
    const connections = rows<ProviderConnectionRecord>('connections').map(connectionRecord), configurations = rows<ModelConfiguration>('configurations').map(configurationRecord);
    const epochs = new Map(connections.map(record => [record.id, record.historyScopeEpoch]));
    const connectionHistory = rows<ProviderConnectionRecord>('connection_versions').map(record => {
      let epoch = epochs.get(record.id);
      if (!epoch) { epoch = record.historyScopeEpoch ?? randomUUID(); epochs.set(record.id, epoch); }
      return connectionRecord({ ...record, historyScopeEpoch: record.historyScopeEpoch ?? epoch });
    });
    const configurationHistory = rows<ModelConfiguration & { defaults?: NativeObject }>('configuration_versions').map(record => {
      const parent = connections.find(connection => connection.id === record.connectionId) ?? connectionHistory.filter(connection => connection.id === record.connectionId).sort((a, b) => b.revision - a.revision)[0];
      const { defaults, ...rest } = record;
      return configurationRecord({ ...rest, parameters: record.parameters?.formatVersion === 1 ? record.parameters : migrateLegacyParameters(parent?.protocolId ?? 'unknown', record.parameters?.value ?? defaults ?? {}, options.legacyParameterConverters) });
    });
    // Old SQLite migrations retain original history JSON. Export its read-normalized
    // representation and align the current revision with its migrated current row.
    const align = <T extends Versioned>(archived: T[], current: readonly T[]) => {
      for (const record of current) {
        const index = archived.findIndex(item => item.id === record.id && item.revision === record.revision);
        if (index >= 0) archived[index] = record; else archived.push(record);
      }
      return archived;
    };
    const history = { providers: align(rows<Provider>('provider_definition_versions').map(providerRecord), providers),
      models: align(rows<Model>('model_definition_versions').map(modelRecord), models),
      connections: align(connectionHistory, connections), configurations: align(configurationHistory, configurations) };
    return { schemaVersion: 1, providers, models, connections, configurations,
      sources: rows<SourceState>('sources').map(sourceState), syncStates: rows<ConnectionSyncState>('connection_sync_states').map(syncState),
      credentialIntents: rows<CredentialIntent>('credential_intents').map(intentRecord), history,
      tombstones: { connections: [...new Set(history.connections.filter(record => !connections.some(item => item.id === record.id)).map(record => record.id))],
        configurations: [...new Set(history.configurations.filter(record => !configurations.some(item => item.id === record.id)).map(record => record.id))] } };
  } catch (error) { throw normalizeError(error, 'storage-unavailable'); }
  finally { if (db) try { db.close(); } catch { throw modelsError('cleanup-failure'); } }
}

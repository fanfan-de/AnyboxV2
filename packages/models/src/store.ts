import { migrateLegacyParameters } from './legacy-parameters.js';
import { validateParameters } from './domain.js';
import { intentRecord, legacyConfigurationRecord, legacyConnectionRecord, legacySyncState, modelRecord, modelSettingsRecord, normalizeStoreChange, providerRecord, requiredString, sourceIdentity, sourceState, validateModelSettingsWrite, validateProviderSettingsWrite, validateVersion, versionFields } from './store-domain.js';
import type { LegacyParameterConverter, NativeObject } from './native-types.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Component } from '@nya/core';
import { LegacyModelSettingsConflict, LegacyProviderSettingsConflict, parseModelsJsonSnapshot } from './json-store-domain.js';
import type { ModelsJsonSnapshot, ModelsJsonSnapshotV2 } from './json-store-domain.js';
import type { LegacyConfiguration, LegacyConnectionRecord, LegacyModelConfiguration, LegacySyncState } from './store-domain.js';
import { modelsError, normalizeError } from './errors.js';
import { externalProviderId } from './identity.js';
import { modelsStoreServiceKey } from './types.js';
import type {
  CredentialIntent, DeclaredCapabilities,
  Model, ModelSettings, ModelsStore, Provider, ProviderSettingsRecord, ProviderSyncState, SourceState,
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
function createDefinitionTables(db: DatabaseSync): void {
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
    CREATE TABLE sources (source_id TEXT PRIMARY KEY, record TEXT NOT NULL);
  `);
}
function createLegacySchema(db: DatabaseSync): void {
  createDefinitionTables(db);
  db.exec(`
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
  createLegacySchema(db);
  const rows = <T>(sql: string) => db.prepare(sql).all().map(row => JSON.parse(String(row.record)) as T);
  const legacyProviders = rows<LegacyProvider>('SELECT record FROM legacy_providers ORDER BY id');
  const legacyModels = rows<LegacyModel>('SELECT record FROM legacy_models ORDER BY id');
  const providerVersions = rows<LegacyProvider>('SELECT record FROM legacy_provider_versions ORDER BY provider_id, revision');
  const modelVersions = rows<LegacyModel>('SELECT record FROM legacy_model_versions ORDER BY model_id, revision');
  const definitions = new Map<string, Provider>(), connections = new Map<string, LegacyConnectionRecord>();
  const toConnection = (legacy: LegacyProvider): LegacyConnectionRecord => {
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
    return legacyConnectionRecord({ ...legacy, providerDefinitionId: id, historyScopeEpoch: randomUUID() });
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
  const toConfiguration = (legacy: LegacyModel, definition = toDefinition(legacy)): LegacyConfiguration => legacyConfigurationRecord({
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
function legacySnapshot(db: DatabaseSync, converters: Readonly<Record<string, LegacyParameterConverter>>) {
  const rows = <T>(table: string): T[] => db.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(String(row.record)) as T);
  const providers = rows<Provider>('provider_definitions').map(providerRecord), models = rows<Model>('model_definitions').map(modelRecord);
  const connections = rows<LegacyConnectionRecord>('connections').map(legacyConnectionRecord), configurations = rows<LegacyConfiguration>('configurations').map(legacyConfigurationRecord);
  const epochs = new Map(connections.map(record => [record.id, record.historyScopeEpoch]));
  const connectionHistory = rows<LegacyConnectionRecord>('connection_versions').map(record => {
    let epoch = epochs.get(record.id);
    if (!epoch) { epoch = record.historyScopeEpoch ?? randomUUID(); epochs.set(record.id, epoch); }
    return legacyConnectionRecord({ ...record, historyScopeEpoch: record.historyScopeEpoch ?? epoch });
  });
  const configurationHistory = rows<LegacyConfiguration & { defaults?: NativeObject }>('configuration_versions').map(record => {
    const parent = connections.find(connection => connection.id === record.connectionId) ?? connectionHistory.filter(connection => connection.id === record.connectionId).sort((a, b) => b.revision - a.revision)[0];
    const { defaults, ...rest } = record;
    return legacyConfigurationRecord({ ...rest, parameters: record.parameters?.formatVersion === 1 ? record.parameters : migrateLegacyParameters(parent?.protocolId ?? 'unknown', record.parameters?.value ?? defaults ?? {}, converters) });
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
    sources: rows<SourceState>('sources').map(sourceState), syncStates: rows<LegacySyncState>('connection_sync_states').map(legacySyncState),
    credentialIntents: rows<CredentialIntent>('credential_intents').map(intentRecord), history,
    tombstones: { connections: [...new Set(history.connections.filter(record => !connections.some(item => item.id === record.id)).map(record => record.id))],
      configurations: [...new Set(history.configurations.filter(record => !configurations.some(item => item.id === record.id)).map(record => record.id))] } };
}

function createProviderSettingsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE provider_settings (id TEXT PRIMARY KEY REFERENCES provider_definitions(id), revision INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE provider_settings_versions (provider_id TEXT NOT NULL REFERENCES provider_definitions(id), revision INTEGER NOT NULL,
      version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY(provider_id,revision));
    CREATE TABLE retired_provider_settings (version_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE provider_sync_states (provider_id TEXT PRIMARY KEY REFERENCES provider_settings(id), record TEXT NOT NULL);
  `);
}
function createModelSettingsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE model_settings (id TEXT PRIMARY KEY REFERENCES model_definitions(id), runtime_model_id TEXT NOT NULL UNIQUE,
      provider_id TEXT NOT NULL REFERENCES provider_settings(id), revision INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE TABLE model_settings_versions (model_id TEXT NOT NULL REFERENCES model_definitions(id), runtime_model_id TEXT NOT NULL,
      revision INTEGER NOT NULL, version_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL, PRIMARY KEY (runtime_model_id, revision));
    CREATE INDEX model_settings_version_model ON model_settings_versions(model_id, revision);
  `);
}
function updateLegacyCurrent(db: DatabaseSync, version: number, converters: Readonly<Record<string, LegacyParameterConverter>>): void {
  const connections = new Map<string, LegacyConnectionRecord>();
  for (const row of db.prepare('SELECT record FROM connections').all()) {
    const record = JSON.parse(String(row.record)) as LegacyConnectionRecord;
    if (version === 3 && !record.historyScopeEpoch) throw modelsError('storage-unavailable');
    const next = { ...record, historyScopeEpoch: record.historyScopeEpoch ?? randomUUID() };
    connections.set(next.id, next);
    if (version !== 3) db.prepare('UPDATE connections SET record=? WHERE id=?').run(JSON.stringify(next), next.id);
  }
  for (const row of db.prepare('SELECT record FROM configurations').all()) {
    const record = JSON.parse(String(row.record)) as LegacyConfiguration & { defaults?: NativeObject };
    const { defaults, ...rest } = record;
    const connection = connections.get(record.connectionId);
    if (!connection) throw modelsError('storage-unavailable');
    const parameters = record.parameters?.formatVersion === 1 ? record.parameters : migrateLegacyParameters(connection.protocolId, record.parameters?.value ?? defaults ?? {}, converters);
    validateParameters(parameters);
    if (!record.parameters || record.parameters.formatVersion !== parameters.formatVersion) {
      db.prepare('UPDATE configurations SET record=? WHERE id=?').run(JSON.stringify({ ...rest, parameters }), record.id);
    }
  }
}
function importProviderSettings(db: DatabaseSync, snapshot: ModelsJsonSnapshot): void {
  createProviderSettingsTables(db);
  for (const record of snapshot.providerSettings) db.prepare('INSERT INTO provider_settings VALUES(?,?,?)')
    .run(record.id, record.revision, JSON.stringify(record));
  for (const record of snapshot.history.providerSettings) db.prepare('INSERT INTO provider_settings_versions VALUES(?,?,?,?)')
    .run(record.id, record.revision, record.versionId, JSON.stringify(record));
  for (const record of snapshot.history.retiredConnections) db.prepare('INSERT INTO retired_provider_settings VALUES(?,?)')
    .run(record.versionId, JSON.stringify(record));
  for (const record of snapshot.syncStates) db.prepare('INSERT INTO provider_sync_states VALUES(?,?)')
    .run(record.providerId, JSON.stringify(record));
  for (const record of snapshot.credentialIntents) db.prepare('UPDATE credential_intents SET record=? WHERE id=?')
    .run(JSON.stringify(record), record.id);
  db.exec(`ALTER TABLE configuration_versions RENAME TO legacy_configuration_versions;
    ALTER TABLE connection_versions RENAME TO legacy_connection_versions;
    DROP TABLE connection_sync_states; DROP TABLE configurations; DROP TABLE connections;`);
}
function importModelSettings(db: DatabaseSync, snapshot: ModelsJsonSnapshot): void {
  createModelSettingsTables(db);
  const insert = db.prepare('INSERT INTO model_settings VALUES(?,?,?,?,?)');
  for (const record of snapshot.modelSettings) insert.run(record.id, record.runtimeModelId, record.providerId, record.revision, JSON.stringify(record));
  const version = db.prepare('INSERT INTO model_settings_versions VALUES(?,?,?,?,?)');
  for (const record of snapshot.history.modelSettings) version.run(record.id, record.runtimeModelId, record.revision, record.versionId, JSON.stringify(record));
}
function upgradeProviderParameters(db: DatabaseSync, converters: Readonly<Record<string, LegacyParameterConverter>>): void {
  for (const row of db.prepare('SELECT record FROM model_settings').all()) {
    const record = JSON.parse(String(row.record)) as ModelSettings;
    if (record.parameters.formatVersion !== 0) continue;
    const parameters = migrateLegacyParameters(record.parameters.protocolId, record.parameters.value, converters);
    if (parameters.formatVersion !== 1) continue;
    const upgraded = modelSettingsRecord({ ...record, parameters, revision: record.revision + 1, versionId: randomUUID(), updatedAt: new Date().toISOString() });
    const encoded = JSON.stringify(upgraded);
    db.prepare('INSERT INTO model_settings_versions VALUES(?,?,?,?,?)').run(upgraded.id, upgraded.runtimeModelId, upgraded.revision, upgraded.versionId, encoded);
    db.prepare('UPDATE model_settings SET revision=?,record=? WHERE id=?').run(upgraded.revision, encoded, upgraded.id);
  }
}
function currentSnapshot(db: DatabaseSync, schema: 2): ModelsJsonSnapshotV2;
function currentSnapshot(db: DatabaseSync, schema: 3): ModelsJsonSnapshot;
function currentSnapshot(db: DatabaseSync, schema: 2 | 3): ModelsJsonSnapshotV2 | ModelsJsonSnapshot {
  const rows = <T>(table: string): T[] => db.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(String(row.record)) as T);
  const providerSettings = rows<ProviderSettingsRecord>('provider_settings');
  const history = {
    providers: rows<Provider>('provider_definition_versions'), models: rows<Model>('model_definition_versions'),
    providerSettings: rows<ProviderSettingsRecord>('provider_settings_versions'),
    retiredConnections: rows<LegacyConnectionRecord>('retired_provider_settings'),
  };
  const removed = <T extends Versioned>(current: readonly T[], versions: readonly T[], key: (record: T) => string = record => record.id) => {
    const active = new Set(current.map(key));
    return [...new Set(versions.map(key).filter(id => !active.has(id)))];
  };
  const base = { providers: rows<Provider>('provider_definitions'), models: rows<Model>('model_definitions'), providerSettings,
    sources: rows<SourceState>('sources'), syncStates: rows<ProviderSyncState>('provider_sync_states'), credentialIntents: rows<CredentialIntent>('credential_intents') };
  const retiredProviders = removed(providerSettings, history.providerSettings);
  if (schema === 2) {
    const configurations = rows<LegacyModelConfiguration>('model_configurations');
    const versions = rows<LegacyModelConfiguration>('model_configuration_versions');
    return { ...base, schemaVersion: 2, configurations, history: { ...history, configurations: versions },
      tombstones: { providerSettings: retiredProviders, configurations: removed(configurations, versions) } };
  }
  const modelSettings = rows<ModelSettings>('model_settings'), versions = rows<ModelSettings>('model_settings_versions');
  return { ...base, schemaVersion: 3, modelSettings, history: { ...history, modelSettings: versions },
    tombstones: { providerSettings: retiredProviders, modelSettings: removed(modelSettings, versions, record => record.runtimeModelId) } };
}
function initialize(db: DatabaseSync, converters: Readonly<Record<string, LegacyParameterConverter>>, readSnapshot = false): ModelsJsonSnapshot | undefined {
  // EXCLUSIVE mode retains the OS lock between commits; process death releases it.
  db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    let snapshot: ModelsJsonSnapshot | undefined;
    const decisions = { now: new Date().toISOString(), versionId: () => randomUUID(), historyScopeEpoch: () => randomUUID() };
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) throw modelsError('storage-unavailable');
      createDefinitionTables(db);
      createProviderSettingsTables(db);
      createModelSettingsTables(db);
      db.exec('CREATE TABLE credential_intents(id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    } else if (version === 1 || version === 2 || version === 3) {
      if (version === 1) migrateV1(db, converters);
      updateLegacyCurrent(db, version, converters);
      snapshot = parseModelsJsonSnapshot(legacySnapshot(db, converters), decisions).snapshot;
      if (!readSnapshot) { importProviderSettings(db, snapshot); importModelSettings(db, snapshot); }
    } else if (version === 4) {
      snapshot = parseModelsJsonSnapshot(currentSnapshot(db, 2), decisions).snapshot;
      if (!readSnapshot) {
        importModelSettings(db, snapshot);
        db.exec('DROP TABLE model_configurations; DROP TABLE model_configuration_versions');
      }
    } else if (version !== 5) throw modelsError('storage-unavailable');
    if (readSnapshot) {
      snapshot ??= currentSnapshot(db, 3);
      db.exec('ROLLBACK');
    } else {
      upgradeProviderParameters(db, converters);
      db.exec('PRAGMA user_version=5; COMMIT');
    }
    return snapshot;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { throw modelsError('storage-unavailable'); }
    throw error;
  }
}

/** Owns definitions, provider and model settings, and their exclusive SQLite migration. */
export function createModelsStoreComponent(options: ModelsStoreOptions): Component.Object<void> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:') throw modelsError('invalid-config');
  return { name: 'models-store', apply(ctx) {
    let db: DatabaseSync;
    try { db = new DatabaseSync(canonicalPath(options.path)); } catch { throw modelsError('storage-unavailable'); }
    try { initialize(db, options.legacyParameterConverters ?? {}); } catch (error) {
      try { db.close(); } catch { /* Already failed initialization. */ }
      throw error instanceof LegacyProviderSettingsConflict || error instanceof LegacyModelSettingsConflict ? error : modelsError('storage-unavailable');
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
    const providerSettings = (id: string) => one<ProviderSettingsRecord>('SELECT record FROM provider_settings WHERE id=?', id);
    const modelSettings = (id: string) => one<ModelSettings>('SELECT record FROM model_settings WHERE id=?', id);
    const modelRuntimeIdExists = (id: string) => prepare('SELECT 1 FROM model_settings_versions WHERE runtime_model_id=? LIMIT 1').get(id) !== undefined;
    const synced = (id: string) => one<ProviderSyncState>('SELECT record FROM provider_sync_states WHERE provider_id=?', id);
    const version = (table: string, key: string, record: Versioned, encoded: string) => {
      prepare(`INSERT INTO ${table}(${key},revision,version_id,record) VALUES(?,?,?,?)`).run(record.id, record.revision, record.versionId, encoded);
    };
    const commit = (change: StoreChange) => {
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        for (const guard of change.syncGuards ?? []) {
          if ((synced(guard.providerId)?.targetSourceVersion ?? null) !== guard.targetSourceVersion) throw modelsError('conflict');
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
        if (change.providerSettings) {
          const { record, expectedRevision } = change.providerSettings, current = providerSettings(record.id);
          if (change.deleteProviderSettings) throw modelsError('invalid-config');
          const latest = one<ProviderSettingsRecord>('SELECT record FROM provider_settings_versions WHERE provider_id=? ORDER BY revision DESC LIMIT 1', record.id);
          validateProviderSettingsWrite(record, current, latest, expectedRevision);
          if (!provider(record.id)) throw modelsError('not-found');
          const encoded = JSON.stringify(record); version('provider_settings_versions', 'provider_id', record, encoded);
          prepare(`INSERT INTO provider_settings(id,revision,record) VALUES(?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`).run(record.id, record.revision, encoded);
        }
        for (const { record, expectedRevision } of change.modelSettings ?? []) {
          const current = modelSettings(record.id);
          const latest = current ?? one<ModelSettings>('SELECT record FROM model_settings_versions WHERE model_id=? ORDER BY revision DESC LIMIT 1', record.id);
          validateModelSettingsWrite(record, current, latest?.revision, expectedRevision);
          if (!current && modelRuntimeIdExists(record.runtimeModelId)) throw modelsError('conflict');
          const owner = providerSettings(record.providerId), definition = model(record.id);
          if (!owner || !definition) throw modelsError('not-found');
          if (owner.id !== definition.providerId) throw modelsError('invalid-config');
          const pinned = one<Model>('SELECT record FROM model_definition_versions WHERE version_id=?', record.modelDefinitionVersionId);
          if (!pinned || pinned.id !== record.id || pinned.remoteModelId !== record.remoteModelId) throw modelsError('invalid-config');
          const encoded = JSON.stringify(record);
          prepare('INSERT INTO model_settings_versions(model_id,runtime_model_id,revision,version_id,record) VALUES(?,?,?,?,?)')
            .run(record.id, record.runtimeModelId, record.revision, record.versionId, encoded);
          prepare(`INSERT INTO model_settings(id,runtime_model_id,provider_id,revision,record) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
            .run(record.id, record.runtimeModelId, record.providerId, record.revision, encoded);
        }
        for (const record of change.sources ?? []) prepare('INSERT INTO sources(source_id,record) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET record=excluded.record')
          .run(record.sourceId, JSON.stringify(record));
        for (const record of change.syncStates ?? []) {
          if (!providerSettings(record.providerId)) throw modelsError('not-found');
          prepare('INSERT INTO provider_sync_states(provider_id,record) VALUES(?,?) ON CONFLICT(provider_id) DO UPDATE SET record=excluded.record')
            .run(record.providerId, JSON.stringify(record));
        }
        for (const record of change.addIntents ?? []) prepare('INSERT INTO credential_intents(id,record) VALUES(?,?)').run(record.id, JSON.stringify(record));
        for (const id of change.removeIntentIds ?? []) prepare('DELETE FROM credential_intents WHERE id=?').run(id);
        if (change.deleteProviderSettings) {
          const { id, expectedRevision } = change.deleteProviderSettings, current = providerSettings(id);
          if (!current) throw modelsError('not-found');
          if (current.revision !== expectedRevision) throw modelsError('conflict');
          // Immutable versions remain available to historical snapshots; remove only current rows.
          prepare('DELETE FROM model_settings WHERE provider_id=?').run(id);
          prepare('DELETE FROM provider_sync_states WHERE provider_id=?').run(id);
          prepare('DELETE FROM provider_settings WHERE id=?').run(id);
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
      configuredProviders() { assertOpen(); return many('SELECT record FROM provider_settings ORDER BY id'); },
      providerSettings(id) { assertOpen(); return providerSettings(id); },
      providerSettingsHistory(id) { assertOpen(); return many('SELECT record FROM provider_settings_versions WHERE provider_id=? ORDER BY revision', [id]); },
      configuredModels() { assertOpen(); return many('SELECT record FROM model_settings ORDER BY id'); },
      modelSettings(id) { assertOpen(); return modelSettings(id); },
      runtimeModelSettings(id) { assertOpen(); return one('SELECT record FROM model_settings WHERE runtime_model_id=?', id); },
      modelSettingsHistory(id) { assertOpen(); return many('SELECT record FROM model_settings_versions WHERE model_id=? ORDER BY revision', [id]); },
      modelRuntimeIdExists(id) { assertOpen(); return modelRuntimeIdExists(id); },
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

/** Read a one-time JSON import snapshot without publishing changes to the source database. */
export function readModelsSqliteSnapshot(options: ModelsStoreOptions): ModelsJsonSnapshot {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(canonicalPath(options.path));
    return initialize(db, options.legacyParameterConverters ?? {}, true)!;
  } catch (error) {
    throw error instanceof LegacyProviderSettingsConflict || error instanceof LegacyModelSettingsConflict ? error : normalizeError(error, 'storage-unavailable');
  } finally {
    if (db) try { db.close(); } catch { throw modelsError('cleanup-failure'); }
  }
}

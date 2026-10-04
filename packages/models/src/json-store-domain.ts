import { modelsError } from './errors.js';
import { equalJson, configurationInput, connectionInput, modelInput, providerInput, validateConfiguration, validateConnection, validateModel, validateProvider } from './domain.js';
import { configurationRecord, connectionRecord, intentRecord, modelRecord, providerRecord, sourceIdentity, sourceState, syncState, validateVersion } from './store-domain.js';
import type { ConnectionSyncState, CredentialIntent, Model, ModelConfiguration, Provider, ProviderConnectionRecord, SourceState, StoreChange, Versioned } from './types.js';

/** Current arrays are editable; history and tombstones are the immutable identity ledger. */
export interface ModelsJsonSnapshot {
  readonly schemaVersion: 1;
  readonly providers: readonly Provider[];
  readonly models: readonly Model[];
  readonly connections: readonly ProviderConnectionRecord[];
  readonly configurations: readonly ModelConfiguration[];
  readonly sources: readonly SourceState[];
  readonly syncStates: readonly ConnectionSyncState[];
  readonly credentialIntents: readonly CredentialIntent[];
  readonly history: {
    readonly providers: readonly Provider[];
    readonly models: readonly Model[];
    readonly connections: readonly ProviderConnectionRecord[];
    readonly configurations: readonly ModelConfiguration[];
  };
  readonly tombstones: { readonly connections: readonly string[]; readonly configurations: readonly string[] };
}
export function emptyModelsJsonSnapshot(): ModelsJsonSnapshot {
  return { schemaVersion: 1, providers: [], models: [], connections: [], configurations: [], sources: [], syncStates: [], credentialIntents: [],
    history: { providers: [], models: [], connections: [], configurations: [] }, tombstones: { connections: [], configurations: [] } };
}
const same = equalJson;
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) throw modelsError('invalid-config');
}
function records<T>(value: unknown, normalize: (record: T) => T): T[] {
  if (!Array.isArray(value)) throw modelsError('invalid-config');
  return value.map(item => {
    const record = normalize(item as T);
    if (!same(item, record)) throw modelsError('invalid-config');
    return record;
  });
}
function unique<T>(values: readonly T[], key: (value: T) => string): void {
  const seen = new Set<string>();
  for (const value of values) { const id = key(value); if (seen.has(id)) throw modelsError('conflict'); seen.add(id); }
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw modelsError('invalid-config');
  unique(value, id => id as string); return value as string[];
}
function latestById<T extends Versioned>(records: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) if ((result.get(record.id)?.revision ?? 0) < record.revision) result.set(record.id, record);
  return result;
}
export interface ModelsJsonEditDecisions {
  readonly now: string;
  readonly versionId: (id: string, revision: number) => string;
  readonly historyScopeEpoch: (connectionId: string) => string;
}
function assertFieldsEqual(record: Versioned, previous: Versioned, fields: readonly string[]): void {
  for (const field of fields) if (!same((record as unknown as Record<string, unknown>)[field], (previous as unknown as Record<string, unknown>)[field])) throw modelsError('invalid-config');
}
const versionKeys = ['id', 'revision', 'versionId', 'createdAt', 'updatedAt'] as const;
const connectionIdentity = ['providerDefinitionId', 'protocolId'] as const;
const configurationIdentity = ['modelDefinitionId', 'modelDefinitionVersionId', 'connectionId', 'baseline', 'remoteModelId'] as const;
function validateHistory<T extends Versioned>(records: readonly T[], immutable: readonly string[]): void {
  unique(records, record => record.versionId); unique(records, record => `${record.id}:${record.revision}`);
  const first = new Map<string, T>();
  for (const record of records) {
    const previous = first.get(record.id);
    if (previous) assertFieldsEqual(record, previous, ['createdAt', ...immutable]);
    else first.set(record.id, record);
  }
}
function reconcile<T extends Versioned>(current: readonly T[], history: readonly T[], immutable: readonly string[], decisions: ModelsJsonEditDecisions,
  revise?: (record: T, previous: T) => T): { current: T[]; history: T[]; changed: boolean } {
  unique(current, record => record.id);
  const nextHistory = [...history], latest = latestById(history); let changed = false;
  const next = current.map(record => {
    const previous = latest.get(record.id);
    if (!previous) throw modelsError('invalid-config');
    if (same(record, previous)) return record;
    assertFieldsEqual(record, previous, [...versionKeys, ...immutable]);
    const revised = { ...(revise ? revise(record, previous) : record), revision: previous.revision + 1, versionId: decisions.versionId(record.id, previous.revision + 1), updatedAt: decisions.now };
    nextHistory.push(revised); changed = true; return revised;
  });
  return { current: next, history: nextHistory, changed };
}
function validateSnapshot(snapshot: ModelsJsonSnapshot): void {
  unique(snapshot.providers, record => record.id); unique(snapshot.models, record => record.id);
  unique(snapshot.connections, record => record.id); unique(snapshot.configurations, record => record.id);
  unique(snapshot.sources, record => record.sourceId); unique(snapshot.syncStates, record => record.connectionId); unique(snapshot.credentialIntents, record => record.id);
  validateHistory(snapshot.history.providers, []);
  // sourceVersion is allowed to evolve; the namespace and original IDs remain fixed.
  for (const records of [snapshot.history.providers, snapshot.history.models]) {
    const sourceById = new Map<string, string>();
    for (const record of records) {
      const identity = sourceIdentity(record.source), previous = sourceById.get(record.id);
      if (previous !== undefined && previous !== identity) throw modelsError('invalid-config');
      sourceById.set(record.id, identity);
    }
  }
  validateHistory(snapshot.history.models, ['providerId']); validateHistory(snapshot.history.connections, connectionIdentity);
  validateHistory(snapshot.history.configurations, ['modelDefinitionId', 'connectionId', 'baseline']);
  for (const [current, history, tombstones] of [
    [snapshot.providers, snapshot.history.providers, []], [snapshot.models, snapshot.history.models, []],
    [snapshot.connections, snapshot.history.connections, snapshot.tombstones.connections],
    [snapshot.configurations, snapshot.history.configurations, snapshot.tombstones.configurations],
  ] as readonly [readonly Versioned[], readonly Versioned[], readonly string[]][]) {
    const latest = latestById(history), currentIds = new Set(current.map(record => record.id)), deletedIds = new Set(tombstones);
    for (const record of current) if (!same(latest.get(record.id), record) || deletedIds.has(record.id)) throw modelsError('invalid-config');
    for (const id of latest.keys()) if (!currentIds.has(id) && !deletedIds.has(id)) throw modelsError('invalid-config');
    for (const id of tombstones) if (!latest.has(id)) throw modelsError('invalid-config');
  }
  const providers = new Map(snapshot.providers.map(record => [record.id, record]));
  const connections = new Map(snapshot.connections.map(record => [record.id, record]));
  const models = new Map(snapshot.models.map(record => [record.id, record]));
  unique(snapshot.providers.filter(record => record.source.kind === 'external'), record => sourceIdentity(record.source));
  unique(snapshot.models.filter(record => record.source.kind === 'external'), record => sourceIdentity(record.source));
  for (const record of snapshot.history.models) {
    const parent = providers.get(record.providerId);
    if (!parent) throw modelsError('not-found');
    if (record.source.kind === 'external' && (parent.source.kind !== 'external' || parent.source.sourceId !== record.source.sourceId || parent.source.providerId !== record.source.providerId)) throw modelsError('invalid-config');
  }
  for (const record of snapshot.history.connections) if (!providers.has(record.providerDefinitionId)) throw modelsError('not-found');
  unique(snapshot.configurations.filter(record => record.baseline), record => JSON.stringify([record.connectionId, record.modelDefinitionId]));
  const connectionVersions = latestById(snapshot.history.connections), modelVersions = new Map(snapshot.history.models.map(record => [record.versionId, record]));
  for (const record of snapshot.history.configurations) {
    const connection = connectionVersions.get(record.connectionId), definition = models.get(record.modelDefinitionId);
    const pinned = modelVersions.get(record.modelDefinitionVersionId);
    if (!connection || !definition || !pinned) throw modelsError('not-found');
    if (connection.providerDefinitionId !== definition.providerId || pinned.id !== record.modelDefinitionId || pinned.remoteModelId !== record.remoteModelId) throw modelsError('invalid-config');
  }
  for (const record of snapshot.configurations) if (!connections.has(record.connectionId)) throw modelsError('not-found');
  for (const record of snapshot.syncStates) if (!connections.has(record.connectionId)) throw modelsError('not-found');
}

/** Accept only stopped-process edits of mutable current fields, preserving the identity ledger. */
export function parseModelsJsonSnapshot(input: unknown, decisions: ModelsJsonEditDecisions): { snapshot: ModelsJsonSnapshot; changed: boolean } {
  object(input, ['schemaVersion', 'providers', 'models', 'connections', 'configurations', 'sources', 'syncStates', 'credentialIntents', 'history', 'tombstones']);
  if (input.schemaVersion !== 1) throw modelsError('invalid-config');
  object(input.history, ['providers', 'models', 'connections', 'configurations']); object(input.tombstones, ['connections', 'configurations']);
  const history = { providers: records(input.history.providers, providerRecord), models: records(input.history.models, modelRecord),
    connections: records(input.history.connections, connectionRecord), configurations: records(input.history.configurations, configurationRecord) };
  const providers = reconcile(records(input.providers, providerRecord), history.providers, ['source', 'state'], decisions, record => { validateProvider(providerInput(record)); return record; });
  const models = reconcile(records(input.models, modelRecord), history.models, ['providerId', 'source', 'state'], decisions, record => { validateModel(modelInput(record)); return record; });
  const connections = reconcile(records(input.connections, connectionRecord), history.connections, [...connectionIdentity, 'credentialRef', 'historyScopeEpoch'], decisions,
    (record, previous) => { validateConnection(connectionInput(record)); return record.baseUrl !== previous.baseUrl || record.auth !== previous.auth ? { ...record, historyScopeEpoch: decisions.historyScopeEpoch(record.id) } : record; });
  const configurations = reconcile(records(input.configurations, configurationRecord), history.configurations, configurationIdentity, decisions, (record, previous) => {
    if (!same(record.parameters, previous.parameters) && record.parameters.formatVersion !== 1) throw modelsError('invalid-config');
    validateConfiguration({ ...configurationInput(record), parameters: { ...record.parameters, formatVersion: 1 } }); return record;
  });
  const snapshot: ModelsJsonSnapshot = { schemaVersion: 1, providers: providers.current, models: models.current, connections: connections.current, configurations: configurations.current,
    sources: records(input.sources, sourceState), syncStates: records(input.syncStates, syncState), credentialIntents: records(input.credentialIntents, intentRecord),
    history: { providers: providers.history, models: models.history, connections: connections.history, configurations: configurations.history },
    tombstones: { connections: ids(input.tombstones.connections), configurations: ids(input.tombstones.configurations) } };
  validateSnapshot(snapshot);
  return { snapshot, changed: providers.changed || models.changed || connections.changed || configurations.changed };
}

/** Atomic in-memory candidate; publication belongs to the persistence adapter. */
export function applyModelsJsonChange(snapshot: ModelsJsonSnapshot, change: StoreChange): ModelsJsonSnapshot {
  const next = structuredClone(snapshot) as { -readonly [K in keyof ModelsJsonSnapshot]: ModelsJsonSnapshot[K] };
  const providers = [...next.providers], models = [...next.models], connections = [...next.connections], configurations = [...next.configurations];
  const history = { providers: [...next.history.providers], models: [...next.history.models], connections: [...next.history.connections], configurations: [...next.history.configurations] };
  const sources = [...next.sources], syncStates = [...next.syncStates], credentialIntents = [...next.credentialIntents];
  const tombstones = { connections: [...next.tombstones.connections], configurations: [...next.tombstones.configurations] };
  const putter = <T>(items: T[], key: (value: T) => string) => {
    const indexes = new Map(items.map((item, index) => [key(item), index]));
    return (record: T) => { const id = key(record), index = indexes.get(id); if (index === undefined) { indexes.set(id, items.length); items.push(record); } else items[index] = record; };
  };
  const synced = new Map(syncStates.map(record => [record.connectionId, record]));
  for (const guard of change.syncGuards ?? []) if ((synced.get(guard.connectionId)?.targetSourceVersion ?? null) !== guard.targetSourceVersion) throw modelsError('conflict');
  const write = <T extends Versioned>(items: T[], archived: T[], updates: readonly { readonly record: T; readonly expectedRevision: number | null }[], immutable: readonly string[], forbidReuse = false) => {
    const currentById = new Map(items.map(record => [record.id, record])), archivedIds = new Set(archived.map(record => record.id)), put = putter(items, record => record.id);
    for (const { record, expectedRevision } of updates) {
      const current = currentById.get(record.id); validateVersion(record, current, expectedRevision);
      if (!current && forbidReuse && archivedIds.has(record.id)) throw modelsError('conflict');
      if (current) assertFieldsEqual(record, current, immutable);
      archived.push(record); archivedIds.add(record.id); put(record); currentById.set(record.id, record);
    }
  };
  const existingProviders = new Map(providers.map(record => [record.id, record]));
  for (const { record } of change.providers ?? []) {
    const current = existingProviders.get(record.id);
    if (current && sourceIdentity(record.source) !== sourceIdentity(current.source)) throw modelsError('invalid-config');
  }
  write(providers, history.providers, change.providers ?? [], []);
  const existingModels = new Map(models.map(record => [record.id, record]));
  for (const { record } of change.models ?? []) {
    const current = existingModels.get(record.id);
    if (current && sourceIdentity(record.source) !== sourceIdentity(current.source)) throw modelsError('invalid-config');
  }
  write(models, history.models, change.models ?? [], ['providerId']);
  write(connections, history.connections, change.connection ? [change.connection] : [], connectionIdentity, true);
  write(configurations, history.configurations, change.configurations ?? [], ['modelDefinitionId', 'connectionId', 'baseline'], true);
  const putSource = putter(sources, record => record.sourceId), putSync = putter(syncStates, record => record.connectionId);
  for (const record of change.sources ?? []) putSource(record);
  for (const record of change.syncStates ?? []) putSync(record);
  const intentIds = new Set(credentialIntents.map(record => record.id));
  for (const record of change.addIntents ?? []) {
    if (intentIds.has(record.id)) throw modelsError('conflict'); credentialIntents.push(record); intentIds.add(record.id);
  }
  const removedIntents = new Set(change.removeIntentIds ?? []);
  for (let i = credentialIntents.length - 1; i >= 0; i--) if (removedIntents.has(credentialIntents[i].id)) credentialIntents.splice(i, 1);
  if (change.deleteConnection) {
    const { id, expectedRevision } = change.deleteConnection, current = connections.find(item => item.id === id);
    if (!current) throw modelsError('not-found'); if (current.revision !== expectedRevision) throw modelsError('conflict');
    tombstones.connections.push(id);
    for (let i = configurations.length - 1; i >= 0; i--) if (configurations[i].connectionId === id) { tombstones.configurations.push(configurations[i].id); configurations.splice(i, 1); }
    connections.splice(connections.indexOf(current), 1);
    for (let i = syncStates.length - 1; i >= 0; i--) if (syncStates[i].connectionId === id) syncStates.splice(i, 1);
  }
  const result: ModelsJsonSnapshot = { ...next, providers, models, connections, configurations, history, sources, syncStates, credentialIntents, tombstones };
  validateSnapshot(result); return result;
}

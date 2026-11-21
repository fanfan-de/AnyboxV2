import { modelsError } from './errors.js';
import { equalJson, modelInput, modelSettingsInput, providerInput, providerSettingsInput, validateModel, validateModelSettings, validateProvider, validateProviderSettings } from './domain.js';
import { configurationRecord, intentRecord, legacyConfigurationRecord, legacyConnectionRecord, legacySyncState, modelRecord, modelSettingsIdentity, modelSettingsRecord, providerRecord, providerSettingsRecord, sourceIdentity, sourceState, syncState, validateModelSettingsWrite, validateProviderSettingsWrite, validateVersion } from './store-domain.js';
import type { CredentialIntent, Model, ModelSettings, Provider, ProviderSettingsRecord, ProviderSyncState, SourceState, StoreChange, Versioned } from './types.js';

import type { LegacyConfiguration, LegacyConnectionRecord, LegacyModelConfiguration, LegacySyncState } from './store-domain.js';

/** Current arrays are editable; history and tombstones are the immutable identity ledger. */
export interface ModelsJsonSnapshot {
  readonly schemaVersion: 3;
  readonly providers: readonly Provider[];
  readonly models: readonly Model[];
  readonly providerSettings: readonly ProviderSettingsRecord[];
  readonly modelSettings: readonly ModelSettings[];
  readonly sources: readonly SourceState[];
  readonly syncStates: readonly ProviderSyncState[];
  readonly credentialIntents: readonly CredentialIntent[];
  readonly history: {
    readonly providers: readonly Provider[];
    readonly models: readonly Model[];
    readonly providerSettings: readonly ProviderSettingsRecord[];
    readonly retiredConnections: readonly LegacyConnectionRecord[];
    readonly modelSettings: readonly ModelSettings[];
  };
  readonly tombstones: { readonly providerSettings: readonly string[]; readonly modelSettings: readonly string[] };
}
export interface ModelsJsonSnapshotV2 extends Omit<ModelsJsonSnapshot, 'schemaVersion' | 'modelSettings' | 'history' | 'tombstones'> {
  readonly schemaVersion: 2;
  readonly configurations: readonly LegacyModelConfiguration[];
  readonly history: Omit<ModelsJsonSnapshot['history'], 'modelSettings'> & { readonly configurations: readonly LegacyModelConfiguration[] };
  readonly tombstones: { readonly providerSettings: readonly string[]; readonly configurations: readonly string[] };
}
export function emptyModelsJsonSnapshot(): ModelsJsonSnapshot {
  return { schemaVersion: 3, providers: [], models: [], providerSettings: [], modelSettings: [], sources: [], syncStates: [], credentialIntents: [],
    history: { providers: [], models: [], providerSettings: [], retiredConnections: [], modelSettings: [] }, tombstones: { providerSettings: [], modelSettings: [] } };
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
function latestById<T extends Versioned>(records: readonly T[], key: (record: T) => string = record => record.id): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const id = key(record);
    if ((result.get(id)?.revision ?? 0) < record.revision) result.set(id, record);
  }
  return result;
}
export interface ModelsJsonEditDecisions {
  readonly now: string;
  readonly versionId: (id: string, revision: number) => string;
  readonly historyScopeEpoch: (providerId: string) => string;
}
function assertFieldsEqual(record: Versioned, previous: Versioned, fields: readonly string[]): void {
  for (const field of fields) if (!same((record as unknown as Record<string, unknown>)[field], (previous as unknown as Record<string, unknown>)[field])) throw modelsError('invalid-config');
}
const versionKeys = ['id', 'revision', 'versionId', 'createdAt', 'updatedAt'] as const;
const settingsIdentity = ['protocolId', 'restoreScopeId'] as const;
const configurationIdentity = ['modelDefinitionId', 'modelDefinitionVersionId', 'providerId', 'baseline', 'remoteModelId'] as const;
function validateHistory<T extends Versioned>(records: readonly T[], immutable: readonly string[], key: (record: T) => string = record => record.id): void {
  unique(records, record => record.versionId); unique(records, record => `${key(record)}:${record.revision}`);
  const first = new Map<string, T>();
  for (const record of records) {
    const id = key(record), previous = first.get(id);
    if (previous) assertFieldsEqual(record, previous, ['createdAt', ...immutable]);
    else first.set(id, record);
  }
}
function reconcile<T extends Versioned>(current: readonly T[], history: readonly T[], immutable: readonly string[], decisions: ModelsJsonEditDecisions,
  revise?: (record: T, previous: T) => T, key: (record: T) => string = record => record.id): { current: T[]; history: T[]; changed: boolean } {
  unique(current, record => record.id);
  const nextHistory = [...history], latest = latestById(history, key); let changed = false;
  const next = current.map(record => {
    const previous = latest.get(key(record));
    if (!previous) throw modelsError('invalid-config');
    if (same(record, previous)) return record;
    assertFieldsEqual(record, previous, [...versionKeys, ...immutable]);
    const revised = { ...(revise ? revise(record, previous) : record), revision: previous.revision + 1, versionId: decisions.versionId(record.id, previous.revision + 1), updatedAt: decisions.now };
    nextHistory.push(revised); changed = true; return revised;
  });
  return { current: next, history: nextHistory, changed };
}
function validateCurrent<T extends Versioned>(current: readonly T[], history: readonly T[], tombstones: readonly string[], key: (record: T) => string = record => record.id): void {
  const latest = latestById(history, key), currentIds = new Set(current.map(key)), deletedIds = new Set(tombstones);
  for (const record of current) {
    const id = key(record);
    if (!same(latest.get(id), record) || deletedIds.has(id)) throw modelsError('invalid-config');
  }
  for (const id of latest.keys()) if (!currentIds.has(id) && !deletedIds.has(id)) throw modelsError('invalid-config');
  for (const id of tombstones) if (!latest.has(id)) throw modelsError('invalid-config');
}
function validateSnapshot(snapshot: ModelsJsonSnapshot): void {
  unique(snapshot.providers, record => record.id); unique(snapshot.models, record => record.id);
  unique(snapshot.providerSettings, record => record.id); unique(snapshot.modelSettings, record => record.id);
  unique(snapshot.sources, record => record.sourceId); unique(snapshot.syncStates, record => record.providerId); unique(snapshot.credentialIntents, record => record.id);
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
  validateHistory(snapshot.history.models, ['providerId']); validateHistory(snapshot.history.providerSettings, []);
  validateHistory(snapshot.history.retiredConnections, ['providerDefinitionId', 'protocolId']);
  validateHistory(snapshot.history.modelSettings, ['id', 'providerId'], record => record.runtimeModelId);
  for (const [current, history, tombstones] of [
    [snapshot.providers, snapshot.history.providers, []], [snapshot.models, snapshot.history.models, []],
    [snapshot.providerSettings, snapshot.history.providerSettings, snapshot.tombstones.providerSettings],
  ] as readonly [readonly Versioned[], readonly Versioned[], readonly string[]][]) validateCurrent(current, history, tombstones);
  validateCurrent(snapshot.modelSettings, snapshot.history.modelSettings, snapshot.tombstones.modelSettings, record => record.runtimeModelId);
  const providers = new Map(snapshot.providers.map(record => [record.id, record]));
  const providerSettings = new Map(snapshot.providerSettings.map(record => [record.id, record]));
  const models = new Map(snapshot.models.map(record => [record.id, record]));
  unique(snapshot.providers.filter(record => record.source.kind === 'external'), record => sourceIdentity(record.source));
  unique(snapshot.models.filter(record => record.source.kind === 'external'), record => sourceIdentity(record.source));
  for (const record of snapshot.history.models) {
    const parent = providers.get(record.providerId);
    if (!parent) throw modelsError('not-found');
    if (record.source.kind === 'external' && (parent.source.kind !== 'external' || parent.source.sourceId !== record.source.sourceId || parent.source.providerId !== record.source.providerId)) throw modelsError('invalid-config');
  }
  for (const record of snapshot.history.providerSettings) if (!providers.has(record.id)) throw modelsError('not-found');
  for (const record of snapshot.history.retiredConnections) if (!providers.has(record.providerDefinitionId)) throw modelsError('not-found');
  const providerIdsWithHistory = new Set([...snapshot.history.providerSettings.map(record => record.id), ...snapshot.history.retiredConnections.map(record => record.providerDefinitionId)]);
  const modelVersions = new Map(snapshot.history.models.map(record => [record.versionId, record]));
  for (const record of snapshot.history.modelSettings) {
    const definition = models.get(record.id);
    const pinned = modelVersions.get(record.modelDefinitionVersionId);
    if (!providerIdsWithHistory.has(record.providerId) || !definition || !pinned) throw modelsError('not-found');
    if (record.providerId !== definition.providerId || pinned.id !== record.id || pinned.remoteModelId !== record.remoteModelId) throw modelsError('invalid-config');
  }
  for (const record of snapshot.modelSettings) if (!providerSettings.has(record.providerId)) throw modelsError('not-found');
  for (const record of snapshot.syncStates) if (!providerSettings.has(record.providerId)) throw modelsError('not-found');
}

export class LegacyProviderSettingsConflict extends Error {
  override readonly name = 'ModelsError';
  readonly code = 'conflict';

  constructor(providerId: string, accountIds: readonly string[]) {
    super(`Provider ${JSON.stringify(providerId)} has several saved accounts ${JSON.stringify(accountIds)}. Use the previous version to keep one account for this provider before upgrading.`);
  }
}

export class LegacyModelSettingsConflict extends Error {
  override readonly name = 'ModelsError';
  readonly code = 'conflict';

  constructor(modelId: string, runtimeModelIds: readonly string[]) {
    super(`Model ${JSON.stringify(modelId)} has several saved parameter sets ${JSON.stringify(runtimeModelIds)}. Enable exactly one in the previous version before upgrading.`);
  }
}

function migrateLegacySnapshot(input: unknown): ModelsJsonSnapshotV2 {
  object(input, ['schemaVersion', 'providers', 'models', 'connections', 'configurations', 'sources', 'syncStates', 'credentialIntents', 'history', 'tombstones']);
  object(input.history, ['providers', 'models', 'connections', 'configurations']);
  object(input.tombstones, ['connections', 'configurations']);
  const connections = records(input.connections, legacyConnectionRecord);
  const history = records(input.history.connections, legacyConnectionRecord);
  const removed = new Set(ids(input.tombstones.connections));
  const historyById = latestById(history);
  const currentById = new Map(connections.map(record => [record.id, record]));
  validateHistory(history, ['providerDefinitionId', 'protocolId']);
  unique(connections, record => record.id);
  for (const current of connections) {
    const latest = historyById.get(current.id);
    if (!latest || removed.has(current.id)) throw modelsError('invalid-config');
    assertFieldsEqual(current, latest, [...versionKeys, 'protocolId', 'providerDefinitionId', 'credentialRef', 'historyScopeEpoch']);
  }
  for (const id of historyById.keys()) if (!currentById.has(id) && !removed.has(id)) throw modelsError('invalid-config');
  for (const id of removed) if (!historyById.has(id)) throw modelsError('invalid-config');
  const group = (values: Iterable<LegacyConnectionRecord>) => {
    const groups = new Map<string, string[]>();
    for (const item of values) {
      let members = groups.get(item.providerDefinitionId);
      if (!members) groups.set(item.providerDefinitionId, members = []);
      members.push(item.id);
    }
    return groups;
  };
  const currentAccounts = group(connections), archivedAccounts = group(historyById.values());
  const selected = new Set<string>();
  const inactive: string[] = [];
  for (const [providerId, accountIds] of archivedAccounts) {
    const current = currentAccounts.get(providerId) ?? [];
    if (current.length > 1) throw new LegacyProviderSettingsConflict(providerId, [...current].sort());
    if (current.length === 1) selected.add(current[0]);
    else if (accountIds.length === 1) { selected.add(accountIds[0]); inactive.push(providerId); }
  }

  const settings = ({ providerDefinitionId, id, ...record }: LegacyConnectionRecord): ProviderSettingsRecord =>
    providerSettingsRecord({ ...record, id: providerDefinitionId, restoreScopeId: id });
  const configurations = records(input.configurations, legacyConfigurationRecord);
  const configurationHistory = records(input.history.configurations, legacyConfigurationRecord);
  const configurationsById = latestById(configurationHistory);
  validateHistory(configurationHistory, ['connectionId', 'modelDefinitionId', 'baseline']);
  for (const record of configurations) {
    const previous = configurationsById.get(record.id);
    if (!currentById.has(record.connectionId) || !previous) throw modelsError('invalid-config');
    assertFieldsEqual(record, previous, [...versionKeys, 'connectionId', 'modelDefinitionId', 'modelDefinitionVersionId', 'baseline', 'remoteModelId']);
  }
  const toProviderId = (connectionId: string): string => {
    const owner = historyById.get(connectionId);
    if (!owner) throw modelsError('not-found');
    return owner.providerDefinitionId;
  };
  const configuration = ({ connectionId, ...record }: LegacyConfiguration): LegacyModelConfiguration => configurationRecord({ ...record, providerId: toProviderId(connectionId) });
  const syncStates = records(input.syncStates, legacySyncState).map(({ connectionId, ...record }) => {
    if (!currentById.has(connectionId)) throw modelsError('not-found');
    return syncState({ ...record, providerId: toProviderId(connectionId) });
  });
  const credentialIntents = records(input.credentialIntents, intentRecord).map(record =>
    // A crashed account creation can leave a journal slot before the first version exists.
    // Recovery uses slot identity and can still clean up these unmapped orphan intents.
    ({ ...record, providerId: historyById.get(record.providerId)?.providerDefinitionId ?? record.providerId }));
  return {
    schemaVersion: 2, providers: records(input.providers, providerRecord), models: records(input.models, modelRecord),
    providerSettings: connections.map(settings), configurations: configurations.map(configuration),
    sources: records(input.sources, sourceState), syncStates, credentialIntents,
    history: { providers: records(input.history.providers, providerRecord), models: records(input.history.models, modelRecord),
      providerSettings: history.filter(record => selected.has(record.id)).map(settings),
      retiredConnections: history.filter(record => !selected.has(record.id)), configurations: configurationHistory.map(configuration) },
    tombstones: { providerSettings: inactive, configurations: ids(input.tombstones.configurations) },
  };
}

function migrateModelSettings(input: unknown, decisions: ModelsJsonEditDecisions): unknown {
  object(input, ['schemaVersion', 'providers', 'models', 'providerSettings', 'configurations', 'sources', 'syncStates', 'credentialIntents', 'history', 'tombstones']);
  object(input.history, ['providers', 'models', 'providerSettings', 'retiredConnections', 'configurations']);
  object(input.tombstones, ['providerSettings', 'configurations']);
  const { history, tombstones, configurations, ...rest } = input;
  const versions = records(history.configurations, configurationRecord);
  validateHistory(versions, ['modelDefinitionId', 'providerId', 'baseline']);
  const reconciled = reconcile(records(configurations, configurationRecord), versions, configurationIdentity, decisions, (record, previous) => {
    if (!same(record.parameters, previous.parameters) && record.parameters.formatVersion !== 1) throw modelsError('invalid-config');
    validateModelSettings({ ...modelSettingsInput(record), parameters: { ...record.parameters, formatVersion: 1 } }); return record;
  });
  const retired = [...ids(tombstones.configurations)];
  validateCurrent(reconciled.current, reconciled.history, retired);
  unique(reconciled.current.filter(record => record.baseline), record => JSON.stringify([record.providerId, record.modelDefinitionId]));
  const groups = new Map<string, LegacyModelConfiguration[]>();
  for (const record of reconciled.current) {
    const group = groups.get(record.modelDefinitionId);
    if (group) group.push(record); else groups.set(record.modelDefinitionId, [record]);
  }
  const selected: LegacyModelConfiguration[] = [];
  for (const [modelId, group] of groups) {
    const candidates = group.length === 1 ? group : group.filter(record => record.enabled);
    if (candidates.length !== 1) throw new LegacyModelSettingsConflict(modelId, group.map(record => record.id).sort());
    const chosen = candidates[0];
    selected.push(chosen);
    for (const record of group) if (record !== chosen) retired.push(record.id);
  }
  const toModelSettings = ({ id, modelDefinitionId, baseline: _baseline, ...record }: LegacyModelConfiguration): ModelSettings =>
    modelSettingsRecord({ ...record, id: modelDefinitionId, runtimeModelId: id });
  const { configurations: _oldHistory, ...otherHistory } = history;
  return { ...rest, schemaVersion: 3, modelSettings: selected.map(toModelSettings),
    history: { ...otherHistory, modelSettings: reconciled.history.map(toModelSettings) },
    tombstones: { providerSettings: tombstones.providerSettings, modelSettings: retired } };
}

/** Accept only stopped-process edits of mutable current fields, preserving the identity ledger. */
export function parseModelsJsonSnapshot(input: unknown, decisions: ModelsJsonEditDecisions): { snapshot: ModelsJsonSnapshot; changed: boolean } {
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion === 1) {
    return { snapshot: parseModelsJsonSnapshot(migrateLegacySnapshot(input), decisions).snapshot, changed: true };
  }
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion === 2) {
    return { snapshot: parseModelsJsonSnapshot(migrateModelSettings(input, decisions), decisions).snapshot, changed: true };
  }
  object(input, ['schemaVersion', 'providers', 'models', 'providerSettings', 'modelSettings', 'sources', 'syncStates', 'credentialIntents', 'history', 'tombstones']);
  if (input.schemaVersion !== 3) throw modelsError('invalid-config');
  object(input.history, ['providers', 'models', 'providerSettings', 'retiredConnections', 'modelSettings']); object(input.tombstones, ['providerSettings', 'modelSettings']);
  const history = { providers: records(input.history.providers, providerRecord), models: records(input.history.models, modelRecord),
    providerSettings: records(input.history.providerSettings, providerSettingsRecord), retiredConnections: records(input.history.retiredConnections, legacyConnectionRecord), modelSettings: records(input.history.modelSettings, modelSettingsRecord) };
  const providers = reconcile(records(input.providers, providerRecord), history.providers, ['source', 'state'], decisions, record => { validateProvider(providerInput(record)); return record; });
  const models = reconcile(records(input.models, modelRecord), history.models, ['providerId', 'source', 'state'], decisions, record => { validateModel(modelInput(record)); return record; });
  const providerSettings = reconcile(records(input.providerSettings, providerSettingsRecord), history.providerSettings, [...settingsIdentity, 'credentialRef', 'historyScopeEpoch'], decisions,
    (record, previous) => { validateProviderSettings(providerSettingsInput(record)); return record.baseUrl !== previous.baseUrl || record.auth !== previous.auth ? { ...record, historyScopeEpoch: decisions.historyScopeEpoch(record.id) } : record; });
  const modelSettings = reconcile(records(input.modelSettings, modelSettingsRecord), history.modelSettings, modelSettingsIdentity, decisions, (record, previous) => {
    if (!same(record.parameters, previous.parameters) && record.parameters.formatVersion !== 1) throw modelsError('invalid-config');
    validateModelSettings({ ...modelSettingsInput(record), parameters: { ...record.parameters, formatVersion: 1 } }); return record;
  }, record => record.runtimeModelId);
  const snapshot: ModelsJsonSnapshot = { schemaVersion: 3, providers: providers.current, models: models.current, providerSettings: providerSettings.current, modelSettings: modelSettings.current,
    sources: records(input.sources, sourceState), syncStates: records(input.syncStates, syncState), credentialIntents: records(input.credentialIntents, intentRecord),
    history: { providers: providers.history, models: models.history, providerSettings: providerSettings.history, retiredConnections: history.retiredConnections, modelSettings: modelSettings.history },
    tombstones: { providerSettings: ids(input.tombstones.providerSettings), modelSettings: ids(input.tombstones.modelSettings) } };
  validateSnapshot(snapshot);
  return { snapshot, changed: providers.changed || models.changed || providerSettings.changed || modelSettings.changed };
}

/** Atomic in-memory candidate; publication belongs to the persistence adapter. */
export function applyModelsJsonChange(snapshot: ModelsJsonSnapshot, change: StoreChange): ModelsJsonSnapshot {
  const providers = [...snapshot.providers], models = [...snapshot.models], providerSettings = [...snapshot.providerSettings], modelSettings = [...snapshot.modelSettings];
  const history = { ...snapshot.history, providers: [...snapshot.history.providers], models: [...snapshot.history.models], providerSettings: [...snapshot.history.providerSettings], modelSettings: [...snapshot.history.modelSettings] };
  const sources = [...snapshot.sources], syncStates = [...snapshot.syncStates], credentialIntents = [...snapshot.credentialIntents];
  const tombstones = { providerSettings: [...snapshot.tombstones.providerSettings], modelSettings: [...snapshot.tombstones.modelSettings] };
  const putter = <T>(items: T[], key: (value: T) => string) => {
    const indexes = new Map(items.map((item, index) => [key(item), index]));
    return (record: T) => { const id = key(record), index = indexes.get(id); if (index === undefined) { indexes.set(id, items.length); items.push(record); } else items[index] = record; };
  };
  const synced = new Map(syncStates.map(record => [record.providerId, record]));
  for (const guard of change.syncGuards ?? []) if ((synced.get(guard.providerId)?.targetSourceVersion ?? null) !== guard.targetSourceVersion) throw modelsError('conflict');
  const write = <T extends Versioned>(items: T[], archived: T[], updates: readonly { readonly record: T; readonly expectedRevision: number | null }[], immutable: readonly string[]) => {
    const currentById = new Map(items.map(record => [record.id, record])), put = putter(items, record => record.id);
    for (const { record, expectedRevision } of updates) {
      const current = currentById.get(record.id); validateVersion(record, current, expectedRevision);
      if (current) assertFieldsEqual(record, current, immutable);
      archived.push(record); put(record); currentById.set(record.id, record);
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
  if (change.providerSettings) {
    if (change.deleteProviderSettings) throw modelsError('invalid-config');
    const { record, expectedRevision } = change.providerSettings;
    validateProviderSettingsWrite(record, providerSettings.find(item => item.id === record.id), latestById(history.providerSettings).get(record.id), expectedRevision);
    history.providerSettings.push(record);
    putter(providerSettings, item => item.id)(record);
    const index = tombstones.providerSettings.indexOf(record.id);
    if (index >= 0) tombstones.providerSettings.splice(index, 1);
  }
  if (change.modelSettings?.length) {
    const current = new Map(modelSettings.map(record => [record.id, record]));
    const latest = latestById(history.modelSettings);
    const runtimeIds = new Set(history.modelSettings.map(record => record.runtimeModelId));
    const put = putter(modelSettings, record => record.id);
    for (const { record, expectedRevision } of change.modelSettings) {
      const previous = current.get(record.id);
      validateModelSettingsWrite(record, previous, latest.get(record.id)?.revision, expectedRevision);
      if (!previous && runtimeIds.has(record.runtimeModelId)) throw modelsError('conflict');
      history.modelSettings.push(record); runtimeIds.add(record.runtimeModelId);
      current.set(record.id, record); put(record);
    }
  }
  const putSource = putter(sources, record => record.sourceId), putSync = putter(syncStates, record => record.providerId);
  for (const record of change.sources ?? []) putSource(record);
  for (const record of change.syncStates ?? []) putSync(record);
  const intentIds = new Set(credentialIntents.map(record => record.id));
  for (const record of change.addIntents ?? []) {
    if (intentIds.has(record.id)) throw modelsError('conflict'); credentialIntents.push(record); intentIds.add(record.id);
  }
  const removedIntents = new Set(change.removeIntentIds ?? []);
  for (let i = credentialIntents.length - 1; i >= 0; i--) if (removedIntents.has(credentialIntents[i].id)) credentialIntents.splice(i, 1);
  if (change.deleteProviderSettings) {
    const { id, expectedRevision } = change.deleteProviderSettings, current = providerSettings.find(item => item.id === id);
    if (!current) throw modelsError('not-found'); if (current.revision !== expectedRevision) throw modelsError('conflict');
    tombstones.providerSettings.push(id);
    for (let i = modelSettings.length - 1; i >= 0; i--) if (modelSettings[i].providerId === id) { tombstones.modelSettings.push(modelSettings[i].runtimeModelId); modelSettings.splice(i, 1); }
    providerSettings.splice(providerSettings.indexOf(current), 1);
    for (let i = syncStates.length - 1; i >= 0; i--) if (syncStates[i].providerId === id) syncStates.splice(i, 1);
  }
  const result: ModelsJsonSnapshot = { ...snapshot, providers, models, providerSettings, modelSettings, history, sources, syncStates, credentialIntents, tombstones };
  validateSnapshot(result); return result;
}

import { validateParameters } from './domain.js';
import { modelsError } from './errors.js';
import type { ConnectionHints, ConnectionSyncState, CredentialIntent, DeclaredCapabilities, Model, ModelConfiguration, Provider, ProviderConnectionRecord, SourceRef, SourceState, StoreChange, Versioned } from './types.js';

export function requiredString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw modelsError('invalid-config');
}
export function pick<T, K extends keyof T>(input: T, keys: readonly K[]): Pick<T, K> {
  const output = {} as Pick<T, K>;
  for (const key of keys) if (input[key] !== undefined) output[key] = input[key];
  return output;
}
export function versionFields(record: Versioned): Versioned {
  for (const field of [record.id, record.versionId, record.createdAt, record.updatedAt]) requiredString(field);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw modelsError('invalid-config');
  return pick(record, ['id', 'revision', 'versionId', 'createdAt', 'updatedAt']);
}
export function validateVersion(record: Versioned, current: Versioned | undefined, expected: number | null): void {
  if (expected === null ? current !== undefined : current?.revision !== expected) throw modelsError('conflict');
  if (record.revision !== (current?.revision ?? 0) + 1 || (current && record.createdAt !== current.createdAt)) throw modelsError('invalid-config');
}
export function sourceRef(source: SourceRef, model = false): SourceRef {
  if (source.kind === 'user') return { kind: 'user' };
  if (source.kind !== 'external') throw modelsError('invalid-config');
  requiredString(source.sourceId); requiredString(source.providerId);
  if (source.sourceVersion !== null) requiredString(source.sourceVersion);
  if (model) requiredString(source.modelId);
  else if (source.modelId !== undefined) throw modelsError('invalid-config');
  return { kind: 'external', sourceId: source.sourceId, providerId: source.providerId,
    ...(model ? { modelId: source.modelId } : {}), sourceVersion: source.sourceVersion };
}
export function sourceIdentity(source: SourceRef): string {
  return source.kind === 'user' ? 'user' : JSON.stringify([source.sourceId, source.providerId, source.modelId ?? null]);
}
export function connectionHints(hints: ConnectionHints): ConnectionHints {
  if (!Array.isArray(hints.protocolIds) || hints.protocolIds.some(id => typeof id !== 'string' || !id.trim())) throw modelsError('invalid-config');
  if (hints.baseUrl !== undefined) requiredString(hints.baseUrl);
  return { ...(hints.baseUrl === undefined ? {} : { baseUrl: hints.baseUrl }), protocolIds: [...hints.protocolIds] };
}
export function finiteNonnegative(value: unknown): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw modelsError('invalid-config');
}
export function capabilities(input: DeclaredCapabilities): DeclaredCapabilities {
  if (input.webSearch && !['supported', 'unsupported', 'unknown'].includes(input.webSearch.support)) throw modelsError('invalid-config');
  for (const cap of [input.tools, input.streaming, input.imageInput, input.reasoning]) {
    if (!['supported', 'unsupported', 'unknown'].includes(cap.support)) throw modelsError('invalid-config');
  }
  for (const items of [input.reasoning.efforts, input.reasoning.modes]) {
    if (items !== undefined && (!Array.isArray(items) || items.some(value => typeof value !== 'string' || !value.trim()))) throw modelsError('invalid-config');
  }
  const budget = input.reasoning.budget;
  if (budget) {
    finiteNonnegative(budget.min); finiteNonnegative(budget.max);
    if (budget.min === undefined || budget.max === undefined || budget.min > budget.max) throw modelsError('invalid-config');
  }
  return {
    ...(input.webSearch ? { webSearch: pick(input.webSearch, ['support']) } : {}),
    tools: pick(input.tools, ['support']), streaming: pick(input.streaming, ['support']), imageInput: pick(input.imageInput, ['support']),
    reasoning: { ...pick(input.reasoning, ['support', 'efforts', 'modes']), ...(budget ? { budget: pick(budget, ['min', 'max']) } : {}) },
  };
}
export function state(value: unknown): asserts value is Provider['state'] {
  if (value !== 'present' && value !== 'missing' && value !== 'unresolved') throw modelsError('invalid-config');
}
/** Whitelist every definition field; upstream metadata and credentials are not module data. */
export function providerRecord(record: Provider): Provider {
  requiredString(record.name); state(record.state);
  if (record.documentationUrl !== undefined) requiredString(record.documentationUrl);
  return { ...versionFields(record), ...pick(record, ['name', 'documentationUrl', 'state']),
    source: sourceRef(record.source), connectionHints: connectionHints(record.connectionHints) };
}
export function modelRecord(record: Model): Model {
  requiredString(record.name); requiredString(record.providerId); requiredString(record.remoteModelId); state(record.state);
  for (const key of ['description', 'family', 'releaseDate', 'lastUpdated', 'status', 'modelType'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') throw modelsError('invalid-config');
  }
  if (record.openWeights !== undefined && typeof record.openWeights !== 'boolean') throw modelsError('invalid-config');
  for (const items of [record.modalities.input, record.modalities.output]) {
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) throw modelsError('invalid-config');
  }
  for (const number of [record.limits.context, record.limits.input, record.limits.output]) finiteNonnegative(number);
  const controls = record.controls;
  for (const support of [controls.temperature, controls.structuredOutput ?? 'unknown']) {
    if (!['unknown', 'supported', 'unsupported'].includes(support)) throw modelsError('invalid-config');
  }
  const reasoning = controls.reasoning?.map(control => {
    if (!['toggle', 'effort', 'budget'].includes(control.kind) || (control.values !== undefined &&
        (!Array.isArray(control.values) || control.values.some(value => typeof value !== 'string')))) throw modelsError('invalid-config');
    finiteNonnegative(control.min); finiteNonnegative(control.max);
    return pick(control, ['kind', 'values', 'min', 'max']);
  });
  const cost = record.cost;
  if (cost && (cost.currency !== 'USD' || cost.unit !== 'million-tokens')) throw modelsError('invalid-config');
  const costFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  if (cost) for (const value of [...costFields.map(key => cost[key]), cost.reasoning]) finiteNonnegative(value);
  return { ...versionFields(record), ...pick(record, ['name', 'providerId', 'remoteModelId', 'description', 'family', 'releaseDate',
      'lastUpdated', 'status', 'openWeights', 'modelType', 'state']), source: sourceRef(record.source, true),
    capabilities: capabilities(record.capabilities), controls: { ...pick(controls, ['temperature', 'structuredOutput']),
      ...(reasoning === undefined ? {} : { reasoning }) }, modalities: pick(record.modalities, ['input', 'output']),
    limits: pick(record.limits, ['context', 'input', 'output']), connectionHints: connectionHints(record.connectionHints),
    ...(cost ? { cost: { ...pick(cost, ['currency', 'unit', ...costFields, 'reasoning']),
      ...(cost.tiers === undefined ? {} : { tiers: cost.tiers.map(tier => {
        for (const value of [...costFields.map(key => tier[key]), tier.reasoning, tier.contextMin, tier.contextMax]) finiteNonnegative(value);
        return pick(tier, ['contextMin', 'contextMax', 'reasoning', ...costFields]);
      }) }) } } : {}) };
}
export function connectionRecord(record: ProviderConnectionRecord): ProviderConnectionRecord {
  for (const value of [record.providerDefinitionId, record.name, record.protocolId, record.baseUrl]) requiredString(value);
  if (typeof record.enabled !== 'boolean' || !['none', 'api-key'].includes(record.auth) ||
      !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs <= 0) throw modelsError('invalid-config');
  if (record.credentialRef !== null) requiredString(record.credentialRef); requiredString(record.historyScopeEpoch);
  return { ...versionFields(record), ...pick(record, ['providerDefinitionId', 'name', 'enabled', 'protocolId', 'baseUrl', 'auth', 'timeoutMs', 'credentialRef', 'historyScopeEpoch']) };
}
export function configurationRecord(record: ModelConfiguration): ModelConfiguration {
  for (const value of [record.modelDefinitionId, record.modelDefinitionVersionId, record.connectionId, record.name, record.remoteModelId]) requiredString(value);
  if (typeof record.enabled !== 'boolean' || typeof record.baseline !== 'boolean') throw modelsError('invalid-config');
  return { ...versionFields(record), ...pick(record, ['modelDefinitionId', 'modelDefinitionVersionId', 'connectionId', 'name', 'enabled', 'baseline', 'remoteModelId']),
    capabilities: capabilities(record.capabilities), parameters: (validateParameters(record.parameters), structuredClone(record.parameters)) };
}
export function sourceState(record: SourceState): SourceState {
  requiredString(record.sourceId); requiredString(record.snapshotVersion);
  if (!Number.isSafeInteger(record.fetchedAt) || record.fetchedAt < 0) throw modelsError('invalid-config');
  return pick(record, ['sourceId', 'snapshotVersion', 'fetchedAt']);
}
export function syncState(record: ConnectionSyncState): ConnectionSyncState {
  requiredString(record.connectionId);
  if (!['pending', 'ready', 'failed'].includes(record.state)) throw modelsError('invalid-config');
  for (const value of [record.targetSourceVersion, record.syncedSourceVersion]) if (value !== null) requiredString(value);
  if (record.error !== undefined) requiredString(record.error);
  return pick(record, ['connectionId', 'state', 'targetSourceVersion', 'syncedSourceVersion', 'error']);
}
export function intentRecord(record: CredentialIntent): CredentialIntent {
  for (const value of [record.id, record.providerId, record.slotId, record.createdAt]) requiredString(value);
  return pick(record, ['id', 'providerId', 'slotId', 'createdAt']);
}

/** Shared whitelist/validation for persistence providers. */
export function normalizeStoreChange(input: StoreChange): StoreChange {
  if (input.deleteConnection) {
    requiredString(input.deleteConnection.id);
    if (!Number.isSafeInteger(input.deleteConnection.expectedRevision) || input.deleteConnection.expectedRevision < 1) throw modelsError('invalid-config');
  }
  for (const guard of input.syncGuards ?? []) {
    requiredString(guard.connectionId);
    if (guard.targetSourceVersion !== null) requiredString(guard.targetSourceVersion);
  }
  for (const id of input.removeIntentIds ?? []) requiredString(id);
  return structuredClone({
    providers: input.providers?.map(item => ({ record: providerRecord(item.record), expectedRevision: item.expectedRevision })),
    models: input.models?.map(item => ({ record: modelRecord(item.record), expectedRevision: item.expectedRevision })),
    ...(input.connection ? { connection: { record: connectionRecord(input.connection.record), expectedRevision: input.connection.expectedRevision } } : {}),
    ...(input.deleteConnection ? { deleteConnection: pick(input.deleteConnection, ['id', 'expectedRevision']) } : {}),
    configurations: input.configurations?.map(item => ({ record: configurationRecord(item.record), expectedRevision: item.expectedRevision })),
    sources: input.sources?.map(sourceState), syncStates: input.syncStates?.map(syncState), syncGuards: input.syncGuards?.map(guard => pick(guard, ['connectionId', 'targetSourceVersion'])),
    addIntents: input.addIntents?.map(intentRecord), removeIntentIds: input.removeIntentIds,
  });
}

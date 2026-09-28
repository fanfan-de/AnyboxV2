import { createHash } from 'node:crypto';
import { immutable, validateCapabilities } from './domain.js';
import { modelsError } from './errors.js';
import { externalModelId, externalProviderId } from './identity.js';
import type { ConnectionHints, DeclaredCapabilities, Model, ModelCost, ModelInput, Provider, ProviderInput, ProtocolDescriptor, ReasoningControl, SourceRef, SourceSnapshot, Support } from './types.js';
import type { ProviderTemplate } from './templates.js';

type ObjectValue = Record<string, unknown>;
const invalid = (): never => { throw modelsError('invalid-response'); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : invalid();
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const required = (value: unknown): string => nonempty(value) ? value : invalid();
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? [...new Set(value.filter(nonempty))] : [];
const support = (value: unknown): Support => value === true ? 'supported' : value === false ? 'unsupported' : 'unknown';
const optionalString = (key: string, value: unknown): ObjectValue => nonempty(value) ? { [key]: value } : {};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, part]) => [key, canonical(part)])) : value;
const contentHash = (value: unknown): string => hash(canonical(value));
function allowed(value: unknown, keys: readonly string[]): ObjectValue { const raw = object(value); if (Object.keys(raw).some(key => !keys.includes(key))) invalid(); return raw; }

function httpUrl(value: unknown, base = false): string | undefined {
  if (!nonempty(value) || /\$\{|\{|\}/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (base && (url.search || url.hash))) return undefined;
    if (base) url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages|interactions)\/?$/u, '').replace(/\/+$/u, '');
    return url.toString().replace(base ? /\/+$/u : /$^/u, '');
  } catch { return undefined; }
}

/** SDK metadata is interpreted here and never becomes a runtime implementation. */
function connectionHints(provider: ObjectValue, override?: ObjectValue): ConnectionHints {
  const values = { ...provider, ...override };
  let protocolIds: readonly string[] = [];
  if (values.shape !== undefined && values.shape !== 'responses' && values.shape !== 'completions') protocolIds = [];
  else if (values.shape === 'responses') protocolIds = ['responses'];
  else if (values.shape === 'completions') protocolIds = ['chat-completions'];
  else if (values.npm === '@ai-sdk/openai') protocolIds = ['responses', 'chat-completions'];
  else if (values.npm === '@ai-sdk/anthropic') protocolIds = ['anthropic-messages'];
  else if (values.npm === '@ai-sdk/google') protocolIds = ['gemini-interactions'];
  else if (['@ai-sdk/openai-compatible', '@ai-sdk/deepinfra', '@ai-sdk/cerebras', '@ai-sdk/groq', '@openrouter/ai-sdk-provider', '@ai-sdk/perplexity', '@ai-sdk/xai', '@ai-sdk/mistral', '@ai-sdk/togetherai'].includes(String(values.npm))) protocolIds = ['chat-completions'];
  const baseUrl = httpUrl(values.api, true);
  return { ...(baseUrl ? { baseUrl } : {}), protocolIds };
}
function reasoningControls(value: unknown): readonly ReasoningControl[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<ReasoningControl>(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as ObjectValue;
    if (item.type === 'toggle') return [{ kind: 'toggle' as const }];
    if (item.type === 'effort') { const values = strings(item.values); return values.length ? [{ kind: 'effort' as const, values }] : []; }
    if (item.type === 'budget_tokens') return [{ kind: 'budget' as const,
      ...(number(item.min) && Number.isSafeInteger(item.min) ? { min: item.min } : {}),
      ...(number(item.max) && Number.isSafeInteger(item.max) ? { max: item.max } : {}) }];
    return [];
  });
}
function costFields(value: ObjectValue) {
  return Object.fromEntries([['input', value.input], ['output', value.output], ['cacheRead', value.cache_read], ['cacheWrite', value.cache_write], ['reasoning', value.reasoning]].filter(([, amount]) => number(amount)));
}
function cost(value: unknown): ModelCost | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as ObjectValue;
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as ObjectValue;
    const tier = item.tier && typeof item.tier === 'object' && !Array.isArray(item.tier) ? item.tier as ObjectValue : {};
    return [{ ...costFields(item), ...(tier.type === 'context' && number(tier.size) ? { contextMin: tier.size } : {}) }];
  }) : [];
  const over = raw.context_over_200k;
  if (over && typeof over === 'object' && !Array.isArray(over)) tiers.push({ ...costFields(over as ObjectValue), contextMin: 200_000 });
  return { currency: 'USD', unit: 'million-tokens', ...costFields(raw), ...(tiers.length ? { tiers } : {}) };
}

const providerFields = ['name', 'documentationUrl', 'connectionHints'] as const;
const modelFields = ['providerId', 'remoteModelId', 'name', 'description', 'family', 'releaseDate', 'lastUpdated', 'status', 'openWeights', 'modelType', 'capabilities', 'controls', 'modalities', 'limits', 'cost', 'connectionHints'] as const;
const versionFields = ['id', 'revision', 'versionId', 'createdAt', 'updatedAt', 'source', 'state'] as const;
/** Source content excludes ingestion time, local revisions and the enclosing source version. */
function definitionContent(value: Provider | Model) {
  const fields = 'remoteModelId' in value ? modelFields : providerFields;
  const source = value.source;
  return { id: value.id, ...Object.fromEntries(fields.filter(key => key in value).map(key => [key, (value as unknown as ObjectValue)[key]])),
    source: source.kind === 'external' ? { kind: source.kind, sourceId: source.sourceId, providerId: source.providerId, ...(source.modelId !== undefined ? { modelId: source.modelId } : {}) } : { kind: source.kind } };
}
export function sourceDefinitionVersion(value: Provider | Model): string { return contentHash(definitionContent(value)); }
export function catalogSnapshotVersion(providers: readonly Provider[], models: readonly Model[]): string {
  const byId = (left: Provider | Model, right: Provider | Model) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return contentHash({ providers: [...providers].sort(byId).map(definitionContent), models: [...models].sort(byId).map(definitionContent) });
}
function versionedDefinition<T extends ProviderInput | ModelInput>(input: T, id: string, source: SourceRef, fetchedAt: number): T & { id: string; revision: number; versionId: string; createdAt: string; updatedAt: string; source: SourceRef; state: 'present' } {
  const time = new Date(fetchedAt).toISOString();
  const value = { id, revision: 1, versionId: '', createdAt: time, updatedAt: time, ...input, source, state: 'present' as const };
  return { ...value, versionId: sourceDefinitionVersion(value as Provider | Model) } as T & { id: string; revision: number; versionId: string; createdAt: string; updatedAt: string; source: SourceRef; state: 'present' };
}
function completeSnapshot(sourceId: string, fetchedAt: number, providers: readonly Provider[], models: readonly Model[]): SourceSnapshot {
  const snapshotVersion = catalogSnapshotVersion(providers, models);
  const versioned = <T extends Provider | Model>(value: T): T => ({ ...value, source: { ...value.source, sourceVersion: snapshotVersion } as SourceRef });
  return immutable({ schemaVersion: 2, sourceId, fetchedAt, snapshotVersion, providers: providers.map(versioned), models: models.map(versioned) });
}

/** Pure normalization into module definitions. Time is supplied by the source/asset boundary. */
export function normalizeModelsDevCatalog(input: unknown, sourceId = 'models.dev', fetchedAt = 0): SourceSnapshot {
  required(sourceId);
  if (!number(fetchedAt) || !Number.isFinite(new Date(fetchedAt).getTime())) invalid();
  const root = object(input), providers: Provider[] = [], models: Model[] = [], providerIds = new Set<string>();
  if (Object.keys(root).length > 5000) invalid();
  const compareKeys = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0;
  for (const [, value] of Object.entries(root).sort(compareKeys)) {
    const raw = object(value), sourceProviderId = required(raw.id), name = required(raw.name);
    if (providerIds.has(sourceProviderId)) invalid();
    providerIds.add(sourceProviderId);
    const providerId = externalProviderId(sourceId, sourceProviderId), hints = connectionHints(raw), documentationUrl = httpUrl(raw.doc);
    providers.push(versionedDefinition({ name, ...(documentationUrl ? { documentationUrl } : {}), connectionHints: hints }, providerId,
      { kind: 'external', sourceId, providerId: sourceProviderId, sourceVersion: null }, fetchedAt));
    const modelIds = new Set<string>();
    for (const [, entry] of Object.entries(object(raw.models)).sort(compareKeys)) {
      const model = object(entry), remoteModelId = required(model.id);
      if (modelIds.has(remoteModelId) || models.length >= 200_000) invalid();
      modelIds.add(remoteModelId);
      const modalities = model.modalities && typeof model.modalities === 'object' ? object(model.modalities) : {};
      const inputModes = strings(modalities.input), outputModes = strings(modalities.output), controls = reasoningControls(model.reasoning_options);
      const efforts = [...new Set(controls.filter(control => control.kind === 'effort').flatMap(control => control.values ?? []))];
      const budget = controls.find(control => control.kind === 'budget' && control.min !== undefined && control.max !== undefined && control.min <= control.max);
      const limits = model.limit && typeof model.limit === 'object' ? object(model.limit) : {}, pricing = cost(model.cost);
      const override = model.provider === undefined ? undefined : object(model.provider);
      const definition: ModelInput = { providerId, remoteModelId, name: required(model.name),
        ...optionalString('description', model.description), ...optionalString('family', model.family),
        ...optionalString('releaseDate', model.release_date), ...optionalString('lastUpdated', model.last_updated),
        ...optionalString('status', model.status), ...optionalString('modelType', model.type),
        ...(typeof model.open_weights === 'boolean' ? { openWeights: model.open_weights } : {}),
        capabilities: { tools: { support: support(model.tool_call) }, streaming: { support: support(model.streaming) },
          imageInput: { support: inputModes.length ? inputModes.includes('image') ? 'supported' : 'unsupported' : 'unknown' },
          reasoning: { support: support(model.reasoning), ...(efforts.length ? { efforts } : {}), ...(budget ? { budget: { min: budget.min!, max: budget.max! } } : {}) } },
        controls: { temperature: support(model.temperature), ...(typeof model.structured_output === 'boolean' ? { structuredOutput: support(model.structured_output) } : {}), ...(controls.length ? { reasoning: controls } : {}) },
        modalities: { input: inputModes, output: outputModes },
        limits: Object.fromEntries(['context', 'input', 'output'].filter(key => number(limits[key])).map(key => [key, limits[key]])),
        ...(pricing ? { cost: pricing } : {}), connectionHints: override ? connectionHints(raw, override) : hints };
      models.push(versionedDefinition(definition, externalModelId(sourceId, sourceProviderId, remoteModelId),
        { kind: 'external', sourceId, providerId: sourceProviderId, modelId: remoteModelId, sourceVersion: null }, fetchedAt));
    }
  }
  return completeSnapshot(sourceId, fetchedAt, providers, models);
}
function validateHints(value: unknown): void {
  const hints = allowed(value, ['baseUrl', 'protocolIds']);
  if (!Array.isArray(hints.protocolIds) || !hints.protocolIds.every(nonempty) || new Set(hints.protocolIds).size !== hints.protocolIds.length || hints.baseUrl !== undefined && httpUrl(hints.baseUrl, true) !== hints.baseUrl) invalid();
}
function validateMetadata(model: ObjectValue, capabilitiesKey: 'capabilities' | 'suggestedCapabilities'): void {
  for (const key of ['description', 'family', 'releaseDate', 'lastUpdated', 'status', 'modelType']) if (model[key] !== undefined && !nonempty(model[key])) invalid();
  if (model.openWeights !== undefined && typeof model.openWeights !== 'boolean') invalid();
  try { validateCapabilities(model[capabilitiesKey] as DeclaredCapabilities); } catch { invalid(); }
  const controls = allowed(model.controls, ['temperature', 'structuredOutput', 'reasoning']);
  if (!['supported', 'unsupported', 'unknown'].includes(String(controls.temperature))) invalid();
  if (controls.structuredOutput !== undefined && !['supported', 'unsupported', 'unknown'].includes(String(controls.structuredOutput))) invalid();
  if (controls.reasoning !== undefined) {
    if (!Array.isArray(controls.reasoning)) invalid();
    for (const item of controls.reasoning as unknown[]) {
      const control = allowed(item, ['kind', 'values', 'min', 'max']);
      if (!['toggle', 'effort', 'budget'].includes(String(control.kind)) || control.values !== undefined && (!Array.isArray(control.values) || !control.values.every(nonempty)) || control.min !== undefined && !number(control.min) || control.max !== undefined && !number(control.max)) invalid();
    }
  }
  const modes = allowed(model.modalities, ['input', 'output']);
  if (!Array.isArray(modes.input) || !modes.input.every(nonempty) || !Array.isArray(modes.output) || !modes.output.every(nonempty)) invalid();
  const limits = allowed(model.limits, ['context', 'input', 'output']);
  if (Object.values(limits).some(item => !number(item))) invalid();
  if (model.cost !== undefined) {
    const pricing = allowed(model.cost, ['currency', 'unit', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tiers']);
    if (pricing.currency !== 'USD' || pricing.unit !== 'million-tokens') invalid();
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) if (pricing[key] !== undefined && !number(pricing[key])) invalid();
    if (pricing.tiers !== undefined) {
      if (!Array.isArray(pricing.tiers)) invalid();
      for (const raw of pricing.tiers as unknown[]) if (Object.values(allowed(raw, ['contextMin', 'contextMax', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'])).some(item => !number(item))) invalid();
    }
  }
}
function validateVersion(value: ObjectValue, sourceId: string, sourceVersion: string, model: boolean): ObjectValue {
  required(value.id); required(value.versionId);
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !nonempty(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || !nonempty(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt)) || value.state !== 'present') invalid();
  const source = allowed(value.source, ['kind', 'sourceId', 'providerId', 'modelId', 'sourceVersion']);
  if (source.kind !== 'external' || source.sourceId !== sourceId || source.sourceVersion !== sourceVersion || !nonempty(source.providerId) || model !== (source.modelId !== undefined) || model && !nonempty(source.modelId)) invalid();
  return source;
}
/** Validate current source/cache data independently of the upstream JSON shape. */
export function validateCatalogSnapshot(input: unknown): asserts input is SourceSnapshot {
  const value = allowed(input, ['schemaVersion', 'sourceId', 'fetchedAt', 'snapshotVersion', 'providers', 'models']);
  if (value.schemaVersion !== 2 || !nonempty(value.sourceId) || !number(value.fetchedAt) || !Number.isFinite(new Date(value.fetchedAt).getTime()) || !nonempty(value.snapshotVersion) || !Array.isArray(value.providers) || !Array.isArray(value.models) || value.providers.length > 5000 || value.models.length > 200_000) invalid();
  const sourceId = required(value.sourceId), snapshotVersion = required(value.snapshotVersion), ids = new Map<string, string>(), models = new Set<string>();
  for (const raw of value.providers as unknown[]) {
    const provider = allowed(raw, [...providerFields, ...versionFields]), source = validateVersion(provider, sourceId, snapshotVersion, false), id = required(provider.id);
    if (id !== externalProviderId(sourceId, String(source.providerId)) || ids.has(id)) invalid();
    ids.set(id, String(source.providerId)); required(provider.name); validateHints(provider.connectionHints);
    if (provider.documentationUrl !== undefined && httpUrl(provider.documentationUrl) !== provider.documentationUrl) invalid();
  }
  for (const raw of value.models as unknown[]) {
    const model = allowed(raw, [...modelFields, ...versionFields]), source = validateVersion(model, sourceId, snapshotVersion, true), id = required(model.id);
    if (id !== externalModelId(sourceId, String(source.providerId), String(source.modelId)) || !ids.has(String(model.providerId)) || ids.get(String(model.providerId)) !== source.providerId || source.modelId !== model.remoteModelId || models.has(id)) invalid();
    models.add(id); required(model.remoteModelId); required(model.name); validateHints(model.connectionHints); validateMetadata(model, 'capabilities');
  }
  if (catalogSnapshotVersion(value.providers as Provider[], value.models as Model[]) !== value.snapshotVersion) invalid();
}

/** The retired v1 format is accepted only on the persistent cache read boundary. */
export function readCatalogSnapshot(input: unknown): SourceSnapshot {
  if (object(input).schemaVersion === 2) { validateCatalogSnapshot(input); return immutable(input); }
  const value = allowed(input, ['schemaVersion', 'sourceId', 'fetchedAt', 'snapshotVersion', 'providers', 'models']);
  if (value.schemaVersion !== 1 || !nonempty(value.sourceId) || !number(value.fetchedAt) || !Number.isFinite(new Date(value.fetchedAt).getTime()) || !nonempty(value.snapshotVersion) || !Array.isArray(value.providers) || !Array.isArray(value.models) || value.providers.length > 5000 || value.models.length > 200_000) invalid();
  // Check the original serialized data before assigning module identities or dropping fields.
  if (hash({ providers: value.providers, models: value.models }) !== value.snapshotVersion) invalid();
  const sourceId = required(value.sourceId), fetchedAt = Number(value.fetchedAt), ids = new Set<string>(), modelIds = new Set<string>(), providers: Provider[] = [], models: Model[] = [];
  for (const raw of value.providers as unknown[]) {
    const old = allowed(raw, ['sourceId', 'id', ...providerFields]), sourceProviderId = required(old.id);
    if (old.sourceId !== sourceId || ids.has(sourceProviderId)) invalid();
    ids.add(sourceProviderId); required(old.name); validateHints(old.connectionHints);
    if (old.documentationUrl !== undefined && httpUrl(old.documentationUrl) !== old.documentationUrl) invalid();
    providers.push(versionedDefinition({ name: String(old.name), ...(old.documentationUrl ? { documentationUrl: String(old.documentationUrl) } : {}), connectionHints: old.connectionHints as ConnectionHints }, externalProviderId(sourceId, sourceProviderId), { kind: 'external', sourceId, providerId: sourceProviderId, sourceVersion: null }, fetchedAt));
  }
  for (const raw of value.models as unknown[]) {
    const old = allowed(raw, ['sourceId', ...modelFields.filter(key => key !== 'capabilities'), 'suggestedCapabilities']), sourceProviderId = required(old.providerId), remoteModelId = required(old.remoteModelId), key = JSON.stringify([sourceProviderId, remoteModelId]);
    if (old.sourceId !== sourceId || !ids.has(sourceProviderId) || modelIds.has(key)) invalid();
    modelIds.add(key); required(old.name); validateHints(old.connectionHints); validateMetadata(old, 'suggestedCapabilities');
    const fields = Object.fromEntries(modelFields.filter(key => key !== 'providerId' && key !== 'capabilities' && key in old).map(key => [key, old[key]]));
    models.push(versionedDefinition({ ...fields, providerId: externalProviderId(sourceId, sourceProviderId), capabilities: old.suggestedCapabilities } as unknown as ModelInput, externalModelId(sourceId, sourceProviderId, remoteModelId), { kind: 'external', sourceId, providerId: sourceProviderId, modelId: remoteModelId, sourceVersion: null }, fetchedAt));
  }
  return completeSnapshot(sourceId, fetchedAt, providers, models);
}

/** Only installed protocols yield recipes; credentials and connection records are not edited. */
export function resolveCatalogConnections(provider: Provider, installedProtocols: readonly ProtocolDescriptor[], hostTemplates: readonly ProviderTemplate[] = [], model?: Model): readonly ProviderTemplate[] {
  const installed = new Set(installedProtocols.map(protocol => protocol.id));
  const hints = model?.connectionHints ?? provider.connectionHints;
  const sameHints = hints.baseUrl === provider.connectionHints.baseUrl && JSON.stringify(hints.protocolIds) === JSON.stringify(provider.connectionHints.protocolIds);
  const source = provider.source;
  const matching = hostTemplates.filter(template => source.kind === 'external' && template.values.sourceRef?.sourceId === source.sourceId && template.values.sourceRef.providerId === source.providerId && installed.has(template.values.protocolId));
  if (sameHints && matching.length) return immutable(matching);
  if (hints.baseUrl === provider.connectionHints.baseUrl) {
    const narrowed = matching.filter(template => hints.protocolIds.includes(template.values.protocolId));
    if (narrowed.length) return immutable(narrowed);
  }
  const baseUrl = hints.baseUrl ?? (sameHints ? matching[0]?.values.baseUrl : undefined);
  if (!baseUrl) return [];
  return immutable(hints.protocolIds.filter(protocolId => installed.has(protocolId)).map(protocolId => ({
    id: `source:${provider.id}:${protocolId}`, name: `${provider.name} · ${installedProtocols.find(protocol => protocol.id === protocolId)!.name}`,
    values: { enabled: true, protocolId, baseUrl, auth: 'api-key' as const, timeoutMs: 120_000,
      ...(source.kind === 'external' ? { sourceRef: { sourceId: source.sourceId, providerId: source.providerId } } : {}) },
  })));
}

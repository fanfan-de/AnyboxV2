import { createHash } from 'node:crypto';
import { immutable, validateCapabilities } from './domain.js';
import { modelsError } from './errors.js';
import type { Support, ProtocolDescriptor } from './types.js';
import type { ProviderTemplate } from './templates.js';
import type { CatalogConnectionHints, CatalogCost, CatalogModel, CatalogProvider, CatalogReasoningControl, CatalogSnapshot } from './catalog-types.js';

type ObjectValue = Record<string, unknown>;
const invalid = (): never => { throw modelsError('invalid-response'); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : invalid();
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const required = (value: unknown): string => nonempty(value) ? value : invalid();
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? [...new Set(value.filter(nonempty))] : [];
const support = (value: unknown): Support => value === true ? 'supported' : value === false ? 'unsupported' : 'unknown';
const optionalString = (key: string, value: unknown): ObjectValue => nonempty(value) ? { [key]: value } : {};

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
function connectionHints(provider: ObjectValue, override?: ObjectValue): CatalogConnectionHints {
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

function reasoningControls(value: unknown): readonly CatalogReasoningControl[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<CatalogReasoningControl>(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as ObjectValue;
    if (item.type === 'toggle') return [{ kind: 'toggle' as const }];
    if (item.type === 'effort') {
      const values = strings(item.values);
      return values.length ? [{ kind: 'effort' as const, values }] : [];
    }
    if (item.type === 'budget_tokens') return [{ kind: 'budget' as const,
      ...(number(item.min) && Number.isSafeInteger(item.min) ? { min: item.min } : {}),
      ...(number(item.max) && Number.isSafeInteger(item.max) ? { max: item.max } : {}) }];
    return [];
  });
}

function costFields(value: ObjectValue) {
  return Object.fromEntries([['input', value.input], ['output', value.output], ['cacheRead', value.cache_read], ['cacheWrite', value.cache_write], ['reasoning', value.reasoning]].filter(([, amount]) => number(amount)));
}
function cost(value: unknown): CatalogCost | undefined {
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

export function catalogSnapshotVersion(providers: readonly CatalogProvider[], models: readonly CatalogModel[]): string {
  return createHash('sha256').update(JSON.stringify({ providers, models })).digest('hex');
}

/** Pure normalization. Time is supplied by the source/asset boundary. */
export function normalizeModelsDevCatalog(input: unknown, sourceId = 'models.dev', fetchedAt = 0): CatalogSnapshot {
  required(sourceId);
  if (!number(fetchedAt)) invalid();
  const root = object(input), providers: CatalogProvider[] = [], models: CatalogModel[] = [], providerIds = new Set<string>();
  if (Object.keys(root).length > 5000) invalid();
  const compareKeys = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0;
  for (const [, value] of Object.entries(root).sort(compareKeys)) {
    const raw = object(value), id = required(raw.id), name = required(raw.name);
    if (providerIds.has(id)) invalid();
    providerIds.add(id);
    const hints = connectionHints(raw), documentationUrl = httpUrl(raw.doc);
    providers.push({ sourceId, id, name, ...(documentationUrl ? { documentationUrl } : {}), connectionHints: hints });
    const modelIds = new Set<string>();
    for (const [, entry] of Object.entries(object(raw.models)).sort(compareKeys)) {
      const model = object(entry), remoteModelId = required(model.id);
      if (modelIds.has(remoteModelId) || models.length >= 200_000) invalid();
      modelIds.add(remoteModelId);
      const modalities = model.modalities && typeof model.modalities === 'object' ? object(model.modalities) : {};
      const inputModes = strings(modalities.input), outputModes = strings(modalities.output);
      const controls = reasoningControls(model.reasoning_options);
      const efforts = [...new Set(controls.filter(control => control.kind === 'effort').flatMap(control => control.values ?? []))];
      const budget = controls.find(control => control.kind === 'budget' && control.min !== undefined && control.max !== undefined && control.min <= control.max);
      const limits = model.limit && typeof model.limit === 'object' ? object(model.limit) : {};
      const pricing = cost(model.cost);
      const override = model.provider === undefined ? undefined : object(model.provider);
      models.push({ sourceId, providerId: id, remoteModelId, name: required(model.name),
        ...optionalString('description', model.description), ...optionalString('family', model.family),
        ...optionalString('releaseDate', model.release_date), ...optionalString('lastUpdated', model.last_updated),
        ...optionalString('status', model.status), ...optionalString('modelType', model.type),
        ...(typeof model.open_weights === 'boolean' ? { openWeights: model.open_weights } : {}),
        suggestedCapabilities: {
          tools: { support: support(model.tool_call) }, streaming: { support: support(model.streaming) },
          imageInput: { support: inputModes.length ? inputModes.includes('image') ? 'supported' : 'unsupported' : 'unknown' },
          reasoning: { support: support(model.reasoning), ...(efforts.length ? { efforts } : {}),
            ...(budget ? { budget: { min: budget.min!, max: budget.max! } } : {}) },
        },
        controls: { temperature: support(model.temperature), ...(typeof model.structured_output === 'boolean' ? { structuredOutput: support(model.structured_output) } : {}), ...(controls.length ? { reasoning: controls } : {}) },
        modalities: { input: inputModes, output: outputModes },
        limits: Object.fromEntries(['context', 'input', 'output'].filter(key => number(limits[key])).map(key => [key, limits[key]])),
        ...(pricing ? { cost: pricing } : {}), connectionHints: override ? connectionHints(raw, override) : hints,
      });
    }
  }
  return immutable({ schemaVersion: 1, sourceId, fetchedAt, snapshotVersion: catalogSnapshotVersion(providers, models), providers, models });
}

/** Validate the module's own cache format, independently of any upstream format. */
export function validateCatalogSnapshot(input: unknown): asserts input is CatalogSnapshot {
  const value = object(input);
  if (value.schemaVersion !== 1 || !nonempty(value.sourceId) || !number(value.fetchedAt) || !nonempty(value.snapshotVersion) || !Array.isArray(value.providers) || !Array.isArray(value.models)) invalid();
  const sourceId = value.sourceId, ids = new Set<string>(), models = new Set<string>();
  const validateHints = (raw: unknown) => {
    const hints = object(raw);
    if (!Array.isArray(hints.protocolIds) || !hints.protocolIds.every(nonempty) || (hints.baseUrl !== undefined && httpUrl(hints.baseUrl, true) !== hints.baseUrl)) invalid();
  };
  for (const raw of value.providers as unknown[]) {
    const provider = object(raw), id = required(provider.id);
    if (provider.sourceId !== sourceId || ids.has(id)) invalid();
    ids.add(id); required(provider.name); validateHints(provider.connectionHints);
  }
  for (const raw of value.models as unknown[]) {
    const model = object(raw), key = `${required(model.providerId)}\u0000${required(model.remoteModelId)}`;
    if (model.sourceId !== sourceId || !ids.has(String(model.providerId)) || models.has(key)) invalid();
    models.add(key); required(model.name); validateHints(model.connectionHints);
    try { validateCapabilities(model.suggestedCapabilities as CatalogModel['suggestedCapabilities']); } catch { invalid(); }
    const controls = object(model.controls);
    if (!['supported', 'unsupported', 'unknown'].includes(String(controls.temperature))) invalid();
    if (controls.structuredOutput !== undefined && !['supported', 'unsupported', 'unknown'].includes(String(controls.structuredOutput))) invalid();
    if (controls.reasoning !== undefined) {
      if (!Array.isArray(controls.reasoning)) invalid();
      for (const rawControl of controls.reasoning as unknown[]) {
        const control = object(rawControl);
        if (!['toggle', 'effort', 'budget'].includes(String(control.kind)) || control.values !== undefined && (!Array.isArray(control.values) || !control.values.every(nonempty)) || control.min !== undefined && !number(control.min) || control.max !== undefined && !number(control.max)) invalid();
      }
    }
    const modes = object(model.modalities);
    if (!Array.isArray(modes.input) || !modes.input.every(nonempty) || !Array.isArray(modes.output) || !modes.output.every(nonempty)) invalid();
    const limits = object(model.limits);
    if (Object.values(limits).some(item => !number(item))) invalid();
    if (model.cost !== undefined) {
      const pricing = object(model.cost);
      if (pricing.currency !== 'USD' || pricing.unit !== 'million-tokens') invalid();
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) if (pricing[key] !== undefined && !number(pricing[key])) invalid();
      if (pricing.tiers !== undefined && (!Array.isArray(pricing.tiers) || pricing.tiers.some(tier => Object.values(object(tier)).some(item => !number(item))))) invalid();
    }
  }
  if (catalogSnapshotVersion(value.providers as CatalogProvider[], value.models as CatalogModel[]) !== value.snapshotVersion) invalid();
}

/** Only installed protocols yield templates; account records are never edited. */
export function resolveCatalogConnections(provider: CatalogProvider, installedProtocols: readonly ProtocolDescriptor[], hostTemplates: readonly ProviderTemplate[] = [], model?: CatalogModel): readonly ProviderTemplate[] {
  const installed = new Set(installedProtocols.map(protocol => protocol.id));
  const hints = model?.connectionHints ?? provider.connectionHints;
  const sameHints = hints.baseUrl === provider.connectionHints.baseUrl && JSON.stringify(hints.protocolIds) === JSON.stringify(provider.connectionHints.protocolIds);
  const matching = hostTemplates.filter(template => template.values.catalogRef?.sourceId === provider.sourceId && template.values.catalogRef.providerId === provider.id && installed.has(template.values.protocolId));
  if (sameHints && matching.length) return immutable(matching);
  // A model may narrow the protocol without changing the provider's address.
  // Keep only matching host recipes; never borrow an address for a different API.
  if (hints.baseUrl === provider.connectionHints.baseUrl) {
    const narrowed = matching.filter(template => hints.protocolIds.includes(template.values.protocolId));
    if (narrowed.length) return immutable(narrowed);
  }
  const baseUrl = hints.baseUrl ?? (sameHints ? matching[0]?.values.baseUrl : undefined);
  if (!baseUrl) return [];
  return immutable(hints.protocolIds.filter(protocolId => installed.has(protocolId)).map(protocolId => ({
    id: `catalog:${provider.sourceId}:${provider.id}:${protocolId}`, name: `${provider.name} · ${installedProtocols.find(protocol => protocol.id === protocolId)!.name}`,
    values: { enabled: true, protocolId, baseUrl, auth: 'api-key' as const, timeoutMs: 120_000, catalogRef: { sourceId: provider.sourceId, providerId: provider.id } },
  })));
}

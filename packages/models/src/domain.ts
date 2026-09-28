import { modelsError } from './errors.js';
import type { DeclaredCapabilities, GenerationOptions, ModelConfigurationInput, ModelInput, ModelMessage, ModelResult, ProviderConnectionInput, ProviderInput, ToolDefinition } from './types.js';

export function immutable<T>(value: T): T {
  try {
    const copy = structuredClone(value); const seen = new WeakSet<object>();
    const freeze = (item: unknown): void => {
      if (item && typeof item === 'object' && !seen.has(item)) { seen.add(item); Object.freeze(item); for (const part of Object.values(item)) freeze(part); }
    };
    freeze(copy);
    return copy;
  } catch { throw modelsError('invalid-config'); }
}
export function assert(condition: unknown): asserts condition { if (!condition) throw modelsError('invalid-config'); }
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  assert(record(value) && Object.keys(value).every(key => allowed.includes(key)));
}
export function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 8192; }
export function identifier(value: unknown): asserts value is string { assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)); }
export function json(value: unknown, depth = 0): boolean {
  if (depth > 60) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1));
  return record(value) && Object.values(value).every(item => json(item, depth + 1));
}
export function validateSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  assert(signal === undefined || signal instanceof AbortSignal);
}
export function validateConnection(value: ProviderConnectionInput): void {
  keys(value, ['providerDefinitionId', 'name', 'enabled', 'protocolId', 'baseUrl', 'auth', 'timeoutMs']);
  assert(nonempty(value.name) && typeof value.enabled === 'boolean'); identifier(value.protocolId);
  assert(typeof value.baseUrl === 'string');
  let url: URL; try { url = new URL(value.baseUrl); } catch { throw modelsError('invalid-config'); }
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
  assert(value.auth === 'none' || value.auth === 'api-key');
  assert(Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 2_147_483_647);
  identifier(value.providerDefinitionId);
}
export function connectionInput(value: ProviderConnectionInput): ProviderConnectionInput {
  return { providerDefinitionId: value.providerDefinitionId, name: value.name, enabled: value.enabled, protocolId: value.protocolId, baseUrl: value.baseUrl, auth: value.auth, timeoutMs: value.timeoutMs };
}
function validateHttpUrl(value: unknown, base = false): void {
  assert(nonempty(value));
  let url: URL;
  try { url = new URL(value); } catch { throw modelsError('invalid-config'); }
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (!base || !url.search && !url.hash));
}
export function validateProvider(value: ProviderInput): void {
  keys(value, ['name', 'documentationUrl', 'connectionHints']); assert(nonempty(value.name));
  validateHints(value.connectionHints);
  if (value.documentationUrl !== undefined) validateHttpUrl(value.documentationUrl);
}
export function validateHints(value: ProviderInput['connectionHints']): void {
  keys(value, ['baseUrl', 'protocolIds']); assert(Array.isArray(value.protocolIds)); value.protocolIds.forEach(identifier);
  assert(new Set(value.protocolIds).size === value.protocolIds.length);
  if (value.baseUrl !== undefined) validateHttpUrl(value.baseUrl, true);
}
export function validateCapabilities(value: DeclaredCapabilities): void {
  keys(value, ['tools', 'streaming', 'imageInput', 'reasoning']);
  for (const key of ['tools', 'streaming', 'imageInput', 'reasoning'] as const) {
    const cap = value[key];
    keys(cap, key === 'reasoning' ? ['support', 'efforts', 'modes', 'budget'] : ['support']);
    assert(['supported', 'unsupported', 'unknown'].includes(cap.support as string));
  }
  const reasoning = value.reasoning;
  for (const options of [reasoning.efforts, reasoning.modes]) {
    if (options !== undefined) assert(Array.isArray(options) && options.length > 0 && options.every(nonempty) && new Set(options).size === options.length);
  }
  if (reasoning.budget !== undefined) {
    keys(reasoning.budget, ['min', 'max']);
    assert(Number.isSafeInteger(reasoning.budget.min) && Number.isSafeInteger(reasoning.budget.max) && reasoning.budget.min >= 0 && reasoning.budget.max >= reasoning.budget.min);
  }
}
export function validateOptions(value: GenerationOptions): void {
  keys(value, ['temperature', 'maxOutputTokens', 'protocol']);
  if (value.temperature !== undefined) assert(typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0);
  if (value.maxOutputTokens !== undefined) assert(typeof value.maxOutputTokens === 'number' && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0);
  if (value.protocol !== undefined) assert(record(value.protocol) && json(value.protocol));
}
const supports = (value: unknown) => typeof value === 'string' && ['supported', 'unsupported', 'unknown'].includes(value);
const finiteNonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validateControls(value: ModelInput['controls']): void {
  keys(value, ['temperature', 'structuredOutput', 'reasoning']); assert(supports(value.temperature));
  assert(value.structuredOutput === undefined || supports(value.structuredOutput));
  if (value.reasoning === undefined) return;
  assert(Array.isArray(value.reasoning));
  for (const control of value.reasoning) {
    keys(control, ['kind', 'values', 'min', 'max']); assert(typeof control.kind === 'string' && ['toggle', 'effort', 'budget'].includes(control.kind));
    if (control.kind === 'toggle') { keys(control, ['kind']); continue; }
    if (control.kind === 'effort') {
      keys(control, ['kind', 'values']); assert(Array.isArray(control.values) && control.values.length > 0 && control.values.every(nonempty) && new Set(control.values).size === control.values.length);
      continue;
    }
    keys(control, ['kind', 'min', 'max']);
    for (const bound of [control.min, control.max]) assert(bound === undefined || finiteNonnegative(bound) && Number.isSafeInteger(bound));
    assert(control.min === undefined || control.max === undefined || Number(control.max) >= Number(control.min));
  }
}
function validateCost(value: ModelInput['cost']): void {
  if (value === undefined) return;
  const amounts = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
  keys(value, ['currency', 'unit', ...amounts, 'tiers']); assert(value.currency === 'USD' && value.unit === 'million-tokens');
  for (const key of amounts) assert(value[key] === undefined || finiteNonnegative(value[key]));
  if (value.tiers !== undefined) {
    assert(Array.isArray(value.tiers));
    for (const tier of value.tiers) {
      keys(tier, ['contextMin', 'contextMax', ...amounts]);
      for (const amount of Object.values(tier)) assert(finiteNonnegative(amount));
      assert(tier.contextMin === undefined || tier.contextMax === undefined || Number(tier.contextMax) >= Number(tier.contextMin));
    }
  }
}
export function validateModel(value: ModelInput): void {
  keys(value, ['name', 'providerId', 'remoteModelId', 'capabilities', 'controls', 'modalities', 'limits', 'connectionHints', 'cost', 'description', 'family', 'releaseDate', 'lastUpdated', 'status', 'openWeights', 'modelType']);
  assert(nonempty(value.name) && nonempty(value.remoteModelId)); identifier(value.providerId);
  for (const key of ['description', 'family', 'releaseDate', 'lastUpdated', 'status', 'modelType'] as const) assert(value[key] === undefined || nonempty(value[key]));
  assert(value.openWeights === undefined || typeof value.openWeights === 'boolean');
  validateCapabilities(value.capabilities); validateHints(value.connectionHints);
  keys(value.modalities, ['input', 'output']); assert(Array.isArray(value.modalities.input) && Array.isArray(value.modalities.output) && [...value.modalities.input, ...value.modalities.output].every(nonempty));
  assert(new Set(value.modalities.input).size === value.modalities.input.length && new Set(value.modalities.output).size === value.modalities.output.length);
  keys(value.limits, ['context', 'input', 'output']); assert(Object.values(value.limits).every(finiteNonnegative));
  validateControls(value.controls); validateCost(value.cost); assert(json(value));
}
export function validateConfiguration(value: ModelConfigurationInput): void {
  keys(value, ['modelDefinitionId', 'connectionId', 'name', 'enabled', 'capabilities', 'defaults', 'baseline']);
  identifier(value.modelDefinitionId); identifier(value.connectionId);
  assert(nonempty(value.name) && typeof value.enabled === 'boolean' && typeof value.baseline === 'boolean');
  validateCapabilities(value.capabilities); validateOptions(value.defaults);
}
export function configurationInput(value: ModelConfigurationInput): ModelConfigurationInput {
  return { name: value.name, enabled: value.enabled, connectionId: value.connectionId, modelDefinitionId: value.modelDefinitionId, capabilities: value.capabilities, defaults: value.defaults, baseline: value.baseline };
}
export function providerInput(value: ProviderInput): ProviderInput {
  return { name: value.name, connectionHints: value.connectionHints, ...(value.documentationUrl === undefined ? {} : { documentationUrl: value.documentationUrl }) };
}
export function modelInput(value: ModelInput): ModelInput {
  const { providerId, remoteModelId, name, capabilities, controls, modalities, limits, connectionHints, cost, description, family, releaseDate, lastUpdated, status, openWeights, modelType } = value;
  return Object.fromEntries(Object.entries({ providerId, remoteModelId, name, capabilities, controls, modalities, limits, connectionHints, cost, description, family, releaseDate, lastUpdated, status, openWeights, modelType }).filter(([, entry]) => entry !== undefined)) as unknown as ModelInput;
}
export function validateTools(tools: readonly ToolDefinition[]): void {
  assert(Array.isArray(tools)); const names = new Set<string>();
  for (const tool of tools) {
    keys(tool, ['name', 'description', 'parameters']);
    assert(typeof tool.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) && !names.has(tool.name)); names.add(tool.name);
    assert(tool.description === undefined || typeof tool.description === 'string');
    assert(record(tool.parameters) && json(tool.parameters));
  }
}
/** Validate tool-call/result correspondence without interpreting tool business schemas. */
export function validateMessages(messages: readonly ModelMessage[], allowPending: boolean): void {
  assert(Array.isArray(messages)); const pending = new Set<string>(); const seen = new Set<string>();
  for (const message of messages) {
    assert(record(message) && typeof message.content === 'string');
    if (message.role === 'tool') {
      keys(message, ['role', 'callId', 'content']);
      assert(typeof message.callId === 'string' && pending.delete(message.callId));
    } else {
      assert(pending.size === 0);
      assert(typeof message.role === 'string' && ['system', 'developer', 'user', 'assistant'].includes(message.role));
      keys(message, message.role === 'assistant' ? ['role', 'content', 'toolCalls'] : ['role', 'content']);
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        assert(Array.isArray(message.toolCalls));
        for (const call of message.toolCalls) {
          keys(call, ['id', 'name', 'arguments']);
          assert(nonempty(call.id) && nonempty(call.name) && !seen.has(call.id) && json(call.arguments));
          seen.add(call.id); pending.add(call.id);
        }
      }
    }
  }
  assert(allowPending || pending.size === 0);
}
export function validateResult(result: ModelResult, tools: readonly ToolDefinition[], history: readonly ModelMessage[]): void {
  try {
    keys(result, ['status', 'text', 'toolCalls', 'usage']);
    assert(['completed', 'incomplete', 'refused'].includes(result.status) && typeof result.text === 'string' && Array.isArray(result.toolCalls));
    assert(result.status === 'completed' || result.toolCalls.length === 0);
    assert(result.toolCalls.every(call => tools.some(tool => tool.name === call.name)));
    validateMessages([...history, { role: 'assistant', content: result.text, toolCalls: result.toolCalls }], true);
    if (result.usage !== undefined) {
      keys(result.usage, ['inputTokens', 'outputTokens', 'totalTokens']);
      assert(Object.values(result.usage).every(value => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)));
    }
  } catch { throw modelsError('invalid-response'); }
}
export function unknownCapabilities(): DeclaredCapabilities {
  return { tools: { support: 'unknown' }, streaming: { support: 'unknown' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } };
}

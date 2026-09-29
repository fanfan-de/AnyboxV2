import type { Component } from '@nya/core';
import { assert, equalJson, immutable, json, record } from '../domain.js';
import { modelsError } from '../errors.js';
import { modelsProtocolsServiceKey } from '../types.js';
import type { DeclaredCapabilities, EffectiveCapabilities, FormField, JsonValue, ProviderConnectionInput } from '../types.js';
import type { ModelsProtocolsService, NativeObject, NativeProtocol, NativeRecordDraft } from '../native-types.js';
export type { NativeObject } from '../native-types.js';
export interface ProtocolOptions { readonly fetch?: typeof globalThis.fetch }
export function captureOptions(options: ProtocolOptions): ProtocolOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'fetch') || (options.fetch !== undefined && typeof options.fetch !== 'function')) throw modelsError('invalid-config');
  return Object.freeze({ fetch: options.fetch ?? globalThis.fetch });
}
export const connectionFields: readonly FormField[] = [
  { key: 'baseUrl', label: 'API base URL', type: 'string', required: true },
  { key: 'auth', label: 'Authentication', type: 'enum', values: ['none', 'api-key'], required: true },
  { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', min: 1, integer: true, required: true },
];
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export function object(value: unknown): Record<string, JsonValue> { if (!record(value)) throw modelsError('invalid-response'); return value as Record<string, JsonValue>; }
export function native(value: unknown): NativeObject { if (!record(value) || !json(value)) throw modelsError('invalid-response'); return immutable(value as NativeObject); }
export function string(value: unknown): string { if (typeof value !== 'string') throw modelsError('invalid-response'); return value; }
export function nonempty(value: unknown): string { const result = string(value); if (!result.trim()) throw modelsError('invalid-response'); return result; }
export function array(value: unknown): JsonValue[] { if (!Array.isArray(value)) throw modelsError('invalid-response'); return value; }
export function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { throw modelsError('invalid-response'); } }
export function index(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw modelsError('invalid-response'); return Number(value); }
export function validateProvider(provider: ProviderConnectionInput, protocolId: string): void {
  try { const url = new URL(provider.baseUrl); if (provider.protocolId !== protocolId || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['none', 'api-key'].includes(provider.auth) || !Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 1) throw new Error(); }
  catch { throw modelsError('invalid-config'); }
}
export function optionKeys(options: NativeObject, allowed: readonly string[]): void { assert(record(options) && json(options) && Object.keys(options).every(key => allowed.includes(key))); }
export function numberOption(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER, integer = false, required = false): void {
  if (value === undefined && !required) return;
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)));
}
export function effortOption(value: unknown, declared: DeclaredCapabilities, allowed: readonly string[]): void {
  if (value === undefined) return;
  assert(typeof value === 'string' && allowed.includes(value));
  if (declared.reasoning.support !== 'supported' || !declared.reasoning.efforts?.includes(value)) throw modelsError('capability-unsupported');
}
export function effectiveCapabilities(declared: DeclaredCapabilities, disabled = false, search = false): EffectiveCapabilities {
  return { tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false,
    webSearch: search && declared.webSearch?.support === 'supported', reasoning: disabled ? { support: 'unsupported' } : declared.reasoning };
}
export function validateServerTools(value: JsonValue | undefined, declared: DeclaredCapabilities, protocolId: string): void {
  if (value === undefined) return;
  assert(Array.isArray(value) && value.length <= 1);
  if (value.length && declared.webSearch?.support !== 'supported') throw modelsError('capability-unsupported');
  for (const entry of value) {
    assert(record(entry));
    if (protocolId === 'responses') assert(Object.keys(entry).length === 1 && entry.type === 'web_search');
    else assert(Object.keys(entry).length === 2 && entry.type === 'web_search_20250305' && entry.name === 'web_search');
  }
}
/** Keep root-owned declarations fixed; each request appends only its own protocol input. */
export function conversation(state: NativeObject, intent: NativeObject, field: 'input' | 'messages', metadata: readonly string[]): NativeObject {
  optionKeys(intent, [field, ...metadata]);
  const added = array(intent[field]); added.forEach(object);
  const old = state[field] === undefined ? [] : array(state[field]);
  if (old.length && added.some(value => ['system', 'developer'].includes(String(object(value).role)))) throw modelsError('invalid-config');
  const next: Record<string, JsonValue> = { ...state, [field]: [...old, ...added] };
  for (const key of metadata) {
    if (intent[key] === undefined) continue;
    if (old.length && !equalJson(state[key], intent[key])) throw modelsError('invalid-config');
    next[key] = intent[key];
  }
  return native(next);
}
export function mergeTools(local: JsonValue | undefined, server: JsonValue | undefined): readonly JsonValue[] {
  const tools = local === undefined ? [] : array(local);
  const names = new Set<string>();
  for (const tool of tools) { const item = object(tool); const fn = item.function === undefined ? item : object(item.function); const name = nonempty(fn.name); if (names.has(name)) throw modelsError('invalid-config'); names.add(name); }
  return [...tools, ...(server === undefined ? [] : array(server))];
}
export function restoreRecords(protocolId: string, records: readonly NativeRecordDraft[], commit: (state: NativeObject, intent: NativeObject, response: NativeObject) => NativeObject, versions: readonly number[] = [1]): NativeObject {
  let state: NativeObject = {}, pending: NativeRecordDraft | undefined; const ids = new Set<string>();
  for (const record of records) {
    if (record.protocolId !== protocolId || !versions.includes(record.recordFormatVersion) || ids.has(record.id)) throw modelsError('invalid-response'); ids.add(record.id);
    if (record.kind === 'request') { if (pending) throw modelsError('invalid-response'); pending = record; }
    else if (record.kind === 'response' && pending?.exchangeId === record.exchangeId) { state = commit(state, native(pending.payload), native(record.payload)); pending = undefined; }
    else throw modelsError('invalid-response');
  }
  if (pending) throw modelsError('invalid-response');
  return state;
}
export function protocolComponent(protocol: NativeProtocol): Component.Object<void, { [modelsProtocolsServiceKey]: ModelsProtocolsService }> {
  return { name: `models-protocol-${protocol.descriptor.id}`, inject: [modelsProtocolsServiceKey], apply(ctx, _config, deps) {
    const registration = deps[modelsProtocolsServiceKey].register(protocol);
    ctx.effect(() => () => registration.unregister(), `unregister ${protocol.descriptor.id} protocol`);
  } };
}

/** The currently declared input contract is text and local function results; media stays unavailable. */
export function textBlocks(value: unknown, type: 'text' | 'input_text' = 'text'): void {
  if (typeof value === 'string') return;
  for (const item of array(value)) { const block = object(item); if (block.type !== type) throw modelsError('capability-unsupported'); string(block.text); }
}
export function requireLocalTools(value: JsonValue | undefined, enabled: boolean): void {
  if (value !== undefined && array(value).length && !enabled) throw modelsError('capability-unsupported');
}

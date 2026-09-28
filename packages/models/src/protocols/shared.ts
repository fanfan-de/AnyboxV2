import type { Component } from '@nya/core';
import { modelsError } from '../errors.js';
import { modelsProtocolsServiceKey, type DeclaredCapabilities, type EffectiveCapabilities, type FormField, type GenerationOptions, type JsonValue, type ModelProtocol, type ModelsProtocolsService, type ModelUsage, type ProviderConnectionInput, type ToolCall } from '../types.js';

export interface ProtocolOptions { readonly fetch?: typeof globalThis.fetch }
export function captureOptions(options: ProtocolOptions): ProtocolOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'fetch') ||
      (options.fetch !== undefined && typeof options.fetch !== 'function')) throw modelsError('invalid-config');
  return Object.freeze({ fetch: options.fetch ?? globalThis.fetch });
}
export type NativeObject = Record<string, unknown>;
export const commonFields: readonly FormField[] = [
  { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 },
  { key: 'maxOutputTokens', label: 'Maximum output tokens', type: 'number', min: 1, integer: true },
];
export const connectionFields: readonly FormField[] = [
  { key: 'baseUrl', label: 'API base URL', type: 'string', required: true },
  { key: 'auth', label: 'Authentication', type: 'enum', values: ['none', 'api-key'], required: true },
  { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', min: 1, integer: true, required: true },
];
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const effortField: FormField = { key: 'protocol.reasoningEffort', label: 'Reasoning effort', type: 'enum', values: reasoningEfforts, description: 'Only use values declared for this model. Omit to use the server default.' };
export function object(value: unknown): NativeObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw modelsError('invalid-response');
  return value as NativeObject;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw modelsError('invalid-response');
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw modelsError('invalid-response');
  return value;
}
export function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw modelsError('invalid-response'); }
}
export function parseTool(id: unknown, name: unknown, args: unknown): ToolCall {
  if (!string(id) || !string(name)) throw modelsError('invalid-response');
  const parsed = parseJson(string(args));
  // Function tools accept an object, never partial JSON or primitives.
  object(parsed);
  return { id: id as string, name: name as string, arguments: parsed as JsonValue };
}
export function usage(value: unknown, responses: boolean): ModelUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value);
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const [key, nativeKey] of [
    ['inputTokens', responses ? 'input_tokens' : 'prompt_tokens'],
    ['outputTokens', responses ? 'output_tokens' : 'completion_tokens'], ['totalTokens', 'total_tokens'],
  ] as const) {
    const count = raw[nativeKey];
    if (count !== undefined && count !== null) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw modelsError('invalid-response');
      result[key] = count;
    }
  }
  return result;
}
export function validateProvider(provider: ProviderConnectionInput, protocolId: string): void {
  try {
    const url = new URL(provider.baseUrl);
    if (provider.protocolId !== protocolId || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['none', 'api-key'].includes(provider.auth) || !Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 1) throw new Error();
  } catch { throw modelsError('invalid-config'); }
}
export function validateOptions(options: GenerationOptions, declared: DeclaredCapabilities, responses: boolean): void {
  if (Object.keys(options).some(key => !['temperature', 'maxOutputTokens', 'protocol'].includes(key))) throw modelsError('invalid-config');
  if (options.temperature !== undefined && (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw modelsError('invalid-config');
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) throw modelsError('invalid-config');
  const specific = options.protocol ?? {};
  if (specific === null || Array.isArray(specific) || typeof specific !== 'object') throw modelsError('invalid-config');
  if (Object.keys(specific).some(key => !['reasoningEffort', ...(responses ? ['reasoningSummary'] : [])].includes(key))) throw modelsError('invalid-config');
  const effort = specific.reasoningEffort;
  if (effort !== undefined) {
    if (typeof effort !== 'string' || !reasoningEfforts.includes(effort as typeof reasoningEfforts[number])) throw modelsError('invalid-config');
    if (declared.reasoning.support !== 'supported' || !declared.reasoning.efforts?.includes(effort)) throw modelsError('capability-unsupported');
  }
  const summary = specific.reasoningSummary;
  if (summary !== undefined && (typeof summary !== 'string' || !['auto', 'concise', 'detailed'].includes(summary))) throw modelsError('invalid-config');
  if (summary !== undefined && (declared.reasoning.support !== 'supported' || effort === 'none')) throw modelsError('capability-unsupported');
}
export function effectiveCapabilities(declared: DeclaredCapabilities, options: GenerationOptions): EffectiveCapabilities {
  const efforts = declared.reasoning.efforts?.filter(value => reasoningEfforts.includes(value as typeof reasoningEfforts[number]));
  return {
    tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false,
    reasoning: { support: options.protocol?.reasoningEffort === 'none' ? 'unsupported' : declared.reasoning.support, ...(efforts ? { efforts } : {}) },
  };
}
export function protocolComponent(protocol: ModelProtocol): Component.Object<void, { [modelsProtocolsServiceKey]: ModelsProtocolsService }> {
  return {
    name: `models-protocol-${protocol.descriptor.id}`,
    inject: [modelsProtocolsServiceKey],
    apply(ctx, _config, deps) {
      const registration = deps[modelsProtocolsServiceKey].register(protocol);
      ctx.effect(() => () => registration.unregister(), `unregister ${protocol.descriptor.id} protocol`);
    },
  };
}

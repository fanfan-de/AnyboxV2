import { immutable, json, record } from './domain.js';
import { modelsError } from './errors.js';
import type { JsonValue } from './types.js';
import type { LegacyParameterConverter, NativeObject, StoredParameters } from './native-types.js';

function convert(value: NativeObject, kind: 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-interactions'): NativeObject {
  if (!record(value) || !json(value) || Object.keys(value).some(key => !['temperature', 'maxOutputTokens', 'protocol'].includes(key))) throw modelsError('invalid-config');
  const specific = value.protocol ?? {};
  if (!record(specific)) throw modelsError('invalid-config');
  const result: Record<string, JsonValue> = {};
  const mappings: Record<string, readonly string[]> = kind === 'responses' ? { reasoningEffort: ['reasoning', 'effort'], reasoningSummary: ['reasoning', 'summary'] }
    : kind === 'chat-completions' ? { reasoningEffort: ['reasoning_effort'] }
    : kind === 'anthropic-messages' ? { reasoningMode: ['thinking', 'type'], reasoningBudgetTokens: ['thinking', 'budget_tokens'], reasoningDisplay: ['thinking', 'display'], reasoningEffort: ['output_config', 'effort'] }
    : { thinkingLevel: ['generation_config', 'thinking_level'], thinkingSummaries: ['generation_config', 'thinking_summaries'] };
  function put(path: readonly string[], value: JsonValue) { let target = result; for (const key of path.slice(0, -1)) target = (target[key] ??= {}) as Record<string, JsonValue>; target[path.at(-1)!] = value; }
  if (value.temperature !== undefined) {
    if (kind === 'gemini-interactions') throw modelsError('invalid-config');
    result.temperature = value.temperature;
  }
  if (value.maxOutputTokens !== undefined) put(kind === 'gemini-interactions' ? ['generation_config', 'max_output_tokens'] : [kind === 'responses' ? 'max_output_tokens' : kind === 'chat-completions' ? 'max_completion_tokens' : 'max_tokens'], value.maxOutputTokens);
  for (const [key, item] of Object.entries(specific)) { const path = mappings[key]; if (!path) throw modelsError('invalid-config'); put(path, item as JsonValue); }
  return immutable(result);
}
export const builtinLegacyParameterConverters: Readonly<Record<string, LegacyParameterConverter>> = Object.freeze(Object.fromEntries(
  (['responses', 'chat-completions', 'anthropic-messages', 'gemini-interactions'] as const).map(id => [id, (value: NativeObject) => convert(value, id)]),
));
/** Read-only old-format conversion. Unknown extensions keep their exact data for an explicit later migration. */
export function migrateLegacyParameters(protocolId: string, value: NativeObject, extra: Readonly<Record<string, LegacyParameterConverter>> = {}): StoredParameters {
  const converter = extra[protocolId] ?? builtinLegacyParameterConverters[protocolId];
  if (!converter) return immutable({ protocolId, formatVersion: 0 as const, value });
  try { const converted = converter(immutable(value)); if (!record(converted) || !json(converted)) throw modelsError('invalid-config'); return immutable({ protocolId, formatVersion: 1 as const, value: converted }); }
  catch { return immutable({ protocolId, formatVersion: 0 as const, value }); }
}

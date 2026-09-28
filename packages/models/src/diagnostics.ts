import type { NativeObject } from './native-types.js';
import type { JsonValue } from './types.js';

// Internal metadata never becomes a property of a public ModelsError.
const diagnostics = new WeakMap<Error, NativeObject>();
export function nativeDiagnostic(error: unknown): NativeObject | undefined { return error instanceof Error ? diagnostics.get(error) : undefined; }
export function withNativeDiagnostic<T extends Error>(error: T, diagnostic: NativeObject | undefined): T {
  if (diagnostic) diagnostics.set(error, diagnostic);
  return error;
}
/** Failure messages may echo credentials. Keep only terminal identity and native blocks. */
export function terminalDiagnostic(raw: NativeObject, blocks?: { field: 'output' | 'content'; values: readonly JsonValue[] }): NativeObject {
  const value: Record<string, JsonValue> = {};
  for (const key of ['id', 'type', 'object', 'status', 'stop_reason', 'code']) if (typeof raw[key] === 'string') value[key] = raw[key];
  if (raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error)) {
    const error: Record<string, JsonValue> = {}, original = raw.error as NativeObject;
    for (const key of ['type', 'code']) if (typeof original[key] === 'string') error[key] = original[key];
    value.error = error;
  }
  for (const key of ['output', 'content']) if (Array.isArray(raw[key])) value[key] = raw[key];
  if (blocks && (!Array.isArray(value[blocks.field]) || !(value[blocks.field] as JsonValue[]).length)) value[blocks.field] = [...blocks.values];
  return sanitizeDiagnostic(value);
}
/** Also redact the captured credential from diagnostic blocks and extension fields. */
export function sanitizeDiagnostic(value: NativeObject, credential?: string): NativeObject {
  const sensitive = new Set(['message', 'headers', 'authorization', 'apikey', 'xapikey', 'xgoogapikey', 'credential', 'credentialref', 'secret', 'token']);
  const clean = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return credential ? value.split(credential).join('[redacted]') : value;
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, entry]) => (key === 'message' && typeof entry === 'object') || !sensitive.has(key.replace(/[-_]/gu, '').toLowerCase())).map(([key, value]) => [key, clean(value)]));
    return value;
  };
  return clean(value) as NativeObject;
}

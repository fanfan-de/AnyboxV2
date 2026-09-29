import { createHash } from 'node:crypto';
import { assert, equalJson, immutable, keys } from './domain.js';
import { modelsError } from './errors.js';
import { joinOperation, throwAborted } from './lifecycle.js';
import type { NativeImageResourceRef, NativeRecordDraft, NativeResourceResolver } from './native-types.js';

const prefix = 'urn:anybox:resource:';
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id);
export const nativeWireLimit = 32 * 1024 * 1024;
export function nativeImageResourceUri(id: string): string {
  assert(validId(id)); return prefix + encodeURIComponent(id);
}
export function parseNativeImageResourceUri(value: string): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  try { const id = decodeURIComponent(value.slice(prefix.length)); return validId(id) && nativeImageResourceUri(id) === value ? id : undefined; }
  catch { return undefined; }
}
export function captureResourceRefs(input: readonly NativeImageResourceRef[] = []): readonly NativeImageResourceRef[] {
  assert(Array.isArray(input)); const ids = new Set<string>();
  for (const ref of input) {
    keys(ref, ['id', 'sha256', 'byteLength', 'mimeType']);
    assert(validId(ref.id) && !ids.has(ref.id) && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256) && typeof ref.byteLength === 'number' && Number.isSafeInteger(ref.byteLength) && ref.byteLength > 0 &&
      typeof ref.mimeType === 'string' && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ref.mimeType));
    ids.add(ref.id);
  }
  return immutable(input);
}
export function addResourceRefs(target: Map<string, NativeImageResourceRef>, refs: readonly NativeImageResourceRef[]): void {
  for (const ref of refs) { const previous = target.get(ref.id); assert(!previous || equalJson(previous, ref)); target.set(ref.id, ref); }
}
export function restoreResourceRefs(records: readonly NativeRecordDraft[]): Map<string, NativeImageResourceRef> {
  const refs = new Map<string, NativeImageResourceRef>();
  for (const record of records) {
    assert(record.recordFormatVersion === 2 || record.resourceRefs === undefined);
    assert(record.kind === 'request' || record.resourceRefs === undefined);
    addResourceRefs(refs, captureResourceRefs(record.resourceRefs));
  }
  return refs;
}
export function requireResourceSet(ids: readonly string[], refs: readonly NativeImageResourceRef[]): void {
  const wanted = new Set(ids); assert(wanted.size === refs.length && refs.every(ref => wanted.has(ref.id)));
}
export function captureResourceResolver(value: NativeResourceResolver | undefined): NativeResourceResolver | undefined {
  if (value === undefined) return undefined;
  assert(value !== null && typeof value === 'object' && typeof value.read === 'function');
  return Object.freeze({ read: value.read.bind(value) });
}
/** Each read is joined before its bytes become wire data. Host paths/errors never escape. */
export async function resourceDataUrl(ref: NativeImageResourceRef, resources: NativeResourceResolver | undefined, signal: AbortSignal): Promise<string> {
  throwAborted(signal);
  if (!resources) throw modelsError('resource-unavailable');
  let bytes: Uint8Array;
  try { bytes = await joinOperation(resources.read(ref, { signal }), signal); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'cleanup-failure') throw modelsError('cleanup-failure');
    if (signal.aborted) throw modelsError('cancelled');
    throw modelsError('resource-unavailable');
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw modelsError('invalid-resource');
  return `data:${ref.mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

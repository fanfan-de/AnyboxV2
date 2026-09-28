import { immutable, keys } from './domain.js';
import { modelsError } from './errors.js';
import type { NativeObject } from './native-types.js';

export interface NativeEventQueue {
  readonly events: AsyncIterableIterator<NativeObject>;
  readonly status: 'open' | 'closed' | 'overflow';
  readonly buffered: number;
  /** Pass directly to generate({ onEvent }). This never waits for a consumer. */
  onEvent(event: NativeObject): void;
  close(): void;
}
/** Host-side streaming bridge: overflow ends only this display subscription. */
export function createNativeEventQueue(options: { capacity?: number; maxBufferedBytes?: number } = {}): NativeEventQueue {
  keys(options, ['capacity', 'maxBufferedBytes']);
  const capacity = options.capacity ?? 128;
  const maxBytes = options.maxBufferedBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw modelsError('invalid-config');
  let status: NativeEventQueue['status'] = 'open';
  let bytes = 0;
  const buffered: { event: NativeObject; bytes: number }[] = [];
  // One outstanding read per subscription keeps the consumer side bounded as well.
  let waiting: ((value: IteratorResult<NativeObject>) => void) | undefined;
  const finish = (state: 'closed' | 'overflow') => {
    if (status !== 'open') return;
    status = state; buffered.length = 0; bytes = 0;
    waiting?.({ done: true, value: undefined }); waiting = undefined;
  };
  const events: AsyncIterableIterator<NativeObject> = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buffered.length) {
        const next = buffered.shift()!; bytes -= next.bytes;
        return Promise.resolve({ done: false as const, value: next.event });
      }
      if (status !== 'open') return Promise.resolve({ done: true as const, value: undefined });
      if (waiting) return Promise.reject(modelsError('busy'));
      return new Promise(resolve => { waiting = resolve; });
    },
    return() { finish('closed'); return Promise.resolve({ done: true as const, value: undefined }); },
  };
  return {
    events, get status() { return status; }, get buffered() { return buffered.length; },
    onEvent(event) {
      if (status !== 'open') return;
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (size > maxBytes || (!waiting && (buffered.length >= capacity || bytes + size > maxBytes))) { finish('overflow'); return; }
      const copy = immutable(event);
      if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value: copy }); }
      else { buffered.push({ event: copy, bytes: size }); bytes += size; }
    },
    close() { finish('closed'); },
  };
}

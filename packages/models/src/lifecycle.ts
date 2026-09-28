import { modelsError, normalizeError } from './errors.js';
import type { ProtocolOperation } from './types.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function abortLink(signal: AbortSignal | undefined, target: AbortController): () => void {
  const abort = () => target.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}
export function throwAborted(signal: AbortSignal): void { if (signal.aborted) throw modelsError('cancelled'); }
export function cancelOperation(operation: Pick<ProtocolOperation<unknown>, 'cancel'>): boolean {
  try { operation.cancel(); return true; } catch { return false; }
}
/** Consume both promises immediately; never substitute abort for actual transport exit. */
export async function joinOperation<T>(operation: ProtocolOperation<T>, signal: AbortSignal): Promise<T> {
  let cancelFailed = false, cancellationRequested = false;
  const abort = () => { if (cancellationRequested) return; cancellationRequested = true; if (!cancelOperation(operation)) cancelFailed = true; };
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  let value!: T;
  let resultError: unknown;
  let resultFailed = false;
  let cleanupFailed = false;
  try {
    await Promise.all([
      operation.result.then(result => { value = result; }, error => { resultFailed = true; resultError = error; abort(); }),
      operation.done.catch(() => { cleanupFailed = true; abort(); throw modelsError('cleanup-failure'); }),
    ]).catch(error => { if (!cleanupFailed) throw error; });
  } finally { signal.removeEventListener('abort', abort); }
  if (cleanupFailed || cancelFailed) throw modelsError('cleanup-failure');
  throwAborted(signal);
  if (resultFailed) throw normalizeError(resultError);
  return value;
}

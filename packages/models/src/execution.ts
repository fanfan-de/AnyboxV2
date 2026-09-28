import { randomUUID } from 'node:crypto';
import { assert, equalJson, immutable, json, keys } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { nativeDiagnostic, sanitizeDiagnostic } from './diagnostics.js';
import { abortLink, deferred, joinOperation } from './lifecycle.js';
import type { EffectiveCapabilities, ProtocolOperation, ProviderConnectionInput } from './types.js';
import type { NativeExecution, NativeExitReport, NativeModelSnapshot, NativeObject, NativeProtocol, NativeRecordDraft, NativeReply, NativeRestoreState } from './native-types.js';

export interface ExecutionResources {
  readonly protocol: NativeProtocol;
  readonly provider: ProviderConnectionInput;
  readonly credential?: string;
  readonly snapshot: NativeModelSnapshot;
  readonly capabilities: EffectiveCapabilities;
  readonly restore?: NativeRestoreState;
  readonly controller: AbortController;
  readonly onRelease: (cleanupFailed?: boolean) => void;
}
export function createExecution(input: ExecutionResources): NativeExecution {
  let credential = input.credential;
  input = { ...input, credential: undefined };
  const snapshot = immutable(input.snapshot), capabilities = immutable(input.capabilities);
  let context = immutable(input.protocol.restore(input.restore?.records ?? []));
  const restoredPreviousId = input.restore?.records.at(-1)?.id ?? null;
  input = { ...input, restore: undefined };
  let state: 'open' | 'closing' | 'closed' = 'open';
  let active: ProtocolOperation<NativeReply> | undefined;
  let prepared = false, cleanupFailed = false, released = false, restorable = true;
  let closePromise: Promise<NativeExitReport> | undefined;
  let previousId = restoredPreviousId;
  const records: NativeRecordDraft[] = [];
  const release = () => {
    if (released) return;
    released = true; state = 'closed'; credential = undefined; context = {};
    input.controller.signal.removeEventListener('abort', onAbort);
    input.onRelease(cleanupFailed);
  };
  const close = (): Promise<NativeExitReport> => {
    if (closePromise) return closePromise;
    state = 'closing'; prepared = false;
    const owned = active;
    closePromise = Promise.resolve().then(async () => {
      if (owned) { try { await owned.done; } catch { cleanupFailed = true; } }
      const report: NativeExitReport = immutable({ records,
        ...(!cleanupFailed && restorable && records.at(-1)?.kind === 'response' ? { restoreState: { protocolId: snapshot.protocolId, recordFormatVersion: 1 as const, modelSnapshot: snapshot } } : {}),
        cleanup: cleanupFailed ? 'failed' : 'succeeded' });
      release(); return report;
    });
    input.controller.abort();
    return closePromise;
  };
  const onAbort = () => { void close(); };
  input.controller.signal.addEventListener('abort', onAbort, { once: true });
  return Object.freeze({ snapshot, capabilities, signal: input.controller.signal, close,
    prepareExchange(intent) {
      if (state !== 'open' || input.controller.signal.aborted) throw modelsError('closed');
      if (active || prepared) throw modelsError('busy');
      assert(json(intent)); const captured = immutable(intent);
      const requestBody = immutable(input.protocol.prepare({ state: context, intent: captured, remoteModelId: snapshot.remoteModelId, parameters: snapshot.parameters.value, capabilities }));
      assert(json(requestBody));
      const exchangeId = randomUUID();
      const request = immutable({ protocolId: snapshot.protocolId, exchangeId, intent: captured, precedingRecordId: previousId });
      const record: NativeRecordDraft = immutable({ id: randomUUID(), exchangeId, protocolId: snapshot.protocolId, recordFormatVersion: 1, kind: 'request', payload: captured });
      prepared = true; let started = false;
      return Object.freeze({ exchangeId, request, record,
        start(onEvent?: (event: NativeObject) => void): ProtocolOperation<NativeReply> {
          if (state !== 'open' || input.controller.signal.aborted) throw modelsError('closed');
          if (started || !prepared || active) throw modelsError('busy');
          assert(onEvent === undefined || typeof onEvent === 'function');
          started = true; prepared = false; records.push(record);
          const result = deferred<NativeReply>(), done = deferred<void>();
          const controller = new AbortController(), unlink = abortLink(input.controller.signal, controller);
          let observer = onEvent, timedOut = false;
          const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.provider.timeoutMs);
          const event = (value: NativeObject) => {
            if (!observer || controller.signal.aborted) return;
            try { const returned: unknown = observer(immutable(value)); if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') void Promise.resolve(returned).catch(() => { observer = undefined; }); }
            catch { observer = undefined; }
          };
          const handle = Object.freeze({ result: result.promise, done: done.promise, cancel: () => controller.abort() });
          active = handle;
          void Promise.resolve().then(async () => {
            let candidate: NativeObject | undefined, next: NativeObject | undefined, diagnostic: NativeObject | undefined;
            let failure: ReturnType<typeof modelsError> | undefined;
            try {
              if (controller.signal.aborted) throw modelsError('cancelled');
              const operation = input.protocol.exchange({ provider: input.provider, credential, signal: controller.signal, request: requestBody, onEvent: event });
              // Capture a diagnostic candidate even if transport cleanup subsequently fails.
              void operation.result.then(value => { candidate = immutable(value); }, error => { diagnostic = nativeDiagnostic(error); }).catch(() => {});
              candidate = immutable(await joinOperation(operation, controller.signal));
              assert(json(candidate));
              next = immutable(input.protocol.commit({ state: context, intent: captured, request: requestBody, response: candidate }));
              assert(json(next));
            } catch (error) { diagnostic ??= nativeDiagnostic(error); failure = normalizeError(error); }
            clearTimeout(timer); unlink(); observer = undefined;
            if (failure?.code !== 'cleanup-failure' && controller.signal.aborted) failure = modelsError(timedOut ? 'timeout' : 'cancelled');
            let responseRecord: NativeRecordDraft | undefined;
            if (failure) restorable = false;
            if (!failure && candidate && next) {
              context = next;
              responseRecord = immutable({ id: randomUUID(), exchangeId, protocolId: snapshot.protocolId, recordFormatVersion: 1, kind: 'response', payload: candidate });
              records.push(responseRecord); previousId = responseRecord.id;
            } else if (diagnostic ?? candidate) records.push(immutable({ id: randomUUID(), exchangeId, protocolId: snapshot.protocolId, recordFormatVersion: 1, kind: 'diagnostic', payload: sanitizeDiagnostic((diagnostic ?? candidate)!, credential) }));
            active = undefined;
            if (failure?.code === 'cleanup-failure') { cleanupFailed = true; state = 'closing'; done.reject(failure); void close(); }
            else done.resolve();
            if (failure) result.reject(failure);
            else result.resolve(immutable({ exchangeId, response: candidate!, records: [record, responseRecord!] }));
          }).catch(() => {
            clearTimeout(timer); unlink(); observer = undefined; active = undefined; cleanupFailed = true;
            const error = modelsError('cleanup-failure'); done.reject(error); result.reject(error); void close();
          });
          return handle;
        },
      });
    },
  } satisfies NativeExecution);
}
/** Scope changes never rewrite native history or use a credential reference as identity. */
export function validateRestore(restore: NativeRestoreState, snapshot: NativeModelSnapshot): void {
  keys(restore, ['protocolId', 'recordFormatVersion', 'modelSnapshot', 'records']);
  assert(restore.protocolId === snapshot.protocolId && restore.recordFormatVersion === 1 && Array.isArray(restore.records));
  const old = restore.modelSnapshot; assert(old?.schemaVersion === 3);
  for (const key of ['modelId', 'modelDefinitionId', 'modelDefinitionVersionId', 'remoteModelId', 'providerId', 'protocolId', 'historyScopeEpoch'] as const) assert(old[key] === snapshot[key]);
  assert(equalJson(old.parameters, snapshot.parameters) && equalJson(old.capabilities, snapshot.capabilities));
  const ids = new Set<string>(); let request: NativeRecordDraft | undefined;
  for (const item of restore.records) {
    assert(item.protocolId === snapshot.protocolId && item.recordFormatVersion === 1 && typeof item.id === 'string' && !ids.has(item.id) && json(item.payload)); ids.add(item.id);
    if (item.kind === 'request') { assert(!request); request = item; }
    else { assert(item.kind === 'response' && request?.exchangeId === item.exchangeId); request = undefined; }
  }
  assert(!request && restore.records.length > 0);
}

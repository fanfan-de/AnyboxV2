import { assert, immutable, keys, validateMessages, validateResult } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { abortLink, deferred, joinOperation } from './lifecycle.js';
import type { EffectiveCapabilities, ExecutionSnapshot, ModelCall, ModelEvent, ModelExecution, ModelMessage, ModelProtocol, ProtocolOutcome, ProviderInput, ToolDefinition } from './types.js';

export interface ExecutionResources {
  readonly protocol: ModelProtocol;
  readonly provider: ProviderInput;
  readonly credential?: string;
  readonly snapshot: ExecutionSnapshot;
  readonly capabilities: EffectiveCapabilities;
  readonly tools: readonly ToolDefinition[];
  readonly history: readonly ModelMessage[];
  readonly controller: AbortController;
  readonly onRelease: (cleanupFailed?: boolean) => void;
}

export function createExecution(input: ExecutionResources): ModelExecution {
  let credential = input.credential;
  const resources = {
    protocol: input.protocol, provider: input.provider, snapshot: input.snapshot, capabilities: input.capabilities,
    tools: input.tools, controller: input.controller, onRelease: input.onRelease,
  };
  let history = input.history;
  let continuation: unknown;
  let state: 'open' | 'closing' | 'closed' = 'open';
  let active: ModelCall | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanupFailed = false;
  let released = false;
  const snapshot = immutable(resources.snapshot);
  const capabilities = immutable(resources.capabilities);
  const release = (failed = false) => {
    cleanupFailed ||= failed;
    if (released) return;
    released = true; state = 'closed'; credential = undefined; history = []; continuation = undefined;
    resources.controller.signal.removeEventListener('abort', onAbort);
    resources.onRelease(cleanupFailed);
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    state = 'closing';
    const owned = active;
    closePromise = Promise.resolve().then(async () => {
      try { if (owned) await owned.done; if (cleanupFailed) throw modelsError('cleanup-failure'); } finally { release(); }
    });
    void closePromise.catch(() => {});
    resources.controller.abort();
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  resources.controller.signal.addEventListener('abort', onAbort, { once: true });

  return Object.freeze({
    snapshot, capabilities, close,
    generate(input): ModelCall {
      if (state !== 'open' || resources.controller.signal.aborted) throw modelsError('closed');
      if (active) throw modelsError('busy');
      keys(input, ['messages', 'onEvent']); assert(input.onEvent === undefined || typeof input.onEvent === 'function');
      let added: readonly ModelMessage[];
      try { added = immutable(input.messages); } catch { throw modelsError('invalid-config'); }
      const messages = immutable([...history, ...added]);
      validateMessages(messages, false);
      const result = deferred<import('./types.js').ModelResult>();
      const done = deferred<void>();
      const controller = new AbortController();
      const unlink = abortLink(resources.controller.signal, controller);
      let observer = input.onEvent;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, resources.provider.timeoutMs);
      const onEvent = (event: ModelEvent): void => {
        if (!observer || controller.signal.aborted) return;
        try {
          // Also isolate an accidentally async listener's rejected promise.
          const returned: unknown = observer(immutable(event));
          if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(returned).catch(() => { observer = undefined; });
          }
        } catch { observer = undefined; }
      };
      const handle: ModelCall = Object.freeze({ result: result.promise, done: done.promise, cancel: () => controller.abort() });
      active = handle;
      void Promise.resolve().then(async () => {
        let candidate: ProtocolOutcome | undefined;
        let error: ReturnType<typeof modelsError> | undefined;
        try {
          if (controller.signal.aborted) throw modelsError('cancelled');
          const operation = resources.protocol.call({
            provider: resources.provider, credential, signal: controller.signal,
            remoteModelId: snapshot.remoteModelId, options: snapshot.options, capabilities,
            messages, newMessages: added, tools: resources.tools, continuation, onEvent,
          });
          candidate = await joinOperation(operation, controller.signal);
          validateResult(candidate.result, resources.tools, messages);
          // Copy before final commit, so protocol-owned objects cannot mutate public results.
          candidate = { result: immutable(candidate.result), continuation: candidate.continuation };
        } catch (failure) { error = normalizeError(failure); }
        clearTimeout(timer); unlink(); observer = undefined;
        // No await between this cancellation check, commit, unlocking, and publication.
        if (error?.code !== 'cleanup-failure' && controller.signal.aborted) error = modelsError(timedOut ? 'timeout' : 'cancelled');
        if (!error && candidate) {
          if (candidate.result.status === 'completed') {
            history = immutable([...messages, { role: 'assistant', content: candidate.result.text, toolCalls: candidate.result.toolCalls }]);
            continuation = candidate.continuation;
          } else { release(); }
        }
        if (error?.code === 'cleanup-failure') release(true);
        active = undefined;
        if (error?.code === 'cleanup-failure') done.reject(error); else done.resolve();
        if (error) result.reject(error); else result.resolve(candidate!.result);
      }).catch(() => {
        // Defensive ownership barrier even for a broken trusted protocol implementation.
        clearTimeout(timer); unlink(); observer = undefined; active = undefined; release(true);
        const error = modelsError('cleanup-failure'); done.reject(error); result.reject(error);
      });
      return handle;
    },
  } satisfies ModelExecution);
}

import { assert, identifier, immutable, keys, validateSignal } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { abortLink, deferred, joinOperation, throwAborted } from './lifecycle.js';
import type { GenerateTextInput, GenerateTextResult, NativeExecution, NativeProtocolLease, NativeTextGenerationAdapter } from './native-types.js';
import type { ProtocolOperation } from './types.js';

interface GenerationResources {
  readonly adapter: NativeTextGenerationAdapter;
  readonly lease: NativeProtocolLease;
  open(signal: AbortSignal): Promise<NativeExecution>;
  /** Registers the whole call before initialization, and removes it after all cleanup. */
  track(operation: ProtocolOperation<GenerateTextResult>): (cleanupFailed: boolean) => void;
}

/** Internal single-use orchestration; the runtime supplies its existing generation and ownership. */
export function createTextGeneration(
  input: GenerateTextInput,
  capture: (input: Omit<GenerateTextInput, 'signal'>) => GenerationResources,
): ProtocolOperation<GenerateTextResult> {
  const result = deferred<GenerateTextResult>(), done = deferred<void>();
  const controller = new AbortController();
  const operation = Object.freeze({ result: result.promise, done: done.promise, cancel: () => controller.abort() });
  let resources: GenerationResources | undefined;
  let captured: Omit<GenerateTextInput, 'signal'> | undefined;
  let finish: ((failed: boolean) => void) | undefined;
  const unlinks: (() => void)[] = [];
  let failure: ReturnType<typeof modelsError> | undefined;
  try {
    keys(input, ['modelId', 'instruction', 'input', 'signal']); identifier(input.modelId); validateSignal(input.signal);
    assert(typeof input.input === 'string' && input.input.trim().length > 0);
    assert(input.instruction === undefined || typeof input.instruction === 'string' && input.instruction.trim().length > 0);
    captured = immutable({ modelId: input.modelId, input: input.input, ...(input.instruction === undefined ? {} : { instruction: input.instruction }) });
    resources = capture(captured);
    finish = resources.track(operation);
    unlinks.push(abortLink(input.signal, controller), abortLink(resources.lease.signal, controller));
  } catch (error) { failure = modelsError(normalizeError(error, 'invalid-config').code); }

  void Promise.resolve().then(async () => {
    let execution: NativeExecution | undefined;
    let value: GenerateTextResult | undefined;
    let failedCleanup = false;
    try {
      if (failure) throw failure;
      throwAborted(controller.signal);
      execution = await resources!.open(controller.signal);
      throwAborted(controller.signal);
      const adapter = resources!.adapter;
      adapter.validateParameters(execution.snapshot.parameters.value);
      const intent = adapter.createIntent({ input: captured!.input, ...(captured!.instruction === undefined ? {} : { instruction: captured!.instruction }) });
      const reply = await joinOperation(execution.prepareExchange(intent, { responseMode: 'complete' }).start(), controller.signal);
      const text = adapter.readText(reply.response);
      if (typeof text !== 'string' || text.trim().length === 0) throw modelsError('invalid-response');
      value = immutable({ text, modelId: execution.snapshot.modelId, modelRevision: execution.snapshot.modelRevision, protocolId: execution.snapshot.protocolId });
    } catch (error) {
      failure = modelsError(normalizeError(error).code);
      failedCleanup = failure.code === 'cleanup-failure';
    }
    // Even rejected initialization and late results remain owned until their resources exit.
    try { if (execution && (await execution.close()).cleanup === 'failed') failedCleanup = true; }
    catch { failedCleanup = true; }
    try { resources?.lease.release(); } catch { failedCleanup = true; }
    for (const unlink of unlinks) { try { unlink(); } catch { failedCleanup = true; } }
    finish?.(failedCleanup);
    if (failedCleanup) {
      const error = modelsError('cleanup-failure'); done.reject(error); result.reject(error);
    } else {
      done.resolve();
      if (controller.signal.aborted) failure = modelsError('cancelled');
      if (failure) result.reject(failure); else result.resolve(value!);
    }
  }).catch(() => {
    // Runtime hooks are synchronous and trusted; a hook failure still settles both public promises.
    const error = modelsError('cleanup-failure'); done.reject(error); result.reject(error);
  });
  return operation;
}

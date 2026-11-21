import { createHash } from 'node:crypto';
import { assert, equalJson, immutable, json, keys, record } from './domain.js';
import type { NativeManagedTools, NativeManagedSend, NativeObject } from './native-types.js';
import type { ProviderSettings, ProtocolOperation } from './types.js';
import { modelsError } from './errors.js';

type ProviderIdentity = Pick<ProviderSettings, 'id' | 'versionId' | 'protocolId'>;

export function nativeSearchTarget(provider: ProviderIdentity): string {
  return createHash('sha256').update(JSON.stringify([provider.id, provider.versionId, provider.protocolId])).digest('hex');
}

export function nativeSearchTool(provider: ProviderIdentity) {
  const version = provider.protocolId === 'responses' ? 'web_search' :
    provider.protocolId === 'anthropic-messages' ? 'web_search_20250305' : undefined;
  return version ? Object.freeze({ environmentId: 'model-search', targetId: nativeSearchTarget(provider), toolId: 'web_search', version }) : undefined;
}

export function captureManagedTools(value: NativeManagedTools): NativeManagedTools {
  keys(value, ['functions', 'hostedSearchTarget', 'bindingId', 'runSend']);
  assert(Array.isArray(value.functions) && value.functions.length <= 256 && typeof value.runSend === 'function');
  assert(value.bindingId === undefined || typeof value.bindingId === 'string');
  assert(value.hostedSearchTarget === undefined || typeof value.hostedSearchTarget === 'string' && /^[0-9a-f]{64}$/.test(value.hostedSearchTarget));
  const names = new Set<string>();
  for (const fn of value.functions) {
    keys(fn, ['name', 'description', 'parameters']);
    assert(typeof fn.name === 'string' && fn.name.length > 0 && !names.has(fn.name));
    assert(fn.description === undefined || typeof fn.description === 'string');
    assert(record(fn.parameters) && json(fn.parameters));
    names.add(fn.name);
  }
  return Object.freeze({ functions: immutable(value.functions), hostedSearchTarget: value.hostedSearchTarget,
    bindingId: value.bindingId, runSend: value.runSend.bind(value) });
}

/** Bind the exact protocol descriptors that will be compared at the transport boundary. */
export function bindManagedTools(policy: NativeManagedTools, provider: ProviderIdentity, parameters: NativeObject) {
  const hosted = policy.hostedSearchTarget ? nativeSearchTool(provider) : undefined;
  if (policy.hostedSearchTarget && (!hosted || hosted.targetId !== policy.hostedSearchTarget ||
    !Array.isArray(parameters.tools) || parameters.tools.length !== 1)) throw modelsError('capability-unsupported');
  const nativeTools: NativeObject[] = policy.functions.map(fn => {
    const definition = { name: fn.name, ...(fn.description === undefined ? {} : { description: fn.description }), parameters: fn.parameters };
    switch (provider.protocolId) {
      case 'chat-completions': return { type: 'function', function: definition } as NativeObject;
      case 'anthropic-messages': return { name: fn.name, ...(fn.description === undefined ? {} : { description: fn.description }), input_schema: fn.parameters } as NativeObject;
      case 'responses': return { type: 'function', ...definition, strict: false } as NativeObject;
      case 'gemini-interactions': return { type: 'function', ...definition } as NativeObject;
      default: throw modelsError('protocol-unavailable');
    }
  });
  const { tools: configured, ...otherParameters } = parameters;
  if (hosted) {
    assert(!policy.functions.some(fn => fn.name === 'web_search'));
    nativeTools.push((configured as NativeObject[])[0]!);
  }
  const tools = immutable(nativeTools);
  const fingerprint = createHash('sha256').update(JSON.stringify([policy.bindingId ?? null, policy.hostedSearchTarget ?? null, tools])).digest('hex');
  const paths: Readonly<Record<string, string>> = { responses: 'responses', 'anthropic-messages': 'messages',
    'chat-completions': 'chat/completions', 'gemini-interactions': 'interactions' };
  const path = paths[provider.protocolId];
  if (!path) throw modelsError('protocol-unavailable');
  return {
    fingerprint, parameters: hosted ? parameters : immutable(otherParameters),
    send(exchangeId: string, current: () => boolean): NativeManagedSend {
      let consumed = false;
      return async <T>(route: string, body: unknown, signal: AbortSignal, start: (signal: AbortSignal) => ProtocolOperation<T>): Promise<T> => {
        assert(!consumed && route === path && record(body) && equalJson(body.tools ?? [], tools));
        consumed = true;
        let started = false;
        return policy.runSend(exchangeId, admitted => {
          assert(!started);
          started = true;
          signal.throwIfAborted(); admitted.throwIfAborted();
          if (hosted && !current()) {
            // The authority has registered this operation, but no request has acquired a transport.
            return { result: Promise.reject(modelsError('conflict')), done: Promise.resolve(), cancel() {} };
          }
          return start(AbortSignal.any([signal, admitted]));
        }, signal);
      };
    },
  };
}

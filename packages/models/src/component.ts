import { randomUUID } from 'node:crypto';
import type { Component } from '@nya/core';
import { assert, identifier, immutable, keys, modelInput, nonempty, providerInput, validateMessages, validateModel, validateOptions, validateProvider, validateSignal, validateTools } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { createExecution } from './execution.js';
import { abortLink, deferred, joinOperation, throwAborted } from './lifecycle.js';
import { modelsProtocolsServiceKey, modelsServiceKey, modelsSettingsServiceKey, modelsStoreServiceKey, modelsVaultServiceKey } from './types.js';
import type { CredentialIntent, EffectiveCapabilities, GenerationOptions, ModelExecution, ModelInput, ModelProtocol, ModelRecord, ModelsProtocolsService, ModelsService, ModelsSettingsService, ModelsStore, ModelsVault, ModelSummary, OpenModelInput, ProtocolConnection, ProtocolOperation, ProviderInput, ProviderRecord, ProviderView } from './types.js';

interface Owned { cancel(): void; readonly done: Promise<void> }
interface Generation {
  readonly protocol: ModelProtocol;
  accepting: boolean;
  readonly pending: Set<Owned>;
  readonly executions: Set<ModelExecution>;
  cleanupFailed: boolean;
  closing?: Promise<void>;
}
type Dependencies = { 'models.store': ModelsStore; 'models.vault': ModelsVault };

/** Installs orchestration only; storage, vault, and protocols remain replaceable Nya dependencies. */
export function createModelsComponent(): Component.Object<void, Dependencies> {
  return {
    name: 'models', inject: [modelsStoreServiceKey, modelsVaultServiceKey],
    async apply(ctx, _config, deps) {
      const runtime = createRuntime(deps['models.store'], deps['models.vault']);
      ctx.effect(() => () => runtime.close(), 'stop model admissions and join owned resources');
      await runtime.recover();
      ctx.provide(modelsServiceKey, runtime.models);
      ctx.provide(modelsSettingsServiceKey, runtime.settings);
      ctx.provide(modelsProtocolsServiceKey, runtime.protocols);
    },
  };
}

function createRuntime(store: ModelsStore, vault: ModelsVault) {
  let accepting = true;
  let closing: Promise<void> | undefined;
  let cleanupFailed = false;
  const generations = new Map<string, Generation>();
  const ownedGenerations = new Set<Generation>();
  const operations = new Set<Owned>();
  const jobs = new Set<Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();
  const requireOpen = () => { if (!accepting) throw modelsError('closed'); };
  const getProvider = (id: string) => { identifier(id); const value = store.provider(id); if (!value) throw modelsError('not-found'); return value; };
  const getModel = (id: string) => { identifier(id); const value = store.model(id); if (!value) throw modelsError('not-found'); return value; };
  const getGeneration = (id: string) => {
    const generation = generations.get(id);
    if (!generation?.accepting) throw modelsError('protocol-unavailable');
    return generation;
  };
  const providerView = (value: ProviderRecord): ProviderView => immutable({
    ...providerInput(value), id: value.id, revision: value.revision, versionId: value.versionId,
    createdAt: value.createdAt, updatedAt: value.updatedAt, credentialConfigured: value.credentialRef !== null,
  });
  const revision = (previous?: ProviderRecord | ModelRecord) => ({
    revision: previous ? previous.revision + 1 : 1, versionId: randomUUID(),
    createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const compare = (actual: number, expected: number) => {
    assert(Number.isSafeInteger(expected) && expected > 0);
    if (actual !== expected) throw modelsError('conflict');
  };
  const enqueue = <T>(providerId: string, work: () => Promise<T>): Promise<T> => {
    try { requireOpen(); } catch (error) { return Promise.reject(error); }
    const previous = queues.get(providerId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work).catch(error => { throw normalizeError(error, 'invalid-config'); });
    queues.set(providerId, task); jobs.add(task);
    void task.finally(() => { jobs.delete(task); if (queues.get(providerId) === task) queues.delete(providerId); }).catch(() => {});
    return task;
  };
  const intentFor = (providerId: string, slotId: string): CredentialIntent => ({ id: randomUUID(), providerId, slotId, createdAt: new Date().toISOString() });
  const cleanupIntent = async (intent: CredentialIntent): Promise<void> => {
    try {
      // Historical references do not keep old secret values alive.
      if (!store.providers().some(provider => provider.credentialRef === intent.slotId)) await vault.delete(intent.slotId);
      await store.commit({ removeIntentIds: [intent.id] });
    } catch { /* The durable intent is retried at startup or the next key mutation. */ }
  };
  const recover = async () => { for (const intent of store.intents()) await cleanupIntent(intent); };
  const changeCredential = async (previous: ProviderRecord | undefined, next: ProviderRecord, secret: string | null): Promise<ProviderView> => {
    const slotId = secret === null ? null : randomUUID();
    const pending = slotId ? intentFor(next.id, slotId) : undefined;
    const retired = previous?.credentialRef ? intentFor(next.id, previous.credentialRef) : undefined;
    if (pending) await store.commit({ addIntents: [pending] });
    try {
      if (slotId && secret !== null) await vault.write(slotId, secret);
      const record = immutable({ ...next, credentialRef: slotId });
      await store.commit({
        provider: { record, expectedRevision: previous?.revision ?? null },
        removeIntentIds: pending ? [pending.id] : [], addIntents: retired ? [retired] : [],
      });
      if (retired) await cleanupIntent(retired);
      // Retry only this provider's abandoned writes while its configuration queue is held.
      for (const intent of store.intents().filter(item => item.providerId === next.id)) await cleanupIntent(intent);
      return providerView(record);
    } catch (error) { if (pending) await cleanupIntent(pending); throw normalizeError(error, 'credential-unavailable'); }
  };
  const effective = (generation: Generation, model: ModelRecord, options: GenerationOptions): EffectiveCapabilities => {
    generation.protocol.validateOptions(options, model.capabilities);
    const declared = model.capabilities;
    const value = generation.protocol.effectiveCapabilities(declared, options);
    return immutable({
      tools: declared.tools.support === 'supported' && value.tools === true,
      streaming: declared.streaming.support === 'supported' && value.streaming === true,
      imageInput: false,
      reasoning: declared.reasoning.support === 'supported' ? value.reasoning : { support: declared.reasoning.support },
    });
  };
  const summary = (model: ModelRecord): ModelSummary => {
    const provider = getProvider(model.providerId);
    let unavailableReason: ModelSummary['unavailableReason'];
    let effectiveCapabilities: EffectiveCapabilities | undefined;
    if (!model.enabled) unavailableReason = 'disabled';
    else if (!provider.enabled) unavailableReason = 'provider-disabled';
    else if (!generations.get(provider.protocolId)?.accepting) unavailableReason = 'protocol-unavailable';
    else if (provider.auth === 'api-key' && !provider.credentialRef) unavailableReason = 'credential-missing';
    if (generations.get(provider.protocolId)?.accepting) {
      try {
        const generation = getGeneration(provider.protocolId);
        generation.protocol.validateProvider(providerInput(provider));
        effectiveCapabilities = effective(generation, model, model.defaults);
      } catch { unavailableReason ??= 'invalid-configuration'; }
    }
    return immutable({ ...model, available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}), ...(effectiveCapabilities ? { effectiveCapabilities } : {}) });
  };
  const readCredential = async (provider: ProviderRecord, signal: AbortSignal) => {
    throwAborted(signal);
    if (provider.auth === 'none') return undefined;
    if (!provider.credentialRef) throw modelsError('credential-missing');
    let credential: string | undefined;
    try { credential = await vault.read(provider.credentialRef, signal); }
    catch { throwAborted(signal); throw modelsError('credential-unavailable'); }
    throwAborted(signal);
    if (!credential) throw modelsError('credential-missing');
    return credential;
  };
  const lease = (signal?: AbortSignal) => {
    const controller = new AbortController();
    const unlink = abortLink(signal, controller);
    const done = deferred<void>();
    const owned: Owned = { cancel: () => controller.abort(), done: done.promise };
    operations.add(owned);
    let generation: Generation | undefined;
    return {
      controller, unlink,
      attach(value: Generation) { generation = value; generation.pending.add(owned); },
      finish(failed = false) {
        generation?.pending.delete(owned); operations.delete(owned);
        if (failed) { cleanupFailed = true; if (generation) generation.cleanupFailed = true; done.reject(modelsError('cleanup-failure')); }
        else done.resolve();
      },
    };
  };

  const models: ModelsService = {
    list(query = {}) {
      requireOpen(); keys(query, ['providerId', 'available']);
      if (query.providerId !== undefined) identifier(query.providerId);
      assert(query.available === undefined || typeof query.available === 'boolean');
      return immutable(store.models().map(summary).filter(item => (!query.providerId || item.providerId === query.providerId) && (query.available === undefined || item.available === query.available)));
    },
    get(id) { requireOpen(); identifier(id); const model = store.model(id); return model ? summary(model) : undefined; },
    async open(input: OpenModelInput) {
      requireOpen();
      keys(input, ['modelId', 'history', 'tools', 'requirements', 'options', 'signal']); identifier(input.modelId);
      validateSignal(input.signal);
      let captured: Omit<OpenModelInput, 'signal'>;
      try { const { signal: _signal, ...rest } = input; captured = immutable(rest); } catch { throw modelsError('invalid-config'); }
      const history = captured.history ?? []; const tools = captured.tools ?? [];
      validateMessages(history, true); validateTools(tools);
      if (captured.options) { keys(captured.options, ['temperature', 'maxOutputTokens']); validateOptions(captured.options); }
      const requirements = captured.requirements ?? {};
      keys(requirements, ['tools', 'streaming', 'reasoning']); assert(Object.values(requirements).every(value => typeof value === 'boolean'));
      const providerId = getModel(input.modelId).providerId;
      const owned = lease(input.signal);
      let transferred = false;
      try {
        return await enqueue(providerId, async () => {
          throwAborted(owned.controller.signal);
          const model = immutable(getModel(captured.modelId)); const provider = immutable(getProvider(providerId));
          if (!model.enabled || !provider.enabled) throw modelsError('unavailable');
          const generation = getGeneration(provider.protocolId); owned.attach(generation);
          generation.protocol.validateProvider(providerInput(provider));
          const options = immutable({ ...model.defaults, ...Object.fromEntries(Object.entries(captured.options ?? {}).filter(([, value]) => value !== undefined)) });
          const capabilities = effective(generation, model, options);
          if ((tools.length > 0 || requirements.tools) && !capabilities.tools || requirements.streaming && !capabilities.streaming || requirements.reasoning && capabilities.reasoning.support !== 'supported') throw modelsError('capability-unsupported');
          const credential = await readCredential(provider, owned.controller.signal);
          throwAborted(owned.controller.signal);
          if (!accepting || !generation.accepting) throw modelsError('closed');
          const execution = createExecution({
            protocol: generation.protocol, provider: immutable(providerInput(provider)), credential,
            snapshot: { modelId: model.id, modelRevision: model.revision, modelVersionId: model.versionId, providerId: provider.id, providerRevision: provider.revision, providerVersionId: provider.versionId, remoteModelId: model.remoteModelId, protocolId: provider.protocolId, protocolVersion: generation.protocol.descriptor.version, options },
            capabilities, tools, history, controller: owned.controller,
            onRelease: failed => { generation.executions.delete(execution); owned.unlink(); if (failed) { generation.cleanupFailed = true; cleanupFailed = true; } },
          });
          generation.executions.add(execution); transferred = true;
          return execution;
        });
      } finally { owned.finish(); if (!transferred) owned.unlink(); }
    },
  };

  const network = async <T>(providerId: string, method: 'discover' | 'check', signal?: AbortSignal): Promise<T> => {
    requireOpen(); identifier(providerId); validateSignal(signal); const owned = lease(signal); let timer: ReturnType<typeof setTimeout> | undefined; let timedOut = false; let failedCleanup = false;
    try {
      const prepared = await enqueue(providerId, async () => {
        throwAborted(owned.controller.signal);
        const provider = immutable(getProvider(providerId));
        if (!provider.enabled) throw modelsError('unavailable');
        const generation = getGeneration(provider.protocolId); owned.attach(generation);
        const invoke = generation.protocol[method]; if (!invoke) throw modelsError('capability-unsupported');
        generation.protocol.validateProvider(providerInput(provider));
        const credential = await readCredential(provider, owned.controller.signal);
        throwAborted(owned.controller.signal);
        if (!generation.accepting || !accepting) throw modelsError('closed');
        return { provider, generation, credential, invoke };
      });
      timer = setTimeout(() => { timedOut = true; owned.controller.abort(); }, prepared.provider.timeoutMs);
      throwAborted(owned.controller.signal);
      const connection: ProtocolConnection = { provider: providerInput(prepared.provider), credential: prepared.credential, signal: owned.controller.signal };
      const operation = prepared.invoke(connection) as ProtocolOperation<T>;
      return immutable(await joinOperation(operation, owned.controller.signal));
    } catch (error) {
      const normalized = normalizeError(error);
      failedCleanup = normalized.code === 'cleanup-failure';
      if (normalized.code !== 'cleanup-failure' && owned.controller.signal.aborted) throw modelsError(timedOut ? 'timeout' : 'cancelled');
      throw normalized;
    } finally { if (timer) clearTimeout(timer); owned.unlink(); owned.finish(failedCleanup); }
  };

  const settings: ModelsSettingsService = {
    protocols() { requireOpen(); return immutable([...generations.values()].filter(value => value.accepting).map(value => value.protocol.descriptor)); },
    providers() { requireOpen(); return immutable(store.providers().map(providerView)); },
    providerHistory(id) { requireOpen(); identifier(id); return immutable(store.providerHistory(id).map(providerView)); },
    models(providerId) { requireOpen(); if (providerId !== undefined) identifier(providerId); return immutable(store.models().filter(value => providerId === undefined || value.providerId === providerId)); },
    modelHistory(id) { requireOpen(); identifier(id); return immutable(store.modelHistory(id)); },
    async createProvider(input) {
      keys(input, ['id', 'name', 'enabled', 'protocolId', 'baseUrl', 'auth', 'timeoutMs', 'apiKey', 'catalogRef']);
      const { id = randomUUID(), apiKey, ...data } = input; identifier(id); validateProvider(data);
      if (apiKey !== undefined) assert(nonempty(apiKey) && data.auth === 'api-key');
      const captured = immutable(data);
      return enqueue(id, async () => {
        if (store.provider(id)) throw modelsError('conflict');
        getGeneration(captured.protocolId).protocol.validateProvider(captured);
        const record: ProviderRecord = immutable({ ...captured, id, ...revision(), credentialRef: null });
        if (apiKey !== undefined) return changeCredential(undefined, record, apiKey);
        await store.commit({ provider: { record, expectedRevision: null } }); return providerView(record);
      });
    },
    async updateProvider(id, input, expectedRevision) {
      keys(input, ['name', 'enabled', 'baseUrl', 'auth', 'timeoutMs', 'catalogRef']); const captured = immutable(input);
      return enqueue(id, async () => {
        const previous = getProvider(id); compare(previous.revision, expectedRevision);
        const data = { ...providerInput(previous), ...captured }; validateProvider(data);
        const generation = generations.get(data.protocolId);
        generation?.protocol.validateProvider(data);
        const record = immutable({ ...previous, ...data, ...revision(previous) });
        await store.commit({ provider: { record, expectedRevision } }); return providerView(record);
      });
    },
    async setApiKey(id, apiKey, expectedRevision) {
      assert(nonempty(apiKey));
      return enqueue(id, async () => {
        const previous = getProvider(id); compare(previous.revision, expectedRevision);
        assert(previous.auth === 'api-key');
        return changeCredential(previous, { ...previous, ...revision(previous) }, apiKey);
      });
    },
    async deleteApiKey(id, expectedRevision) {
      return enqueue(id, async () => {
        const previous = getProvider(id); compare(previous.revision, expectedRevision);
        return changeCredential(previous, { ...previous, ...revision(previous) }, null);
      });
    },
    async createModel(input) {
      keys(input, ['id', 'name', 'enabled', 'providerId', 'remoteModelId', 'capabilities', 'defaults']);
      const { id = randomUUID(), ...data } = input; identifier(id); validateModel(data); const captured = immutable(data);
      return enqueue(data.providerId, async () => {
        if (store.model(id)) throw modelsError('conflict');
        const provider = getProvider(captured.providerId);
        const generation = getGeneration(provider.protocolId);
        generation.protocol.validateOptions(captured.defaults, captured.capabilities);
        const record = immutable({ ...captured, id, ...revision() });
        await store.commit({ model: { record, expectedRevision: null } }); return record;
      });
    },
    async updateModel(id, input, expectedRevision) {
      keys(input, ['name', 'enabled', 'remoteModelId', 'capabilities', 'defaults']); const captured = immutable(input);
      const providerId = getModel(id).providerId;
      return enqueue(providerId, async () => {
        const previous = getModel(id); compare(previous.revision, expectedRevision);
        const data: ModelInput = { ...modelInput(previous), ...captured }; validateModel(data);
        const provider = getProvider(providerId); const generation = generations.get(provider.protocolId);
        if (generation) generation.protocol.validateOptions(data.defaults, data.capabilities);
        else if (captured.defaults !== undefined || captured.capabilities !== undefined) throw modelsError('protocol-unavailable');
        const record = immutable({ ...previous, ...data, ...revision(previous) });
        await store.commit({ model: { record, expectedRevision } }); return record;
      });
    },
    discoverModels: (id, signal) => network(id, 'discover', signal),
    checkConnection: (id, signal) => network(id, 'check', signal),
  };

  const unregister = (generation: Generation): Promise<void> => {
    if (generation.closing) return generation.closing;
    generation.accepting = false;
    const id = generation.protocol.descriptor.id;
    if (generations.get(id) === generation) generations.delete(id);
    for (const operation of generation.pending) operation.cancel();
    generation.closing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([
        ...[...generation.pending].map(operation => operation.done),
        ...[...generation.executions].map(execution => execution.close()),
      ]);
      ownedGenerations.delete(generation);
      if (generation.cleanupFailed || outcomes.some(outcome => outcome.status === 'rejected')) { cleanupFailed = true; throw modelsError('cleanup-failure'); }
    });
    // Stop admission to existing idle executions synchronously too.
    for (const execution of generation.executions) void execution.close().catch(() => {});
    void generation.closing.catch(() => {});
    return generation.closing;
  };
  const protocols: ModelsProtocolsService = {
    register(protocol) {
      requireOpen(); identifier(protocol.descriptor.id); assert(nonempty(protocol.descriptor.version));
      if (generations.has(protocol.descriptor.id)) throw modelsError('conflict');
      // Capture methods and metadata: mutating a registration object cannot change an open execution.
      const stable: ModelProtocol = Object.freeze({
        descriptor: immutable(protocol.descriptor), validateProvider: protocol.validateProvider.bind(protocol),
        validateOptions: protocol.validateOptions.bind(protocol), effectiveCapabilities: protocol.effectiveCapabilities.bind(protocol),
        call: protocol.call.bind(protocol), discover: protocol.discover?.bind(protocol), check: protocol.check?.bind(protocol),
      });
      const generation: Generation = { protocol: stable, accepting: true, pending: new Set(), executions: new Set(), cleanupFailed: false };
      generations.set(stable.descriptor.id, generation); ownedGenerations.add(generation);
      return Object.freeze({ unregister: () => unregister(generation) });
    },
  };
  const close = () => {
    if (closing) return closing;
    accepting = false;
    for (const operation of operations) operation.cancel();
    closing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([...ownedGenerations].map(unregister));
      await Promise.allSettled([...jobs, ...[...operations].map(operation => operation.done)]);
      if (cleanupFailed || outcomes.some(outcome => outcome.status === 'rejected')) throw modelsError('cleanup-failure');
    });
    void closing.catch(() => {});
    return closing;
  };
  return { models, settings, protocols, recover, close };
}

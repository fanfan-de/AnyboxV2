import type { NativeContinuation, NativeExecution, NativeManagedTools, NativeObject, NativeParameters, NativeProtocol, NativeProtocolLease, OpenNativeModelInput } from './native-types.js';
import { bindManagedTools, captureManagedTools } from './managed-tools.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import type { Component } from '@nya/core';
import { assert, identifier, immutable, keys, nonempty, providerSettingsInput, modelSettingsInput, modelInput, providerInput, validateModelSettings, validateProviderSettings, validateModel, validateParameters, validateProvider, validateSignal } from './domain.js';
import { modelsError, normalizeError } from './errors.js';
import { createExecution, validateContinuation, validateRestore, type MaterializedNativeContinuation } from './execution.js';
import { captureResourceResolver } from './resources.js';
import { createTextGeneration } from './text-generation.js';
import { abortLink, deferred, joinOperation, throwAborted } from './lifecycle.js';
import { modelsProtocolsServiceKey, modelsServiceKey, modelsSettingsServiceKey, modelsStoreServiceKey, modelsVaultServiceKey, modelsSourceDataServiceKey } from './types.js';
import type { ProviderModel, ProviderSyncState, CredentialIntent, EffectiveCapabilities, Model, ModelSettings, ModelSettingsInput, ModelInput, ModelsProtocolsService, ModelsService, ModelsSettingsService, ModelsSourceDataService, ModelsStore, ModelsVault, RunnableModelSummary, ProtocolConnection, ProtocolOperation, Provider, ProviderSettingsRecord, ProviderSettings, ProviderInput, SourceSnapshot, Versioned } from './types.js';
import { validateCatalogSnapshot } from './catalog-domain.js';

interface Owned { cancel(): void; readonly done: Promise<void> }
interface Generation {
  readonly protocol: NativeProtocol;
  readonly id: string;
  readonly controller: AbortController;
  accepting: boolean;
  readonly pending: Set<Owned>;
  readonly executions: Set<NativeExecution>;
  cleanupFailed: boolean;
  closing?: Promise<void>;
}
type Dependencies = { 'models.store': ModelsStore; 'models.vault': ModelsVault };

/** Installs orchestration only; storage, vault, and protocols remain replaceable Nya dependencies. */
export function createModelsComponent(options: { readonly requireManagedTools?: boolean } = {}): Component.Object<void, Dependencies> {
  return {
    name: 'models', inject: [modelsStoreServiceKey, modelsVaultServiceKey],
    async apply(ctx, _config, deps) {
      const runtime = createRuntime(deps['models.store'], deps['models.vault'], options.requireManagedTools === true);
      ctx.effect(() => () => runtime.close(), 'stop model admissions and join owned resources');
      await runtime.recover();
      ctx.provide(modelsServiceKey, runtime.models);
      ctx.provide(modelsSettingsServiceKey, runtime.settings);
      ctx.provide(modelsProtocolsServiceKey, runtime.protocols);
      ctx.provide(modelsSourceDataServiceKey, runtime.sourceData);
    },
  };
}

function nativeParameters(model: Pick<ModelSettingsInput, 'parameters'>, protocolId: string): NativeParameters {
  validateParameters(model.parameters); if (model.parameters.protocolId !== protocolId || model.parameters.formatVersion !== 1) throw modelsError('invalid-config');
  return immutable(model.parameters);
}

function createRuntime(store: ModelsStore, vault: ModelsVault, requireManagedTools: boolean) {
  let accepting = true;
  let closing: Promise<void> | undefined;
  let cleanupFailed = false;
  const generations = new Map<string, Generation>();
  const ownedGenerations = new Set<Generation>();
  const leases = new WeakMap<object, { generation: Generation; released: boolean }>();
  const continuations = new WeakMap<Generation, WeakMap<NativeContinuation, MaterializedNativeContinuation>>();
  const captureContinuation = (generation: Generation, material: MaterializedNativeContinuation): NativeContinuation | undefined => {
    const cache = continuations.get(generation);
    if (!accepting || !generation.accepting || !cache) return undefined;
    const continuation = Object.freeze({ resourceRefs: material.resourceRefs }) as NativeContinuation;
    cache.set(continuation, material);
    return continuation;
  };
  const operations = new Set<Owned>();
  const jobs = new Set<Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();
  const requireOpen = () => { if (!accepting) throw modelsError('closed'); };
  const getProviderSettings = (id: string) => { identifier(id); const value = store.providerSettings(id); if (!value) throw modelsError('not-found'); return value; };
  const getRuntimeModelSettings = (id: string) => { identifier(id); const value = store.runtimeModelSettings(id); if (!value) throw modelsError('not-found'); return value; };
  const getGeneration = (id: string) => {
    const generation = generations.get(id);
    if (!generation?.accepting) throw modelsError('protocol-unavailable');
    return generation;
  };
  const providerSettingsView = (value: ProviderSettingsRecord): ProviderSettings => immutable({
    ...providerSettingsInput(value), id: value.id, revision: value.revision, versionId: value.versionId,
    createdAt: value.createdAt, updatedAt: value.updatedAt, credentialConfigured: value.credentialRef !== null, sync: syncOverrides.get(value.id) ?? store.syncState(value.id),
  });
  const revision = (previous?: Versioned) => ({
    revision: previous ? previous.revision + 1 : 1, versionId: randomUUID(),
    createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const compare = (actual: number, expected: number) => {
    assert(Number.isSafeInteger(expected) && expected > 0);
    if (actual !== expected) throw modelsError('conflict');
  };
  const trackJob = <T>(task: Promise<T>): Promise<T> => { jobs.add(task); void task.finally(() => jobs.delete(task)).catch(() => {}); return task; };
  const enqueue = <T>(key: string, work: () => Promise<T>, admitted = false): Promise<T> => {
    try { if (!admitted) requireOpen(); } catch (error) { return Promise.reject(error); }
    const previous = queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work).catch(error => { throw normalizeError(error, 'invalid-config'); });
    queues.set(key, task); jobs.add(task);
    void task.finally(() => { jobs.delete(task); if (queues.get(key) === task) queues.delete(key); }).catch(() => {});
    return task;
  };
  const intentFor = (providerId: string, slotId: string): CredentialIntent => ({ id: randomUUID(), providerId, slotId, createdAt: new Date().toISOString() });
  const cleanupIntent = async (intent: CredentialIntent): Promise<void> => {
    try {
      // Historical references do not keep old secret values alive.
      if (!store.configuredProviders().some(provider => provider.credentialRef === intent.slotId)) await vault.delete(intent.slotId);
      await store.commit({ removeIntentIds: [intent.id] });
    } catch { /* The durable intent is retried at startup or the next key mutation. */ }
  };
  const recover = async () => { for (const intent of store.intents()) await cleanupIntent(intent); for (const providerSettings of store.configuredProviders()) await reconcile(providerSettings.id); };
  const changeCredential = async (previous: ProviderSettingsRecord | undefined, next: ProviderSettingsRecord, secret: string | null): Promise<ProviderSettings> => {
    const slotId = secret === null ? null : randomUUID();
    const pending = slotId ? intentFor(next.id, slotId) : undefined;
    const retired = previous?.credentialRef ? intentFor(next.id, previous.credentialRef) : undefined;
    if (pending) await store.commit({ addIntents: [pending] });
    try {
      if (slotId && secret !== null) await vault.write(slotId, secret);
      const record = immutable({ ...next, credentialRef: slotId, historyScopeEpoch: randomUUID() });
      await store.commit({
        providerSettings: { record, expectedRevision: previous?.revision ?? null },
        removeIntentIds: pending ? [pending.id] : [], addIntents: retired ? [retired] : [],
      });
      if (retired) await cleanupIntent(retired);
      // Retry only this provider's abandoned writes while its configuration queue is held.
      for (const intent of store.intents().filter(item => item.providerId === next.id)) await cleanupIntent(intent);
      return providerSettingsView(record);
    } catch (error) { if (pending) await cleanupIntent(pending); throw normalizeError(error, 'credential-unavailable'); }
  };
  const effective = (generation: Generation, model: ModelSettings, parameters: NativeParameters): EffectiveCapabilities => {
    assert(parameters.formatVersion === 1); generation.protocol.validateParameters(parameters.value, model.capabilities);
    const declared = model.capabilities;
    const value = generation.protocol.effectiveCapabilities(declared, parameters.value);
    return immutable({
      tools: declared.tools.support === 'supported' && value.tools === true,
      streaming: declared.streaming.support !== 'unsupported' && value.streaming === true,
      imageInput: declared.imageInput.support === 'supported' && value.imageInput === true, webSearch: declared.webSearch?.support === 'supported' && value.webSearch === true,
      reasoning: declared.reasoning.support === 'supported' ? value.reasoning : { support: declared.reasoning.support },
    });
  };
  const definitionLimits = (model: ModelSettings): ModelInput['limits'] | undefined => {
    const current = store.model(model.id);
    const definition = current?.versionId === model.modelDefinitionVersionId ? current :
      store.modelHistory(model.id).find(value => value.versionId === model.modelDefinitionVersionId);
    return definition?.limits;
  };
  const summary = (model: ModelSettings): RunnableModelSummary => {
    const provider = getProviderSettings(model.providerId);
    const limits = definitionLimits(model);
    let unavailableReason: RunnableModelSummary['unavailableReason'];
    let effectiveCapabilities: EffectiveCapabilities | undefined;
    if (!model.enabled) unavailableReason = 'disabled';
    else if (!provider.enabled) unavailableReason = 'provider-disabled';
    else if (!generations.get(provider.protocolId)?.accepting) unavailableReason = 'protocol-unavailable';
    else if (provider.auth === 'api-key' && !provider.credentialRef) unavailableReason = 'credential-missing';
    if (generations.get(provider.protocolId)?.accepting) {
      try {
        const generation = getGeneration(provider.protocolId);
        generation.protocol.validateProvider(providerSettingsInput(provider));
        effectiveCapabilities = effective(generation, model, nativeParameters(model, provider.protocolId));
      } catch { unavailableReason ??= 'invalid-configuration'; }
    }
    const { id, runtimeModelId, ...data } = model;
    return immutable({ ...data, id: runtimeModelId, modelDefinitionId: id, source: store.model(id)!.source, ...(limits ? { limits } : {}), available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}), ...(effectiveCapabilities ? { effectiveCapabilities } : {}) });
  };
  const readCredential = async (provider: ProviderSettingsRecord, signal: AbortSignal) => {
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
      return immutable(store.configuredModels().map(summary).filter(item => (!query.providerId || item.providerId === query.providerId) && (query.available === undefined || item.available === query.available)));
    },
    get(id) { requireOpen(); identifier(id); const model = store.runtimeModelSettings(id); return model ? summary(model) : undefined; },
    generateText(input) {
      return createTextGeneration(input, captured => {
        requireOpen();
        const providerSettings = getProviderSettings(getRuntimeModelSettings(captured.modelId).providerId);
        const generation = getGeneration(providerSettings.protocolId), adapter = generation.protocol.textGeneration;
        if (!adapter || !generation.protocol.descriptor.responseModes?.includes('complete')) throw modelsError('capability-unsupported');
        const held = acquire(generation);
        const textOnly: NativeManagedTools | undefined = requireManagedTools ? {
          functions: [], runSend: (_id, start, signal) => joinOperation(start(signal), signal),
        } : undefined;
        return { adapter, lease: held, open: signal => models.openNative({ modelId: captured.modelId, lease: held, signal, managedTools: textOnly }),
          track(operation) {
            operations.add(operation); generation.pending.add(operation);
            return failed => {
              generation.pending.delete(operation); operations.delete(operation);
              if (failed) { generation.cleanupFailed = true; cleanupFailed = true; }
            };
          },
        };
      });
    },
    async openNative<I extends NativeObject, R extends NativeObject, E extends NativeObject>(input: OpenNativeModelInput<I, R, E>): Promise<NativeExecution<I, R, E>> {
      requireOpen(); keys(input, ['modelId', 'lease', 'restore', 'historyPrefix', 'continuation', 'captureContinuation', 'requirements', 'resources', 'signal', 'managedTools']); identifier(input.modelId); validateSignal(input.signal);
      if (requireManagedTools && !input.managedTools) throw modelsError('capability-unsupported');
      const policy = input.managedTools && captureManagedTools(input.managedTools);
      const continuationToken = input.continuation, shouldCapture = input.captureContinuation;
      assert(continuationToken === undefined || (input.restore === undefined && input.historyPrefix === undefined));
      assert(shouldCapture === undefined || typeof shouldCapture === 'boolean');
      const resources = captureResourceResolver(input.resources);
      const held = input.lease && leases.get(input.lease); if (!held || held.released || !held.generation.accepting) throw modelsError('protocol-unavailable');
      const generation = held.generation;
      const captured = immutable({ modelId: input.modelId, restore: input.restore, historyPrefix: input.historyPrefix, requirements: input.requirements ?? {} });
      keys(captured.requirements, ['tools', 'streaming', 'reasoning', 'imageInput']); assert(Object.values(captured.requirements).every(value => typeof value === 'boolean'));
      const providerId = getRuntimeModelSettings(input.modelId).providerId, owned = lease(input.signal); owned.attach(generation);
      let transferred = false;
      try {
        return await enqueue(providerId, async () => {
          throwAborted(owned.controller.signal);
          if (held.released || !generation.accepting) throw modelsError('protocol-unavailable');
          const continuation = continuationToken === undefined ? undefined : continuations.get(generation)?.get(continuationToken);
          assert(continuationToken === undefined || continuation !== undefined);
          const model = immutable(getRuntimeModelSettings(captured.modelId)), provider = immutable(getProviderSettings(providerId));
          if (!model.enabled || !provider.enabled) throw modelsError('unavailable');
          if (provider.protocolId !== input.lease.protocolId) throw modelsError('conflict');
          generation.protocol.validateProvider(providerSettingsInput(provider));
          const parameters = nativeParameters(model, provider.protocolId), capabilities = effective(generation, model, parameters), requirements = captured.requirements;
          const limits = definitionLimits(model);
          if (policy && !generation.protocol.supportsManagedSend) throw modelsError('capability-unsupported');
          const managed = policy && bindManagedTools(policy, provider, parameters.value);
          const effectiveParameters = managed ? { ...parameters, value: managed.parameters } : parameters;
          const snapshot = immutable({ schemaVersion: 3 as const, ...(managed ? { managedToolFingerprint: managed.fingerprint } : {}), modelDefinitionId: model.id, providerDefinitionId: provider.id, modelDefinitionVersionId: model.modelDefinitionVersionId, modelId: model.runtimeModelId, modelRevision: model.revision, modelVersionId: model.versionId, providerId: provider.restoreScopeId, providerRevision: provider.revision, providerVersionId: provider.versionId, remoteModelId: model.remoteModelId, protocolId: provider.protocolId, protocolVersion: generation.protocol.descriptor.version, registrationGenerationId: generation.id, historyScopeEpoch: provider.historyScopeEpoch, parameters: effectiveParameters, capabilities, ...(limits ? { limits } : {}) });
          if (continuation) validateContinuation(continuation, snapshot);
          if (requirements.tools && !capabilities.tools || requirements.streaming && !capabilities.streaming || requirements.reasoning && capabilities.reasoning.support !== 'supported' || requirements.imageInput && !capabilities.imageInput) throw modelsError('capability-unsupported');
          if (captured.restore) validateRestore(captured.restore, snapshot, generation.protocol);
          const credential = await readCredential(provider, owned.controller.signal);
          throwAborted(owned.controller.signal);
          if (!accepting || !generation.accepting || held.released) throw modelsError('closed');
          const execution = createExecution({
            managedSend: managed ? id => managed.send(id, () => store.providerSettings(providerId)?.versionId === provider.versionId) : undefined,
            protocol: generation.protocol, provider: immutable(providerSettingsInput(provider)), credential, snapshot, capabilities, resources, restore: captured.restore, historyPrefix: captured.historyPrefix, continuation, controller: owned.controller,
            captureContinuation: shouldCapture ? material => captureContinuation(generation, material) : undefined,
            onRelease: failed => { generation.executions.delete(execution); owned.unlink(); if (failed) { generation.cleanupFailed = true; cleanupFailed = true; } } });
          generation.executions.add(execution); transferred = true; return execution as NativeExecution<I, R, E>;
        });
      } finally { owned.finish(); if (!transferred) owned.unlink(); }
    },
  };

  const network = async <T>(providerId: string, method: 'discover' | 'check', signal?: AbortSignal): Promise<T> => {
    requireOpen(); identifier(providerId); validateSignal(signal); const owned = lease(signal); let timer: ReturnType<typeof setTimeout> | undefined; let timedOut = false; let failedCleanup = false;
    try {
      const prepared = await enqueue(providerId, async () => {
        throwAborted(owned.controller.signal);
        const provider = immutable(getProviderSettings(providerId));
        if (!provider.enabled) throw modelsError('unavailable');
        const generation = getGeneration(provider.protocolId); owned.attach(generation);
        const invoke = generation.protocol[method]; if (!invoke) throw modelsError('capability-unsupported');
        generation.protocol.validateProvider(providerSettingsInput(provider));
        const credential = await readCredential(provider, owned.controller.signal);
        throwAborted(owned.controller.signal);
        if (!generation.accepting || !accepting) throw modelsError('closed');
        return { provider, generation, credential, invoke };
      });
      timer = setTimeout(() => { timedOut = true; owned.controller.abort(); }, prepared.provider.timeoutMs);
      throwAborted(owned.controller.signal);
      const connection: ProtocolConnection = { provider: providerSettingsInput(prepared.provider), credential: prepared.credential, signal: owned.controller.signal };
      const operation = prepared.invoke(connection) as ProtocolOperation<T>;
      return immutable(await joinOperation(operation, owned.controller.signal));
    } catch (error) {
      const normalized = normalizeError(error);
      failedCleanup = normalized.code === 'cleanup-failure';
      if (normalized.code !== 'cleanup-failure' && owned.controller.signal.aborted) throw modelsError(timedOut ? 'timeout' : 'cancelled');
      throw normalized;
    } finally { if (timer) clearTimeout(timer); owned.unlink(); owned.finish(failedCleanup); }
  };

  const syncOverrides = new Map<string, ProviderSyncState>();
  const definitionProvider = (id: string) => { identifier(id); const value = store.provider(id); if (!value) throw modelsError('not-found'); return value; };
  const definitionModel = (id: string) => { identifier(id); const value = store.model(id); if (!value) throw modelsError('not-found'); return value; };
  const checkUserRemoteModelId = (id: string, model: ModelInput) => {
    if (store.models().some(value => value.id !== id && value.providerId === model.providerId && value.remoteModelId === model.remoteModelId)) throw modelsError('conflict');
  };
  const sourceVersion = (providerSettings: ProviderSettingsRecord): string | null => {
    const source = definitionProvider(providerSettings.id).source;
    return source.kind === 'external' ? store.sources().find(item => item.sourceId === source.sourceId)?.snapshotVersion ?? null : null;
  };
  const compatibility = (model: Model, providerSettings: ProviderSettingsRecord): string | undefined => {
    if (model.state !== 'present') return 'definition-missing';
    if (model.status === 'deprecated') return 'deprecated';
    if (!model.modalities.input.includes('text') || !model.modalities.output.includes('text') || ['embedding', 'rerank', 'reranker', 'decision', 'image', 'audio', 'video'].includes(model.modelType ?? '')) return 'text-unsupported';
    const generation = generations.get(providerSettings.protocolId);
    if (!generation?.accepting) return 'protocol-unavailable';
    const provider = definitionProvider(model.providerId);
    const mapped = model.connectionHints.protocolIds.includes(providerSettings.protocolId) ||
      model.source.kind === 'user' && model.connectionHints.protocolIds.length === 0 ||
      model.source.kind === 'external' && generation.protocol.descriptor.sourceMappings?.some(mapping => model.source.kind === 'external' && mapping.sourceId === model.source.sourceId && mapping.providerId === model.source.providerId && mapping.protocolIds.some(id => model.connectionHints.protocolIds.includes(id)));
    if (!mapped) return 'protocol-unmapped';
    if (model.connectionHints.baseUrl && model.connectionHints.baseUrl !== provider.connectionHints.baseUrl && model.connectionHints.baseUrl !== providerSettings.baseUrl) return 'connection-mismatch';
    return undefined;
  };
  const initialParameters = (model: Model, protocol: NativeProtocol): NativeParameters => {
    const value = protocol.initialParameters?.(model.limits.output, model.capabilities) ?? {};
    const parameters: NativeParameters = immutable({ protocolId: protocol.descriptor.id, formatVersion: 1, value });
    validateParameters(parameters); return parameters;
  };
  const newModelSettings = (model: Model, input: ModelSettingsInput): ModelSettings => {
    const runtimeModelId = store.modelRuntimeIdExists(model.id) ? randomUUID() : model.id;
    return immutable({
      ...input, id: model.id, runtimeModelId, ...revision(store.modelSettingsHistory(model.id).at(-1)),
      providerId: model.providerId, modelDefinitionVersionId: model.versionId, remoteModelId: model.remoteModelId,
    });
  };
  async function reconcile(id: string): Promise<ProviderSettings> {
    const providerSettings = getProviderSettings(id), version = sourceVersion(providerSettings);
    const previous = syncOverrides.get(id) ?? store.syncState(id);
    const pending: ProviderSyncState = { providerId: id, state: 'pending', targetSourceVersion: version, syncedSourceVersion: previous?.syncedSourceVersion ?? null };
    try {
      const generation = generations.get(providerSettings.protocolId);
      if (!providerSettings.enabled || providerSettings.auth === 'api-key' && !providerSettings.credentialRef || !generation?.accepting) {
        await store.commit({ syncStates: [pending] }); syncOverrides.delete(id); return providerSettingsView(providerSettings);
      }
      generation.protocol.validateProvider(providerSettingsInput(providerSettings));
      const existing = new Set(store.configuredModels().filter(value => value.providerId === id).map(value => value.id));
      const modelSettings: { record: ModelSettings; expectedRevision: null }[] = [];
      for (const model of store.models().filter(value => value.providerId === providerSettings.id)) {
        if (existing.has(model.id) || compatibility(model, providerSettings)) continue;
        const parameters = initialParameters(model, generation.protocol);
        // Unsupported source options stay visible as unavailable definitions.
        try { assert(parameters.formatVersion === 1); generation.protocol.validateParameters(parameters.value, model.capabilities); } catch { continue; }
        modelSettings.push({ expectedRevision: null, record: newModelSettings(model, { name: model.name, enabled: true, capabilities: model.capabilities, parameters }) });
      }
      const ready: ProviderSyncState = { ...pending, state: 'ready', syncedSourceVersion: version };
      await store.commit({ modelSettings, syncStates: [ready], syncGuards: [{ providerId: id, targetSourceVersion: store.syncState(id)?.targetSourceVersion ?? null }] });
      syncOverrides.delete(id);
    } catch (error) {
      if (normalizeError(error).code === 'conflict' || sourceVersion(getProviderSettings(id)) !== version) return reconcile(id);
      const failed: ProviderSyncState = { ...pending, state: 'failed', error: normalizeError(error, 'invalid-config').code };
      syncOverrides.set(id, failed);
      try { await store.commit({ syncStates: [failed] }); } catch { /* Saved provider settings and Key remain valid; retry repairs synchronization. */ }
    }
    return providerSettingsView(getProviderSettings(id));
  }
  const queryDefinitions = <T extends Provider | Model>(values: readonly T[], query: import('./types.js').DefinitionQuery = {}): readonly T[] => {
    keys(query, ['sourceId', 'providerId', 'search', 'includeMissing', 'includeDeprecated', 'textOnly']);
    assert(query.search === undefined || typeof query.search === 'string');
    for (const key of ['sourceId', 'providerId']) assert(query[key as keyof typeof query] === undefined || typeof query[key as keyof typeof query] === 'string');
    for (const key of ['includeMissing', 'includeDeprecated', 'textOnly']) assert(query[key as keyof typeof query] === undefined || typeof query[key as keyof typeof query] === 'boolean');
    const search = typeof query.search === 'string' ? query.search.trim().toLocaleLowerCase() : '';
    return immutable(values.filter(value => (!query.sourceId || value.source.kind === 'external' && value.source.sourceId === query.sourceId) &&
      (!query.providerId || 'providerId' in value && value.providerId === query.providerId) && (query.includeMissing || value.state === 'present') &&
      (!search || `${value.id} ${value.name} ${'remoteModelId' in value ? value.remoteModelId : value.source.kind === 'external' ? value.source.providerId : ''}`.toLocaleLowerCase().includes(search)) &&
      (!('remoteModelId' in value) || (query.includeDeprecated || value.status !== 'deprecated') && (!query.textOnly || value.modalities.input.includes('text') && value.modalities.output.includes('text') && !['embedding', 'rerank', 'reranker', 'decision', 'image', 'audio', 'video'].includes(value.modelType ?? '')))));
  };
  const settings: ModelsSettingsService = {
    protocols() { requireOpen(); return immutable([...generations.values()].filter(value => value.accepting).map(value => value.protocol.descriptor)); },
    providers(query) { requireOpen(); return queryDefinitions(store.providers(), query); },
    providerHistory(id) { requireOpen(); identifier(id); return immutable(store.providerHistory(id)); },
    models(query) { requireOpen(); return queryDefinitions(store.models(), query); },
    modelHistory(id) { requireOpen(); identifier(id); return immutable(store.modelHistory(id)); },
    async createProvider(input) {
      keys(input, ['id', 'name', 'documentationUrl', 'connectionHints']); const { id = randomUUID(), ...data } = input; identifier(id); validateProvider(data); const captured = immutable(data);
      return enqueue('@definitions', async () => { const record: Provider = immutable({ ...captured, id, ...revision(), source: { kind: 'user' }, state: 'present' }); await store.commit({ providers: [{ record, expectedRevision: null }] }); return record; });
    },
    async updateProvider(id, input, expectedRevision) {
      keys(input, ['name', 'documentationUrl', 'connectionHints']); const captured = immutable(input);
      return enqueue('@definitions', async () => { const previous = definitionProvider(id); compare(previous.revision, expectedRevision); assert(previous.source.kind === 'user'); const data = { ...providerInput(previous), ...captured }; validateProvider(data); const record: Provider = immutable({ ...previous, ...data, ...revision(previous) }); await store.commit({ providers: [{ record, expectedRevision }] }); return record; });
    },
    async createModel(input) {
      const { id = randomUUID(), ...data } = input; identifier(id); validateModel(data); const captured = immutable(data);
      return enqueue('@definitions', async () => {
        definitionProvider(captured.providerId);
        checkUserRemoteModelId(id, captured);
        const record: Model = immutable({ ...captured, id, ...revision(), source: { kind: 'user' }, state: 'present' });
        await store.commit({ models: [{ record, expectedRevision: null }] });
        return record;
      });
    },
    async updateModel(id, input, expectedRevision) {
      keys(input, ['remoteModelId', 'name', 'description', 'family', 'releaseDate', 'lastUpdated', 'status', 'openWeights', 'modelType', 'capabilities', 'controls', 'modalities', 'limits', 'cost', 'connectionHints']);
      const captured = immutable(input);
      return enqueue('@definitions', async () => {
        const previous = definitionModel(id);
        compare(previous.revision, expectedRevision);
        assert(previous.source.kind === 'user');
        const data = { ...modelInput(previous), ...captured };
        validateModel(data);
        if (data.remoteModelId !== previous.remoteModelId) checkUserRemoteModelId(id, data);
        const record: Model = immutable({ ...previous, ...data, ...revision(previous) });
        await store.commit({ models: [{ record, expectedRevision }] });
        return record;
      });
    },
    configuredProviders() { requireOpen(); return immutable(store.configuredProviders().map(providerSettingsView)); },
    providerSettingsHistory(id) { requireOpen(); identifier(id); return immutable(store.providerSettingsHistory(id).map(value => { const { sync: _sync, ...view } = providerSettingsView(value); return view; })); },
    modelSettings(providerId) { requireOpen(); if (providerId !== undefined) identifier(providerId); return immutable(store.configuredModels().filter(value => providerId === undefined || value.providerId === providerId)); },
    modelSettingsHistory(id) { requireOpen(); identifier(id); return immutable(store.modelSettingsHistory(id)); },
    providerModels(id) {
      requireOpen(); const providerSettings = getProviderSettings(id);
      const configured = new Map(store.configuredModels().filter(value => value.providerId === id).map(value => [value.id, value]));
      return immutable(store.models().filter(value => value.providerId === id && (value.state === 'present' || configured.has(value.id))).map(model => {
        const saved = configured.get(model.id);
        if (saved) { const view = summary(saved); return { ...model, runtimeModelId: saved.runtimeModelId, available: view.available, ...(view.unavailableReason ? { unavailableReason: view.unavailableReason } : {}) }; }
        const reason = compatibility(model, providerSettings) ?? (!providerSettings.enabled ? 'provider-disabled' : providerSettings.auth === 'api-key' && !providerSettings.credentialRef ? 'credential-missing' : 'invalid-configuration');
        return { ...model, available: false, unavailableReason: reason } as ProviderModel;
      }));
    },
    async createProviderSettings(input) {
      keys(input, ['providerId', 'name', 'enabled', 'protocolId', 'baseUrl', 'auth', 'timeoutMs', 'apiKey']);
      const { providerId: id, apiKey, ...data } = input;
      identifier(id);
      validateProviderSettings(data);
      if (apiKey !== undefined) assert(nonempty(apiKey) && data.auth === 'api-key');
      const captured = immutable(data);
      return enqueue(id, async () => {
        if (store.providerSettings(id)) throw modelsError('conflict');
        definitionProvider(id);
        generations.get(captured.protocolId)?.protocol.validateProvider(captured);
        const record: ProviderSettingsRecord = immutable({
          ...captured, id, ...revision(store.providerSettingsHistory(id).at(-1)),
          credentialRef: null, historyScopeEpoch: randomUUID(), restoreScopeId: id,
        });
        if (apiKey !== undefined) await changeCredential(undefined, record, apiKey);
        else await store.commit({ providerSettings: { record, expectedRevision: null } });
        return reconcile(id);
      });
    },
    async updateProviderSettings(id, input, expectedRevision) {
      keys(input, ['name', 'enabled', 'baseUrl', 'auth', 'timeoutMs']); const captured = immutable(input);
      return enqueue(id, async () => { const previous = getProviderSettings(id); compare(previous.revision, expectedRevision); const data = { ...providerSettingsInput(previous), ...captured }; validateProviderSettings(data); generations.get(data.protocolId)?.protocol.validateProvider(data); const record = immutable({ ...previous, ...data, ...revision(previous), historyScopeEpoch: data.baseUrl !== previous.baseUrl || data.auth !== previous.auth ? randomUUID() : previous.historyScopeEpoch }); await store.commit({ providerSettings: { record, expectedRevision } }); return reconcile(id); });
    },
    async deleteProviderSettings(id, expectedRevision) {
      return enqueue(id, async () => {
        const previous = getProviderSettings(id); compare(previous.revision, expectedRevision);
        const retired = previous.credentialRef ? intentFor(id, previous.credentialRef) : undefined;
        // Source ingestion reads current provider settings before committing sync state; serialize that read/write with deletion.
        await enqueue('@definitions', () => store.commit({ deleteProviderSettings: { id, expectedRevision }, addIntents: retired ? [retired] : [] }), true);
        syncOverrides.delete(id);
        // Executions already hold their own credential and configuration snapshot.
        for (const intent of store.intents().filter(item => item.providerId === id)) await cleanupIntent(intent);
      });
    },
    async setApiKey(id, apiKey, expectedRevision) { assert(nonempty(apiKey)); return enqueue(id, async () => { const previous = getProviderSettings(id); compare(previous.revision, expectedRevision); assert(previous.auth === 'api-key'); await changeCredential(previous, { ...previous, ...revision(previous) }, apiKey); return reconcile(id); }); },
    async deleteApiKey(id, expectedRevision) { return enqueue(id, async () => { const previous = getProviderSettings(id); compare(previous.revision, expectedRevision); await changeCredential(previous, { ...previous, ...revision(previous) }, null); return reconcile(id); }); },
    retryProviderSettings: id => enqueue(id, () => reconcile(id)),
    async createModelSettings(input) {
      requireOpen();
      const { modelId, ...data } = input;
      validateModelSettings(data);
      const captured = immutable(data), providerId = definitionModel(modelId).providerId;
      return enqueue(providerId, async () => {
        if (store.modelSettings(modelId)) throw modelsError('conflict');
        const model = definitionModel(modelId), provider = getProviderSettings(providerId);
        const parameters = nativeParameters(captured, provider.protocolId);
        generations.get(provider.protocolId)?.protocol.validateParameters(parameters.value, captured.capabilities);
        const record = newModelSettings(model, captured);
        await store.commit({ modelSettings: [{ record, expectedRevision: null }] });
        return record;
      });
    },
    async updateModelSettings(id, input, expectedRevision) {
      requireOpen();
      keys(input, ['name', 'enabled', 'capabilities', 'parameters']);
      const captured = immutable(input), providerId = definitionModel(id).providerId;
      return enqueue(providerId, async () => {
        const previous = store.modelSettings(id);
        if (!previous) throw modelsError('not-found');
        compare(previous.revision, expectedRevision);
        const data = { ...modelSettingsInput(previous), ...captured };
        validateModelSettings(data);
        const provider = getProviderSettings(providerId), parameters = nativeParameters(data, provider.protocolId);
        generations.get(provider.protocolId)?.protocol.validateParameters(parameters.value, data.capabilities);
        const record = immutable({ ...previous, ...data, ...revision(previous) });
        await store.commit({ modelSettings: [{ record, expectedRevision }] });
        return record;
      });
    },
    discoverModels: (id, signal) => network(id, 'discover', signal),
    checkProvider: (id, signal) => network(id, 'check', signal),
  };
  const sourceData: ModelsSourceDataService = {
    accepted(sourceId) {
      requireOpen(); const state = store.sources().find(value => value.sourceId === sourceId); if (!state) return undefined;
      return immutable({ ...state, schemaVersion: 2, providers: store.providers().filter(value => value.source.kind === 'external' && value.source.sourceId === sourceId && value.state === 'present'), models: store.models().filter(value => value.source.kind === 'external' && value.source.sourceId === sourceId && value.state === 'present') });
    },
    async accept(snapshot: SourceSnapshot, options = {}) {
      requireOpen(); keys(options, ['confirmed']); assert(options.confirmed === undefined || typeof options.confirmed === 'boolean'); validateCatalogSnapshot(snapshot); const captured = immutable(snapshot); const confirmed = options.confirmed === true;
      return trackJob((async () => {
      const accepted = await enqueue('@definitions', async () => {
        await yieldToHost();
        const previous = store.sources().find(value => value.sourceId === captured.sourceId);
        if (previous && captured.snapshotVersion !== previous.snapshotVersion && (captured.fetchedAt < previous.fetchedAt || captured.fetchedAt === previous.fetchedAt && !confirmed)) return false;
        if (previous?.snapshotVersion === captured.snapshotVersion) { if (captured.fetchedAt > previous.fetchedAt) await store.commit({ sources: [{ ...previous, fetchedAt: captured.fetchedAt }] }); return true; }
        const merge = <T extends Provider | Model>(values: readonly T[], existing: readonly T[]) => {
          const incoming = new Map(values.map(value => [value.id, value])); const currentById = new Map(existing.map(value => [value.id, value]));
          const changes: { record: T; expectedRevision: number | null }[] = [];
          for (const candidate of values) { const current = currentById.get(candidate.id); if (current?.source.kind === 'user') throw modelsError('conflict'); const record = immutable({ ...candidate, ...revision(current), id: candidate.id }); changes.push({ record, expectedRevision: current?.revision ?? null }); }
          for (const current of existing) if (current.source.kind === 'external' && current.source.sourceId === captured.sourceId && !incoming.has(current.id) && current.state !== 'missing') changes.push({ record: immutable({ ...current, ...revision(current), state: 'missing' }) as T, expectedRevision: current.revision });
          return changes;
        };
        const providerChanges = merge(captured.providers, store.providers()), modelChanges = merge(captured.models, store.models());
        const providerIds = new Set(providerChanges.map(value => value.record.id));
        // Yield before opening the atomic store transaction, never inside it.
        await yieldToHost();
        await store.commit({ providers: providerChanges, models: modelChanges, sources: [{ sourceId: captured.sourceId, fetchedAt: captured.fetchedAt, snapshotVersion: captured.snapshotVersion }], syncStates: store.configuredProviders().filter(value => providerIds.has(value.id)).map(value => ({ providerId: value.id, state: 'pending', targetSourceVersion: captured.snapshotVersion, syncedSourceVersion: store.syncState(value.id)?.syncedSourceVersion ?? null })) });
        return true;
      }, true);
      const providers = new Set(store.providers().filter(value => value.source.kind === 'external' && value.source.sourceId === captured.sourceId).map(value => value.id));
      const reconciled = await Promise.all(store.configuredProviders().filter(value => providers.has(value.id)).map(value => enqueue(value.id, async () => { if (!store.providerSettings(value.id)) return undefined; const providerSettings = await reconcile(value.id); return providerSettings.sync!; }, true)));
      const providerStates = reconciled.filter((value): value is ProviderSyncState => value !== undefined);
      return immutable({ accepted, source: store.sources().find(value => value.sourceId === captured.sourceId)!, providers: providerStates });
      })());
    },
  };

  const unregister = (generation: Generation): Promise<void> => {
    if (generation.closing) return generation.closing;
    generation.accepting = false; generation.controller.abort();
    continuations.delete(generation);
    const id = generation.protocol.descriptor.id;
    if (generations.get(id) === generation) generations.delete(id);
    for (const operation of generation.pending) operation.cancel();
    generation.closing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([
        ...[...generation.pending].map(operation => operation.done),
        ...[...generation.executions].map(async execution => { const report = await execution.close(); if (report.cleanup === 'failed') throw modelsError('cleanup-failure'); }),
      ]);
      ownedGenerations.delete(generation);
      if (generation.cleanupFailed || outcomes.some(outcome => outcome.status === 'rejected')) { cleanupFailed = true; throw modelsError('cleanup-failure'); }
    });
    // Stop admission to existing idle executions synchronously too.
    for (const execution of generation.executions) void execution.close().catch(() => {});
    void generation.closing.catch(() => {});
    return generation.closing;
  };
  const acquire = (generation: Generation): NativeProtocolLease => {
    requireOpen(); if (!generation.accepting) throw modelsError('protocol-unavailable');
    const state = { generation, released: false };
    const value = Object.freeze({ protocolId: generation.protocol.descriptor.id, generationId: generation.id, protocolVersion: generation.protocol.descriptor.version,
      signal: generation.controller.signal, release() { state.released = true; } });
    leases.set(value, state); return value;
  };
  const protocols: ModelsProtocolsService = {
    acquire(id) { identifier(id); return acquire(getGeneration(id)); },
    register<I extends NativeObject, R extends NativeObject, E extends NativeObject>(protocol: NativeProtocol<I, R, E>) {
      requireOpen(); identifier(protocol.descriptor.id); assert(nonempty(protocol.descriptor.version));
      assert(protocol.recordFormatVersion === undefined || protocol.recordFormatVersion === 1 || protocol.recordFormatVersion === 2);
      assert(protocol.descriptor.responseModes === undefined || Array.isArray(protocol.descriptor.responseModes) && protocol.descriptor.responseModes.every(value => value === 'stream' || value === 'complete') && new Set(protocol.descriptor.responseModes).size === protocol.descriptor.responseModes.length);
      const adapter = protocol.textGeneration;
      assert(adapter === undefined || adapter && typeof adapter.createIntent === 'function' && typeof adapter.validateParameters === 'function' && typeof adapter.readText === 'function');
      if (generations.has(protocol.descriptor.id)) throw modelsError('conflict');
      const stable: NativeProtocol = Object.freeze({
        descriptor: immutable(protocol.descriptor), supportsManagedSend: protocol.supportsManagedSend, validateProvider: protocol.validateProvider.bind(protocol),
        textGeneration: adapter ? Object.freeze({ createIntent: adapter.createIntent.bind(adapter), validateParameters: adapter.validateParameters.bind(adapter), readText: adapter.readText.bind(adapter) }) as NativeProtocol['textGeneration'] : undefined,
        recordFormatVersion: protocol.recordFormatVersion, canRestoreVersion: protocol.canRestoreVersion?.bind(protocol), resourceIds: protocol.resourceIds?.bind(protocol),
        validateParameters: protocol.validateParameters.bind(protocol), effectiveCapabilities: protocol.effectiveCapabilities.bind(protocol),
        initialParameters: protocol.initialParameters?.bind(protocol), supportsHistoryPrefix: protocol.supportsHistoryPrefix, restore: protocol.restore.bind(protocol), prepare: protocol.prepare.bind(protocol),
        exchange: protocol.exchange.bind(protocol), commit: protocol.commit.bind(protocol), discover: protocol.discover?.bind(protocol), check: protocol.check?.bind(protocol),
      });
      const generation: Generation = { protocol: stable, id: randomUUID(), controller: new AbortController(), accepting: true, pending: new Set(), executions: new Set(), cleanupFailed: false };
      continuations.set(generation, new WeakMap());
      generations.set(stable.descriptor.id, generation); ownedGenerations.add(generation);
      for (const provider of store.configuredProviders().filter(value => value.protocolId === stable.descriptor.id)) void enqueue(provider.id, () => reconcile(provider.id)).catch(() => {});
      return Object.freeze({ generationId: generation.id, protocolVersion: stable.descriptor.version, signal: generation.controller.signal, acquire: () => acquire(generation) as NativeProtocolLease<I, R, E>, unregister: () => unregister(generation) });
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
  return { models, settings, protocols, sourceData, recover, close };
}

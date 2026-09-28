import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context, FiberState } from '@nya/core'
import { createModelsComponent } from '../dist/component.js'
import { modelsError } from '../dist/errors.js'

export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const code = expected => error => error?.code === expected
export const complete = (text = 'answer', toolCalls = []) => ({ status: 'completed', text, toolCalls })
export const capabilities = overrides => ({
  tools: { support: 'supported' }, streaming: { support: 'supported' },
  imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' }, ...overrides,
})

/** Transactions are atomic; this fake is independent of SQLite and runtime queues. */
export function memoryStore() {
  const maps = { providers: new Map(), models: new Map(), connections: new Map(), configurations: new Map() }
  const histories = Object.fromEntries(Object.keys(maps).map(key => [key, new Map()]))
  const intents = new Map(), sources = new Map(), syncStates = new Map()
  const port = { failCommit: undefined,
    intents: () => structuredClone([...intents.values()]),
    sources: () => structuredClone([...sources.values()]),
    syncState: id => structuredClone(syncStates.get(id)),
    async commit(change) {
      if (this.failCommit) throw this.failCommit
      if (change.deleteConnection) {
        const current = maps.connections.get(change.deleteConnection.id)
        if (!current) throw modelsError('not-found')
        if (current.revision !== change.deleteConnection.expectedRevision) throw modelsError('conflict')
      }
      for (const guard of change.syncGuards ?? []) if ((syncStates.get(guard.connectionId)?.targetSourceVersion ?? null) !== guard.targetSourceVersion) throw modelsError('conflict')
      const groups = [['providers', change.providers ?? []], ['models', change.models ?? []], ['connections', change.connection ? [change.connection] : []], ['configurations', change.configurations ?? []]]
      for (const [kind, changes] of groups) for (const item of changes) {
        const current = maps[kind].get(item.record.id)
        if ((current?.revision ?? null) !== item.expectedRevision) throw modelsError('conflict')
        if (!current && histories[kind].has(item.record.id)) throw modelsError('conflict')
        if (kind === 'configurations' && item.record.baseline && [...maps.configurations.values(), ...changes.filter(x => x !== item).map(x => x.record)].some(x => x.id !== item.record.id && x.baseline && x.connectionId === item.record.connectionId && x.modelDefinitionId === item.record.modelDefinitionId)) throw modelsError('conflict')
      }
      for (const [kind, changes] of groups) for (const item of changes) {
        const copy = structuredClone(item.record); maps[kind].set(copy.id, copy)
        histories[kind].set(copy.id, [...(histories[kind].get(copy.id) ?? []), copy])
      }
      for (const state of change.sources ?? []) sources.set(state.sourceId, structuredClone(state))
      for (const state of change.syncStates ?? []) syncStates.set(state.connectionId, structuredClone(state))
      for (const intent of change.addIntents ?? []) intents.set(intent.id, structuredClone(intent))
      for (const id of change.removeIntentIds ?? []) intents.delete(id)
      if (change.deleteConnection) {
        const { id } = change.deleteConnection
        for (const [configurationId, value] of maps.configurations) if (value.connectionId === id) maps.configurations.delete(configurationId)
        syncStates.delete(id); maps.connections.delete(id)
      }
    },
  }
  for (const [kind, one] of [['providers', 'provider'], ['models', 'model'], ['connections', 'connection'], ['configurations', 'configuration']]) {
    port[kind] = () => structuredClone([...maps[kind].values()])
    port[one] = id => structuredClone(maps[kind].get(id))
    port[`${one}History`] = id => structuredClone(histories[kind].get(id) ?? [])
  }
  return port
}

export async function addConnection(settings, input) {
  const definition = await settings.createProvider({ id: `${input.id ?? randomUUID()}-definition`, name: input.name, connectionHints: { protocolIds: [input.protocolId], baseUrl: input.baseUrl } })
  return settings.createConnection({ ...input, providerDefinitionId: definition.id })
}
export async function addConfiguration(settings, input) {
  const { id, providerId, remoteModelId, defaults, enabled, ...metadata } = input
  const connection = settings.connections().find(value => value.id === providerId)
  const definition = await settings.createModel({ ...metadata, providerId: connection.providerDefinitionId, remoteModelId,
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [connection.protocolId] } })
  return settings.createConfiguration({ id, name: input.name, connectionId: providerId, modelDefinitionId: definition.id, enabled, defaults, capabilities: input.capabilities, baseline: true })
}

export function memoryVault() {
  const secrets = new Map(), operations = [], reads = []
  return {
    secrets, operations, reads,
    failWrite: undefined, failDelete: undefined, holdReads: false,
    async read(slotId, signal) {
      const read = { slotId, signal, release: deferred(), aborted: deferred() }
      reads.push(read); operations.push({ kind: 'read', slotId })
      if (signal?.aborted) read.aborted.resolve()
      else signal?.addEventListener('abort', () => read.aborted.resolve(), { once: true })
      if (this.holdReads) await read.release.promise
      if (signal?.aborted) throw modelsError('cancelled')
      return secrets.get(slotId)
    },
    async write(slotId, value) {
      operations.push({ kind: 'write', slotId })
      // Failure may happen after an external store has already written the slot.
      secrets.set(slotId, value)
      if (this.failWrite) throw this.failWrite
    },
    async delete(slotId) {
      operations.push({ kind: 'delete', slotId })
      if (this.failDelete) throw this.failDelete
      secrets.delete(slotId)
    },
    release() { for (const read of reads) read.release.resolve() },
  }
}

export function fakeProtocol(id = 'test', version = '1') {
  const calls = [], operations = [], queued = []
  function operation(input, kind = 'call') {
    const result = deferred(), done = deferred(), aborted = deferred()
    const record = {
      input, kind, result, done, aborted, cancellations: [],
      succeed(value = kind === 'call' ? { result: complete(), continuation: { turn: calls.length } } : kind === 'discover' ? [] : undefined) {
        result.resolve(value); done.resolve()
      },
    }
    if (input.signal.aborted) aborted.resolve()
    else input.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    operations.push(record)
    if (kind === 'call') calls.push(record)
    const action = queued.shift()
    if (action) action(record)
    else queueMicrotask(() => record.succeed())
    return { result: result.promise, done: done.promise, cancel(reason) { record.cancellations.push(reason); aborted.resolve() } }
  }
  return {
    calls, operations,
    next(action = () => {}) { queued.push(action) },
    release() { for (const item of operations) item.succeed() },
    descriptor: { id, version, name: `Protocol ${id}`, connectionFields: [], modelFields: [], supportsDiscovery: true, supportsCheck: true },
    validateProvider() {},
    validateOptions(options) {
      if (options.protocol && Object.keys(options.protocol).length) throw modelsError('invalid-config')
    },
    effectiveCapabilities(declared) {
      return { tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false, reasoning: declared.reasoning }
    },
    call: input => operation(input),
    discover: input => operation(input, 'discover'),
    check: input => operation(input, 'check'),
  }
}

export async function fixture({ store = memoryStore(), vault = memoryVault(), protocols = [fakeProtocol()] } = {}) {
  const root = new Context()
  const ports = root.installComponent({ name: 'test-models-ports', apply(ctx) { ctx.provide('models.store', store); ctx.provide('models.vault', vault) } })
  await ports
  const component = root.installComponent(createModelsComponent())
  await component
  assert.equal(component.state, FiberState.ACTIVE)
  const models = root.get('models'), settings = root.get('models.settings'), registry = root.get('models.protocols')
  const registrations = protocols.map(protocol => registry.register(protocol))
  return {
    root, component, models, settings, registry, store, vault, protocols, registrations, sourceData: root.get('models.source-data'),
    addConnection: input => addConnection(settings, input), addConfiguration: input => addConfiguration(settings, input),
    async add({ providerId = 'provider', modelId = 'model', protocolId = protocols[0]?.descriptor.id ?? 'absent', key, timeoutMs = 10000, defaults = {}, capabilityDeclarations = capabilities() } = {}) {
      const provider = await addConnection(settings, {
        id: providerId, name: providerId, enabled: true, protocolId, baseUrl: 'https://example.invalid/v1',
        auth: key === undefined ? 'none' : 'api-key', timeoutMs, ...(key === undefined ? {} : { apiKey: key }),
      })
      const model = await addConfiguration(settings, { id: modelId, name: modelId, enabled: true, providerId, remoteModelId: 'same-remote-model', capabilities: capabilityDeclarations, defaults })
      return { provider, model }
    },
    async close() { vault.release?.(); for (const protocol of protocols) protocol.release(); await root.fiber.dispose() },
  }
}

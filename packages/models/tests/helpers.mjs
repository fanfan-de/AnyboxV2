import assert from 'node:assert/strict'
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
  const providers = new Map(), models = new Map(), providerHistory = new Map(), modelHistory = new Map(), intents = new Map()
  return {
    failCommit: undefined,
    providers: () => structuredClone([...providers.values()]),
    provider: id => structuredClone(providers.get(id)),
    providerHistory: id => structuredClone(providerHistory.get(id) ?? []),
    models: () => structuredClone([...models.values()]),
    model: id => structuredClone(models.get(id)),
    modelHistory: id => structuredClone(modelHistory.get(id) ?? []),
    intents: () => structuredClone([...intents.values()]),
    async commit(change) {
      if (this.failCommit) throw this.failCommit
      for (const [item, records] of [[change.provider, providers], [change.model, models]]) {
        if (!item) continue
        const current = records.get(item.record.id)
        if ((current?.revision ?? null) !== item.expectedRevision) throw modelsError('conflict')
      }
      for (const [item, records, versions] of [[change.provider, providers, providerHistory], [change.model, models, modelHistory]]) {
        if (!item) continue
        const copy = structuredClone(item.record)
        records.set(copy.id, copy)
        versions.set(copy.id, [...(versions.get(copy.id) ?? []), copy])
      }
      for (const intent of change.addIntents ?? []) intents.set(intent.id, structuredClone(intent))
      for (const id of change.removeIntentIds ?? []) intents.delete(id)
    },
  }
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
    root, component, models, settings, registry, store, vault, protocols, registrations,
    async add({ providerId = 'provider', modelId = 'model', protocolId = protocols[0]?.descriptor.id ?? 'absent', key, timeoutMs = 10000, defaults = {}, capabilityDeclarations = capabilities() } = {}) {
      const provider = await settings.createProvider({
        id: providerId, name: providerId, enabled: true, protocolId, baseUrl: 'https://example.invalid/v1',
        auth: key === undefined ? 'none' : 'api-key', timeoutMs, ...(key === undefined ? {} : { apiKey: key }),
      })
      const model = await settings.createModel({ id: modelId, name: modelId, enabled: true, providerId, remoteModelId: 'same-remote-model', capabilities: capabilityDeclarations, defaults })
      return { provider, model }
    },
    async close() { vault.release?.(); for (const protocol of protocols) protocol.release(); await root.fiber.dispose() },
  }
}

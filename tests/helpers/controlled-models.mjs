import { modelsError, modelsServiceKey } from '@anybox/models'

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export function ids() { let next = 0; return () => `id-${++next}` }

export function modelSnapshot(modelId = 'default', version = 'v1') {
  return Object.freeze({ schemaVersion: 2, modelDefinitionId: `definition-${modelId}`, providerDefinitionId: 'test-provider-definition', modelDefinitionVersionId: 'definition-v1', modelId, modelRevision: 1, modelVersionId: `model-${version}`, providerId: 'test-provider',
    providerRevision: 1, providerVersionId: 'provider-v1', remoteModelId: 'test-remote', protocolId: 'test', protocolVersion: version, options: {} })
}

/** Controlled ModelsService used to test Harness ownership, independently of transport. */
export function controlledModels({ version = 'v1', modelIds = ['default'], call, open } = {}) {
  const calls = [], events = [], opens = []
  const capabilities = Object.freeze({ tools: true, streaming: true, imageInput: false, reasoning: { support: 'unknown' } })
  const summaries = modelIds.map(id => ({ id, name: id, enabled: true, revision: 1, versionId: `model-${version}`, createdAt: 'now', updatedAt: 'now', connectionId: 'test-provider', providerDefinitionId: 'test-provider-definition', modelDefinitionId: `definition-${id}`, modelDefinitionVersionId: 'definition-v1', source: { kind: 'user' }, baseline: true,
    remoteModelId: 'test-remote', capabilities: { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } },
    defaults: {}, available: true, effectiveCapabilities: capabilities }))
  const record = input => {
    const result = deferred(), done = deferred(), cancelled = deferred()
    const entry = { input, result, done, cancellations: [], cancelled }
    calls.push(entry)
    return { result: result.promise, done: done.promise, cancel(reason) { entry.cancellations.push(reason); if (entry.cancellations.length === 1) cancelled.resolve(reason); result.reject(modelsError('cancelled')) } }
  }
  const api = { calls, events, opens, call, open,
    protocol: () => ({
      descriptor: { id: 'controlled', version, name: 'Controlled transport', connectionFields: [], modelFields: [], supportsCheck: true, supportsDiscovery: true },
      validateProvider() {}, validateOptions() {},
      effectiveCapabilities: declared => ({ tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false, reasoning: declared.reasoning }),
      call(input) {
        const raw = (api.call ?? record)(input)
        return { ...raw, result: raw.result.then(value => ({ result: typeof value === 'string' ? { status: 'completed', text: value, toolCalls: [] } : value })) }
      },
      check: () => ({ result: Promise.resolve(), done: Promise.resolve(), cancel() {} }),
      discover: () => ({ result: Promise.resolve([{ remoteModelId: 'candidate', name: 'Candidate' }]), done: Promise.resolve(), cancel() {} }),
    }),
    component: () => ({
      name: 'controlled-models',
      apply(ctx) {
        const executions = new Set()
        let accepting = true, cleanupFailed = false
        ctx.effect(() => async () => {
          accepting = false
          const stopped = await Promise.allSettled([...executions].map(execution => execution.close()))
          events.push('disposed')
          if (cleanupFailed || stopped.some(item => item.status === 'rejected')) throw modelsError('cleanup-failure')
        }, 'join controlled model executions')
        const service = {
          list: () => structuredClone(summaries),
          get: id => structuredClone(summaries.find(item => item.id === id)),
          async open(input) {
            if (!accepting) throw modelsError('closed')
            if (!modelIds.includes(input.modelId)) throw modelsError('unavailable')
            if (api.open) await api.open(input)
            if (input.signal?.aborted) throw modelsError('cancelled')
            let history = structuredClone(input.history ?? []), active, closePromise, closed = false
            const snapshot = modelSnapshot(input.modelId, version)
            const execution = {
              snapshot, capabilities,
              generate(request) {
                if (closed) throw modelsError('closed')
                if (active) throw modelsError('busy')
                const messages = [...history, ...structuredClone(request.messages)]
                const raw = (api.call ?? record)({ ...request, messages, newMessages: structuredClone(request.messages), tools: input.tools ?? [], execution })
                let cancelled = false, cancelFailed = false
                const result = deferred(), done = deferred()
                const cancel = reason => {
                  if (cancelled) return
                  cancelled = true
                  try { raw.cancel(reason) } catch { cancelFailed = true; cleanupFailed = true }
                }
                const handle = { result: result.promise, done: done.promise, cancel }
                active = handle
                const exited = raw.done.then(() => undefined, () => { throw modelsError('cleanup-failure') })
                void exited.catch(() => {})
                const value = raw.result.then(value => typeof value === 'string' ? { status: 'completed', text: value, toolCalls: [] } : value)
                void value.catch(() => {})
                void (async () => {
                  let reply, failure
                  try {
                    reply = await Promise.race([value, exited.then(() => new Promise(() => {}))])
                  } catch (error) { failure = error }
                  try { await exited } catch (error) { failure = error; cleanupFailed = true }
                  if (cancelFailed) failure = modelsError('cleanup-failure')
                  if (cancelled && !failure) failure = modelsError('cancelled')
                  if (!failure) history = [...messages, { role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}) }]
                  active = undefined
                  if (failure?.code === 'cleanup-failure') done.reject(failure); else done.resolve()
                  if (failure) result.reject(failure); else result.resolve(reply)
                })()
                return handle
              },
              close() {
                if (closePromise) return closePromise
                closed = true
                const current = active
                current?.cancel('execution-closed')
                closePromise = (async () => {
                  try { await current?.done } finally { executions.delete(execution); input.signal?.removeEventListener('abort', aborted) }
                })()
                void closePromise.catch(() => {})
                return closePromise
              },
            }
            const aborted = () => { active?.cancel('cancelled') }
            input.signal?.addEventListener('abort', aborted, { once: true })
            executions.add(execution); opens.push({ input, execution })
            return execution
          },
        }
        ctx.provide(modelsServiceKey, service)
      },
    }),
  }
  return api
}

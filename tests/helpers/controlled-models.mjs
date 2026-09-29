import { modelsError, modelsServiceKey, createChatCompletionsProtocol, unknownCapabilities } from '@anybox/models'
import { createExecution, validateRestore } from '../../packages/models/dist/execution.js'

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
export function ids() { let next = 0; return () => `id-${++next}` }
export function modelSnapshot(modelId = 'default', version = 'v1') {
  return Object.freeze({ schemaVersion: 3, modelDefinitionId: `definition-${modelId}`, providerDefinitionId: 'test-provider-definition', modelDefinitionVersionId: 'definition-v1',
    modelId, modelRevision: 1, modelVersionId: `model-${version}`, providerId: 'test-provider', providerRevision: 1, providerVersionId: 'provider-v1',
    remoteModelId: 'test-remote', protocolId: 'chat-completions', protocolVersion: version, registrationGenerationId: `test-generation-${version}`,
    historyScopeEpoch: 'test-scope-v1', parameters: { protocolId: 'chat-completions', formatVersion: 1, value: {} },
    capabilities: { tools: true, streaming: true, imageInput: false, webSearch: false, reasoning: { support: 'unknown' } } })
}

/** Test fixtures keep controllable result/done promises while exercising the native execution kernel. */
export function controlledModels({ version = 'v1', modelIds = ['default'], call, open } = {}) {
  const calls = [], events = [], opens = []
  const capabilities = Object.freeze({ tools: true, streaming: true, imageInput: false, webSearch: false, reasoning: { support: 'unknown' } })
  const declarations = { ...unknownCapabilities(), tools: { support: 'supported' }, streaming: { support: 'supported' } }
  const summaries = modelIds.map(id => ({ id, name: id, enabled: true, revision: 1, versionId: `model-${version}`, createdAt: 'now', updatedAt: 'now',
    connectionId: 'test-provider', providerDefinitionId: 'test-provider-definition', modelDefinitionId: `definition-${id}`, modelDefinitionVersionId: 'definition-v1',
    source: { kind: 'user' }, baseline: true, remoteModelId: 'test-remote', capabilities: declarations,
    parameters: { protocolId: 'chat-completions', formatVersion: 1, value: {} }, available: true, effectiveCapabilities: capabilities }))
  const record = input => {
    const result = deferred(), done = deferred(), cancelled = deferred()
    const entry = { input, result, done, cancellations: [], cancelled }
    calls.push(entry)
    return { result: result.promise, done: done.promise, cancel(reason) {
      entry.cancellations.push(reason); if (entry.cancellations.length === 1) cancelled.resolve(reason)
      result.reject(modelsError('cancelled'))
    } }
  }
  // Legacy-shaped fixture values are converted here, never in production execution.
  const nativeResponse = value => {
    if (value && Array.isArray(value.choices)) return value
    const reply = typeof value === 'string' ? { status: 'completed', text: value, toolCalls: [] } : value
    const tools = reply?.toolCalls ?? []
    return { choices: [{ index: 0, finish_reason: reply?.status === 'incomplete' ? 'length' : reply?.status === 'refused' ? 'content_filter' : tools.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: reply?.text ?? '', ...(reply?.status === 'refused' ? { refusal: reply.text || 'Refused' } : {}),
        ...(tools.length ? { tool_calls: tools.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) } : {}) } }] }
  }
  const fixtureMessage = message => ({ ...message,
    ...(message.role === 'tool' ? { callId: message.tool_call_id } : {}),
    ...(message.tool_calls ? { toolCalls: message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) })) } : {}) })
  const api = { calls, events, opens, call, open,
    protocol(executionRef) {
      const base = createChatCompletionsProtocol()
      return { ...base, descriptor: { ...base.descriptor, version }, recordFormatVersion: 1,
        canRestoreVersion: previous => previous === version,
        exchange(input) {
          const messages = input.request.messages.map(fixtureMessage)
          let lastAssistant = -1
          messages.forEach((message, index) => { if (message.role === 'assistant') lastAssistant = index })
          const onEvent = event => input.onEvent(event?.type === 'text-delta'
            ? { choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] } : event)
          const fixture = { ...input, messages, newMessages: messages.slice(lastAssistant + 1), onEvent,
            tools: (input.request.tools ?? []).map(tool => tool.function), execution: executionRef?.() }
          const raw = (api.call ?? record)(fixture)
          return { ...raw, result: raw.result.then(nativeResponse) }
        },
        check: () => ({ result: Promise.resolve(), done: Promise.resolve(), cancel() {} }),
        discover: () => ({ result: Promise.resolve([{ remoteModelId: 'candidate', name: 'Candidate' }]), done: Promise.resolve(), cancel() {} }),
      }
    },
    component: () => ({ name: 'controlled-models', apply(ctx) {
      const executions = new Set(), controller = new AbortController(), generationId = `test-generation-${version}`
      let accepting = true, cleanupFailed = false
      const protocol = api.protocol()
      const lease = () => {
        if (!accepting) throw modelsError('closed')
        return { protocolId: 'chat-completions', protocolVersion: version, generationId, signal: controller.signal, release() {} }
      }
      ctx.provide('models.protocols', { acquire(id) { if (id !== 'chat-completions') throw modelsError('protocol-unavailable'); return lease() } })
      ctx.provide('models.settings', { protocols: () => [protocol.descriptor] })
      ctx.effect(() => async () => {
        accepting = false; controller.abort()
        const results = await Promise.all([...executions].map(execution => execution.close()))
        events.push('disposed')
        if (cleanupFailed || results.some(result => result.cleanup === 'failed')) throw modelsError('cleanup-failure')
      }, 'join controlled native executions')
      const service = { list: () => structuredClone(summaries), get: id => structuredClone(summaries.find(item => item.id === id)),
        async openNative(input) {
          if (!accepting) throw modelsError('closed')
          if (!modelIds.includes(input.modelId)) throw modelsError('unavailable')
          if (api.open) await api.open(input)
          if (input.signal?.aborted) throw modelsError('cancelled')
          const snapshot = modelSnapshot(input.modelId, version)
          if (input.restore) validateRestore(input.restore, snapshot, protocol)
          const abort = new AbortController()
          const stop = () => abort.abort()
          input.signal?.addEventListener('abort', stop, { once: true }); controller.signal.addEventListener('abort', stop, { once: true })
          let execution
          execution = createExecution({ protocol: api.protocol(() => execution),
            provider: { providerDefinitionId: 'test-provider-definition', name: 'Test', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 30000 },
            snapshot, capabilities, restore: input.restore, controller: abort, onRelease(failed) {
              if (failed) cleanupFailed = true
              executions.delete(execution); input.signal?.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', stop)
            } })
          executions.add(execution); opens.push({ input, execution }); return execution
        } }
      ctx.provide(modelsServiceKey, service)
    } }),
  }
  return api
}

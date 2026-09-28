import type { Component } from '@nya/core'
import { createChatCompletionsProtocol, modelsError, modelsProtocolsServiceKey } from '@anybox/models'
import type { ModelProtocol, ModelsProtocolsService, ProtocolOptions } from '@anybox/models'

/** Host extension for the existing DeepSeek non-thinking tool workflow.
 * Shared Chat transport/parser still owns HTTP, SSE and actual resource exit. */
export function createDeepSeekProtocol(options: ProtocolOptions = {}): ModelProtocol {
  const fetch = options.fetch ?? globalThis.fetch
  const chat = createChatCompletionsProtocol({ fetch: (url, init) => {
    if (typeof init?.body !== 'string') return fetch(url, init)
    const { max_completion_tokens, ...body } = JSON.parse(init.body)
    return fetch(url, { ...init, body: JSON.stringify({ ...body, thinking: { type: 'disabled' },
      ...(max_completion_tokens === undefined ? {} : { max_tokens: max_completion_tokens }) }) })
  } })
  return Object.freeze({
    ...chat,
    descriptor: Object.freeze({ ...chat.descriptor, id: 'deepseek-chat-completions', name: 'DeepSeek 非推理',
      modelFields: Object.freeze(chat.descriptor.modelFields.filter(field => !field.key.startsWith('protocol.'))) }),
    validateProvider(provider) {
      if (provider.protocolId !== 'deepseek-chat-completions') throw modelsError('invalid-config')
      chat.validateProvider({ ...provider, protocolId: 'chat-completions' })
    },
    validateOptions(options, capabilities) {
      if (options.protocol && Object.keys(options.protocol).length) throw modelsError('capability-unsupported')
      chat.validateOptions(options, capabilities)
    },
    effectiveCapabilities(declared, options) {
      return Object.freeze({ ...chat.effectiveCapabilities(declared, options), reasoning: Object.freeze({ support: 'unsupported' as const }) })
    },
    call(input) {
      if (input.messages.some(message => message.role === 'developer')) throw modelsError('invalid-config')
      return chat.call(input)
    },
  } satisfies ModelProtocol)
}

export function createDeepSeekProtocolComponent(options: ProtocolOptions = {}): Component.Object<void, { [modelsProtocolsServiceKey]: ModelsProtocolsService }> {
  const protocol = createDeepSeekProtocol(options)
  return {
    name: 'models-protocol-deepseek', inject: [modelsProtocolsServiceKey],
    apply(ctx, _config, deps) {
      const registration = deps[modelsProtocolsServiceKey].register(protocol)
      ctx.effect(() => () => registration.unregister(), 'unregister DeepSeek protocol generation')
    },
  }
}

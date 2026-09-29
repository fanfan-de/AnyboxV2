import type { Component } from '@nya/core'
import { createChatCompletionsProtocol, modelsError, modelsProtocolsServiceKey } from '@anybox/models'
import type { ModelsProtocolsService, NativeObject, NativeProtocol, ProtocolOptions } from '@anybox/models'

/** Pure read/migration adapter. No retired execution API is retained. */
export function convertLegacyDeepSeekParameters(value: NativeObject): NativeObject {
  if (Object.keys(value).some(key => !['temperature', 'maxOutputTokens', 'protocol'].includes(key)) ||
    (value.protocol !== undefined && (!value.protocol || typeof value.protocol !== 'object' || Array.isArray(value.protocol) || Object.keys(value.protocol).length))) {
    throw modelsError('invalid-config')
  }
  return { ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.maxOutputTokens === undefined ? {} : { max_tokens: value.maxOutputTokens }) }
}

/** Explicit wire policy; native Chat transport, parsing and restore codec remain reusable. */
export function createDeepSeekProtocol(options: ProtocolOptions = {}): NativeProtocol {
  return createChatCompletionsProtocol(options, { protocolId: 'deepseek-chat-completions', name: 'DeepSeek 非推理',
    maxTokensField: 'max_tokens', disableThinking: true, allowDeveloper: false,
    sourceMappings: [{ sourceId: 'models.dev', providerId: 'deepseek', protocolIds: ['chat-completions'] }],
  })
}

export function createDeepSeekProtocolComponent(options: ProtocolOptions = {}): Component.Object<void, { [modelsProtocolsServiceKey]: ModelsProtocolsService }> {
  const protocol = createDeepSeekProtocol(options)
  return { name: 'models-protocol-deepseek', inject: [modelsProtocolsServiceKey], apply(ctx, _config, deps) {
    const registration = deps[modelsProtocolsServiceKey].register(protocol)
    ctx.effect(() => () => registration.unregister(), 'unregister DeepSeek native protocol generation')
  } }
}

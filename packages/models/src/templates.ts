import type { ProviderConnectionInput, SourceProviderIdentity } from './types.js';

export interface ProviderTemplate {
  readonly id: string;
  readonly name: string;
  readonly values: Omit<ProviderConnectionInput, 'name' | 'providerDefinitionId'> & { readonly sourceRef?: SourceProviderIdentity };
}
/** Optional UI defaults only. Runtime routing always uses the saved protocolId. */
export const builtinProviderTemplates: readonly ProviderTemplate[] = Object.freeze([
  Object.freeze({ id: 'openai-responses', name: 'OpenAI · Responses', values: Object.freeze({ enabled: true, protocolId: 'responses', baseUrl: 'https://api.openai.com/v1', auth: 'api-key' as const, timeoutMs: 120_000, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'openai' }) }) }),
  Object.freeze({ id: 'openai-chat-completions', name: 'OpenAI · Chat Completions', values: Object.freeze({ enabled: true, protocolId: 'chat-completions', baseUrl: 'https://api.openai.com/v1', auth: 'api-key' as const, timeoutMs: 120_000, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'openai' }) }) }),
  Object.freeze({ id: 'anthropic-messages', name: 'Anthropic · Messages', values: Object.freeze({ enabled: true, protocolId: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', auth: 'api-key' as const, timeoutMs: 120_000, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'anthropic' }) }) }),
  Object.freeze({ id: 'gemini-interactions', name: 'Gemini · Interactions', values: Object.freeze({ enabled: true, protocolId: 'gemini-interactions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'api-key' as const, timeoutMs: 120_000, sourceRef: Object.freeze({ sourceId: 'models.dev', providerId: 'google' }) }) }),
]);

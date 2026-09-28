import { isModelsError } from '@anybox/models'

/** Fixed, secret-free Run categories; protocol errors stay inside Models. */
export type ModelFailureCategory =
  | 'model-unavailable' | 'dependency-unavailable' | 'unsupported-request' | 'timeout'
  | 'provider-failure' | 'invalid-response' | 'cleanup-failure'
  | 'credential-missing' | 'credential-unavailable' | 'incomplete-response' | 'refused-response'

export interface ModelFailure extends Error { readonly category: ModelFailureCategory }

const messages: Record<ModelFailureCategory, string> = {
  'model-unavailable': 'model is unavailable',
  'dependency-unavailable': 'model dependency is unavailable',
  'unsupported-request': 'request is not supported by the model',
  timeout: 'model call timed out',
  'provider-failure': 'model provider failed',
  'invalid-response': 'model response is invalid',
  'cleanup-failure': 'model resources could not be released',
  'credential-missing': 'model API key is not configured',
  'credential-unavailable': 'model API key could not be read',
  'incomplete-response': 'model response was incomplete',
  'refused-response': 'model refused the request',
}

export function modelFailure(category: ModelFailureCategory): ModelFailure {
  return Object.assign(new Error(messages[category]), { name: 'ModelFailure', category })
}

export function isModelFailure(error: unknown): error is ModelFailure {
  return error instanceof Error && error.name === 'ModelFailure' && 'category' in error &&
    Object.hasOwn(messages, String(error.category))
}

export function normalizeModelFailure(error: unknown): ModelFailure {
  if (isModelFailure(error)) return modelFailure(error.category)
  if (!isModelsError(error)) return modelFailure('provider-failure')
  switch (error.code) {
    case 'credential-missing': case 'credential-unavailable': case 'timeout':
    case 'invalid-response': case 'cleanup-failure': case 'provider-failure': return modelFailure(error.code)
    case 'invalid-config': case 'capability-unsupported': return modelFailure('unsupported-request')
    case 'cancelled': case 'closed': case 'protocol-unavailable': return modelFailure('dependency-unavailable')
    default: return modelFailure('model-unavailable')
  }
}

export type ModelsErrorCode = 'invalid-config' | 'conflict' | 'not-found' | 'unavailable' | 'protocol-unavailable' | 'capability-unsupported' | 'credential-missing' | 'credential-unavailable' | 'cancelled' | 'timeout' | 'provider-failure' | 'invalid-response' | 'cleanup-failure' | 'closed' | 'busy' | 'storage-unavailable';
export interface ModelsError extends Error { readonly code: ModelsErrorCode }
const messages: Record<ModelsErrorCode, string> = {
  'invalid-config': 'Invalid model configuration or input.', conflict: 'Configuration revision conflict.',
  'not-found': 'Configuration does not exist.', unavailable: 'Model is unavailable.',
  'protocol-unavailable': 'The configured protocol is unavailable.',
  'capability-unsupported': 'A required capability is unsupported or unknown.',
  'credential-missing': 'A required credential is missing.', 'credential-unavailable': 'The credential store is unavailable.',
  cancelled: 'Model operation was cancelled.', timeout: 'Model operation timed out.',
  'provider-failure': 'The model provider request failed.', 'invalid-response': 'The model provider returned an invalid response.',
  'cleanup-failure': 'Model resources could not be released.', closed: 'Model service or execution is closed.',
  busy: 'An execution already has an active call.', 'storage-unavailable': 'Model configuration storage is unavailable.',
};
export function modelsError(code: ModelsErrorCode): ModelsError { return Object.assign(new Error(messages[code]), { name: 'ModelsError', code }); }
export function isModelsError(error: unknown): error is ModelsError {
  return error instanceof Error && error.name === 'ModelsError' && 'code' in error && Object.hasOwn(messages, String(error.code));
}
export function normalizeError(error: unknown, fallback: ModelsErrorCode = 'provider-failure'): ModelsError {
  return modelsError(isModelsError(error) ? error.code : fallback);
}

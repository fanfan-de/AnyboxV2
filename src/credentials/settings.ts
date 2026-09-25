import type { Component } from '@nya/core'
import { createApiKeyService, validateManagedCredentialDefinitions } from '@anybox/api-key-manager'
import type { ApiKeyManager, ApiKeyServiceOptions } from '@anybox/api-key-manager'
import { credentialReadServiceKey } from './port.js'

export { UnmanagedCredentialError } from '@anybox/api-key-manager'
export type { ManagedCredentialDefinition, ManagedCredentialStatus } from '@anybox/api-key-manager'
export const credentialSettingsServiceKey = 'credentials.settings'
export interface CredentialSettingsPort extends ApiKeyManager {}

/** One self-contained Nya component provides reads and management, with no injected project services. */
export function createApiKeyServiceComponent(options: ApiKeyServiceOptions): Component.Object<void> {
  const definitions = validateManagedCredentialDefinitions(options?.definitions)
  return {
    name: 'api-key-service',
    apply(ctx) {
      const service = createApiKeyService({ namespace: options.namespace, definitions, openEntry: options.openEntry })
      ctx.effect(() => () => service.close(), 'abort and join API Key operations')
      ctx.provide(credentialReadServiceKey, { read: (id: string, signal?: AbortSignal) => service.read(id, signal) })
      ctx.provide(credentialSettingsServiceKey, service)
    },
  }
}

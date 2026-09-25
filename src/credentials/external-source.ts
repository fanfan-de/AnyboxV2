import type { Component } from '@nya/core'
import { createOperationTracker } from './operations.js'
import { credentialId, credentialReadServiceKey } from './port.js'
import type { CredentialReadPort } from './port.js'

/** A trusted host's own credential source, for deployments without a desktop credential store. */
export interface ExternalCredentialSource {
  /** Resolves undefined when the id has no secret. Any rejection is reported as `store-unavailable`; the signal fires on unload. */
  read(id: string, signal: AbortSignal): Promise<string | undefined>
}

/** Registers only `credentials.read`. Nothing is written to disk and nothing is cached here. */
export function createExternalCredentialSourceComponent(source: ExternalCredentialSource): Component.Object<void> {
  if (typeof source?.read !== 'function') throw new TypeError('an external credential source with read() is required')
  return {
    name: 'external-credential-source',
    apply(ctx) {
      const operations = createOperationTracker('store-unavailable')
      ctx.effect(() => () => operations.close(), 'abort and join external credential reads')
      const service: CredentialReadPort = {
        async read(id, signal) {
          const target = credentialId(id)
          const value: unknown = await operations.run(ownedSignal => source.read(target, ownedSignal), signal)
          if (value === undefined || value === null) return undefined
          if (typeof value !== 'string') throw new TypeError('external credential source must resolve a string or undefined')
          return value
        },
      }
      ctx.provide(credentialReadServiceKey, service)
    },
  }
}

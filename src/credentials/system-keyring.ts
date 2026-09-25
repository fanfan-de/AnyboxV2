import type { Component } from '@nya/core'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import { credentialManageServiceKey, credentialReadServiceKey } from './port.js'
import { nonEmpty } from '../validation.js'
export type { CredentialEntry, SystemKeyringOptions } from '@anybox/api-key-manager'
import type { SystemKeyringOptions } from '@anybox/api-key-manager'

/** A thin Nya adapter for the portable OS-backed store. */
export function createSystemKeyringComponent(options: SystemKeyringOptions): Component.Object<void> {
  const namespace = nonEmpty(options?.namespace, 'credential namespace')
  if (options.openEntry !== undefined && typeof options.openEntry !== 'function') {
    throw new TypeError('credential entry factory must be a function')
  }
  return {
    name: 'system-keyring',
    apply(ctx) {
      const store = createSystemKeyringStore({ namespace, openEntry: options.openEntry })
      ctx.effect(() => () => store.close(), 'abort and join credential store operations')
      ctx.provide(credentialReadServiceKey, store)
      ctx.provide(credentialManageServiceKey, store)
    },
  }
}

import type { PackageUseCredential } from './port.js'

/** Private fixed-role startup. Paths and secrets are never accepted from a browser. */
export interface ManagedRoleStart {
  /** Trusted parent recovery only; never populated from package metadata or browser input. */
  readonly managementOnly?: boolean
  readonly role: 'client' | 'execution'
  readonly path: string
  readonly executionPath?: string
  readonly packageDirectory: string
  readonly trustPolicyPath?: string
  readonly roleConfigPath?: string
  readonly roles: readonly ('client' | 'execution')[]
  readonly generation: string
  readonly transportSecret: string
  readonly credential?: PackageUseCredential
  readonly activation?: { readonly id: string; readonly parents: readonly PackageUseCredential[] }
}
export interface ManagedRoleReady {
  readonly role: 'client' | 'execution'
  readonly generation: string
  readonly url: string
  readonly instanceId?: string
  readonly usageId?: string
}

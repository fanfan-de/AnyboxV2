/** Credential contracts shared by the credential components and the API component that reads from them. */
import { nonEmpty } from '../validation.js'
export { CredentialFailure } from '@anybox/api-key-manager'
export type { CredentialFailureCategory } from '@anybox/api-key-manager'

export const credentialReadServiceKey = 'credentials.read'
export const credentialManageServiceKey = 'credentials.manage'

export interface CredentialReadPort {
  /** Resolves undefined when nothing is stored under the id; rejects with CredentialFailure when the store cannot answer. */
  /** A caller may cancel its own read. Settlement waits for the underlying reader to exit. */
  read(id: string, signal?: AbortSignal): Promise<string | undefined>
}

/**
 * Registered by name like every Nya service, so keeping it apart from `credentials.read` is a convention for the
 * trusted host rather than an access boundary. The Harness facade never forwards it.
 */
export interface CredentialManagePort {
  write(id: string, secret: string): Promise<void>
  /** Resolves false only when nothing was stored. A deletion the store refuses rejects instead. */
  delete(id: string): Promise<boolean>
}

export function credentialId(value: unknown): string {
  return nonEmpty(value, 'credential id')
}

/** Secrets are never trimmed or echoed; only their presence is checked. */
export function credentialSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('credential secret must be a non-empty string')
  return value
}

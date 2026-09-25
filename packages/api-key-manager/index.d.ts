export type CredentialFailureCategory = 'store-unavailable' | 'operation-failed' | 'closed' | 'cancelled'

export declare class CredentialFailure extends Error {
  readonly category: CredentialFailureCategory
  constructor(category: CredentialFailureCategory)
}

export declare class UnmanagedCredentialError extends Error {}

export interface CredentialReadStore {
  read(id: string, signal?: AbortSignal): Promise<string | undefined>
}

export interface CredentialStore extends CredentialReadStore {
  write(id: string, secret: string): Promise<void>
  delete(id: string): Promise<boolean | void>
}

export interface ManagedCredentialDefinition {
  readonly id: string
  readonly label: string
  readonly category: string
}

export interface ManagedCredentialStatus extends ManagedCredentialDefinition {
  readonly configured: boolean
}

export interface ApiKeyManager {
  list(): Promise<readonly ManagedCredentialStatus[]>
  write(id: string, secret: string): Promise<ManagedCredentialStatus>
  delete(id: string): Promise<ManagedCredentialStatus>
}

export declare function validateManagedCredentialDefinitions(
  definitions: readonly ManagedCredentialDefinition[],
): readonly ManagedCredentialDefinition[]

export declare function createApiKeyManager(
  definitions: readonly ManagedCredentialDefinition[], store: CredentialStore,
): ApiKeyManager

export interface CredentialEntry {
  getPassword(signal: AbortSignal): Promise<string | undefined>
  setPassword(secret: string, signal: AbortSignal): Promise<void>
  deleteCredential(signal: AbortSignal): Promise<boolean>
}

export interface SystemKeyringOptions {
  readonly namespace: string
  readonly openEntry?: (namespace: string, id: string) => CredentialEntry
}

export interface SystemKeyringStore extends CredentialStore {
  delete(id: string): Promise<boolean>
  close(): Promise<void>
}

export declare function createSystemKeyringStore(options: SystemKeyringOptions): SystemKeyringStore

export interface ApiKeyServiceOptions extends SystemKeyringOptions {
  readonly definitions: readonly ManagedCredentialDefinition[]
}

export interface ApiKeyService extends ApiKeyManager, CredentialReadStore {
  close(): Promise<void>
}

export declare function createApiKeyService(options: ApiKeyServiceOptions): ApiKeyService

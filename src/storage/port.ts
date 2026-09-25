/** Contracts shared by storage consumers. No SQLite driver types cross this boundary. */
export const localStorageServiceKey = 'local-storage'

export type StorageValue = string | number | bigint | Uint8Array | null
export type StorageRow = Readonly<Record<string, StorageValue>>

export interface StorageReader {
  get<Row extends StorageRow = StorageRow>(sql: string, values?: readonly StorageValue[]): Row | undefined
  all<Row extends StorageRow = StorageRow>(sql: string, values?: readonly StorageValue[]): readonly Row[]
}

export interface StorageTransaction extends StorageReader {
  execute(sql: string, values?: readonly StorageValue[]): {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }
}

export interface LocalStoragePort {
  /** Operations are serialized on one connection. The reader expires when work settles. */
  read<Result>(work: (reader: StorageReader) => Result | Promise<Result>, signal?: AbortSignal): Promise<Result>
  /** One transaction spans all tables used by work; rejection rolls it back. */
  transaction<Result>(work: (tx: StorageTransaction) => Result | Promise<Result>, signal?: AbortSignal): Promise<Result>
  /** Applies a domain's missing migrations in order; each one commits with its recorded version. */
  migrate(domain: string, migrations: readonly StorageMigration[]): Promise<void>
}

/** Versions are consecutive within one domain, starting at 1. Domain owners supply their own tables. */
export interface StorageMigration {
  readonly version: number
  readonly up: (tx: StorageTransaction) => void
}

export type LocalStorageErrorCode =
  | 'occupied' | 'closed' | 'open-failed' | 'close-failed' | 'operation-failed'
  | 'migration-failed' | 'schema-version' | 'rollback-failed'

export interface LocalStorageError extends Error {
  readonly code: LocalStorageErrorCode
}

export function localStorageError(code: LocalStorageErrorCode, message: string): LocalStorageError {
  return Object.assign(new Error(message), { name: 'LocalStorageError', code })
}

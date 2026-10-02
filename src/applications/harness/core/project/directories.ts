/** Public directory picker DTOs. They contain paths and display data, never filesystem handles. */
export interface DirectoryBrowseOptions {
  readonly path?: string
  readonly query?: string
  readonly showHidden?: boolean
}

export interface DirectoryBrowseOpened {
  readonly browseId: string
  readonly homePath: string
}

export type DirectoryEntryFailure = 'directory-permission-denied' | 'directory-missing' |
  'directory-not-directory' | 'directory-link-loop' | 'directory-unavailable'

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'symlink'
  readonly reason?: DirectoryEntryFailure
}

export interface DirectoryPage {
  readonly browseId: string
  readonly page: number
  readonly path: string
  readonly homePath: string
  readonly parentPath: string | null
  readonly breadcrumbs: readonly Readonly<{ name: string; path: string }>[]
  readonly entries: readonly DirectoryEntry[]
  readonly nextPage: number | null
}

export type DirectoryBrowseFailureCode = DirectoryEntryFailure | 'directory-browse-unsupported' |
  'directory-browse-invalid' | 'directory-browse-busy' | 'directory-browse-expired' |
  'directory-browse-conflict' | 'directory-browse-cancelled' | 'directory-browse-cleanup-failed'

export interface DirectoryBrowseFailure extends Error {
  readonly code: DirectoryBrowseFailureCode
}

export function directoryBrowseFailure(code: DirectoryBrowseFailureCode): DirectoryBrowseFailure {
  return Object.assign(new Error(code), { name: 'DirectoryBrowseFailure', code })
}

export function isDirectoryBrowseFailure(error: unknown): error is DirectoryBrowseFailure {
  return error instanceof Error && error.name === 'DirectoryBrowseFailure' && 'code' in error
}

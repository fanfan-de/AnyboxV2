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

export interface DirectoryCreated {
  readonly path: string
}

/** A single child name, without interpreting it as a path or trimming user data. */
export function isDirectoryNameValid(name: unknown, windows: boolean): name is string {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' ||
    /[\\/\u0000-\u001f\u007f-\u009f]/u.test(name)) return false
  return !windows || !/[<>:"|?*]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)
}

export type DirectoryBrowseFailureCode = DirectoryEntryFailure | 'directory-browse-unsupported' |
  'directory-browse-invalid' | 'directory-browse-busy' | 'directory-browse-expired' |
  'directory-browse-conflict' | 'directory-browse-cancelled' | 'directory-browse-cleanup-failed' |
  'directory-create-unsupported' | 'directory-name-invalid' | 'directory-exists'

export interface DirectoryBrowseFailure extends Error {
  readonly code: DirectoryBrowseFailureCode
}

export function directoryBrowseFailure(code: DirectoryBrowseFailureCode): DirectoryBrowseFailure {
  return Object.assign(new Error(code), { name: 'DirectoryBrowseFailure', code })
}

export function isDirectoryBrowseFailure(error: unknown): error is DirectoryBrowseFailure {
  return error instanceof Error && error.name === 'DirectoryBrowseFailure' && 'code' in error
}

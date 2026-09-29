import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import type { StorageTransaction } from '../storage/port.js'
import type { FileContent, FileRef, FileSelection, FileSearch, FilePreview, FileRenewal } from './domain.js'
export const projectFilesServiceKey = 'harness.project-files'
export interface ProjectFilesPort {
  search(projectId: string, query: string, signal?: AbortSignal): OwnedCall<FileSearch>
  preview(projectId: string, selection: Extract<FileSelection, { kind: 'project-file' }>, signal?: AbortSignal): OwnedCall<FilePreview>
  prepare(scopeId: string, projectId: string, key: string, selections: readonly FileSelection[], signal?: AbortSignal): OwnedCall<readonly FileRef[]>
  read(scopeId: string, ids: readonly string[], signal?: AbortSignal): OwnedCall<readonly FileContent[]>
  renew(scopeId: string, ids: readonly string[]): Promise<FileRenewal>
  retainIn(tx: StorageTransaction, scopeId: string, ownerKey: string, refs: readonly FileRef[]): void
}
export interface ProjectFilesOptions extends Partial<RuntimeInputs> { readonly collectionIntervalMs?: number }

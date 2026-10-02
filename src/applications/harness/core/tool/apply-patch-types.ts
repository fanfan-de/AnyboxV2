/** Project-owned patch values shared by pure planning and the filesystem owner. */
export interface PatchChunk {
  readonly anchor?: string
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
  readonly eof: boolean
}

export type PatchOperation =
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'update'; readonly path: string; readonly moveTo?: string; readonly chunks: readonly PatchChunk[] }

export interface PatchDiagnostic {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly line?: number
}

export interface PatchChange {
  readonly kind: 'added' | 'updated' | 'deleted'
  readonly path: string
}

export interface PendingPatchOperation {
  readonly kind: PatchOperation['kind']
  readonly path: string
  readonly moveTo?: string
}

export interface ApplyPatchResult {
  readonly status: 'applied' | 'rejected' | 'partial' | 'cancelled'
  readonly changes: readonly PatchChange[]
  readonly pending: readonly PendingPatchOperation[]
  readonly diagnostic?: PatchDiagnostic
}

export function patchRejection(code: string, message: string, path?: string, line?: number): Error & { readonly diagnostic: PatchDiagnostic } {
  return Object.assign(new Error(message), { name: 'PatchRejection', diagnostic: Object.freeze({
    code, message, ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }),
  }) })
}

export function patchDiagnostic(error: unknown): PatchDiagnostic | undefined {
  if (error instanceof Error && error.name === 'PatchRejection' && 'diagnostic' in error) {
    return error.diagnostic as PatchDiagnostic
  }
  return undefined
}

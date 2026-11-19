import { isAbsolute } from 'node:path'
import type { UnitScope } from '../unit/domain.js'
import { fileError, validateFilePath, validateFileRange, validateFileTreePath } from '../project-files/domain.js'
import type { FilePreview, FileRange, FileSearch, FileTreeEntry } from '../project-files/domain.js'
import { ceilingPermits } from './worker-attachments-domain.js'
import type { DirectoryContainsPath } from './worker-attachments-domain.js'
import { workerError } from './worker-port.js'

/**
 * The Computer unit's read-only query surface. Queries belong to no Run: they carry only the attachment, are idempotent and
 * never touch the operation ledger. Roots are absolute paths on the unit; the executor checks their canonical identity
 * against both the device ceiling and the approved project scope before reading.
 */
export type ComputerQuery =
  | { readonly kind: 'stat'; readonly path: string }
  | { readonly kind: 'list'; readonly root: string; readonly path: string }
  | { readonly kind: 'search'; readonly root: string; readonly query: string }
  | { readonly kind: 'read'; readonly root: string; readonly path: string; readonly range?: FileRange }
export type ComputerQueryResult =
  | { readonly kind: 'stat'; readonly directory: boolean; readonly canonical: string | null }
  | { readonly kind: 'list'; readonly entries: readonly FileTreeEntry[]; readonly identity: string; readonly truncated: boolean }
  | { readonly kind: 'search'; readonly search: FileSearch }
  | { readonly kind: 'read'; readonly preview: FilePreview }

function absolute(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || !isAbsolute(value) || /[\0]/.test(value)) throw workerError('worker-invalid')
  return value
}
export function validateComputerQuery(value: unknown): ComputerQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workerError('worker-invalid')
  const query = value as Record<string, unknown>, keys = Object.keys(query)
  const only = (...allowed: string[]) => { if (keys.some(key => !allowed.includes(key))) throw workerError('worker-invalid') }
  switch (query.kind) {
    case 'stat': only('kind', 'path'); return Object.freeze({ kind: 'stat', path: absolute(query.path) })
    case 'list': only('kind', 'root', 'path'); return Object.freeze({ kind: 'list', root: absolute(query.root), path: validateFileTreePath(query.path) })
    case 'search': {
      only('kind', 'root', 'query')
      if (typeof query.query !== 'string' || query.query.length > 4096 || query.query.includes('\0')) throw fileError('file-invalid')
      return Object.freeze({ kind: 'search', root: absolute(query.root), query: query.query })
    }
    case 'read': {
      only('kind', 'root', 'path', 'range')
      const range = validateFileRange(query.range)
      return Object.freeze({ kind: 'read', root: absolute(query.root), path: validateFilePath(query.path), ...(range ? { range } : {}) })
    }
    default: throw workerError('worker-invalid')
  }
}
/** The root a query reads is checked against the attachment's project directories; tools are irrelevant to reads. */
export function queryRoot(query: ComputerQuery): string { return query.kind === 'stat' ? query.path : query.root }
export function ceilingPermitsRoot(ceiling: Extract<UnitScope, { kind: 'computer' }>, root: string, within?: DirectoryContainsPath): boolean {
  return ceilingPermits({ ...ceiling, tools: 'all' }, { path: root, toolId: 'read' }, within)
}

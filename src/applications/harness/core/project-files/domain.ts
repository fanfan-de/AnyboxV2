/** Browser-safe values and pure rules for project text references. */
export const fileLimits = Object.freeze({ maxFiles: 8, maxSourceBytes: 10 * 1024 * 1024,
  maxBytes: 64 * 1024, maxTotalBytes: 256 * 1024, maxEncodedBytes: 1024 * 1024,
  concurrency: 2, draftLifetimeMs: 24 * 60 * 60 * 1000, renewIntervalMs: 5 * 60 * 1000,
  maxSearchEntries: 20_000, searchTimeMs: 2_000, maxResults: 50 })
export interface FileRange { readonly start: number; readonly end: number }
export type FileSelection =
  | { readonly kind: 'project-file'; readonly path: string; readonly range?: FileRange }
  | { readonly kind: 'snapshot'; readonly snapshotId: string }
export interface FileRef {
  readonly snapshotId: string; readonly projectId: string; readonly path: string
  readonly range?: FileRange; readonly actualRange: FileRange | null
  readonly byteLength: number; readonly sha256: string; readonly createdAt: string; readonly expiresAt?: string
}
export interface FileContent { readonly file: FileRef; readonly text: string }
export interface FileSearch { readonly paths: readonly string[]; readonly incomplete: boolean }
export interface FileTreeEntry { readonly name: string; readonly path: string; readonly kind: 'directory' | 'file' }
export interface FileTreePage {
  readonly cursorId: string; readonly page: number; readonly path: string
  readonly entries: readonly FileTreeEntry[]; readonly nextPage: number | null
}
export const fileTreeLimits = Object.freeze({ pageEntries: 100, scanEntries: 1_000, scanTimeMs: 200,
  maxCursors: 16, idleMs: 60_000 })
export interface FilePreview {
  readonly path: string; readonly text: string; readonly totalLines: number; readonly sourceByteLength: number
  readonly byteLength: number; readonly actualRange: FileRange | null; readonly canReference: boolean
  readonly reason?: 'file-too-large'
}
export interface FileRenewal { readonly valid: readonly FileRef[]; readonly invalid: readonly string[] }
export type ProjectFileErrorCode = 'file-invalid' | 'file-missing' | 'file-unavailable' | 'file-unsupported' |
  'file-too-large' | 'file-range-invalid' | 'file-changed' | 'file-expired' | 'file-corrupt' |
  'file-cancelled' | 'file-cleanup-failed' | 'file-preparation-conflict' | 'file-tree-expired' |
  'file-tree-conflict' | 'file-tree-busy'
export function fileError(code: ProjectFileErrorCode): Error & { readonly code: ProjectFileErrorCode } {
  return Object.assign(new Error(code), { name: 'ProjectFileError', code })
}
export function excludedPath(path: string): boolean {
  const parts = path.split('/')
  return parts.some((part, index) => ['.git', '.hg', '.svn', 'node_modules', '.pnpm-store', '.venv', 'venv'].includes(part) ||
    (parts[index - 1] === '.yarn' && ['cache', 'unplugged'].includes(part)))
}
export function validateFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) ||
    value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || excludedPath(value)) throw fileError('file-invalid')
  return value
}
export function validateFileTreePath(value: unknown): string { return value === '' ? '' : validateFilePath(value) }
export function validateFileRange(value: unknown): FileRange | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'start' && key !== 'end') ||
    !('start' in value) || !('end' in value) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
    (value.start as number) < 1 || (value.end as number) < (value.start as number)) throw fileError('file-range-invalid')
  return Object.freeze({ start: value.start as number, end: value.end as number })
}
export function validateFileSelections(value: unknown): readonly FileSelection[] {
  if (!Array.isArray(value) || value.length > fileLimits.maxFiles) throw fileError('file-invalid')
  return Object.freeze(value.map((item): FileSelection => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fileError('file-invalid')
    if (item.kind === 'snapshot' && Object.keys(item).every(key => ['kind', 'snapshotId'].includes(key)) && validId(item.snapshotId))
      return Object.freeze({ kind: 'snapshot', snapshotId: item.snapshotId })
    if (item.kind !== 'project-file' || Object.keys(item).some(key => !['kind', 'path', 'range'].includes(key))) throw fileError('file-invalid')
    const path = validateFilePath(item.path), range = validateFileRange(item.range)
    return Object.freeze({ kind: 'project-file', path, ...(range ? { range } : {}) })
  }))
}
export function validId(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 1024 && !value.includes('\0') }
export function validateSnapshotIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > fileLimits.maxFiles || value.some(id => !validId(id))) throw fileError('file-invalid')
  return Object.freeze([...value])
}
export function isFileRef(value: unknown): value is FileRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as FileRef
  try {
    validateFilePath(ref.path); validateFileRange(ref.range)
    if (ref.actualRange !== null && !validateFileRange(ref.actualRange)) return false
    return validId(ref.snapshotId) && validId(ref.projectId) && /^[a-f0-9]{64}$/.test(ref.sha256) &&
      Number.isSafeInteger(ref.byteLength) && ref.byteLength >= 0 && ref.byteLength <= fileLimits.maxBytes &&
      typeof ref.createdAt === 'string' && Number.isFinite(Date.parse(ref.createdAt)) &&
      (ref.expiresAt === undefined || (typeof ref.expiresAt === 'string' && Number.isFinite(Date.parse(ref.expiresAt))))
  } catch { return false }
}
export function validateFileBatch(files: readonly FileRef[]): void {
  if (files.length > fileLimits.maxFiles || files.some(file => !isFileRef(file))) throw fileError('file-invalid')
  if (files.reduce((sum, file) => sum + file.byteLength, 0) > fileLimits.maxTotalBytes) throw fileError('file-too-large')
}
/** Trailing newline terminates the final line; it does not create a phantom line. */
export function selectFileText(text: string, range?: FileRange): { text: string; actualRange: FileRange | null; totalLines: number } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  if (range && range.end > lines.length) throw fileError('file-range-invalid')
  return { text: range ? lines.slice(range.start - 1, range.end).join('') : text,
    actualRange: range ?? (lines.length ? { start: 1, end: lines.length } : null), totalLines: lines.length }
}
export function compareFilePaths(query: string, a: string, b: string): number {
  const rank = (path: string) => { const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase(); return name === query ? 0 : name.startsWith(query) ? 1 : 2 }
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)
}
export function encodeFileContents(files: readonly FileContent[]): string {
  if (!files.length) return ''
  validateFileBatch(files.map(value => value.file))
  const encoded = JSON.stringify({ type: 'project-file-context', schemaVersion: 1,
    files: files.map(({ file, text }) => ({ path: file.path, range: file.actualRange, content: text })) })
  if (new TextEncoder().encode(encoded).byteLength > fileLimits.maxEncodedBytes) throw fileError('file-too-large')
  return encoded
}

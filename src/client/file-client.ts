import { fileLimits, isFileRef, validateFileSelections, validId } from '../harness/project-files/domain.js'
import type { FileRef, FileRenewal, FileSelection } from '../harness/project-files/domain.js'
import type { Api, PendingSubmission } from './client-types.js'
import type { DraftFile, DraftStore } from './draft-client.js'
import type { PendingStore } from './session-client.js'

export function pendingFilesValid(value: PendingSubmission): boolean {
  try {
    const selections = validateFileSelections(value.fileSelections ?? [])
    const files = value.files ?? []
    if (!Array.isArray(files) || files.length > fileLimits.maxFiles || files.some(file => !isFileRef(file))) return false
    if ((selections.length || files.length) && value.schemaVersion !== 3) return false
    if (selections.length && !validId(value.preparationKey)) return false
    return !files.length || !selections.length || files.length === selections.length
  } catch { return false }
}
export function pendingFileDrafts(value: PendingSubmission): readonly DraftFile[] {
  if (value.invalidFiles || !pendingFilesValid(value)) return [{ id: 'invalid-pending-file', error: '待提交文件引用无效，请移除后重新添加。' }]
  if (value.files?.length) return value.files.map(file => ({ id: file.snapshotId, file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }))
  return (value.fileSelections ?? []).map((selection, index) => ({ id: `pending-file-${index}`, selection }))
}
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, query: match[1] } : undefined
}
export function fileLabel(selection: FileSelection | undefined, file?: FileRef): string {
  const path = selection?.kind === 'project-file' ? selection.path : file?.path ?? '文件引用'
  const range = selection?.kind === 'project-file' ? selection.range : file?.range
  return `${path} · ${range ? `L${range.start}–${range.end}` : '整文件'}`
}
export function createFileLeaseKeeper(env: {
  api: Api; drafts: DraftStore; pending: PendingStore; schedule(fn: () => void, ms: number): unknown
  clear(timer: unknown): void; changed(): void; error(error: unknown): void
}) {
  let disposed = false, timer: unknown, job: Promise<void> | undefined
  const abort = new AbortController()
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (job) return job
    if (timer !== undefined) env.clear(timer)
    job = (async () => {
      const bySession = new Map<string, Set<string>>()
      const collect = (session: string, files: readonly FileRef[]) => {
        const ids = bySession.get(session) ?? new Set<string>()
        for (const file of files) if (file.expiresAt) ids.add(file.snapshotId)
        if (ids.size) bySession.set(session, ids)
      }
      for (const entry of env.drafts.entries()) collect(entry.sessionId, entry.draft.files.flatMap(item => item.file ? [item.file] : []))
      for (const value of env.pending.entries()) collect(value.sessionId, value.files ?? [])
      for (const [session, ids] of bySession) {
        const list = [...ids]
        for (let i = 0; i < list.length; i += fileLimits.maxFiles) {
          const renewal = await env.api<FileRenewal>(`/sessions/${encodeURIComponent(session)}/project-files/renew`, { snapshotIds: list.slice(i, i + fileLimits.maxFiles) }, abort.signal)
          if (disposed) return
          const valid = new Map(renewal.valid.map(file => [file.snapshotId, file])), invalid = new Set(renewal.invalid)
          for (const entry of env.drafts.entries()) if (entry.sessionId === session) {
            const files = entry.draft.files.map(item => !item.file ? item : valid.has(item.file.snapshotId)
              ? { ...item, file: valid.get(item.file.snapshotId), error: undefined }
              : invalid.has(item.file.snapshotId) ? { ...item, error: '文件快照已过期，请更新为当前文件。' } : item)
            env.drafts.set(session, entry.parentNodeId, { ...entry.draft, files })
          }
          const value = env.pending.get(session)
          if (value?.files?.length) env.pending.set(session, { ...value, files: value.files.map(file => valid.get(file.snapshotId) ?? file) })
        }
      }
      env.changed()
    })().catch(error => { if (!disposed) env.error(error) }).finally(() => {
      job = undefined
      if (!disposed) timer = env.schedule(() => { void refresh() }, fileLimits.renewIntervalMs)
    })
    return job
  }
  void refresh()
  return { refresh, dispose() { disposed = true; abort.abort(); if (timer !== undefined) env.clear(timer) } }
}

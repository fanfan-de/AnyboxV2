import { isFileRef, validateFileSelections } from '../project-files/domain.js'
import type { FileSelection, FileRef } from '../project-files/domain.js'
import type { ImageRef } from './client-types.js'
import { imageLimits } from '../image/limits.js'
import type { BrowserStorage } from './session-client.js'

/** Keep the historical key so existing image drafts remain readable. */
export const draftsKey = 'anybox.web.image-drafts.v1'
export interface DraftImage {
  readonly id: string
  readonly name: string
  readonly byteLength: number
  readonly status: 'queued' | 'uploading' | 'ready' | 'failed' | 'expired'
  readonly image?: ImageRef
  readonly error?: string
}
export interface DraftFile { readonly id: string; readonly selection?: FileSelection; readonly file?: FileRef; readonly error?: string }
export interface MessageDraft { readonly text: string; readonly images: readonly DraftImage[]; readonly files: readonly DraftFile[] }
export interface DraftEntry { readonly sessionId: string; readonly parentNodeId: string | null; readonly draft: MessageDraft }
export interface DraftStore {
  get(sessionId: string, parentNodeId: string | null): MessageDraft
  set(sessionId: string, parentNodeId: string | null, draft: MessageDraft): void
  entries(): readonly DraftEntry[]
}
const emptyDraft: MessageDraft = Object.freeze({ text: '', images: Object.freeze([]), files: Object.freeze([]) })
const keyFor = (sessionId: string, parentNodeId: string | null) => JSON.stringify([sessionId, parentNodeId])

export function isImageRef(value: unknown): value is ImageRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as ImageRef
  return typeof ref.assetId === 'string' && ref.assetId.length > 0 && ref.assetId.length <= 1024 &&
    typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256) &&
    imageLimits.acceptedMediaTypes.includes(ref.mediaType) && Number.isSafeInteger(ref.byteLength) && ref.byteLength > 0 && ref.byteLength <= imageLimits.maxBytes &&
    Number.isSafeInteger(ref.width) && ref.width > 0 && ref.width <= imageLimits.maxWidth &&
    Number.isSafeInteger(ref.height) && ref.height > 0 && ref.height <= imageLimits.maxHeight &&
    (ref.expiresAt === undefined || (typeof ref.expiresAt === 'string' && Number.isFinite(Date.parse(ref.expiresAt))))
}
export function draftFromInput(text: string, images: readonly ImageRef[] = [], files: readonly FileRef[] = []): MessageDraft {
  return { text, files: files.map(file => ({ id: file.snapshotId, file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } })), images: images.map((image, index) => ({ id: image.assetId, name: `图片 ${index + 1}`, byteLength: image.byteLength, status: 'ready', image })) }
}
export function createDraftStore(storage?: BrowserStorage): DraftStore {
  const values = new Map<string, DraftEntry>()
  try {
    const stored: unknown = JSON.parse(storage?.getItem(draftsKey) ?? '[]')
    if (Array.isArray(stored)) for (const row of stored) {
      if (!row || typeof row.sessionId !== 'string' || (row.parentNodeId !== null && typeof row.parentNodeId !== 'string') ||
          typeof row.draft?.text !== 'string' || !Array.isArray(row.draft.images)) continue
      const images: DraftImage[] = row.draft.images.map((item: Partial<DraftImage>, index: number) => {
        const image = isImageRef(item?.image) ? item.image : undefined
        return { id: typeof item?.id === 'string' ? item.id : `restored-${index}`, name: typeof item?.name === 'string' ? item.name.slice(0, 200) : '图片',
          byteLength: image?.byteLength ?? 0, ...(image ? { image } : {}),
          status: image && item.status === 'ready' ? 'ready' : image && item.status === 'expired' ? 'expired' : 'failed',
          ...(!image ? { error: '图片尚未上传完成，请移除后重新添加。' } : {}) }
      })
      const entry: DraftEntry = { sessionId: row.sessionId, parentNodeId: row.parentNodeId, draft: { text: row.draft.text, images, files: restoreDraftFiles(row.draft.files) } }
      values.set(keyFor(row.sessionId, row.parentNodeId), entry)
    }
  } catch { /* Browser storage is optional; submitting still requires durable pending storage. */ }
  return {
    get: (sessionId, parentNodeId) => values.get(keyFor(sessionId, parentNodeId))?.draft ?? emptyDraft,
    entries: () => [...values.values()],
    set(sessionId, parentNodeId, draft) {
      const key = keyFor(sessionId, parentNodeId)
      if (draft.text || draft.images.length || draft.files?.length) values.set(key, { sessionId, parentNodeId, draft: { ...draft, files: draft.files ?? [] } })
      else values.delete(key)
      storage?.setItem(draftsKey, JSON.stringify([...values.values()]))
    },
  }
}

export function restoreDraftFiles(raw: unknown): readonly DraftFile[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return [{ id: 'invalid-files', error: '文件引用信息无效，请移除后重新添加。' }]
  return raw.map((item, index): DraftFile => {
    const id = typeof item?.id === 'string' ? item.id : `invalid-file-${index}`
    try {
      const [selection] = validateFileSelections([item.selection])
      if (selection.kind === 'snapshot' && (!isFileRef(item.file) || item.file.snapshotId !== selection.snapshotId)) throw new Error()
      return { id, selection, ...(isFileRef(item.file) ? { file: item.file } : {}), ...(typeof item.error === 'string' ? { error: item.error } : {}) }
    } catch { return { id, error: '文件引用信息无效，请移除后重新添加。' } }
  })
}

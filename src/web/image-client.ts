import type { Api, ImageRef, PendingSubmission } from './client-types.js'
import { imageLimits, validateImageBatch } from '../image/limits.js'
import type { BrowserStorage } from './session-client.js'

export const draftsKey = 'anybox.web.image-drafts.v1'
export interface DraftImage {
  readonly id: string
  readonly name: string
  readonly byteLength: number
  readonly status: 'queued' | 'uploading' | 'ready' | 'failed' | 'expired'
  readonly image?: ImageRef
  readonly error?: string
}
export interface MessageDraft { readonly text: string; readonly images: readonly DraftImage[] }
export interface DraftEntry { readonly sessionId: string; readonly parentNodeId: string | null; readonly draft: MessageDraft }
export interface DraftStore {
  get(sessionId: string, parentNodeId: string | null): MessageDraft
  set(sessionId: string, parentNodeId: string | null, draft: MessageDraft): void
  entries(): readonly DraftEntry[]
}
export interface ImageRenewal { readonly valid: readonly ImageRef[]; readonly invalid: readonly string[] }
const emptyDraft: MessageDraft = Object.freeze({ text: '', images: Object.freeze([]) })
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
export function imageURL(sessionId: string, assetId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(assetId)}/content`
}
export function draftFromInput(text: string, images: readonly ImageRef[] = []): MessageDraft {
  return { text, images: images.map((image, index) => ({ id: image.assetId, name: `图片 ${index + 1}`, byteLength: image.byteLength, status: 'ready', image })) }
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
      const entry: DraftEntry = { sessionId: row.sessionId, parentNodeId: row.parentNodeId, draft: { text: row.draft.text, images } }
      values.set(keyFor(row.sessionId, row.parentNodeId), entry)
    }
  } catch { /* Browser storage is optional; submitting still requires durable pending storage. */ }
  return {
    get: (sessionId, parentNodeId) => values.get(keyFor(sessionId, parentNodeId))?.draft ?? emptyDraft,
    entries: () => [...values.values()],
    set(sessionId, parentNodeId, draft) {
      const key = keyFor(sessionId, parentNodeId)
      if (draft.text || draft.images.length) values.set(key, { sessionId, parentNodeId, draft })
      else values.delete(key)
      storage?.setItem(draftsKey, JSON.stringify([...values.values()]))
    },
  }
}

/** Queue slots are allocated before any upload starts, so completion cannot reorder input. */
export function createImageUploads(env: {
  readonly sessionId: string; readonly drafts: DraftStore; readonly newId: () => string
  readonly upload: (file: File, signal: AbortSignal) => Promise<ImageRef>
  readonly changed: () => void; readonly error: (error: unknown) => void
}) {
  const files = new Map<string, { parent: string | null; file: File }>()
  const running = new Map<string, AbortController>()
  const queue: string[] = []
  let disposed = false
  const write = (parent: string | null, images: readonly DraftImage[]) => {
    try { env.drafts.set(env.sessionId, parent, { ...env.drafts.get(env.sessionId, parent), images }) }
    catch (error) { env.error(error) }
    env.changed()
  }
  const update = (parent: string | null, id: string, patch: Partial<DraftImage>) => {
    const draft = env.drafts.get(env.sessionId, parent)
    write(parent, draft.images.map(image => image.id === id ? { ...image, ...patch } : image))
  }
  const pump = () => {
    while (!disposed && running.size < 2 && queue.length) {
      const id = queue.shift()!, item = files.get(id)
      if (!item || !env.drafts.get(env.sessionId, item.parent).images.some(image => image.id === id)) continue
      const abort = new AbortController()
      running.set(id, abort)
      update(item.parent, id, { status: 'uploading', error: undefined })
      void env.upload(item.file, abort.signal).then(image => {
        if (abort.signal.aborted || disposed) return
        if (!isImageRef(image)) throw new Error('图片上传返回了无效信息。')
        update(item.parent, id, { image, byteLength: image.byteLength, status: 'ready' })
        files.delete(id)
      }).catch(error => {
        if (!abort.signal.aborted && !disposed) update(item.parent, id, { status: 'failed', error: error instanceof Error ? error.message : '图片上传失败，请重试。' })
      }).finally(() => { running.delete(id); pump() })
    }
  }
  return {
    add(parent: string | null, selected: readonly File[]) {
      if (disposed || !selected.length) return
      try {
        const prior = env.drafts.get(env.sessionId, parent)
        validateImageBatch([...prior.images, ...selected.map(file => ({ byteLength: file.size }))])
        if (selected.some(file => file.type && !imageLimits.acceptedMediaTypes.includes(file.type as ImageRef['mediaType']))) throw new Error('只支持静态 PNG、JPEG 和 WebP 图片。')
        const added = selected.map(file => {
          const id = env.newId(); files.set(id, { parent, file }); queue.push(id)
          return { id, name: file.name.slice(0, 200) || '粘贴的图片', byteLength: file.size, status: 'queued' as const }
        })
        write(parent, [...prior.images, ...added]); pump()
      } catch (error) { env.error(error); env.changed() }
    },
    remove(parent: string | null, id: string) {
      running.get(id)?.abort(); files.delete(id)
      write(parent, env.drafts.get(env.sessionId, parent).images.filter(image => image.id !== id))
    },
    retry(parent: string | null, id: string) {
      if (!files.has(id) || running.has(id)) { env.error(new Error('请移除此图片后重新添加。')); env.changed(); return }
      update(parent, id, { status: 'queued', error: undefined }); queue.push(id); pump()
    },
    dispose() { disposed = true; for (const abort of running.values()) abort.abort(); files.clear(); queue.length = 0 },
  }
}

export function applyImageRenewal(drafts: DraftStore, sessionId: string, renewal: ImageRenewal): void {
  const valid = new Map(renewal.valid.map(image => [image.assetId, image])), invalid = new Set(renewal.invalid)
  for (const entry of drafts.entries()) {
    if (entry.sessionId !== sessionId) continue
    let changed = false
    const images = entry.draft.images.map(item => {
      if (!item.image) return item
      const image = valid.get(item.image.assetId)
      if (image) { changed = true; return { ...item, image, status: 'ready' as const, error: undefined } }
      if (invalid.has(item.image.assetId)) { changed = true; return { ...item, status: 'expired' as const, error: '图片已失效，请移除后重新添加。' } }
      return item
    })
    if (changed) drafts.set(sessionId, entry.parentNodeId, { ...entry.draft, images })
  }
}

/** The workspace retains every parent draft, including detached and hidden panes. */
export function createImageLeaseKeeper(env: {
  readonly api: Api; readonly drafts: DraftStore
  readonly pending: { entries(): readonly PendingSubmission[] }
  readonly schedule: (callback: () => void, ms: number) => unknown; readonly clear: (timer: unknown) => void
  readonly changed: () => void; readonly error: (error: unknown) => void
}) {
  let disposed = false, timer: unknown, job: Promise<void> | undefined
  const abort = new AbortController()
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (job) return job
    job = (async () => {
      const sessions = new Map<string, Set<string>>()
      const collect = (sessionId: string, images: readonly ImageRef[]) => {
        for (const image of images) {
          if (!image.expiresAt) continue
          let refs = sessions.get(sessionId)
          if (!refs) { refs = new Set(); sessions.set(sessionId, refs) }
          refs.add(image.assetId)
        }
      }
      for (const entry of env.drafts.entries()) collect(entry.sessionId, entry.draft.images.flatMap(item => item.image ? [item.image] : []))
      for (const entry of env.pending.entries()) collect(entry.sessionId, entry.images ?? [])
      for (const [sessionId, ids] of sessions) {
        const list = [...ids]
        for (let start = 0; start < list.length && !disposed; start += imageLimits.maxImages) {
          const renewal = await env.api<ImageRenewal>(`/sessions/${encodeURIComponent(sessionId)}/images/renew`, { assetIds: list.slice(start, start + imageLimits.maxImages) }, abort.signal)
          applyImageRenewal(env.drafts, sessionId, renewal)
        }
      }
      if (!disposed) env.changed()
    })().catch(error => { if (!disposed) env.error(error) }).finally(() => { job = undefined })
    return job
  }
  const tick = () => { void refresh(); if (!disposed) timer = env.schedule(tick, imageLimits.renewIntervalMs) }
  tick()
  return { refresh, dispose() { disposed = true; abort.abort(); if (timer !== undefined) env.clear(timer) } }
}

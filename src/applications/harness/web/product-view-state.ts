type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>
export interface PromptViewState { documentId?: string; agentId?: string; versionId?: string; scroll: number }
function read(storage: ViewStorage, key: string): unknown {
  try { return JSON.parse(storage.getItem(key) ?? 'null') } catch { return undefined }
}
function write(storage: ViewStorage, key: string, value: unknown): void {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* Optional browser position. */ }
}
export function readPromptViewState(storage: ViewStorage, key: string): PromptViewState {
  const raw = read(storage, `anybox.product.prompt.v1.${key}`)
  const saved = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return { ...Object.fromEntries(['documentId', 'agentId', 'versionId'].flatMap(field => typeof saved[field] === 'string' && saved[field].length <= 1000 ? [[field, saved[field]]] : [])),
    scroll: typeof saved.scroll === 'number' && Number.isFinite(saved.scroll) && saved.scroll >= 0 ? saved.scroll : 0 }
}
export function rememberPromptViewState(storage: ViewStorage, key: string, value: PromptViewState): void {
  write(storage, `anybox.product.prompt.v1.${key}`, { documentId: value.documentId, agentId: value.agentId, versionId: value.versionId, scroll: value.scroll })
}

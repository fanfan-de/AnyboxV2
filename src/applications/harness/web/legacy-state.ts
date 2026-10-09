import { mapResourceIds, scopedId, splitScopedId } from './harness-client.js'
import type { BrowserStorage } from './session-client.js'

const keys = [
  ['anybox.web.workspace.v1', 'anybox.web.workspace.v2'],
  ['anybox.web.positions.v1', 'anybox.web.positions.v2'],
  ['anybox.web.v2.pending', 'anybox.web.v3.pending'],
  ['anybox.web.image-drafts.v1', 'anybox.web.image-drafts.v2'],
] as const
/** Retain source values intact. Only the launcher's verified local instance may claim legacy state. */
export async function migrateLegacyState(storage: BrowserStorage, instanceId: string | undefined,
  verify: (sessionId: string, projectId?: string) => Promise<boolean>): Promise<'none' | 'pending' | 'migrated'> {
  if (storage.getItem('anybox.client.legacy-migrated')) return 'none'
  const raw = keys.map(([old]) => storage.getItem(old))
  if (raw.every(value => value === null)) return 'none'
  if (!instanceId) return 'pending'
  try {
    const values = raw.map(value => value === null ? undefined : JSON.parse(value)), sessions = new Map<string, string | undefined>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      const row = value as Record<string, unknown>
      if (typeof row.sessionId === 'string' && !splitScopedId(row.sessionId)) sessions.set(row.sessionId, typeof row.projectId === 'string' ? row.projectId : sessions.get(row.sessionId))
      Object.values(row).forEach(collect)
    }
    values.forEach(collect)
    // A project-only layout cannot prove that an old database is this database.
    if (!sessions.size || !(await Promise.all([...sessions].map(([id, project]) => verify(id, project)))).every(Boolean)) return 'pending'
    const scope = (id: string) => splitScopedId(id) ? id : scopedId(instanceId, id)
    values.forEach((value, index) => {
      if (value === undefined) return
      const currentText = storage.getItem(keys[index][1])
      const current = currentText === null ? undefined : JSON.parse(currentText)
      let mapped: unknown = mapResourceIds(value, scope)
      if (index === 1 || index === 2) mapped = Object.fromEntries(Object.entries(value).map(([id, item]) => [scope(id), mapResourceIds(item, scope)]))
      if (current !== undefined) {
        if (index === 0 && current.root) return
        if (index === 1 || index === 2) mapped = { ...(mapped as object), ...current }
        if (index === 3 && Array.isArray(current) && Array.isArray(mapped)) {
          const has = new Set(current.map(row => JSON.stringify([row.sessionId, row.parentNodeId])))
          mapped = [...current, ...mapped.filter(row => !has.has(JSON.stringify([row.sessionId, row.parentNodeId])))]
        }
      }
      storage.setItem(keys[index][1], JSON.stringify(mapped))
    })
    storage.setItem('anybox.client.legacy-migrated', instanceId)
    return 'migrated'
  } catch { return 'pending' }
}

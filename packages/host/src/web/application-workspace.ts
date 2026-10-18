export interface ApplicationPosition { readonly id: string; readonly route: string }
/** The tabs field preserves the existing browser workspace format. */
export interface ApplicationWorkspace { readonly tabs: readonly ApplicationPosition[]; readonly activeId: string | null }
export const workspaceStorageKey = 'anybox.apps.workspace.v1'
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)
export function readApplicationWorkspace(raw: string | null): ApplicationWorkspace {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (!value || !Array.isArray(value.tabs)) return { tabs: [], activeId: null }
    const seen = new Set<string>(), tabs: ApplicationPosition[] = []
    for (const item of value.tabs) if (item && validId(item.id) && typeof item.route === 'string' && item.route.length <= 16384 && !seen.has(item.id)) {
      seen.add(item.id); tabs.push({ id: item.id, route: item.route })
    }
    return { tabs, activeId: seen.has(value.activeId) ? value.activeId : null }
  } catch { return { tabs: [], activeId: null } }
}
export function applicationHash(id: string, route: string): string { return `#/apps/${encodeURIComponent(id)}${route ? '/' + route.replace(/^\//, '') : ''}` }
export function parseApplicationHash(hash: string): ApplicationPosition | undefined {
  const match = /^#\/apps\/([^/?#]+)(?:\/(.*))?$/.exec(hash)
  if (!match) return undefined
  try { const id = decodeURIComponent(match[1]); return validId(id) ? { id, route: match[2] ?? '' } : undefined } catch { return undefined }
}
export function closeApplicationView(state: ApplicationWorkspace, id: string): ApplicationWorkspace {
  const index = state.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter(tab => tab.id !== id)
  return { tabs, activeId: state.activeId === id ? (state.tabs[index + 1] ?? state.tabs[index - 1])?.id ?? null : state.activeId }
}

/** Remove only confirmed uninstalled applications, preserving other view positions. */
export function removeApplicationViews(state: ApplicationWorkspace, appIds: readonly string[]): ApplicationWorkspace {
  return [...new Set(appIds)].reduce(closeApplicationView, state)
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** A handoff or reclamation in progress is never an uninstall receipt. */
export function removedApplicationIds(value: unknown): readonly string[] {
  if (!record(value) || value.kind !== 'remove' || value.phase !== 'completed' || !Array.isArray(value.roles) || !value.roles.every(role => record(role) && role.ready === true) || !Array.isArray(value.targets)) return []
  return [...new Set(value.targets.flatMap(target => record(target) && record(target.identity) && validId(target.identity.appId) ? [target.identity.appId] : []))]
}
/** Historical removal cannot erase positions belonging to a subsequent reinstall. */
export function completedRemovedApplicationIds(value: unknown): readonly string[] {
  if (!record(value) || !Array.isArray(value.activations) || !Array.isArray(value.installations)) return []
  const candidates = new Set(value.activations.flatMap(removedApplicationIds)), installations = value.installations
  return [...candidates].filter(id => installations.some(facts => record(facts) && facts.appId === id && facts.selected === null && facts.pending === null && Array.isArray(facts.installed) && facts.installed.length > 0 && facts.installed.every(item => record(item) && item.state === 'removed')))
}

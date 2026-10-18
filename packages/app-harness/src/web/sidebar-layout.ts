/** Independent sidebar preferences. Automatic fitting never changes saved values. */
export interface SidebarState {
  readonly version: 1
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftExpanded: boolean
  readonly rightExpanded: boolean
  readonly collapsedProjects: readonly string[]
  readonly perSession: Readonly<Record<string, unknown>>
}

export const defaultSidebarState: SidebarState = {
  version: 1, leftWidth: 240, rightWidth: 600, leftExpanded: true, rightExpanded: true, collapsedProjects: [], perSession: {},
}
export const sidebarSeparatorSize = 1
export const sidebarBounds = { left: [200, 360], right: [320, 720] } as const
export type SidebarSide = keyof typeof sidebarBounds

export function clampSidebarWidth(side: SidebarSide, width: number): number {
  const [minimum, maximum] = sidebarBounds[side]
  return Math.max(minimum, Math.min(maximum, Number.isFinite(width) ? width : defaultSidebarState[`${side}Width`]))
}

export function restoreSidebarState(value: unknown): SidebarState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 1) return defaultSidebarState
  const record = value as Record<string, unknown>
  return {
    version: 1,
    leftWidth: typeof record.leftWidth === 'number' ? clampSidebarWidth('left', record.leftWidth) : 240,
    rightWidth: typeof record.rightWidth === 'number' ? clampSidebarWidth('right', record.rightWidth) : defaultSidebarState.rightWidth,
    leftExpanded: typeof record.leftExpanded === 'boolean' ? record.leftExpanded : true,
    rightExpanded: typeof record.rightExpanded === 'boolean' ? record.rightExpanded : true,
    collapsedProjects: Array.isArray(record.collapsedProjects)
      ? [...new Set(record.collapsedProjects.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512))] : [],
    perSession: record.perSession && typeof record.perSession === 'object' && !Array.isArray(record.perSession)
      ? Object.fromEntries(Object.entries(record.perSession)) : {},
  }
}

export interface SidebarFit {
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftDocked: boolean
  readonly rightDocked: boolean
  readonly leftDrawer: boolean
  readonly rightDrawer: boolean
  readonly centerWidth: number
}

/** Fit the Anybox Harness container, rather than the browser viewport. */
export function fitSidebars(width: number, state: SidebarState): SidebarFit {
  const available = Math.max(0, Number.isFinite(width) ? width : 0)
  const narrow = available <= 760
  const leftDocked = !narrow && state.leftExpanded
  // Determine this even while collapsed so opening a drawer does not persist a collapsed preference.
  const rightDrawer = narrow || available < 320 + 320 + sidebarSeparatorSize + (leftDocked ? 200 + sidebarSeparatorSize : 0)
  const rightDocked = !rightDrawer && state.rightExpanded
  let leftWidth = leftDocked ? clampSidebarWidth('left', state.leftWidth) : 0
  let rightWidth = rightDocked ? clampSidebarWidth('right', state.rightWidth) : 0
  const separators = (Number(leftDocked) + Number(rightDocked)) * sidebarSeparatorSize
  let deficit = Math.max(0, leftWidth + rightWidth + separators + 320 - available)
  if (rightDocked) {
    const shrink = Math.min(deficit, rightWidth - sidebarBounds.right[0])
    rightWidth -= shrink; deficit -= shrink
  }
  if (leftDocked) leftWidth -= Math.min(deficit, leftWidth - sidebarBounds.left[0])
  return { leftWidth, rightWidth, leftDocked, rightDocked, leftDrawer: narrow, rightDrawer,
    centerWidth: Math.max(0, available - leftWidth - rightWidth - separators) }
}

export interface SidebarStateStore {
  read(): SidebarState
  update(change: (state: SidebarState) => SidebarState): void
  subscribe(listener: (state: SidebarState) => void): () => void
}

export function createSidebarStateStore(storageKey: string, options: {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  onStorageError?(error: unknown): void
} = {}): SidebarStateStore {
  let storage = options.storage
  if (!storage) { try { storage = sessionStorage } catch { /* Persistence can be disabled by the browser. */ } }
  let state = defaultSidebarState
  try { state = restoreSidebarState(JSON.parse(storage?.getItem(storageKey) ?? 'null')) } catch { /* Independent recovery from a corrupt sidebar record. */ }
  const listeners = new Set<(state: SidebarState) => void>()
  return {
    read: () => state,
    update(change) {
      state = restoreSidebarState(change(state))
      try { storage?.setItem(storageKey, JSON.stringify(state)) } catch (error) { options.onStorageError?.(error) }
      for (const listener of listeners) listener(state)
    },
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener) } },
  }
}

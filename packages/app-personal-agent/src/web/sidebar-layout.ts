/** Independent sidebar preferences. Automatic fitting never changes saved values. */
export interface SidebarState {
  readonly version: 1
  readonly rightWidth: number
  readonly leftExpanded: boolean
  readonly rightExpanded: boolean
  readonly perSession: Readonly<Record<string, unknown>>
}

export const defaultSidebarState: SidebarState = {
  version: 1, rightWidth: 600, leftExpanded: true, rightExpanded: true, perSession: {},
}
export const sidebarSeparatorSize = 1
const agentSidebarWidth = 72
const minimumChatWidth = 320
export const fileSidebarBounds = [320, 720] as const
export type SidebarSide = 'left' | 'right'

export function clampFileSidebarWidth(width: number): number {
  const [minimum, maximum] = fileSidebarBounds
  return Math.max(minimum, Math.min(maximum, Number.isFinite(width) ? width : defaultSidebarState.rightWidth))
}

export function restoreSidebarState(value: unknown): SidebarState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 1) return defaultSidebarState
  const record = value as Record<string, unknown>
  return {
    version: 1,
    rightWidth: typeof record.rightWidth === 'number' ? clampFileSidebarWidth(record.rightWidth) : defaultSidebarState.rightWidth,
    leftExpanded: typeof record.leftExpanded === 'boolean' ? record.leftExpanded : true,
    rightExpanded: typeof record.rightExpanded === 'boolean' ? record.rightExpanded : true,
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

/** Fit the Personal Agent container, rather than the browser viewport. */
export function fitSidebars(width: number, state: SidebarState): SidebarFit {
  const available = Math.max(0, Number.isFinite(width) ? width : 0)
  const leftDrawer = available < 512
  const leftDocked = !leftDrawer && state.leftExpanded
  const leftWidth = leftDocked ? agentSidebarWidth : 0
  // Determine this even while collapsed so opening a drawer does not persist a collapsed preference.
  const fileSpace = available - leftWidth - sidebarSeparatorSize - minimumChatWidth
  const rightDrawer = fileSpace < fileSidebarBounds[0]
  const rightDocked = !rightDrawer && state.rightExpanded
  const rightWidth = rightDocked ? Math.min(fileSpace, clampFileSidebarWidth(state.rightWidth)) : 0
  return { leftWidth, rightWidth, leftDocked, rightDocked, leftDrawer, rightDrawer,
    centerWidth: Math.max(0, available - leftWidth - rightWidth - Number(rightDocked) * sidebarSeparatorSize) }
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

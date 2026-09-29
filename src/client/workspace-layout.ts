/** Browser workspace values. No DOM, persistence or service ownership. */
export interface SessionRef { readonly projectId: string; readonly sessionId: string }
export interface Pane extends SessionRef { readonly kind: 'pane'; readonly id: string }
export interface Split {
  readonly kind: 'split'
  readonly id: string
  readonly axis: 'horizontal' | 'vertical'
  readonly ratio: number
  readonly first: LayoutNode
  readonly second: LayoutNode
}
export type LayoutNode = Pane | Split
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export interface Size { readonly width: number; readonly height: number }
export interface Workspace {
  readonly version: 1
  readonly root: LayoutNode | null
  readonly activePaneId: string | null
  readonly sidebarProjectId: string | null
}
export const paneLimit = 4
export const separatorSize = 8
export const minimumPane: Size = { width: 320, height: 260 }
export const emptyWorkspace: Workspace = { version: 1, root: null, activePaneId: null, sidebarProjectId: null }

export function panes(root: LayoutNode | null): readonly Pane[] {
  return root === null ? [] : root.kind === 'pane' ? [root] : [...panes(root.first), ...panes(root.second)]
}

export function minimumSize(root: LayoutNode | null): Size {
  if (!root || root.kind === 'pane') return minimumPane
  const a = minimumSize(root.first), b = minimumSize(root.second)
  return root.axis === 'horizontal'
    ? { width: a.width + separatorSize + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + separatorSize + b.height }
}

export function fits(root: LayoutNode | null, size: Size): boolean {
  const min = minimumSize(root)
  return size.width >= min.width && size.height >= min.height
}

export function removePane(root: LayoutNode | null, id: string): LayoutNode | null {
  if (!root || root.kind === 'pane') return root?.id === id ? null : root
  const first = removePane(root.first, id), second = removePane(root.second, id)
  if (!first) return second
  if (!second) return first
  return first === root.first && second === root.second ? root : { ...root, first, second }
}

function replace(root: LayoutNode, id: string, node: LayoutNode): LayoutNode {
  if (root.id === id) return node
  return root.kind === 'pane' ? root : { ...root, first: replace(root.first, id, node), second: replace(root.second, id, node) }
}

export function closePane(state: Workspace, id: string): Workspace {
  const root = removePane(state.root, id)
  return { ...state, root, activePaneId: state.activePaneId === id ? panes(root)[0]?.id ?? null : state.activePaneId }
}

export function openSession(state: Workspace, ref: SessionRef): Workspace {
  const existing = panes(state.root).find(item => item.sessionId === ref.sessionId)
  if (existing) return { ...state, activePaneId: existing.id }
  const pane: Pane = { kind: 'pane', id: ref.sessionId, ...ref }
  const target = panes(state.root).find(item => item.id === state.activePaneId) ?? panes(state.root)[0]
  return { ...state, root: state.root && target ? replace(state.root, target.id, pane) : pane, activePaneId: pane.id }
}

/** Moving an existing leaf removes it before splitting the target; it never creates a duplicate. */
export function splitSession(state: Workspace, ref: SessionRef, targetId: string, edge: Edge, splitId: string): Workspace {
  const all = panes(state.root), existing = all.find(item => item.sessionId === ref.sessionId)
  if (!state.root || existing?.id === targetId || !all.some(item => item.id === targetId) ||
      (!existing && all.length >= paneLimit)) return state
  const root = existing ? removePane(state.root, existing.id)! : state.root
  const target = panes(root).find(item => item.id === targetId)!
  const pane: Pane = existing ?? { kind: 'pane', id: ref.sessionId, ...ref }
  const before = edge === 'left' || edge === 'top'
  const split: Split = { kind: 'split', id: splitId, axis: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
    ratio: 0.5, first: before ? pane : target, second: before ? target : pane }
  return { ...state, root: replace(root, targetId, split), activePaneId: pane.id }
}

export function ratioBounds(split: Split, size: Size): readonly [number, number] {
  const key = split.axis === 'horizontal' ? 'width' : 'height'
  const available = Math.max(1, size[key] - separatorSize)
  return [minimumSize(split.first)[key] / available, 1 - minimumSize(split.second)[key] / available]
}

export function resizeSplit(root: LayoutNode, id: string, ratio: number, size: Size): LayoutNode {
  if (root.id === id && root.kind === 'split') {
    const [low, high] = ratioBounds(root, size)
    return low <= high ? { ...root, ratio: Math.max(low, Math.min(high, ratio)) } : root
  }
  return root.kind === 'pane' ? root : { ...root,
    first: resizeSplit(root.first, id, ratio, size), second: resizeSplit(root.second, id, ratio, size) }
}

/** Clamp all ratios after a viewport resize without changing the user's saved tree. */
export function fitRatios(root: LayoutNode, size: Size): LayoutNode {
  if (root.kind === 'pane' || !fits(root, size)) return root
  const node = resizeSplit(root, root.id, root.ratio, size) as Split
  const key = node.axis === 'horizontal' ? 'width' : 'height'
  const available = size[key] - separatorSize
  return { ...node, first: fitRatios(node.first, { ...size, [key]: available * node.ratio }),
    second: fitRatios(node.second, { ...size, [key]: available * (1 - node.ratio) }) }
}

/** Invalid leaves are discarded, and their siblings expand into their space. */
export function restoreWorkspace(value: unknown): Workspace {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return emptyWorkspace
  const record = value as Record<string, unknown>, sessions = new Set<string>(), ids = new Set<string>()
  const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512
  const read = (raw: unknown, depth: number): LayoutNode | null => {
    if (!raw || typeof raw !== 'object' || depth > 8) return null
    const v = raw as Record<string, unknown>
    if (!string(v.id) || ids.has(v.id)) return null
    ids.add(v.id)
    if (v.kind === 'pane') {
      if (!string(v.projectId) || !string(v.sessionId) || sessions.has(v.sessionId) || sessions.size >= paneLimit) return null
      sessions.add(v.sessionId)
      return { kind: 'pane', id: v.id, projectId: v.projectId, sessionId: v.sessionId }
    }
    if (v.kind !== 'split' || (v.axis !== 'horizontal' && v.axis !== 'vertical')) return null
    const first = read(v.first, depth + 1), second = read(v.second, depth + 1)
    if (!first) return second
    if (!second) return first
    return { kind: 'split', id: v.id, axis: v.axis,
      ratio: typeof v.ratio === 'number' && Number.isFinite(v.ratio) && v.ratio > 0 && v.ratio < 1 ? v.ratio : 0.5,
      first, second }
  }
  const root = read(record.root, 0), all = panes(root)
  return { version: 1, root, activePaneId: all.find(item => item.id === record.activePaneId)?.id ?? all[0]?.id ?? null,
    sidebarProjectId: string(record.sidebarProjectId) ? record.sidebarProjectId : null }
}

export function parseRoute(hash: string): { projectId: string; sessionId?: string } | undefined {
  const match = /^#\/projects\/([^/]+)(?:\/sessions\/([^/]+))?$/.exec(hash)
  if (!match) return undefined
  try { return { projectId: decodeURIComponent(match[1]), ...(match[2] ? { sessionId: decodeURIComponent(match[2]) } : {}) } }
  catch { return undefined }
}

export function sessionHash(ref: SessionRef): string {
  return `#/projects/${encodeURIComponent(ref.projectId)}/sessions/${encodeURIComponent(ref.sessionId)}`
}

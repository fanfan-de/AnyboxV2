import type { NodeView, RunView } from './client-types.js'
import type { SessionSnapshot } from './session-client.js'

export interface ConversationTree {
  readonly nodes: ReadonlyMap<string, NodeView>
  readonly children: ReadonlyMap<string | null, readonly NodeView[]>
  readonly activeRuns: ReadonlyMap<string | null, readonly RunView[]>
  readonly pathIds: ReadonlySet<string>
}

function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function compareRuns(a: RunView, b: RunView): number {
  return compareIds(a.createdAt, b.createdAt) || compareIds(a.id, b.id)
}

/** A node is traversable only when its explicit parent chain reaches the session origin. */
function rootedNodes(nodes: ReadonlyMap<string, NodeView>): ReadonlyMap<string, boolean> {
  const rooted = new Map<string, boolean>()
  for (const node of nodes.values()) {
    if (rooted.has(node.id)) continue
    const trail: string[] = [], seen = new Set<string>()
    let current: NodeView | undefined = node, reachesRoot = false
    while (current) {
      const known = rooted.get(current.id)
      if (known !== undefined) { reachesRoot = known; break }
      if (seen.has(current.id)) break
      trail.push(current.id); seen.add(current.id)
      if (current.parentId === null) { reachesRoot = true; break }
      current = nodes.get(current.parentId)
    }
    for (const id of trail) rooted.set(id, reachesRoot)
  }
  return rooted
}

/** Native sessions have a source Run for every node; legacy sessions expose only queried facts. */
export function conversationTree(snapshot: Pick<SessionSnapshot, 'session' | 'runs' | 'path' | 'children'>): ConversationTree {
  const nodes = new Map<string, NodeView>(), children = new Map<string | null, readonly NodeView[]>()
  const activeRuns = new Map<string | null, readonly RunView[]>(), pathIds = new Set<string>()
  const session = snapshot.session
  if (!session) return { nodes, children, activeRuns, pathIds }
  const runs = snapshot.runs.filter(run => run.sessionId === session.id)
  const runsById = new Map(runs.map(run => [run.id, run]))
  if (session.historyMode === 'native-local-v1') {
    for (const run of runs) {
      if (run.status !== 'completed' || !run.resultNodeId || run.history.kind !== 'tree') continue
      nodes.set(run.resultNodeId, {
        id: run.resultNodeId, sessionId: run.sessionId, parentId: run.history.parentNodeId,
        input: run.input, images: run.images ?? [], files: run.files ?? [], output: run.output ?? '', sourceRunId: run.id,
      })
    }
  }
  for (const node of [...snapshot.path, ...snapshot.children]) {
    if (node.sessionId === session.id) nodes.set(node.id, node)
  }
  for (const node of snapshot.path) if (node.sessionId === session.id) pathIds.add(node.id)

  const rooted = rootedNodes(nodes), groupedNodes = new Map<string | null, NodeView[]>()
  for (const node of nodes.values()) {
    if (!rooted.get(node.id)) continue
    const group = groupedNodes.get(node.parentId) ?? []
    group.push(node); groupedNodes.set(node.parentId, group)
  }
  const compareNodes = (a: NodeView, b: NodeView): number => {
    const aRun = a.sourceRunId ? runsById.get(a.sourceRunId) : undefined
    const bRun = b.sourceRunId ? runsById.get(b.sourceRunId) : undefined
    return compareIds(aRun?.createdAt ?? '', bRun?.createdAt ?? '') || compareIds(a.id, b.id)
  }
  for (const [parent, group] of groupedNodes) children.set(parent, Object.freeze(group.sort(compareNodes)))

  const groupedRuns = new Map<string | null, RunView[]>()
  for (const run of runs) {
    if ((run.status !== 'running' && run.status !== 'cancelling') || run.history.kind !== 'tree') continue
    const parent = run.history.parentNodeId, group = groupedRuns.get(parent) ?? []
    group.push(run); groupedRuns.set(parent, group)
  }
  for (const [parent, group] of groupedRuns) activeRuns.set(parent, Object.freeze(group.sort(compareRuns)))
  return { nodes, children, activeRuns, pathIds }
}

export function conversationNodeLabel(node: NodeView): string {
  const text = node.input.replace(/\s+/gu, ' ').trim()
  if (text) return text
  const parts: string[] = []
  if (node.files?.length) parts.push(`${node.files.length} 个文件`)
  if (node.images?.length) parts.push(`${node.images.length} 张图片`)
  return parts.join(' · ') || '无文本输入'
}

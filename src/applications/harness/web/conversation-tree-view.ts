import type { NodeView, RunView } from './client-types.js'
import type { SessionSnapshot } from './session-client.js'
import { conversationNodeLabel, type ConversationTree } from './conversation-tree.js'

interface TreeActions {
  navigate(id: string | null): void
  showRun(id: string): void
  close(): void
}
interface TreeRow {
  readonly element: HTMLLIElement
  readonly toggle: HTMLButtonElement
  readonly button: HTMLButtonElement
  readonly guides: HTMLElement
  readonly marker: HTMLElement
  readonly label: HTMLElement
  readonly version: HTMLElement
  readonly current: HTMLElement
}
interface VisibleItem {
  readonly key: string
  readonly id: string | null
  readonly node?: NodeView
  readonly run?: RunView
  readonly chain?: readonly VisibleItem[]
  readonly depth: number
  readonly guides: readonly boolean[]
  readonly index: number
  readonly total: number
}
const rootKey = 'root'

/** Pane-local navigation renders durable nodes and keeps running attempts distinct. */
export function createConversationTreeView(container: HTMLElement, actions: TreeActions): {
  update(snapshot: SessionSnapshot, tree: ConversationTree): void
  locate(id?: string | null): void
  dispose(): void
} {
  const document = container.ownerDocument, lifetime = new AbortController(), options = { signal: lifetime.signal }
  container.classList.add('conversation-tree-panel')
  container.setAttribute('aria-label', '分支总览')
  const header = document.createElement('header'); header.className = 'conversation-tree-heading'
  const heading = document.createElement('div'); heading.className = 'conversation-tree-heading-copy'
  const title = document.createElement('strong'); title.textContent = '分支总览'
  const summary = document.createElement('span'); summary.className = 'conversation-tree-summary'
  heading.append(title, summary)
  const controls = document.createElement('div'); controls.className = 'conversation-tree-controls'
  const locateButton = document.createElement('button'); locateButton.type = 'button'; locateButton.className = 'conversation-tree-locate'
  locateButton.textContent = '定位当前'; locateButton.title = '展开并定位当前对话节点'
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'conversation-tree-close'
  closeButton.title = '关闭分支总览'; closeButton.setAttribute('aria-label', closeButton.title)
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 7 10 10M7 17 17 7"/></svg>'
  controls.append(locateButton, closeButton); header.append(heading, controls)
  const legend = document.createElement('p'); legend.className = 'conversation-tree-legend'
  legend.innerHTML = '<span><i aria-hidden="true"></i>当前路径</span><span>点击节点切换对话</span>'
  const viewport = document.createElement('div'); viewport.className = 'conversation-tree-viewport'
  const list = document.createElement('ul'); list.className = 'conversation-tree-list'; list.setAttribute('aria-label', '会话分支')
  const empty = document.createElement('p'); empty.className = 'conversation-tree-empty'
  empty.textContent = '发送第一条消息后，轮次会出现在这里。'; empty.hidden = true
  viewport.append(list, empty); container.replaceChildren(header, legend, viewport)
  const rows = new Map<string, TreeRow>(), expanded = new Set<string | null>([null]), expandedChainNodes = new Set<string>()
  let snapshot: SessionSnapshot | undefined, tree: ConversationTree | undefined, previousNodeId: string | null | undefined
  let visibleItems: readonly VisibleItem[] = [], disposed = false
  const setText = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value }
  const childCount = (id: string | null) => (tree?.children.get(id)?.length ?? 0) + (tree?.activeRuns.get(id)?.length ?? 0)
  const reveal = (id: string | null) => {
    const seen = new Set<string>(); expanded.add(null)
    while (id && !seen.has(id)) { seen.add(id); expanded.add(id); id = tree?.nodes.get(id)?.parentId ?? null }
  }
  const position = () => {
    for (let current: HTMLElement | null = container; current; current = current.parentElement) if (current.hidden || current.inert) return
    const pane = container.parentElement, navigation = pane?.querySelector<HTMLElement>('.branch-navigation')
    if (!pane || !navigation || !pane.clientHeight || !pane.clientWidth) return
    const paneBox = pane.getBoundingClientRect?.(), navigationBox = navigation.getBoundingClientRect?.()
    if (!paneBox || !navigationBox) return
    const top = Math.max(0, navigationBox.bottom - paneBox.top + 4)
    const composer = pane.querySelector<HTMLElement>('.composer'), composerBox = composer?.getBoundingClientRect?.()
    // Small split panes retain a usable overlay; larger panes leave the composer visible.
    const bottom = composer && !composer.hidden && composerBox && composerBox.height && composerBox.top - paneBox.top - top > 180
      ? Math.max(12, paneBox.bottom - composerBox.top + 8) : 12
    container.style.top = `${top}px`; container.style.bottom = `${bottom}px`
  }
  const collect = (): readonly VisibleItem[] => {
    if (!tree) return []
    const result: VisibleItem[] = [{ key: rootKey, id: null, depth: 0, guides: [], index: 0, total: 1 }]
    const seen = new Set<string>()
    const descendants = (id: string | null, depth: number, guides: readonly boolean[]): VisibleItem[] => {
      const nodes = tree!.children.get(id) ?? [], runs = tree!.activeRuns.get(id) ?? [], total = nodes.length + runs.length
      return [...nodes.map((node, index) => ({ key: `node:${node.id}`, id: node.id, node, depth,
        guides: [...guides, index < total - 1], index, total: nodes.length })),
      ...runs.map((run, index) => ({ key: `run:${run.id}`, id: run.id, run, depth,
        guides: [...guides, nodes.length + index < total - 1], index, total: runs.length }))]
    }
    const pending = expanded.has(null) ? descendants(null, 1, []).reverse() : []
    while (pending.length) {
      const item = pending.pop()!
      if (seen.has(item.key)) continue
      seen.add(item.key); result.push(item)
      if (item.node && expanded.has(item.id)) pending.push(...descendants(item.id, item.depth + 1, item.guides).reverse())
    }
    return result
  }
  const chainOpen = (item: VisibleItem) => item.chain?.some(member => expandedChainNodes.has(member.id!)) ?? false
  const compact = (items: readonly VisibleItem[]): readonly VisibleItem[] => {
    if (!tree || !snapshot) return items
    const intermediate = (item: VisibleItem) => Boolean(item.node && item.depth > 1 && item.total === 1 &&
      item.id !== snapshot!.position.viewNodeId && expanded.has(item.id) &&
      tree!.children.get(item.id)?.length === 1 && !tree!.activeRuns.get(item.id)?.length &&
      !tree!.activeRuns.get(item.node.parentId)?.length)
    const result: VisibleItem[] = []
    for (let index = 0; index < items.length;) {
      const first = items[index]!, members: VisibleItem[] = []
      if (intermediate(first)) {
        let candidate: VisibleItem | undefined = first
        while (candidate && intermediate(candidate) && (!members.length || candidate.node!.parentId === members.at(-1)!.id)) {
          members.push(candidate); candidate = items[index + members.length]
        }
      }
      if (members.length < 3) { result.push(first); index++; continue }
      const last = members.at(-1)!, group: VisibleItem = {
        key: `chain:${JSON.stringify([first.id, last.id])}`, id: first.id, depth: first.depth, guides: first.guides,
        index: 0, total: 1, chain: members,
      }
      result.push(group)
      if (chainOpen(group)) result.push(...members)
      index += members.length
    }
    return result
  }
  const createRow = (item: VisibleItem): TreeRow => {
    const element = document.createElement('li'); element.className = 'conversation-tree-item'; element.dataset.treeKey = item.key
    const guides = document.createElement('span'); guides.className = 'conversation-tree-guides'; guides.setAttribute('aria-hidden', 'true')
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'conversation-tree-expand'
    toggle.dataset.treeToggle = item.key
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
    const button = document.createElement('button'); button.type = 'button'; button.className = 'conversation-tree-node'
    if (item.chain) button.dataset.treeChain = item.key; else button.dataset.treeNavigate = item.key
    const marker = document.createElement('span'); marker.className = 'conversation-tree-marker'; marker.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span'); label.className = 'conversation-tree-label'
    const version = document.createElement('span'); version.className = 'conversation-tree-version'
    const current = document.createElement('span'); current.className = 'conversation-tree-current'; current.textContent = '当前'
    button.append(marker, label, version, current); element.append(guides, toggle, button)
    return { element, toggle, button, guides, marker, label, version, current }
  }
  const render = () => {
    if (!snapshot || !tree || disposed) return
    visibleItems = compact(collect())
    const keep = new Set(visibleItems.map(item => item.key)), focused = document.activeElement as HTMLElement | null
    const hadFocus = Boolean(focused && container.contains(focused))
    for (const [key, row] of rows) if (!keep.has(key)) { row.element.remove(); rows.delete(key) }
    let next = list.firstChild
    for (const item of visibleItems) {
      let row = rows.get(item.key)
      if (!row) { row = createRow(item); rows.set(item.key, row) }
      if (row.element !== next) list.insertBefore(row.element, next)
      next = row.element.nextSibling
      const root = item.key === rootKey, run = item.run, chain = item.chain
      const active = !run && !chain && snapshot.position.viewNodeId === item.id
      const path = root || (chain ? chain.every(member => tree!.pathIds.has(member.id!)) : !run && tree.pathIds.has(item.id!))
      const children = chain ? true : !run && childCount(item.id), open = chain ? chainOpen(item) : expanded.has(item.id)
      row.element.classList.toggle('is-root', root); row.element.classList.toggle('is-path', path)
      row.element.classList.toggle('is-current', active); row.element.classList.toggle('is-running', Boolean(run))
      row.element.classList.toggle('is-chain', Boolean(chain))
      row.element.style.setProperty('--conversation-tree-depth', String(Math.min(item.depth, 6)))
      const guideKey = item.guides.slice(-6).map(value => value ? '1' : '0').join('')
      if (row.guides.dataset.guides !== guideKey) {
        row.guides.dataset.guides = guideKey
        row.guides.replaceChildren(...item.guides.slice(-6).map((continuation, index, all) => {
          const guide = document.createElement('i'); guide.style.setProperty('--conversation-tree-guide', String(index))
          guide.classList.toggle('continues', continuation); guide.classList.toggle('is-elbow', index === all.length - 1); return guide
        }))
      }
      const label = root ? '会话起点' : chain ? `中间 ${chain.length} 轮` : run ? run.input.replace(/\s+/g, ' ').trim() || (run.files?.length ? `${run.files.length} 个文件` : run.images?.length ? `${run.images.length} 张图片` : '本轮输入') : conversationNodeLabel(item.node!)
      const range = chain ? `第 ${chain[0]!.depth}–${chain.at(-1)!.depth} 轮连续对话` : ''
      row.toggle.hidden = !children; row.toggle.disabled = snapshot.loading
      row.toggle.setAttribute('aria-expanded', String(open)); row.toggle.title = chain ? `${open ? '收起' : '展开'}${range}` : `${open ? '折叠' : '展开'}后续分支`
      row.toggle.setAttribute('aria-label', `${row.toggle.title}：${label}`)
      row.button.disabled = snapshot.loading
      if (active) row.button.setAttribute('aria-current', 'location'); else row.button.removeAttribute('aria-current')
      if (chain) row.button.setAttribute('aria-expanded', String(open)); else row.button.removeAttribute('aria-expanded')
      setText(row.label, label)
      setText(row.marker, root || run ? '' : chain ? '⋯' : String(item.depth))
      row.marker.title = root ? '' : chain ? range : `第 ${item.depth} 轮`
      row.current.hidden = !active
      row.version.hidden = !run && !chain && (root || item.total < 2)
      setText(row.version, chain ? open ? '收起' : '展开' : run ? run.status === 'cancelling' ? '取消中' : '进行中' : `${item.index + 1} / ${item.total}`)
      row.version.title = chain ? range : run ? '运行完成后才会创建对话节点；点击查看轨迹' : `同父节点的第 ${item.index + 1} 个分支，共 ${item.total} 个`
      row.button.title = root ? '查看会话起点' : chain ? `${open ? '收起' : '展开'}${range}（${label}）` : run ? `查看运行轨迹：${label}` : `第 ${item.depth} 轮${item.total > 1 ? ` · 分支 ${item.index + 1} / ${item.total}` : ''}：${label}`
      row.button.setAttribute('aria-label', row.button.title)
    }
    // Keep keyboard focus within the visible branch after its ancestor is collapsed.
    if (hadFocus && focused && document.activeElement !== focused) {
      const target = focused.isConnected ? focused : rows.get(snapshot.position.viewNodeId ? `node:${snapshot.position.viewNodeId}` : rootKey)?.button ?? rows.get(rootKey)?.button
      target?.focus({ preventScroll: true })
    }
    const count = tree.nodes.size, activeCount = [...tree.activeRuns.values()].reduce((total, runs) => total + runs.length, 0)
    setText(summary, `${count} 个轮次${activeCount ? ` · ${activeCount} 个运行中` : ''}`)
    empty.hidden = count > 0 || activeCount > 0
    locateButton.disabled = snapshot.loading
    position()
  }
  const locate = (id: string | null = snapshot?.position.viewNodeId ?? null) => {
    if (!snapshot || !tree || disposed) return
    reveal(id)
    if (id && compact(collect()).some(item => item.chain?.some(member => member.id === id))) expandedChainNodes.add(id)
    render()
    const row = rows.get(id ? `node:${id}` : rootKey)
    if (!row || container.hidden || container.inert) return
    const viewportBox = viewport.getBoundingClientRect?.(), itemBox = row.element.getBoundingClientRect?.()
    if (viewportBox && itemBox) {
      if (itemBox.top < viewportBox.top + 8) viewport.scrollTop -= viewportBox.top + 8 - itemBox.top
      else if (itemBox.bottom > viewportBox.bottom - 8) viewport.scrollTop += itemBox.bottom - viewportBox.bottom + 8
    }
    row.button.focus({ preventScroll: true })
  }
  closeButton.addEventListener('click', actions.close, options)
  locateButton.addEventListener('click', () => locate(), options)
  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null | undefined
    if (!button || button.disabled) return
    const item = visibleItems.find(item => item.key === (button.dataset.treeToggle ?? button.dataset.treeNavigate ?? button.dataset.treeChain))
    if (!item) return
    if (item.chain) {
      const open = chainOpen(item)
      for (const member of item.chain) { if (open) expandedChainNodes.delete(member.id!); else expandedChainNodes.add(member.id!) }
      render(); return
    }
    if (button.dataset.treeToggle) {
      if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id)
      render(); return
    }
    if (item.run) actions.showRun(item.run.id); else actions.navigate(item.id)
  }, options)
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); actions.close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const current = (event.target as HTMLElement | null)?.closest?.('[data-tree-key]') as HTMLElement | null | undefined
    if (!current || !list.contains(current)) return
    event.preventDefault()
    const index = visibleItems.findIndex(item => item.key === current.dataset.treeKey)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleItems.length - 1
      : Math.max(0, Math.min(visibleItems.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    rows.get(visibleItems[next]!.key)?.button.focus()
  }, options)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position)
  const pane = container.parentElement
  if (pane) {
    observer?.observe(pane)
    for (const element of pane.querySelectorAll('.branch-navigation, .composer')) observer?.observe(element)
  }
  return {
    update(nextSnapshot, nextTree) {
      if (disposed) return
      snapshot = nextSnapshot; tree = nextTree
      if (!snapshot.loading && previousNodeId !== snapshot.position.viewNodeId) { previousNodeId = snapshot.position.viewNodeId; reveal(previousNodeId) }
      render()
    },
    locate,
    dispose() { disposed = true; lifetime.abort(); observer?.disconnect(); rows.clear(); expandedChainNodes.clear(); container.replaceChildren() },
  }
}

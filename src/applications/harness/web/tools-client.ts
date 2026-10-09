import type { Api } from './client-types.js'
import type { AgentToolsSelection } from '../core/session/domain.js'
import type { listTools } from '../core/tool/catalog.js'
import { createPageRequests } from './page-lifecycle.js'
import { splitScopedId } from './harness-client.js'

type Catalog = ReturnType<typeof listTools>
interface Draft {
  saved?: AgentToolsSelection
  toolIds: readonly string[]
  loading: boolean
  saving: boolean
  read: number
  notice: string
  failed: boolean
  conflict: boolean
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index])

/** One fixed device owns catalog reads and every Agent selection write. */
export function createToolsSettingsClient(source: Api, messageFor: (error: unknown) => string) {
  const requests = createPageRequests(source), drafts = new Map<string, Draft>(), listeners = new Set<() => void>()
  let agentId = '', disposed = false, catalog: Catalog = [], catalogError = '', catalogRead = 0
  const emit = () => { if (!disposed) for (const listener of listeners) listener() }
  const dirty = (draft: Draft) => Boolean(draft.saved && !same(draft.saved.toolIds, draft.toolIds))
  async function readCatalog(): Promise<void> {
    const read = ++catalogRead
    try {
      const value = await requests.api<Catalog>('/tools')
      if (disposed || read !== catalogRead) return
      catalog = value; catalogError = ''
    } catch (error) { if (!disposed && read === catalogRead) catalogError = messageFor(error) }
    emit()
  }
  async function load(id: string): Promise<void> {
    const draft = drafts.get(id)
    if (!draft || disposed || draft.saving) return
    const read = ++draft.read
    draft.loading = true; draft.notice = ''; draft.failed = false; emit()
    try {
      const saved = await requests.api<AgentToolsSelection>(`/agents/${encodeURIComponent(id)}/tools`)
      if (disposed || read !== draft.read) return
      draft.saved = saved; draft.toolIds = [...saved.toolIds]; draft.conflict = false
    } catch (error) { if (!disposed && read === draft.read) { draft.failed = true; draft.notice = messageFor(error) } }
    finally { if (!disposed && read === draft.read) { draft.loading = false; emit() } }
  }
  void readCatalog()
  return {
    snapshot() {
      const draft = drafts.get(agentId)
      return { agentId, catalog, catalogError, toolIds: draft?.toolIds ?? [], saved: draft?.saved,
        loading: draft?.loading ?? false, saving: draft?.saving ?? false, dirty: draft ? dirty(draft) : false,
        notice: draft?.notice ?? '', failed: draft?.failed ?? false, conflict: draft?.conflict ?? false }
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    selectAgent(id: string): void {
      if (disposed || id === agentId) return
      agentId = id
      if (id && !drafts.has(id)) {
        drafts.set(id, { toolIds: [], loading: false, saving: false, read: 0, notice: '', failed: false, conflict: false })
        void load(id)
      }
      emit()
    },
    toggle(toolId: string, selected: boolean): void {
      const draft = drafts.get(agentId)
      if (disposed || !draft?.saved || draft.loading || draft.saving || !catalog.some(tool => tool.toolId === toolId)) return
      draft.toolIds = selected ? [...new Set([...draft.toolIds, toolId])] : draft.toolIds.filter(id => id !== toolId)
      if (!draft.conflict) { draft.notice = ''; draft.failed = false }
      emit()
    },
    async reload(): Promise<void> { await Promise.all([readCatalog(), load(agentId)]) },
    async save(): Promise<void> {
      const id = agentId, draft = drafts.get(id)
      if (disposed || !draft?.saved || draft.loading || draft.saving || draft.conflict || !dirty(draft) || catalogError) return
      draft.saving = true; draft.notice = ''; draft.failed = false; emit()
      try {
        const saved = await requests.api<AgentToolsSelection>(`/agents/${encodeURIComponent(id)}/tools`, {
          toolIds: draft.toolIds, expectedRevision: draft.saved.revision,
        })
        if (disposed) return
        draft.saved = saved; draft.toolIds = [...saved.toolIds]; draft.notice = '已保存，接下来创建的会话将使用这些工具。'
      } catch (error) {
        if (disposed) return
        draft.conflict = error instanceof Error && 'code' in error && error.code === 'agent-tools-conflict'
        draft.notice = draft.conflict ? '工具设置已被其他页面修改。当前选择已保留，请重新加载后保存。' : messageFor(error)
        draft.failed = true
      } finally { if (!disposed) { draft.saving = false; emit() } }
    },
    canLeave(): boolean {
      for (const [id, draft] of drafts) {
        if (!draft.saving && !dirty(draft)) continue
        agentId = id; draft.failed = false
        draft.notice = draft.saving ? '正在保存 Agent 工具，请稍候。' : 'Agent 工具选择尚未保存，请保存或重新加载以放弃修改。'
        emit(); return false
      }
      return true
    },
    async dispose() { disposed = true; listeners.clear(); await requests.dispose(); drafts.clear() },
  }
}

export function setupToolsSettings(source: Api, messageFor: (error: unknown) => string, container: HTMLElement, agentSelect: HTMLSelectElement) {
  const client = createToolsSettingsClient(source, messageFor), lifetime = new AbortController()
  container.innerHTML = `<header class="settings-panel-heading"><h3 id="agent--tools-title">Agent 工具</h3><p>自由选择单个工具，可跨来源组合。保存后仅影响新会话。</p></header>
    <div class="tools-filters"><label>搜索工具<input type="search" data-tools-search placeholder="名称或功能"></label>
    <label>分类<select data-tools-category><option value="">全部分类</option><option value="command">命令</option><option value="files">文件</option><option value="search">搜索</option><option value="image">图片</option><option value="plan">计划</option></select></label>
    <label>来源<select data-tools-source><option value="">全部来源</option></select></label></div>
    <p data-tools-summary role="status"></p><div class="tools-list" aria-label="可选工具"></div>
    <div class="settings-actions"><button type="button" data-tools-save disabled>保存工具</button><button type="button" class="secondary-button" data-tools-reload disabled>重新加载</button></div>
    <p data-tools-notice role="status" aria-live="polite" hidden></p>`
  const required = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector)!
  const search = required<HTMLInputElement>('[data-tools-search]'), filter = required<HTMLSelectElement>('[data-tools-source]'), category = required<HTMLSelectElement>('[data-tools-category]')
  const list = required<HTMLElement>('.tools-list'), summary = required<HTMLElement>('[data-tools-summary]'), notice = required<HTMLElement>('[data-tools-notice]')
  const save = required<HTMLButtonElement>('[data-tools-save]'), reload = required<HTMLButtonElement>('[data-tools-reload]')
  const sourceName = (id: string) => ({ codex: 'Codex', 'claude-code': 'Claude Code', 'deepseek-harness': 'DeepSeek Harness' }[id] ?? id)
  function render(): void {
    const state = client.snapshot(), previousSource = filter.value
    const option = (value: string, text: string) => { const element = document.createElement('option'); element.value = value; element.textContent = text; return element }
    filter.replaceChildren(option('', '全部来源'), ...[...new Set(state.catalog.map(tool => tool.source?.harnessId).filter((id): id is string => Boolean(id)))].map(id => option(id, sourceName(id))))
    filter.value = previousSource
    const query = search.value.trim().toLowerCase(), selected = new Set(state.toolIds)
    const tools = state.catalog.filter(tool => tool.selectable && (!filter.value || tool.source?.harnessId === filter.value) && (!category.value || tool.category === category.value) &&
      (!query || `${tool.name} ${tool.toolId} ${tool.definition.description ?? ''}`.toLowerCase().includes(query)))
    list.replaceChildren(...tools.map(tool => {
      const row = document.createElement('label'); row.className = 'tool-option'
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(tool.toolId)
      checkbox.dataset.toolId = tool.toolId; checkbox.disabled = !state.saved || state.loading || state.saving
      const detail = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small')
      title.textContent = `${tool.name}${tool.source ? ` · ${sourceName(tool.source.harnessId)}` : ''}`
      description.textContent = tool.definition.description ?? tool.toolId
      detail.append(title, description)
      if (tool.dependencies.length) { const hint = document.createElement('small'); hint.textContent = `需要：${tool.dependencies.map(id => state.catalog.find(value => value.toolId === id)?.name ?? id).join('、')}`; detail.append(hint) }
      row.append(checkbox, detail); return row
    }))
    const missing = state.toolIds.filter(id => !state.catalog.some(tool => tool.toolId === id))
    const dependencies = state.catalog.filter(tool => selected.has(tool.toolId)).flatMap(tool => tool.dependencies.filter(id => !selected.has(id)))
    summary.textContent = !state.agentId ? '请先选择执行设备上的 Agent。' : state.loading ? '正在读取工具配置…' : state.catalogError ? `工具目录读取失败：${state.catalogError}` :
      `已选择 ${state.toolIds.length} 个工具${missing.length ? `，不可用：${missing.join('、')}` : ''}${dependencies.length ? `，请补选：${[...new Set(dependencies)].map(id => state.catalog.find(tool => tool.toolId === id)?.name ?? id).join('、')}` : ''}。已有会话保持创建时的工具。`
    save.disabled = !state.saved || state.loading || state.saving || !state.dirty || state.conflict || Boolean(state.catalogError) || Boolean(missing.length) || Boolean(dependencies.length)
    save.textContent = state.saving ? '保存中…' : '保存工具'
    reload.disabled = !state.agentId || state.loading || state.saving
    reload.textContent = state.dirty ? '放弃修改并重新加载' : '重新加载'
    notice.textContent = state.notice; notice.hidden = !state.notice; notice.dataset.error = String(state.failed)
  }
  list.addEventListener('change', event => { const target = event.target as HTMLInputElement; if (target.dataset.toolId) client.toggle(target.dataset.toolId, target.checked) }, { signal: lifetime.signal })
  search.addEventListener('input', render, { signal: lifetime.signal }); filter.addEventListener('change', render, { signal: lifetime.signal }); category.addEventListener('change', render, { signal: lifetime.signal })
  save.addEventListener('click', () => { void client.save() }, { signal: lifetime.signal }); reload.addEventListener('click', () => { void client.reload() }, { signal: lifetime.signal })
  const unsubscribe = client.subscribe(render); render()
  return {
    selectAgent(id: string) { client.selectAgent(splitScopedId(id)?.id ?? id) },
    canLeave() {
      const result = client.canLeave()
      if (!result) agentSelect.value = [...agentSelect.options].find(option => (splitScopedId(option.value)?.id ?? option.value) === client.snapshot().agentId)?.value ?? ''
      return result
    },
    async dispose() { lifetime.abort(); unsubscribe(); await client.dispose() },
  }
}

import type { RunnableModelSummary, ProviderConnection } from '@anybox/models'
import type { Api } from './client-types.js'
import type { SessionDefaults } from '../core/session/domain.js'
import type { ModelsCatalog } from './models-client.js'
import { canUseModel, modelAvailability } from './models-client.js'
import { createPageRequests } from './page-lifecycle.js'
import { splitScopedId } from './harness-client.js'

interface DefaultsDraft {
  defaults?: SessionDefaults
  modelId: string | null
  loading: boolean
  saving: boolean
  read: number
  notice: string
  failed: boolean
  conflict: boolean
}

/** Drafts belong to an Agent on this fixed execution device; late reads never replace a newer draft. */
export function createSessionDefaultsClient(source: Api, messageFor: (error: unknown) => string) {
  const requests = createPageRequests(source), drafts = new Map<string, DefaultsDraft>(), listeners = new Set<() => void>()
  let agentId = '', disposed = false
  const emit = () => { if (!disposed) for (const listener of listeners) listener() }
  const entry = () => drafts.get(agentId)
  const dirty = (value: DefaultsDraft) => Boolean(value.defaults && value.modelId !== value.defaults.modelId)
  async function load(id: string): Promise<void> {
    const value = drafts.get(id)
    if (!value || value.saving || disposed) return
    const read = ++value.read
    value.loading = true; value.notice = ''; value.failed = false; emit()
    try {
      const defaults = await requests.api<SessionDefaults>(`/agents/${encodeURIComponent(id)}/session-defaults`)
      if (disposed || read !== value.read) return
      value.defaults = defaults; value.modelId = defaults.modelId; value.conflict = false
    } catch (error) {
      if (disposed || read !== value.read) return
      value.notice = messageFor(error); value.failed = true
    } finally {
      if (!disposed && read === value.read) { value.loading = false; emit() }
    }
  }
  return {
    snapshot() {
      const value = entry()
      return { agentId, defaults: value?.defaults, modelId: value?.modelId ?? null, loading: value?.loading ?? false,
        saving: value?.saving ?? false, dirty: value ? dirty(value) : false, notice: value?.notice ?? '',
        failed: value?.failed ?? false, conflict: value?.conflict ?? false }
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    selectAgent(id: string): void {
      if (disposed || id === agentId) return
      agentId = id
      if (id && !drafts.has(id)) {
        drafts.set(id, { modelId: null, loading: false, saving: false, read: 0, notice: '', failed: false, conflict: false })
        void load(id)
      }
      emit()
    },
    selectModel(modelId: string | null): void {
      const value = entry()
      if (disposed || !value?.defaults || value.loading || value.saving) return
      value.modelId = modelId
      if (!value.conflict) { value.notice = ''; value.failed = false }
      emit()
    },
    reload: () => load(agentId),
    async save(): Promise<void> {
      const id = agentId, value = entry()
      if (disposed || !value?.defaults || value.loading || value.saving || value.conflict || !dirty(value)) return
      const modelId = value.modelId, expectedRevision = value.defaults.revision
      value.saving = true; value.notice = ''; value.failed = false; emit()
      try {
        const defaults = await requests.api<SessionDefaults>(`/agents/${encodeURIComponent(id)}/session-defaults`, { modelId, expectedRevision })
        if (disposed) return
        value.defaults = defaults; value.modelId = defaults.modelId; value.notice = '已保存，接下来创建的会话将使用此设置。'
      } catch (error) {
        if (disposed) return
        value.conflict = error instanceof Error && 'code' in error && error.code === 'session-defaults-conflict'
        value.notice = value.conflict ? '设置已被其他页面修改，当前选择已保留。请重新加载后再选择并保存。' : messageFor(error)
        value.failed = true
      } finally {
        if (!disposed) { value.saving = false; emit() }
      }
    },
    canLeave(): boolean {
      for (const [id, value] of drafts) {
        if (!value.saving && !dirty(value)) continue
        agentId = id
        value.notice = value.saving ? '正在保存新会话默认模型，请稍候。' : '新会话默认模型尚未保存，请保存或重新加载以放弃修改。'
        value.failed = false; emit(); return false
      }
      return true
    },
    async dispose() { disposed = true; listeners.clear(); await requests.dispose(); drafts.clear() },
  }
}

export function defaultModelDescription(modelId: string | null, models: readonly RunnableModelSummary[], providers: readonly ProviderConnection[]): string {
  if (!modelId) return '尚未设置默认模型，新会话需先选择模型。'
  const model = models.find(item => item.id === modelId)
  if (!model) return '原默认模型已不可用，请重新选择；新会话会保留此选择。'
  const provider = providers.find(item => item.id === model.connectionId)
  const label = `${provider ? `${provider.name} · ` : ''}${model.name}`
  return canUseModel(model) ? `新会话将使用：${label}。` : `${label}：${modelAvailability(model)}，请处理配置或重新选择。`
}

export function setupSessionDefaults(source: Api, messageFor: (error: unknown) => string, catalog: ModelsCatalog, container: HTMLElement, agentSelect: HTMLSelectElement) {
  const client = createSessionDefaultsClient(source, messageFor), lifetime = new AbortController()
  const required = <T extends HTMLElement>(selector: string): T => {
    const value = container.querySelector<T>(selector)
    if (!value) throw new Error(`missing element ${selector}`)
    return value
  }
  const modelSelect = required<HTMLSelectElement>('[data-default-model]'), save = required<HTMLButtonElement>('[data-save-session-defaults]')
  const reload = required<HTMLButtonElement>('[data-reload-session-defaults]'), notice = required<HTMLElement>('[data-session-defaults-notice]')
  const hint = required<HTMLElement>('[data-default-model-hint]')
  const option = (value: string, label: string, disabled = false): HTMLOptionElement => {
    const element = document.createElement('option'); element.value = value; element.textContent = label; element.disabled = disabled; return element
  }
  function render(): void {
    const state = client.snapshot(), available = catalog.snapshot()
    const children: (HTMLOptionElement | HTMLOptGroupElement)[] = [option('', state.defaults?.fallbackModelId ? '使用 Agent 默认模型' : '未设置默认模型')]
    const groups = new Map<string, HTMLOptGroupElement>()
    for (const model of available.models) {
      let group = groups.get(model.connectionId)
      if (!group) {
        group = document.createElement('optgroup'); group.label = available.providers.find(item => item.id === model.connectionId)?.name ?? '未命名连接'
        groups.set(model.connectionId, group); children.push(group)
      }
      group.append(option(model.id, `${model.name}${canUseModel(model) ? '' : ` · ${modelAvailability(model)}`}`, !canUseModel(model)))
    }
    if (state.modelId && !available.models.some(model => model.id === state.modelId)) children.push(option(state.modelId, '原默认模型已不可用', true))
    modelSelect.replaceChildren(...children); modelSelect.value = state.modelId ?? ''
    modelSelect.disabled = !state.defaults || state.loading || state.saving || available.loading
    save.disabled = !state.defaults || state.loading || state.saving || available.loading || state.conflict || !state.dirty ||
      (state.modelId !== null && !canUseModel(available.models.find(model => model.id === state.modelId)))
    save.textContent = state.saving ? '保存中…' : '保存默认模型'
    reload.disabled = !state.agentId || state.loading || state.saving
    reload.textContent = state.dirty ? '放弃修改并重新加载' : '重新加载'
    const modelId = state.modelId ?? state.defaults?.fallbackModelId ?? null
    hint.textContent = !state.agentId ? '请先选择执行设备上的 Agent。' : state.loading ? '正在读取默认模型…' :
      !state.defaults ? '默认模型设置尚未读取。' : available.loading ? '正在读取模型列表…' : available.error ? `模型列表读取失败：${available.error}` :
      `${defaultModelDescription(modelId, available.models, available.providers)} 仅影响新会话。`
    notice.textContent = state.notice; notice.hidden = !state.notice; notice.dataset.error = String(state.failed)
  }
  modelSelect.addEventListener('change', () => { client.selectModel(modelSelect.value || null) }, { signal: lifetime.signal })
  save.addEventListener('click', () => { void client.save() }, { signal: lifetime.signal })
  reload.addEventListener('click', () => { void client.reload() }, { signal: lifetime.signal })
  const unsubscribeClient = client.subscribe(render), unsubscribeCatalog = catalog.subscribe(render)
  render()
  return {
    selectAgent(id: string) { client.selectAgent(splitScopedId(id)?.id ?? id) },
    canLeave() {
      const result = client.canLeave()
      if (!result) agentSelect.value = [...agentSelect.options].find(option =>
        (splitScopedId(option.value)?.id ?? option.value) === client.snapshot().agentId)?.value ?? ''
      return result
    },
    async dispose() { lifetime.abort(); unsubscribeClient(); unsubscribeCatalog(); await client.dispose() },
  }
}

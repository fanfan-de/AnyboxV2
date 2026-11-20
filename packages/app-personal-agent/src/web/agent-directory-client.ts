import type { AgentDetail, AgentSummary } from '../core/agent/domain.js'
import type { Api } from './client-types.js'
import { canUseModel, modelAvailability } from './models-client.js'
import type { ModelsCatalog } from './models-client.js'
import { createPageRequests } from './page-lifecycle.js'
import { setupAgentLogoEditor } from './agent-logo-editor.js'

type AgentFields = Pick<AgentDetail, 'name' | 'description' | 'instructions' | 'modelId'> & { readonly logoShader?: string | null }
type CreateRequest = AgentFields & { readonly requestId: string }

const emptyFields: AgentFields = { name: '', description: '', instructions: '', modelId: null }
const equal = (left: AgentFields, right: AgentFields) => left.name === right.name && left.description === right.description &&
  left.instructions === right.instructions && left.modelId === right.modelId && (left.logoShader ?? null) === (right.logoShader ?? null)
const option = (value: string, label: string) => new Option(label, value)

/** A lost creation response is observed by retrying the exact payload and request ID on this device. */
export function setupAgentDirectory(source: Api, messageFor: (error: unknown) => string, catalog: ModelsCatalog, container: HTMLElement,
  instanceId: string, changed: (agent: AgentDetail) => void) {
  const requests = createPageRequests(source), lifetime = new AbortController()
  const element = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!
  const list = element<HTMLSelectElement>('[data-directory-agent]')
  const create = element<HTMLButtonElement>('[data-create-agent]')
  const form = element<HTMLFormElement>('form')
  const title = element<HTMLElement>('[data-agent-form-title]')
  const name = element<HTMLInputElement>('[data-agent-name]')
  const description = element<HTMLInputElement>('[data-agent-description]')
  const instructions = element<HTMLTextAreaElement>('[data-agent-instructions]')
  const model = element<HTMLSelectElement>('[data-agent-model]')
  const modelHint = element<HTMLElement>('[data-agent-model-hint]')
  const save = element<HTMLButtonElement>('[data-save-agent]')
  const discard = element<HTMLButtonElement>('[data-discard-agent]')
  const reload = element<HTMLButtonElement>('[data-reload-agent]')
  const notice = element<HTMLElement>('[data-agent-notice]')
  const logo = setupAgentLogoEditor(element<HTMLFieldSetElement>('[data-agent-logo-editor]'), render)
  const storageKey = `anybox.personal-agent.agent-create.v1.${instanceId}`

  let agents: readonly AgentSummary[] = [], target: string | null | undefined
  let detail: AgentDetail | undefined, modelId: string | null = null
  let pendingCreate: CreateRequest | undefined, uncertainUpdate: AgentFields | undefined
  let loading = false, saving = false, conflict = false, disposed = false
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Partial<CreateRequest> | null
    if (saved && typeof saved.requestId === 'string' && saved.requestId && typeof saved.name === 'string' && saved.name.trim() &&
        typeof saved.description === 'string' && typeof saved.instructions === 'string' && saved.instructions.trim() &&
        (saved.modelId === null || typeof saved.modelId === 'string') &&
        (saved.logoShader === undefined || saved.logoShader === null || typeof saved.logoShader === 'string')) {
      pendingCreate = { name: saved.name, description: saved.description, instructions: saved.instructions, modelId: saved.modelId, requestId: saved.requestId,
        ...(saved.logoShader === undefined ? {} : { logoShader: saved.logoShader }) }
      target = null
    }
  } catch { /* A missing record leaves the editor ready for a new draft. */ }

  const fields = (): AgentFields => ({
    name: name.value.trim(), description: description.value.trim(), instructions: instructions.value, modelId, logoShader: logo.read(),
  })
  const dirty = () => (target === null || detail !== undefined) && !equal(fields(), detail ?? emptyFields)
  const show = (message = '', error = false) => {
    notice.textContent = message; notice.hidden = !message; notice.dataset.error = String(error)
  }
  const fill = (values: AgentFields) => {
    name.value = values.name; description.value = values.description; instructions.value = values.instructions; modelId = values.modelId
    logo.set(values.logoShader)
  }
  const renderAgents = () => {
    list.replaceChildren(option('', agents.length ? '选择 Agent' : '暂无 Agent'), ...agents.map(agent => option(agent.id, agent.name || agent.id)))
    list.value = target ?? ''
  }
  const renderModels = () => {
    const available = catalog.snapshot(), options: (HTMLOptionElement | HTMLOptGroupElement)[] = [option('', '不设默认模型')]
    const groups = new Map<string, HTMLOptGroupElement>()
    for (const item of available.models) {
      let group = groups.get(item.connectionId)
      if (!group) {
        group = document.createElement('optgroup')
        group.label = available.providers.find(provider => provider.id === item.connectionId)?.name ?? '未命名连接'
        groups.set(item.connectionId, group); options.push(group)
      }
      const entry = option(item.id, canUseModel(item) ? item.name : `${item.name} · ${modelAvailability(item)}`)
      entry.disabled = !canUseModel(item); group.append(entry)
    }
    if (modelId && !available.models.some(item => item.id === modelId)) {
      const previous = option(modelId, '原默认模型已不可用'); previous.disabled = true; options.push(previous)
    }
    model.replaceChildren(...options); model.value = modelId ?? ''
    modelHint.textContent = available.loading ? '正在读取模型列表…' : available.error ? `模型列表读取失败：${available.error}`
      : available.models.some(canUseModel) ? '未手动指定模型时，Agent 使用此默认模型。' : '可以先保存 Agent，再到“模型管理”配置模型。'
  }
  function render() {
    const editing = target === null || detail !== undefined
    const busy = saving || loading, frozen = !editing || busy || !!pendingCreate
    const available = catalog.snapshot()
    const modelValid = modelId === null || modelId === detail?.modelId || canUseModel(available.models.find(item => item.id === modelId))
    form.hidden = target === undefined
    title.textContent = target === null ? '新建 Agent' : '编辑 Agent'
    list.disabled = busy || !!pendingCreate || !agents.length
    create.disabled = busy || !!pendingCreate || target === null
    name.disabled = description.disabled = instructions.disabled = frozen
    model.disabled = frozen || available.loading
    logo.render(name.value, frozen, editing)
    const logoValid = logo.valid() || (detail !== undefined && logo.read() === (detail.logoShader ?? null))
    save.disabled = busy || (!pendingCreate && (!editing || !dirty() || conflict || !name.value.trim() || !instructions.value.trim() || !modelValid || !logoValid))
    save.textContent = saving ? '保存中…' : pendingCreate ? '重试本次创建' : target === null ? '创建 Agent' : '保存修改'
    reload.hidden = !target || (detail !== undefined && !conflict)
    reload.disabled = busy
    discard.disabled = busy || !!pendingCreate || (target !== null && !dirty())
    discard.textContent = target === null ? '取消新建' : '放弃修改'
  }
  const clearPending = () => {
    pendingCreate = undefined
    try { sessionStorage.removeItem(storageKey) } catch { /* Re-reading a retained request remains idempotent. */ }
  }
  const applyDetail = (saved: AgentDetail, values: AgentFields = saved) => {
    target = saved.id; detail = saved; conflict = false; uncertainUpdate = undefined
    fill(values); renderModels(); renderAgents()
  }
  async function readDetail(id: string, keepDraft = false) {
    const previous = detail, draft = fields(), attempted = uncertainUpdate
    loading = true; show('正在读取 Agent…'); render()
    try {
      const latest = await requests.api<AgentDetail>(`/agents/${encodeURIComponent(id)}`)
      if (disposed) return
      const values = keepDraft && previous ? {
        name: draft.name !== previous.name ? draft.name : latest.name,
        description: draft.description !== previous.description ? draft.description : latest.description,
        instructions: draft.instructions !== previous.instructions ? draft.instructions : latest.instructions,
        modelId: draft.modelId !== previous.modelId ? draft.modelId : latest.modelId,
        logoShader: (draft.logoShader ?? null) !== (previous.logoShader ?? null) ? draft.logoShader ?? null : latest.logoShader ?? null,
      } : latest
      applyDetail(latest, values)
      if (attempted && equal(attempted, latest)) { changed(latest); show('已确认 Agent 修改已保存。') }
      else if (keepDraft && dirty()) show('已读取最新版本，保留了你的修改。请确认后保存。')
      else show()
    } catch (error) { if (!disposed) show(messageFor(error), true) }
    finally { loading = false; if (!disposed) render() }
  }

  function canLeave(): boolean {
    if (saving) { show('正在保存 Agent，请稍候。'); return false }
    if (!pendingCreate && dirty()) { show('Agent 有未保存的修改。请保存或放弃修改。', true); return false }
    return true
  }
  function select(id: string | null | undefined) {
    if (!canLeave()) { list.value = target ?? ''; return }
    target = id; detail = undefined; conflict = false; uncertainUpdate = undefined
    fill(emptyFields); renderModels(); renderAgents(); show(); render()
    if (id) void readDetail(id)
    else if (id === null) name.focus()
  }
  async function submit() {
    const id = target
    if (save.disabled || id === undefined) return
    const values = fields()
    const { logoShader, ...otherFields } = values
    const logoChanged = (logoShader ?? null) !== (detail?.logoShader ?? null)
    const payload = { ...otherFields, ...(logoChanged ? { logoShader: logoShader ?? null } : {}) }
    if (id === null && !pendingCreate) {
      const request = { ...payload, requestId: crypto.randomUUID() }
      try { sessionStorage.setItem(storageKey, JSON.stringify(request)) }
      catch { show('浏览器无法保存本次创建请求，请允许此页面保存数据后重试。', true); return }
      pendingCreate = request
    }
    saving = true; show(); render()
    try {
      const saved = id === null ? await requests.api<AgentDetail>('/agents', pendingCreate!)
        : await requests.api<AgentDetail>(`/agents/${encodeURIComponent(id)}`, { ...payload, expectedRevision: detail!.revision })
      if (disposed) return
      if (id === null) clearPending()
      applyDetail(saved)
      changed(saved)
      show(id === null ? 'Agent 已创建。' : 'Agent 已保存。')
    } catch (error) {
      if (disposed) return
      const status = error instanceof Error && 'status' in error ? Number(error.status) : undefined
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      const uncertain = status === undefined || status >= 500
      if (id === null && uncertain) {
        show('暂时无法确认创建结果。连接恢复后可用原请求重试本次创建。', true)
      } else if (id === null) {
        clearPending()
        show(code === 'agent-request-conflict' ? '创建请求与服务器记录冲突，请确认现有 Agent 后再提交。' : messageFor(error), true)
      } else if (uncertain || code === 'agent-revision-conflict') {
        conflict = true
        if (uncertain) uncertainUpdate = values
        show(uncertain ? '暂时无法确认保存结果。请读取最新版本，你的修改会保留。' : '此 Agent 已被修改。请读取最新版本，你的修改会保留。', true)
      } else show(messageFor(error), true)
    } finally { saving = false; if (!disposed) render() }
  }

  list.addEventListener('change', () => { select(list.value || undefined) }, { signal: lifetime.signal })
  create.addEventListener('click', () => { select(null) }, { signal: lifetime.signal })
  model.addEventListener('change', () => { modelId = model.value || null; render() }, { signal: lifetime.signal })
  form.addEventListener('input', render, { signal: lifetime.signal })
  form.addEventListener('submit', event => { event.preventDefault(); void submit() }, { signal: lifetime.signal })
  reload.addEventListener('click', () => { if (target) void readDetail(target, true) }, { signal: lifetime.signal })
  discard.addEventListener('click', () => {
    if (target) { conflict = false; uncertainUpdate = undefined; void readDetail(target) }
    else { fill(emptyFields); select(undefined); create.focus() }
  }, { signal: lifetime.signal })
  const unsubscribeModels = catalog.subscribe(() => { renderModels(); render() })
  if (pendingCreate) { fill(pendingCreate); show('上次创建尚待确认，可用原请求重试。') }
  renderModels(); render()
  return {
    create() { if (create.disabled) return false; select(null); return true },
    receiveAgents(values: readonly AgentSummary[]) { agents = values; renderAgents(); render() },
    refresh() {
      void catalog.refresh()
      if (target && !loading && !saving && !dirty()) void readDetail(target)
    },
    canLeave,
    pauseLogo: () => logo.pause(),
    async dispose() { disposed = true; lifetime.abort(); unsubscribeModels(); logo.dispose(); await requests.dispose() },
  }
}

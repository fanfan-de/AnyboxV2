import { createPageRequests } from './page-lifecycle.js'
import type { Api } from './client-types.js'
import { readPromptViewState, rememberPromptViewState } from './product-view-state.js'
/** Prompt settings use only the public browser protocol. */
type PromptKind = 'agent-instruction' | 'task-template' | 'context'
type PromptRole = 'system' | 'developer' | 'user'
interface DraftFields { name: string; description: string; kind: PromptKind; role: PromptRole; content: string }
interface PromptDocumentView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly draft: { readonly revision: number; readonly kind: PromptKind; readonly role: PromptRole; readonly content: string }
  readonly publishedDraftRevision?: number
  readonly versionIds: readonly string[]
}
interface PromptVersionView {
  readonly id: string
  readonly documentId: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
  readonly createdAt: string
}
interface PromptSnapshotView {
  readonly versionId: string
  readonly documentId: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
}

const kindLabels: Record<PromptKind, string> = {
  'agent-instruction': 'Agent 指令', 'task-template': '任务模板', context: '上下文',
}
const rolesByKind: Record<PromptKind, readonly PromptRole[]> = {
  'agent-instruction': ['system', 'developer'], 'task-template': ['user'], context: ['user', 'developer'],
}

export function setupPromptSettings(
  source: Api, messageFor: (error: unknown) => string, container: HTMLElement, viewKey?: string,
) {
  const owned = createPageRequests(source), api = owned.api
  let disposed = false
  const lifetime = new AbortController()
  const element = <T extends HTMLElement>(id: string): T => {
    const found = container.querySelector<HTMLElement>(`#${id}`)
    if (!found) throw new Error(`missing element ${id}`)
    return found as T
  }
  const create = element<HTMLButtonElement>('agent--new-prompt')
  const list = element<HTMLElement>('agent--prompt-list')
  const empty = element<HTMLElement>('agent--prompt-empty')
  const agent = element<HTMLSelectElement>('agent--prompt-agent')
  const editCurrent = element<HTMLButtonElement>('agent--edit-agent-prompt')
  const bindingsView = element<HTMLElement>('agent--prompt-bindings')
  const form = element<HTMLFormElement>('agent--prompt-form')
  const name = element<HTMLInputElement>('agent--prompt-name')
  const description = element<HTMLInputElement>('agent--prompt-description')
  const kind = element<HTMLSelectElement>('agent--prompt-kind')
  const role = element<HTMLSelectElement>('agent--prompt-role')
  const content = element<HTMLTextAreaElement>('agent--prompt-content')
  const hint = element<HTMLElement>('agent--prompt-content-hint')
  const status = element<HTMLElement>('agent--prompt-draft-status')
  const notice = element<HTMLElement>('agent--prompt-notice')
  const save = element<HTMLButtonElement>('agent--save-prompt')
  const publish = element<HTMLButtonElement>('agent--publish-prompt')
  const discard = element<HTMLButtonElement>('agent--discard-prompt')
  const version = element<HTMLSelectElement>('agent--prompt-version')
  const versionStatus = element<HTMLElement>('agent--prompt-version-status')
  const versionContent = element<HTMLElement>('agent--prompt-version-content')
  const apply = element<HTMLButtonElement>('agent--apply-prompt')
  const viewStorage = { getItem: (key: string) => sessionStorage.getItem(key), setItem: (key: string, value: string) => sessionStorage.setItem(key, value) }
  const remembered = viewKey ? readPromptViewState(viewStorage, viewKey) : undefined
  const scrollContainer = container
  let documents: readonly PromptDocumentView[] = []
  let selected: PromptDocumentView | undefined
  let versions: readonly PromptVersionView[] = []
  let bindings: readonly PromptSnapshotView[] = []
  let baseline = ''
  let busy = false
  let ready = false
  const rememberView = () => {
    if (!viewKey || !ready) return
    rememberPromptViewState(viewStorage, viewKey, { documentId: selected?.id, agentId: agent.value || undefined,
      versionId: version.value || undefined, scroll: scrollContainer.scrollTop })
  }

  const fields = (): DraftFields => ({ name: name.value, description: description.value,
    kind: kind.value as PromptKind, role: role.value as PromptRole, content: content.value })
  const dirty = () => JSON.stringify(fields()) !== baseline
  const showNotice = (text = '', error = false) => {
    notice.textContent = text
    notice.hidden = !text
    notice.dataset.error = String(error)
  }
  const option = (value: string, label: string) => {
    const item = document.createElement('option')
    item.value = value
    item.textContent = label
    return item
  }
  const updateRoles = (preferred = role.value) => {
    const roles = rolesByKind[kind.value as PromptKind]
    role.replaceChildren(...roles.map(value => option(value, value)))
    if (roles.includes(preferred as PromptRole)) role.value = preferred
    hint.textContent = kind.value === 'task-template'
      ? '任务模板必须包含且只包含一个 {{input}}，运行时替换为用户消息。'
      : '消息角色需与所用模型兼容；当前默认 DeepSeek 不支持 developer。'
  }
  const updateControls = () => {
    const blocked = busy || !ready
    const changed = dirty()
    for (const input of [name, description, kind, role, content]) input.disabled = blocked
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.disabled = blocked
    create.disabled = blocked
    agent.disabled = blocked || !agent.options.length
    editCurrent.disabled = blocked || !bindings.some(item => item.kind === 'agent-instruction')
    save.disabled = blocked || (Boolean(selected) && !changed)
    publish.disabled = blocked || !selected || changed || selected.publishedDraftRevision === selected.draft.revision
    discard.disabled = blocked
    version.disabled = blocked || !versions.length
    apply.disabled = blocked || changed || !version.value || !agent.value || bindings.some(item => item.versionId === version.value)
    status.textContent = `${selected ? `修订 ${selected.draft.revision}` : '新建草稿'}${changed ? ' · 未保存' : selected ? ' · 已保存' : ''}`
  }
  const renderLibrary = () => {
    list.replaceChildren(...documents.map(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.promptId = item.id
      button.className = selected?.id === item.id ? 'selected' : ''
      button.setAttribute('aria-current', String(selected?.id === item.id))
      button.textContent = item.name
      const detail = document.createElement('small')
      detail.textContent = `${kindLabels[item.draft.kind]} · ${item.versionIds.length ? `${item.versionIds.length} 个版本` : '未发布'}`
      button.append(detail)
      return button
    }))
    empty.hidden = documents.length > 0
  }
  const renderBindings = () => {
    bindingsView.replaceChildren(...bindings.map(item => {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      const source = documents.find(document => document.id === item.documentId)
      const ordinal = source ? source.versionIds.indexOf(item.versionId) + 1 : 0
      summary.textContent = `${kindLabels[item.kind]} · ${source ? `${source.name} · v${ordinal}` : item.versionId.startsWith('builtin:') ? '内置默认' : '已绑定版本'}`
      const preview = document.createElement('pre')
      preview.className = 'prompt-preview'
      preview.textContent = item.content
      details.append(summary, preview)
      return details
    }))
  }
  const renderVersion = () => {
    const chosen = versions.find(item => item.id === version.value)
    versionContent.hidden = !chosen
    versionContent.textContent = chosen?.content ?? ''
    versionStatus.textContent = chosen
      ? `${kindLabels[chosen.kind]} · ${chosen.role} · ${new Date(chosen.createdAt).toLocaleString()}${bindings.some(item => item.versionId === chosen.id) ? ' · 当前 Agent 已应用' : ''}`
      : '保存并发布后，可以在这里应用版本。'
    updateControls()
  }
  const setFields = (value: DraftFields) => {
    name.value = value.name
    description.value = value.description
    kind.value = value.kind
    updateRoles(value.role)
    content.value = value.content
  }
  const newDraft = (initial?: DraftFields) => {
    selected = undefined
    versions = []
    version.replaceChildren()
    setFields({ name: '', description: '', kind: 'agent-instruction', role: 'system', content: '' })
    baseline = JSON.stringify(fields())
    if (initial) setFields(initial)
    renderLibrary()
    renderVersion()
    rememberView()
  }
  const loadDocument = async (id: string) => {
    const [document, published] = await Promise.all([
      api<PromptDocumentView>(`/prompts/${encodeURIComponent(id)}`),
      api<readonly PromptVersionView[]>(`/prompts/${encodeURIComponent(id)}/versions`),
    ])
    selected = document
    documents = documents.some(item => item.id === id)
      ? documents.map(item => item.id === id ? document : item) : [...documents, document]
    setFields({ name: document.name, description: document.description, ...document.draft })
    baseline = JSON.stringify(fields())
    versions = published
    version.replaceChildren(...[...published].reverse().map((item, index) =>
      option(item.id, `v${published.length - index} · ${kindLabels[item.kind]}`)))
    renderLibrary()
    renderBindings()
    renderVersion()
    rememberView()
  }
  const loadBindings = async () => {
    bindings = []
    renderBindings()
    renderVersion()
    bindings = agent.value ? await api<readonly PromptSnapshotView[]>(`/agents/${encodeURIComponent(agent.value)}/prompts`) : []
    renderBindings()
    renderVersion()
  }
  const perform = async (work: () => Promise<void>) => {
    if (busy || disposed) return
    busy = true
    showNotice()
    updateControls()
    try { await work() }
    catch (error) { if (!disposed) showNotice(messageFor(error), true) }
    finally { busy = false; if (!disposed) updateControls() }
  }
  const canLeaveDraft = () => {
    if (owned.writing) return false
    if (!dirty()) return true
    showNotice('有尚未保存的修改。请先保存草稿，或点击“放弃修改 / 重新读取”。', true)
    return false
  }

  newDraft()
  const load = () => {
    void perform(async () => {
      const [library, agents] = await Promise.all([
        api<readonly PromptDocumentView[]>('/prompts'), api<readonly { readonly id: string }[]>('/agents'),
      ])
      documents = library
      const preferred = agent.value || remembered?.agentId || ''
      agent.replaceChildren(...agents.map(item => option(item.id, item.id)))
      if (agents.some(item => item.id === preferred)) agent.value = preferred
      renderLibrary()
      const documentId = selected?.id ?? remembered?.documentId
      if (documentId && documents.some(item => item.id === documentId)) {
        await loadDocument(documentId)
        if (!ready && remembered?.versionId && versions.some(item => item.id === remembered.versionId)) { version.value = remembered.versionId; renderVersion() }
      }
      else newDraft()
      await loadBindings()
      ready = true
      if (remembered) scrollContainer.scrollTop = remembered.scroll
      rememberView()
    })
  }
  load()
  create.addEventListener('click', () => {
    if (!canLeaveDraft()) return
    showNotice()
    newDraft()
    name.focus()
  })
  list.addEventListener('click', event => {
    const id = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-prompt-id]')?.dataset.promptId
    if (id && id !== selected?.id && canLeaveDraft()) void perform(() => loadDocument(id))
  })
  agent.addEventListener('change', () => { rememberView(); void perform(loadBindings) })
  editCurrent.addEventListener('click', () => {
    if (!canLeaveDraft()) return
    const instruction = bindings.find(item => item.kind === 'agent-instruction')
    if (!instruction) return
    if (documents.some(item => item.id === instruction.documentId)) {
      void perform(() => loadDocument(instruction.documentId))
    } else {
      showNotice('已从当前指令创建草稿。编辑后保存、发布并应用，即可替换当前指令。')
      newDraft({ name: `${agent.value} 指令`, description: '', kind: instruction.kind,
        role: instruction.role, content: instruction.content })
    }
  })
  kind.addEventListener('change', () => { updateRoles(); updateControls() })
  form.addEventListener('input', updateControls)
  form.addEventListener('change', updateControls)
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!form.reportValidity() || busy || !ready) return
    const input = fields()
    if (!input.name.trim() || !input.content.trim()) { showNotice('名称和内容不能为空。', true); return }
    if (input.kind === 'task-template' && input.content.split('{{input}}').length !== 2) {
      showNotice('任务模板必须包含且只包含一个 {{input}}。', true)
      return
    }
    void perform(async () => {
      const saved = await api<PromptDocumentView>(selected ? `/prompts/${encodeURIComponent(selected.id)}` : '/prompts',
        { ...input, ...(selected ? { expectedRevision: selected.draft.revision } : {}) })
      // Keep the committed identity even if the follow-up read fails.
      selected = saved
      setFields({ name: saved.name, description: saved.description, ...saved.draft })
      baseline = JSON.stringify(fields())
      await loadDocument(saved.id)
      showNotice('草稿已保存。发布版本并应用到 Agent 后，后续运行才会使用新内容。')
    })
  })
  publish.addEventListener('click', () => {
    if (!selected || dirty() || publish.disabled) return
    const document = selected
    void perform(async () => {
      await api(`/prompts/${encodeURIComponent(document.id)}/publish`, { expectedRevision: document.draft.revision })
      await loadDocument(document.id)
      showNotice('版本已发布。点击“应用到 Agent”后生效。')
    })
  })
  discard.addEventListener('click', () => {
    void perform(async () => {
      documents = await api<readonly PromptDocumentView[]>('/prompts')
      if (selected) await loadDocument(selected.id)
      else newDraft()
      await loadBindings()
      showNotice('已重新读取，未保存的修改已放弃。')
    })
  })
  version.addEventListener('change', () => { renderVersion(); rememberView() })
  scrollContainer.addEventListener('scroll', rememberView, { signal: lifetime.signal, passive: true })
  apply.addEventListener('click', () => {
    if (apply.disabled) return
    const agentId = agent.value
    const versionId = version.value
    void perform(async () => {
      await api(`/agents/${encodeURIComponent(agentId)}/prompts`, { versionId })
      await loadBindings()
      showNotice(`已应用到 ${agentId}。所有项目中该 Agent 的后续运行使用此版本，正在进行的运行保持原内容。`)
    })
  })
  return { canLeave: canLeaveDraft, async dispose() { rememberView(); disposed = true; lifetime.abort(); await owned.dispose() } }
}

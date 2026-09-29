import type { ConnectionModel, DeclaredCapabilities, DiscoveredModel, FormField, NativeObject, JsonValue, Model, ModelInput, ModelConfiguration, ModelConfigurationInput, RunnableModelSummary, ProtocolDescriptor, ProviderConnectionInput, ProviderTemplate, ProviderConnection, Support } from '@anybox/models'
import type { Api } from './client-types.js'
import type { DirectoryModel, DirectoryProvider } from './client-types.js'
import { setupModelsDirectory, sourceLabel, connectionModelAvailability } from './models-directory-client.js'

export interface ModelsCatalog {
  snapshot(): { readonly models: readonly RunnableModelSummary[]; readonly providers: readonly ProviderConnection[]; readonly loading: boolean; readonly error?: string }
  refresh(): Promise<void>
  subscribe(listener: () => void): () => void
}

/** Shared by settings and all panes. A refresh never changes a session's selection. */
export function createModelsCatalog(api: Api, messageFor: (error: unknown) => string): ModelsCatalog {
  let models: readonly RunnableModelSummary[] = [], providers: readonly ProviderConnection[] = [], loading = true, error: string | undefined
  let revision = 0
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    snapshot: () => ({ models, providers, loading, error }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async refresh() {
      const read = ++revision
      loading = true; emit()
      try {
        const [nextModels, nextProviders] = await Promise.all([
          api<readonly RunnableModelSummary[]>('/models'), api<readonly ProviderConnection[]>('/models/connections'),
        ])
        if (read !== revision) return
        models = nextModels; providers = nextProviders; error = undefined
      } catch (cause) { if (read === revision) error = messageFor(cause) }
      if (read === revision) { loading = false; emit() }
    },
  }
}

/** Blank optional values remain omitted, including protocol-specific settings. */
export function nativeParameterValues(fields: readonly FormField[], values: Readonly<Record<string, string>>): NativeObject {
  const parameters: Record<string, JsonValue> = {}
  for (const field of fields) {
    const raw = values[field.key] ?? ''
    if (raw === '') { if (field.required) throw new Error(`${field.label} 必须填写。`); continue }
    let value: JsonValue = raw
    if (field.type === 'enum' || field.type === 'boolean') {
      try { value = JSON.parse(raw) as JsonValue } catch { throw new Error(`${field.label} 选项无效。`) }
      if (field.type === 'enum' && !field.values?.some(item => item === value)) throw new Error(`${field.label} 选项无效。`)
      if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${field.label} 选项无效。`)
    } else if (field.type === 'number') {
      value = Number(raw)
      if (!Number.isFinite(value) || (field.integer && !Number.isSafeInteger(value)) ||
          (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error(`${field.label} 超出允许范围。`)
    }
    const parts = field.key.split('.')
    if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('无效的参数路径。')
    let target = parameters
    for (const part of parts.slice(0, -1)) {
      const existing = target[part]
      if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) throw new Error('参数路径冲突。')
      target = (target[part] ??= {}) as Record<string, JsonValue>
    }
    target[parts.at(-1)!] = value
  }
  return parameters
}

export function modelAvailability(model: RunnableModelSummary): string {
  if (model.available && model.effectiveCapabilities?.tools) return '可用于 Agent · 支持工具'
  if (model.available) return '可用于 Agent · 仅文本调用'
  return { disabled: '模型已停用', 'provider-disabled': '提供方已停用', 'protocol-unavailable': '协议未安装',
    'credential-missing': '尚未配置 Key', 'invalid-configuration': '配置无效' }[model.unavailableReason ?? 'invalid-configuration']
}
export function canUseModel(model: RunnableModelSummary | undefined): boolean { return Boolean(model?.available) }

/** A remembered account stays selected even when it needs attention; first use prefers a ready one. */
export function settingsConnectionSelection(connections: readonly ProviderConnection[], models: readonly RunnableModelSummary[], preferredId?: string): ProviderConnection | undefined {
  return connections.find(value => value.id === preferredId) ??
    connections.find(value => value.enabled && models.some(model => model.connectionId === value.id && model.available)) ??
    connections.find(value => value.enabled && (value.auth === 'none' || value.credentialConfigured)) ?? connections[0]
}

export interface SettingsModelEditorState {
  readonly connectionId: string
  readonly target: { readonly kind: 'configuration'; readonly id: string } | { readonly kind: 'draft' }
  readonly visible: boolean
  readonly expanded: boolean
}

/** A new draft remains an editing target even while its editor is collapsed. */
export function settingsModelEditorSelection(configurations: readonly Pick<ModelConfiguration, 'id' | 'connectionId'>[], connectionId: string, remembered?: SettingsModelEditorState, hasDraft = false): SettingsModelEditorState | undefined {
  const own = configurations.filter(value => value.connectionId === connectionId)
  const rememberedId = remembered?.target.kind === 'configuration' ? remembered.target.id : undefined
  if (remembered?.connectionId === connectionId && (remembered.target.kind === 'draft' ? hasDraft : own.some(value => value.id === rememberedId))) return remembered
  if (hasDraft) return { connectionId, target: { kind: 'draft' }, visible: true, expanded: true }
  return own[0] ? { connectionId, target: { kind: 'configuration', id: own[0].id }, visible: false, expanded: false } : undefined
}

const supportChoices: readonly [Support, string][] = [['unknown', '未知'], ['supported', '支持'], ['unsupported', '不支持']]
const unknownCapabilities = (): DeclaredCapabilities => ({ tools: { support: 'unknown' }, streaming: { support: 'unknown' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } })
function option(value: string, text: string): HTMLOptionElement {
  const item = document.createElement('option'); item.value = value; item.textContent = text; return item
}
function fieldValue(defaults: NativeObject, key: string): JsonValue | undefined {
  let value: JsonValue | undefined = defaults
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as NativeObject)[part]
  }
  return value
}

/** Only a new configuration receives descriptor defaults; saved omissions stay omitted. */
export function initialNativeParameters(fields: readonly FormField[], candidate?: Pick<DirectoryModel, 'limits'>): NativeObject {
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.defaultValue === undefined) continue
    let value = field.defaultValue
    if (['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'generation_config.max_output_tokens'].includes(field.key) && typeof value === 'number' && candidate?.limits.output !== undefined) value = Math.min(value, candidate.limits.output)
    values[field.key] = field.type === 'enum' || field.type === 'boolean' ? JSON.stringify(value) : String(value)
  }
  // Required fields with no prefill are left for the user to enter in the form.
  return nativeParameterValues(fields.map(field => ({ ...field, required: false })), values)
}

export function setupModelsSettings(api: Api, messageFor: (error: unknown) => string, catalog: ModelsCatalog) {
  const root = document.getElementById('models-settings')!
  root.innerHTML = `
    <header class="settings-panel-heading models-heading"><div><h3 id="models-settings-title">模型服务</h3><p>配置一个提供方连接，即可在会话中使用它的模型。</p></div><div class="settings-actions"><button type="button" class="secondary-button" data-reload>刷新状态</button><button type="button" data-add-provider>添加提供方</button></div></header>
    <p class="models-notice" role="status" aria-live="polite" hidden></p>
    <fieldset class="models-controls">
      <div class="models-layout" data-management>
        <aside class="settings-card models-connections" aria-label="已配置连接"><div class="models-card-heading"><h4>我的连接</h4><p data-connections-count></p></div><div class="models-connection-list" data-connections></div></aside>
        <div class="models-main">
          <header class="models-detail-heading"><div><h4 data-connection-title></h4><p data-connection-subtitle class="settings-hint"></p></div><div class="settings-actions"><span data-connection-status class="models-status-badge"></span><button type="button" data-delete-connection class="secondary-button models-danger-button" hidden>删除连接</button></div></header>
          <section class="settings-card models-delete-confirm" data-delete-connection-confirm aria-labelledby="models-delete-connection-title" hidden><h4 id="models-delete-connection-title">删除此连接？</h4><p data-delete-connection-description></p><p class="settings-hint">历史对话和已开始的运行会保留。依赖此连接的原生历史可能无法继续；其他协议需新建会话。</p><div class="settings-actions"><button type="button" data-confirm-delete-connection class="models-danger-button">确认删除连接</button><button type="button" data-cancel-delete-connection class="secondary-button">取消</button></div></section>
          <details class="settings-card models-connection-editor" data-connection-editor><summary><span>连接设置</span><span data-connection-summary class="settings-hint"></span></summary><div data-manage-form-slot></div></details>
          <section class="settings-card models-model-section" aria-labelledby="models-config-title">
            <div class="models-card-heading"><div><h4 id="models-config-title">模型列表</h4><p data-model-count class="models-model-count" role="status"></p></div><button type="button" data-new-model class="secondary-button">添加自定义模型</button></div>
            <div class="models-model-toolbar"><label>搜索模型<input type="search" data-model-search placeholder="名称或模型 ID"></label><label>可用状态<select data-model-filter><option value="all">全部模型</option><option value="available">可用模型</option><option value="unavailable">不可用模型</option></select></label></div>
            <p data-inventory-status class="settings-hint" role="status"></p><ul data-connection-models class="models-model-list"></ul>
            <details data-model-advanced class="models-model-editor" hidden><summary data-model-editor-title>模型参数</summary>
              <p data-model-status class="settings-hint" role="status"></p><div class="settings-actions"><button type="button" data-new-variant class="secondary-button">另存为参数预设</button><button type="button" data-model-history class="secondary-button">配置版本</button></div>
              <form data-model-form>
                <div class="models-grid"><label>显示名称<input data-model-name required maxlength="200" placeholder="例如：深入分析"></label><label>远端模型标识<input data-remote-id required placeholder="提供方要求的 model ID"></label></div>
                <label class="models-check"><input data-model-enabled type="checkbox" checked>启用此模型</label>
                <fieldset class="models-parameters"><legend>生成参数</legend><p class="settings-hint">留空使用服务端默认值。</p><div class="models-grid" data-parameters></div><label data-server-search-label class="models-check" hidden><input type="checkbox" data-server-search>启用服务端网络搜索</label><p data-server-search-hint class="settings-hint" hidden>先在模型能力中明确声明支持网络搜索，再启用此功能。</p></fieldset>
                <details class="models-capabilities"><summary>模型能力与推理声明</summary><p class="settings-hint">未知能力不会被认定为支持。工具能力未知时仅进行文本调用。</p><div class="models-grid" data-capabilities></div><label>推理档位（可选，逗号分隔）<input data-efforts placeholder="例如：low, medium, high"></label><label>推理模式（可选，逗号分隔）<input data-modes></label><div class="models-grid"><label>最小推理预算<input data-budget-min type="number" min="0" step="1"></label><label>最大推理预算<input data-budget-max type="number" min="0" step="1"></label></div></details>
                <div class="settings-actions"><button type="submit" data-save-model>保存参数</button><button type="button" data-reset-model class="secondary-button">放弃修改</button><button type="button" data-close-model class="secondary-button">收起</button></div>
              </form>
            </details>
            <details class="models-remote-models"><summary>获取远端模型列表</summary><p class="settings-hint">目录中没有所需模型时，可从当前连接获取候选，再确认能力与参数。</p><button type="button" data-discover class="secondary-button">获取模型</button><label data-candidates-label hidden>远端候选<select data-candidates></select></label></details>
          </section>
        </div>
      </div>
      <section class="settings-card" data-add-flow hidden>
        <header class="models-flow-heading"><div><h4>添加提供方连接</h4><p>选择提供方，填写 Key；保存后自动准备适用模型。</p></div><div class="settings-actions"><button type="button" data-custom-provider class="secondary-button">自定义连接</button><button type="button" data-cancel-add class="secondary-button">返回我的连接</button></div></header>
        <ol class="models-flow-steps"><li>选择提供方</li><li>配置连接和 API Key</li><li>使用模型</li></ol>
        <div class="models-add-flow"><section class="models-directory" aria-label="选择提供方"></section><div data-add-form-slot><p data-provider-placeholder class="settings-hint">先选择提供方，连接信息会自动填写；也可点击“自定义连接”手动配置。</p></div></div>
      </section>
    </fieldset>
    <section data-provider-section class="models-provider-section" hidden>
      <div class="models-card-heading"><h4 data-provider-form-title>配置连接</h4><p data-provider-origin class="settings-hint"></p></div>
      <form data-provider-form autocomplete="off">
        <label>连接名称<input data-provider-name required maxlength="200" placeholder="例如：OpenAI 工作账号"></label>
        <div class="models-grid"><label>API 协议<select data-protocol required></select></label><label>API 地址<input data-base-url required type="url" placeholder="https://api.example.com/v1"></label></div>
        <div class="models-key"><label>API Key<input data-api-key type="password" autocomplete="new-password" placeholder="填写 API Key"></label><p data-key-status class="settings-hint"></p><button type="button" data-delete-key class="secondary-button" hidden>删除 Key</button><div data-delete-confirm hidden><p>删除后，此连接的模型将无法开始新运行。</p><div class="settings-actions"><button type="button" data-confirm-delete-key>确认删除</button><button type="button" data-cancel-delete-key class="secondary-button">取消</button></div></div></div>
        <details><summary>高级连接设置</summary><label data-template-label>使用连接模板<select data-template></select></label><div class="models-grid"><label>认证方式<select data-auth><option value="api-key">API Key</option><option value="none">无需认证</option></select></label><label>请求超时（毫秒）<input data-timeout type="number" min="1" step="1" value="120000" required></label></div><label class="models-check"><input data-provider-enabled type="checkbox" checked>启用此连接</label><div class="settings-actions"><button type="button" data-check class="secondary-button">检查已保存连接</button><button type="button" data-provider-history class="secondary-button">连接版本</button></div></details>
        <p data-provider-draft class="models-draft-status" role="status"></p><div class="settings-actions"><button type="submit" data-save-provider>保存连接</button><button type="button" data-reset-provider class="secondary-button">放弃修改</button></div>
        <p data-sync-status class="settings-hint" role="status"></p><button type="button" data-retry-sync class="secondary-button" hidden>重试准备模型</button>
        <p class="settings-hint">API Key 保存在系统凭据库中，读取时仅显示配置状态。修改仅影响后续运行。</p>
      </form>
    </section>
    <details class="models-history" hidden><summary>配置版本历史</summary><ol></ol></details>`
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const input = (name: string) => get<HTMLInputElement>(`[data-${name}]`)
  const select = (name: string) => get<HTMLSelectElement>(`[data-${name}]`)
  const protocolSelect = select('protocol'), key = input('api-key'), controls = get<HTMLFieldSetElement>('.models-controls')
  const notice = get<HTMLElement>('.models-notice'), providerSection = get('[data-provider-section]')
  const providerForm = get<HTMLFormElement>('[data-provider-form]'), modelEditor = get<HTMLDetailsElement>('[data-model-advanced]')
  const connectionEditor = get<HTMLDetailsElement>('[data-connection-editor]'), history = get<HTMLDetailsElement>('.models-history')
  let protocols: readonly ProtocolDescriptor[] = [], templates: readonly ProviderTemplate[] = []
  let providers: readonly ProviderConnection[] = [], records: readonly ModelConfiguration[] = [], candidates: readonly DiscoveredModel[] = []
  let definitions: readonly DirectoryProvider[] = [], inventory: readonly ConnectionModel[] = []
  let inventoryRead = 0, reloadRead = 0, selectionRead = 0, secretRevision = 0, inventoryLoading = false, inventoryError = ''
  let provider: ProviderConnection | undefined, model: ModelConfiguration | undefined, busy = false, loaded = false
  let mode: 'manage' | 'add' = 'manage', returnConnectionId: string | undefined, customConnection = false
  let providerDefinitionId = '', configurationDefinitionId = '', variantDefaults: NativeObject | undefined, variantCapabilities: DeclaredCapabilities | undefined
  let directory: ReturnType<typeof setupModelsDirectory> | undefined
  let preferredConnectionId: string | undefined
  try { preferredConnectionId = localStorage.getItem('anybox.models.connection') ?? undefined } catch { /* Browser storage may be unavailable. */ }
  let parameterFields: readonly FormField[] = [], draftKey = '', modelDraftKey = ''
  type Fields = Readonly<Record<string, string | boolean>>
  type Draft = { fields: Fields; baseFields: Fields; baseRevision?: number }
  const connectionDrafts = new Map<string, Draft>(), modelEditors = new Map<string, SettingsModelEditorState>()
  const modelDrafts = new Map<string, Draft & { definitionId: string; defaults?: NativeObject; capabilities?: DeclaredCapabilities }>()
  let connectionBaseFields: Fields = {}, modelBaseFields: Fields = {}, connectionBaseRevision: number | undefined, modelBaseRevision: number | undefined
  const show = (text = '', failed = false) => { notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', failed) }
  const errorText = (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'conflict') return '配置已被其他页面修改，当前草稿仍在表单中。请先复制保留，再点击“放弃修改”加载最新配置。'
    return error instanceof Error && !(error instanceof TypeError) && !('status' in error) ? error.message : messageFor(error)
  }
  const currentProtocol = () => protocols.find(item => item.id === protocolSelect.value)
  const connectionPath = (id = provider!.id) => `/models/connections/${encodeURIComponent(id)}`
  const modelPath = () => `/models/configurations/${encodeURIComponent(model!.id)}`
  const definition = () => definitions.find(value => value.id === providerDefinitionId)
  const connectionFields = ['provider-name', 'base-url', 'timeout', 'provider-enabled'] as const
  const modelFields = ['model-name', 'remote-id', 'model-enabled', 'efforts', 'modes', 'budget-min', 'budget-max', 'server-search'] as const
  function readFields(names: readonly string[]): Record<string, string | boolean> {
    return Object.fromEntries(names.map(name => [name, input(name).type === 'checkbox' ? input(name).checked : input(name).value]))
  }
  function writeFields(fields: Fields): void {
    for (const [name, value] of Object.entries(fields)) {
      const field = name.startsWith('parameter:') ? root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-parameter="${name.slice(10)}"]`) :
        name.startsWith('capability:') ? root.querySelector<HTMLSelectElement>(`[data-capability="${name.slice(11)}"]`) : input(name)
      if (!field) continue
      if (typeof value === 'boolean' && field instanceof HTMLInputElement) field.checked = value
      else field.value = String(value)
    }
  }
  function captureConnection(): void {
    if (!draftKey || !loaded) return
    const fields = readConnectionFields()
    if (provider && JSON.stringify(fields) === JSON.stringify(connectionBaseFields)) connectionDrafts.delete(draftKey)
    else connectionDrafts.set(draftKey, { fields, baseFields: connectionBaseFields, baseRevision: connectionBaseRevision })
  }
  function readConnectionFields(): Fields {
    return { ...readFields(connectionFields), protocol: protocolSelect.value, auth: select('auth').value, template: select('template').value }
  }
  function readModelFields(): Record<string, string | boolean> {
    const fields = readFields(modelFields)
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-parameter]')) fields[`parameter:${field.dataset.parameter}`] = field.value
    for (const field of root.querySelectorAll<HTMLSelectElement>('[data-capability]')) fields[`capability:${field.dataset.capability}`] = field.value
    return fields
  }
  function captureModel(): void {
    if (provider && modelDraftKey) modelEditors.set(provider.id, { connectionId: provider.id,
      target: model ? { kind: 'configuration', id: model.id } : { kind: 'draft' }, visible: !modelEditor.hidden, expanded: modelEditor.open })
    if (!modelDraftKey || modelEditor.hidden) return
    const fields = readModelFields()
    if (model && JSON.stringify(fields) === JSON.stringify(modelBaseFields)) modelDrafts.delete(modelDraftKey)
    else modelDrafts.set(modelDraftKey, { fields, baseFields: modelBaseFields, baseRevision: modelBaseRevision, definitionId: configurationDefinitionId, defaults: variantDefaults, capabilities: variantCapabilities })
  }
  function connectionChanged(): boolean {
    return Boolean(provider && (key.value || JSON.stringify(readConnectionFields()) !== JSON.stringify(connectionBaseFields)))
  }
  function updateDraftStatus(): void {
    const changed = connectionChanged()
    get('[data-provider-draft]').textContent = changed ? provider?.revision !== connectionBaseRevision ? '有未保存的修改；已保存配置有更新，保存时将检查版本。' : '有未保存的修改' : ''
    get('[data-provider-draft]').hidden = !changed
  }
  for (const [name, label] of [['tools', '工具调用'], ['streaming', '流式输出'], ['imageInput', '图片输入'], ['reasoning', '推理'], ['webSearch', '服务端网络搜索']] as const) {
    const wrapper = document.createElement('label'), field = document.createElement('select')
    wrapper.textContent = label; field.dataset.capability = name
    field.append(...supportChoices.map(([value, text]) => option(value, text))); wrapper.append(field); get('[data-capabilities]').append(wrapper)
  }
  function renderParameters(defaults: NativeObject = {}): void {
    parameterFields = currentProtocol()?.modelFields ?? []
    input('server-search').checked = Array.isArray(defaults.tools) && defaults.tools.some(tool => Boolean(tool && typeof tool === 'object' && !Array.isArray(tool) && typeof tool.type === 'string' && tool.type.startsWith('web_search')))
    get('[data-parameters]').replaceChildren(...parameterFields.map(field => {
      const wrapper = document.createElement('label'); wrapper.textContent = field.label
      let control: HTMLInputElement | HTMLSelectElement
      if (field.type === 'enum' || field.type === 'boolean') {
        control = document.createElement('select'); control.append(option('', '使用服务端默认值'), ...(field.values ?? [true, false]).map(value => option(JSON.stringify(value), String(value))))
      } else {
        control = document.createElement('input'); control.type = field.type === 'number' ? 'number' : 'text'
        if (field.min !== undefined) control.min = String(field.min)
        if (field.max !== undefined) control.max = String(field.max)
        if (field.type === 'number') control.step = field.integer ? '1' : 'any'
        control.placeholder = '使用服务端默认值'
      }
      control.required = field.required ?? false; control.dataset.parameter = field.key
      const value = fieldValue(defaults, field.key)
      const savedValue = value === undefined ? '' : field.type === 'enum' || field.type === 'boolean' ? JSON.stringify(value) : String(value)
      if (control instanceof HTMLSelectElement && savedValue && ![...control.options].some(item => item.value === savedValue)) control.append(option(savedValue, `已保存：${String(value)}（需要修改）`))
      control.value = savedValue; if (field.description) control.title = field.description
      wrapper.append(control); return wrapper
    }))
  }
  function loadModel(value?: ModelConfiguration, candidate?: DiscoveredModel, restore = true): void {
    model = value; configurationDefinitionId = value?.modelDefinitionId ?? configurationDefinitionId
    if (value) variantDefaults = variantCapabilities = undefined
    modelDraftKey = value?.id ?? (provider ? `new:${provider.id}` : '')
    input('model-name').value = value?.name ?? candidate?.name ?? ''
    input('remote-id').value = value?.remoteModelId ?? candidate?.remoteModelId ?? ''
    input('remote-id').readOnly = Boolean(value || configurationDefinitionId)
    input('model-enabled').checked = value?.enabled ?? true
    const capabilities = value?.capabilities ?? variantCapabilities ?? { ...unknownCapabilities(), ...candidate?.suggestedCapabilities }
    for (const name of ['tools', 'streaming', 'imageInput', 'reasoning', 'webSearch'] as const) get<HTMLSelectElement>(`[data-capability="${name}"]`).value = capabilities[name]?.support ?? 'unknown'
    input('efforts').value = capabilities.reasoning.efforts?.join(', ') ?? ''; input('modes').value = capabilities.reasoning.modes?.join(', ') ?? ''
    input('budget-min').value = capabilities.reasoning.budget ? String(capabilities.reasoning.budget.min) : ''; input('budget-max').value = capabilities.reasoning.budget ? String(capabilities.reasoning.budget.max) : ''
    renderParameters(value?.parameters.value ?? variantDefaults ?? initialNativeParameters(currentProtocol()?.modelFields ?? []))
    modelBaseFields = readModelFields(); modelBaseRevision = value?.revision
    const draft = restore ? modelDrafts.get(modelDraftKey) : undefined
    if (draft) { configurationDefinitionId = draft.definitionId; variantDefaults = draft.defaults; variantCapabilities = draft.capabilities; modelBaseFields = draft.baseFields; modelBaseRevision = draft.baseRevision; writeFields(draft.fields); input('remote-id').readOnly = Boolean(value || configurationDefinitionId) }
    get('[data-model-editor-title]').textContent = value ? `模型参数 · ${value.name}` : variantDefaults ? '新增参数预设' : '添加自定义模型'
    renderState()
  }
  function badge(text: string, tone: string): HTMLSpanElement {
    const span = document.createElement('span'); span.className = 'models-status-badge'; span.dataset.tone = tone; span.textContent = text; return span
  }
  function connectionStatus(value: ProviderConnection): [string, string] {
    if (!value.enabled) return ['已停用', 'muted']
    if (!protocols.some(item => item.id === value.protocolId)) return ['协议未安装', 'error']
    if (value.auth === 'api-key' && !value.credentialConfigured) return ['待填写 Key', 'pending']
    if (value.sync?.state === 'failed') return ['模型准备失败', 'error']
    if (value.sync?.state === 'pending') return ['等待准备', 'pending']
    return ['已配置', 'ready']
  }
  function renderConnections(): void {
    get('[data-connections-count]').textContent = `${providers.length} 个账号连接`
    get('[data-connections]').replaceChildren(...providers.map(value => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'models-connection-item'
      button.setAttribute('aria-current', String(value.id === provider?.id)); button.disabled = busy
      const title = document.createElement('strong'); title.textContent = value.name
      const meta = document.createElement('span'); meta.className = 'models-connection-meta'
      meta.textContent = definitions.find(item => item.id === value.providerDefinitionId)?.name ?? '自定义提供方'
      const [label, tone] = connectionStatus(value); button.append(title, meta, badge(label, tone))
      button.addEventListener('click', () => { if (!busy) { show(); captureConnection(); captureModel(); loadProvider(value) } })
      return button
    }))
  }
  function renderModels(): void {
    const summaries = catalog.snapshot().models
    const configured = records.filter(value => value.connectionId === provider?.id)
    type ModelRow = { name: string; remoteId: string; configuration?: ModelConfiguration; definition?: ConnectionModel; source?: Model['source']; available: boolean; reason: string }
    const rows: ModelRow[] = configured.map(configuration => {
      const found = inventory.find(value => value.id === configuration.modelDefinitionId), summary = summaries.find(value => value.id === configuration.id)
      return { name: configuration.name, remoteId: configuration.remoteModelId, configuration, definition: found, source: summary?.source ?? found?.source,
        available: summary?.available ?? false, reason: summary ? modelAvailability(summary) : '正在读取状态' }
    })
    for (const value of inventory) if (!configured.some(item => item.modelDefinitionId === value.id)) rows.push({ name: value.name, remoteId: value.remoteModelId, definition: value, source: value.source, available: Boolean(value.available), reason: connectionModelAvailability(value) })
    rows.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, 'zh-CN'))
    const available = rows.filter(value => value.available).length
    get('[data-model-count]').textContent = `${available} 个可用 · ${rows.length} 个模型${configured.some(value => !value.baseline) ? '（含参数预设）' : ''}`
    const search = input('model-search').value.trim().toLowerCase(), filter = select('model-filter').value
    const visible = rows.filter(value => `${value.name} ${value.remoteId}`.toLowerCase().includes(search) && (filter === 'all' || value.available === (filter === 'available')))
    get('[data-inventory-status]').textContent = inventoryError || (inventoryLoading ? '正在读取此连接的模型…' : search || filter !== 'all' ? `显示 ${visible.length} / ${rows.length} 个模型` : '可用模型已加入会话选择器；远端权限以实际请求为准。')
    const list = get('[data-connection-models]')
    list.replaceChildren(...visible.map(value => {
      const row = document.createElement('li'); row.className = 'models-model-row'
      const main = document.createElement('div'), name = document.createElement('strong'), id = document.createElement('span'), meta = document.createElement('span')
      name.className = 'models-model-name'; name.textContent = value.name
      id.className = 'models-model-id'; id.textContent = value.remoteId
      meta.className = 'models-model-meta'; meta.textContent = value.source ? sourceLabel(value.source) : '正在读取来源'
      if (value.configuration && !value.configuration.baseline) meta.textContent += ' · 参数预设'
      main.append(name, id, meta); row.append(main, badge(value.available ? '可用' : value.reason, value.available ? 'ready' : 'muted'))
      if (value.configuration) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '参数设置'
        button.setAttribute('aria-label', `设置 ${value.name} 的参数`); button.disabled = busy || !currentProtocol()
        if (model?.id === value.configuration.id && !modelEditor.hidden) row.setAttribute('aria-current', 'true')
        button.addEventListener('click', () => { if (!busy) { captureModel(); loadModel(value.configuration); modelEditor.hidden = false; modelEditor.open = true; renderState(); modelEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } })
        row.append(button)
      }
      return row
    }))
    if (!visible.length) {
      const empty = document.createElement('li'); empty.className = 'models-list-empty'
      empty.textContent = inventoryLoading ? '正在读取模型…' : rows.length ? '没有匹配的模型，请调整搜索或筛选条件。' : '暂时没有模型。可配置 Key 后重试，或添加自定义模型。'; list.append(empty)
    }
  }
  function renderState(): void {
    controls.disabled = busy || !loaded
    get<HTMLButtonElement>('[data-reload]').disabled = busy; get<HTMLButtonElement>('[data-add-provider]').disabled = busy || !loaded || mode === 'add'
    get('[data-management]').hidden = mode !== 'manage'; get('[data-add-flow]').hidden = mode !== 'add'
    const slot = get(mode === 'add' ? '[data-add-form-slot]' : '[data-manage-form-slot]')
    if (providerSection.parentElement !== slot) slot.append(providerSection)
    const waitingForProvider = mode === 'add' && !providerDefinitionId && !customConnection
    providerSection.hidden = waitingForProvider
    get('[data-provider-placeholder]').hidden = !waitingForProvider
    get<HTMLButtonElement>('[data-cancel-add]').hidden = !providers.length
    get('[data-provider-form-title]').textContent = mode === 'add' ? '配置连接和 API Key' : '编辑连接'
    get('[data-template-label]').hidden = Boolean(provider)
    protocolSelect.disabled = Boolean(provider)
    get('[data-provider-origin]').textContent = definition() ? `${definition()!.name} · 来源：${sourceLabel(definition()!.source)}` : '自定义提供方'
    get('[data-connection-title]').textContent = provider?.name ?? '选择连接'
    get('[data-connection-subtitle]').textContent = definition() ? `${definition()!.name} · ${sourceLabel(definition()!.source)}` : ''
    const [statusLabel, statusTone] = provider ? connectionStatus(provider) : ['未配置', 'pending']
    get('[data-connection-status]').textContent = statusLabel; get('[data-connection-status]').dataset.tone = statusTone
    get('[data-delete-connection]').hidden = !provider
    get('[data-delete-connection-description]').textContent = provider ? `将删除“${provider.name}”的连接、API Key 和 ${records.filter(value => value.connectionId === provider!.id).length} 个模型配置（含参数预设）。` : ''
    get('[data-connection-summary]').textContent = provider ? `${protocols.find(value => value.id === provider!.protocolId)?.name ?? provider.protocolId} · ${provider.credentialConfigured ? 'Key 已配置' : provider.auth === 'none' ? '无需认证' : 'Key 未配置'}` : ''
    const sync = provider?.sync
    get('[data-sync-status]').textContent = sync?.state === 'failed' ? '连接和 Key 已保存，模型准备失败。可重试，无需重新填写 Key。' : sync?.state === 'pending' ? '模型尚未准备；请确认连接已启用、协议已安装并配置 Key。' : ''
    get<HTMLButtonElement>('[data-retry-sync]').hidden = !provider || sync?.state !== 'failed' && !(sync?.state === 'pending' && (provider.credentialConfigured || provider.auth === 'none'))
    key.disabled = select('auth').value === 'none'; get('.models-key').hidden = select('auth').value === 'none' && !provider?.credentialConfigured
    key.placeholder = provider?.credentialConfigured ? '留空保留现有 Key；填写新 Key 可替换' : '填写 API Key'
    get('[data-key-status]').textContent = provider?.credentialConfigured ? 'Key 已配置。填写新 Key 后，随连接一起保存。' : '填写并保存后，适用模型会自动加入会话选择器。'
    get<HTMLButtonElement>('[data-delete-key]').hidden = !provider?.credentialConfigured
    get<HTMLButtonElement>('[data-check]').disabled = !provider || !currentProtocol()?.supportsCheck
    get<HTMLButtonElement>('[data-provider-history]').disabled = !provider
    get<HTMLButtonElement>('[data-discover]').disabled = !provider || !currentProtocol()?.supportsDiscovery
    get<HTMLButtonElement>('[data-new-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-new-variant]').disabled = !provider || !model || !currentProtocol()
    get<HTMLButtonElement>('[data-save-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-model-history]').disabled = !model
    const searchable = ['responses', 'anthropic-messages'].includes(currentProtocol()?.id ?? '')
    const searchSupported = get<HTMLSelectElement>('[data-capability="webSearch"]').value === 'supported'
    get('[data-server-search-label]').hidden = !searchable
    get('[data-server-search-hint]').hidden = !searchable || searchSupported
    input('server-search').disabled = !searchable || !searchSupported
    // Existing connections can still edit neutral fields when their protocol is temporarily absent.
    get<HTMLButtonElement>('[data-save-provider]').disabled = waitingForProvider || !provider && !currentProtocol()
    get('[data-save-provider]').textContent = busy ? '正在保存…' : provider ? '保存连接' : '保存并添加模型'
    get<HTMLButtonElement>('[data-reset-provider]').hidden = !provider
    const summary = catalog.snapshot().models.find(item => item.id === model?.id)
    get('[data-model-status]').textContent = summary ? `${modelAvailability(summary)} · ${sourceLabel(summary.source)}` : variantDefaults ? '此预设会作为独立选项出现在会话选择器中，原配置保持不变。' : '保存后，此模型将加入当前连接的列表。'
    updateDraftStatus(); renderConnections(); renderModels(); directory?.sync()
  }
  async function readInventory(id: string): Promise<void> {
    const read = ++inventoryRead; inventoryLoading = true; inventoryError = ''; renderModels()
    try {
      const next = await api<readonly ConnectionModel[]>(`${connectionPath(id)}/models`)
      if (read !== inventoryRead || provider?.id !== id) return
      inventory = next
    } catch (error) { if (read === inventoryRead && provider?.id === id) inventoryError = errorText(error) }
    finally { if (read === inventoryRead && provider?.id === id) { inventoryLoading = false; renderState() } }
  }
  function loadProvider(value?: ProviderConnection, restore = true, fetchInventory = true): void {
    selectionRead++
    if (value) {
      preferredConnectionId = value.id
      try { localStorage.setItem('anybox.models.connection', value.id) } catch { /* Selection still works without persistence. */ }
    }
    provider = value; mode = value ? 'manage' : 'add'; customConnection = false; key.value = ''; candidates = []; inventory = []; inventoryError = ''; inventoryLoading = false; inventoryRead++
    configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined; modelDraftKey = ''
    providerDefinitionId = value?.providerDefinitionId ?? ''; draftKey = value?.id ?? 'add:custom'
    get('[data-candidates-label]').hidden = true; get('[data-delete-confirm]').hidden = true; get('[data-delete-connection-confirm]').hidden = true; history.hidden = true; modelEditor.hidden = true; modelEditor.open = false
    protocolSelect.replaceChildren(...protocols.map(item => option(item.id, item.name)))
    if (value && !protocols.some(item => item.id === value.protocolId)) protocolSelect.append(option(value.protocolId, `${value.protocolId} · 未安装`))
    input('provider-name').value = value?.name ?? ''; protocolSelect.value = value?.protocolId ?? protocols[0]?.id ?? ''
    input('base-url').value = value?.baseUrl ?? ''; select('auth').value = value?.auth ?? 'api-key'; input('timeout').value = String(value?.timeoutMs ?? 120000)
    input('provider-enabled').checked = value?.enabled ?? true; select('template').value = ''
    connectionBaseFields = readConnectionFields(); connectionBaseRevision = value?.revision
    const draft = restore ? connectionDrafts.get(draftKey) : undefined
    if (draft) { writeFields(Object.fromEntries(connectionFields.map(name => [name, draft.fields[name]!]))); select('auth').value = String(draft.fields.auth); select('template').value = String(draft.fields.template); if (!value) protocolSelect.value = String(draft.fields.protocol); connectionBaseFields = draft.baseFields; connectionBaseRevision = draft.baseRevision }
    connectionEditor.open = Boolean(value && (value.auth === 'api-key' && !value.credentialConfigured || !value.enabled || value.sync?.state === 'failed'))
    const editor = value ? settingsModelEditorSelection(records, value.id, modelEditors.get(value.id), modelDrafts.has(`new:${value.id}`)) : undefined
    const editedId = editor?.target.kind === 'configuration' ? editor.target.id : undefined
    loadModel(editedId ? records.find(item => item.id === editedId) : undefined)
    modelEditor.hidden = !editor?.visible; modelEditor.open = Boolean(editor?.visible && editor.expanded)
    if (value && fetchInventory) void readInventory(value.id)
    renderState()
  }
  async function reload(): Promise<boolean> {
    const read = ++reloadRead
    const result = await Promise.all([
      api<readonly ProtocolDescriptor[]>('/models/protocols'), api<readonly ProviderTemplate[]>('/models/templates'),
      api<readonly ProviderConnection[]>('/models/connections'), api<readonly ModelConfiguration[]>('/models/configurations'),
      api<readonly DirectoryProvider[]>('/models/providers?includeMissing=true'), catalog.refresh(),
    ])
    if (read !== reloadRead) return false
    ;[protocols, templates, providers, records, definitions] = result
    templates = templates.filter(template => protocols.some(protocol => protocol.id === template.values.protocolId))
    loaded = true
    const templateId = select('template').value
    select('template').replaceChildren(option('', '手动配置'), ...templates.map(item => option(item.id, item.name)))
    select('template').value = templates.some(value => value.id === templateId) ? templateId : ''
    return true
  }
  async function refreshCurrent(preserve = true): Promise<void> {
    const read = selectionRead, id = provider?.id, connectionOpen = connectionEditor.open
    const pendingKey = key.value, keyRead = secretRevision
    if (preserve) { captureConnection(); captureModel() }
    if (!await reload() || read !== selectionRead) return
    if (id) {
      const current = providers.find(item => item.id === id)
      loadProvider(current ?? settingsConnectionSelection(providers, catalog.snapshot().models), preserve, false)
      if (current) {
        connectionEditor.open = connectionOpen
        if (keyRead === secretRevision && document.getElementById('settings-dialog')?.hasAttribute('open')) key.value = pendingKey
      }
      if (provider) await readInventory(provider.id)
    }
    renderState()
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true; show(); renderState()
    try { await action() } catch (error) { show(errorText(error), true) }
    finally { busy = false; renderState() }
  }
  function beginAdd(): void {
    if (busy || !loaded) return
    returnConnectionId = provider?.id ?? providers[0]?.id; captureConnection(); captureModel(); show()
    loadProvider(); directory?.select(''); root.scrollIntoView({ block: 'start', behavior: 'smooth' }); get<HTMLInputElement>('[data-directory-provider-search]').focus()
  }
  function prepareDirectoryConnection(value: DirectoryProvider, recipe?: ProviderTemplate, focus = true): void {
    if (busy || !loaded) return
    const nextDraftKey = `add:${value.id}:${recipe?.id ?? ''}`
    if (mode === 'add' && providerDefinitionId === value.id && draftKey === nextDraftKey) {
      if (focus) { key.focus(); providerForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
      return
    }
    selectionRead++
    captureConnection(); captureModel()
    provider = undefined; mode = 'add'; customConnection = false; key.value = ''; providerDefinitionId = value.id; configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined
    inventory = []; inventoryRead++; modelEditor.hidden = true; get('[data-delete-confirm]').hidden = true
    draftKey = nextDraftKey
    protocolSelect.replaceChildren(...protocols.map(item => option(item.id, item.name)))
    protocolSelect.value = recipe?.values.protocolId ?? value.connectionHints.protocolIds.find(id => protocols.some(item => item.id === id)) ?? protocols[0]?.id ?? ''
    input('provider-name').value = value.name; input('base-url').value = recipe?.values.baseUrl ?? value.connectionHints.baseUrl ?? ''
    select('auth').value = recipe?.values.auth ?? 'api-key'; input('timeout').value = String(recipe?.values.timeoutMs ?? 120000); input('provider-enabled').checked = true
    select('template').value = templates.some(template => template.id === recipe?.id) ? recipe!.id : ''
    connectionBaseFields = readConnectionFields(); connectionBaseRevision = undefined
    const draft = connectionDrafts.get(draftKey)
    if (draft) { writeFields(Object.fromEntries(connectionFields.map(name => [name, draft.fields[name]!]))); select('auth').value = String(draft.fields.auth); protocolSelect.value = String(draft.fields.protocol); select('template').value = String(draft.fields.template); connectionBaseFields = draft.baseFields }
    loadModel(); renderState()
    if (focus) { key.focus(); providerForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
  }
  providerForm.addEventListener('input', updateDraftStatus)
  providerForm.addEventListener('change', updateDraftStatus)
  function adoptConnection(value: ProviderConnection): void {
    selectionRead++; provider = value; providerDefinitionId = value.providerDefinitionId; mode = 'manage'
    providers = providers.some(item => item.id === value.id) ? providers.map(item => item.id === value.id ? value : item) : [...providers, value]
    connectionDrafts.delete(draftKey); draftKey = value.id
    connectionBaseRevision = value.revision; connectionBaseFields = readConnectionFields()
  }
  function observeConnection(value: ProviderConnection): void {
    // Key-only and sync operations keep configuration drafts; advance only our own revision.
    if (connectionBaseRevision === provider?.revision) connectionBaseRevision = value.revision
    selectionRead++; provider = value
    providers = providers.map(item => item.id === value.id ? value : item)
  }
  providerForm.addEventListener('submit', event => {
    event.preventDefault()
    void perform(async () => {
      captureModel()
      const name = input('provider-name').value.trim(), apiKey = key.value
      if (!name) throw new Error('请填写连接名称。')
      if (!provider && select('auth').value === 'api-key' && !apiKey.trim()) throw new Error('请输入 API Key。')
      if (!providerDefinitionId) {
        const savedDefinition = await api<DirectoryProvider>('/models/providers', { name, connectionHints: { baseUrl: input('base-url').value.trim(), protocolIds: [protocolSelect.value] } })
        providerDefinitionId = savedDefinition.id
      }
      const values: ProviderConnectionInput = { providerDefinitionId, name, protocolId: protocolSelect.value, baseUrl: input('base-url').value.trim(), auth: select('auth').value as ProviderConnectionInput['auth'], timeoutMs: Number(input('timeout').value), enabled: input('provider-enabled').checked }
      const { protocolId: _protocol, providerDefinitionId: _definition, ...patch } = values
      const existing = Boolean(provider)
      let saved = provider ? await api<ProviderConnection>(connectionPath(), { patch, expectedRevision: connectionBaseRevision ?? provider.revision }) : await api<ProviderConnection>('/models/connections', { ...values, ...(apiKey && values.auth === 'api-key' ? { apiKey } : {}) })
      adoptConnection(saved)
      if (existing && apiKey && values.auth === 'api-key') {
        // Keep the accepted revision if only the following Key operation fails.
        try { saved = await api<ProviderConnection>(`${connectionPath()}/key`, { apiKey, expectedRevision: saved.revision }) }
        catch (error) { await catalog.refresh(); throw new Error(`连接已保存，Key 保存失败：${errorText(error)}。可重试保存。`) }
        adoptConnection(saved)
      }
      key.value = ''
      try { await refreshCurrent() }
      catch (error) { show(`连接已保存，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
      connectionEditor.open = saved.sync?.state === 'failed' || saved.auth === 'api-key' && !saved.credentialConfigured
      if (!existing) root.scrollIntoView({ block: 'start', behavior: 'smooth' })
      show(saved.sync?.state === 'failed' ? '连接和 Key 已保存，模型准备失败，请点击重试。' : saved.sync?.state === 'pending' ? '连接已保存，模型尚未准备；请检查连接状态。' : '连接已保存，可用模型已加入会话选择器。', saved.sync?.state === 'failed')
    })
  })
  select('template').addEventListener('change', () => {
    const value = templates.find(item => item.id === select('template').value)
    if (!value) return
    const ref = value.values.sourceRef
    const found = ref ? definitions.find(item => item.source.kind === 'external' && item.source.sourceId === ref.sourceId && item.source.providerId === ref.providerId) : undefined
    if (found) { prepareDirectoryConnection(found, value, false); directory?.select(found.id) }
    else { protocolSelect.value = value.values.protocolId; input('base-url').value = value.values.baseUrl; select('auth').value = value.values.auth; input('timeout').value = String(value.values.timeoutMs); renderState() }
  })
  protocolSelect.addEventListener('change', () => { captureModel(); select('template').value = ''; renderParameters(initialNativeParameters(currentProtocol()?.modelFields ?? [])); renderState() })
  select('auth').addEventListener('change', () => { secretRevision++; key.value = ''; renderState() })
  get('[data-add-provider]').addEventListener('click', beginAdd)
  get('[data-custom-provider]').addEventListener('click', () => { captureConnection(); show(); loadProvider(); customConnection = true; directory?.select(''); renderState(); input('provider-name').focus() })
  get('[data-cancel-add]').addEventListener('click', () => { captureConnection(); show(); loadProvider(providers.find(value => value.id === returnConnectionId) ?? providers[0]) })
  get('[data-reset-provider]').addEventListener('click', () => {
    captureModel()
    connectionDrafts.delete(draftKey)
    if (provider) loadProvider(provider, false)
    renderState(); show('已恢复保存的连接配置。')
  })
  function resumeModelDraft(): boolean {
    if (!provider || !modelDrafts.has(`new:${provider.id}`)) return false
    configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined; loadModel()
    modelEditor.hidden = false; modelEditor.open = true; renderState(); input('model-name').focus()
    show('已恢复未保存的新模型或参数预设；放弃修改后可重新创建。')
    return true
  }
  get('[data-new-model]').addEventListener('click', () => {
    captureModel(); if (resumeModelDraft()) return
    configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined; loadModel(undefined, undefined, false)
    modelEditor.hidden = false; modelEditor.open = true; renderState(); input('model-name').focus()
  })
  get('[data-new-variant]').addEventListener('click', () => {
    if (!model) return
    captureModel(); if (resumeModelDraft()) return
    try {
      const defaults = readNativeParameters()
      const capabilities = readCapabilities(), name = input('model-name').value.trim() || model.name
      const original = model; configurationDefinitionId = original.modelDefinitionId; variantDefaults = defaults; variantCapabilities = capabilities
      loadModel(undefined, { remoteModelId: original.remoteModelId, name: `${name} · 预设` }, false); modelEditor.hidden = false; modelEditor.open = true; renderState(); input('model-name').focus()
    } catch (error) { show(errorText(error), true) }
  })
  get('[data-close-model]').addEventListener('click', () => { captureModel(); modelEditor.open = false; renderState() })
  get('[data-reset-model]').addEventListener('click', () => {
    modelDrafts.delete(modelDraftKey)
    if (model) loadModel(model, undefined, false)
    else { configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined; modelEditor.hidden = true; modelEditor.open = false }
    renderState(); show('已放弃未保存的模型修改。')
  })
  input('model-search').addEventListener('input', renderModels); select('model-filter').addEventListener('change', renderModels)
  get('[data-reload]').addEventListener('click', () => { void perform(async () => {
    if (!loaded) { if (await reload()) loadProvider(settingsConnectionSelection(providers, catalog.snapshot().models, preferredConnectionId)) }
    else await refreshCurrent()
    show('已刷新状态，未保存的修改已保留。')
  }) })
  get('[data-delete-key]').addEventListener('click', () => { get('[data-delete-confirm]').hidden = false })
  get('[data-delete-connection]').addEventListener('click', () => {
    if (!provider || busy) return
    get('[data-delete-connection-confirm]').hidden = false
    get('[data-delete-connection-confirm]').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    get('[data-cancel-delete-connection]').focus()
  })
  get('[data-cancel-delete-connection]').addEventListener('click', () => {
    get('[data-delete-connection-confirm]').hidden = true
    get('[data-delete-connection]').focus()
  })
  get('[data-confirm-delete-connection]').addEventListener('click', () => { if (provider) void perform(async () => {
    const removed = provider
    if (!removed) return
    const own = records.filter(value => value.connectionId === removed.id)
    await api(`${connectionPath(removed.id)}/delete`, { expectedRevision: removed.revision })
    connectionDrafts.delete(removed.id); modelEditors.delete(removed.id); modelDrafts.delete(`new:${removed.id}`)
    for (const value of own) modelDrafts.delete(value.id)
    providers = providers.filter(value => value.id !== removed.id); records = records.filter(value => value.connectionId !== removed.id)
    preferredConnectionId = undefined; returnConnectionId = undefined; secretRevision++
    try { localStorage.removeItem('anybox.models.connection') } catch { /* Selection still works without persistence. */ }
    loadProvider(settingsConnectionSelection(providers, catalog.snapshot().models), true, false)
    try {
      await refreshCurrent()
      if (!provider) loadProvider(settingsConnectionSelection(providers, catalog.snapshot().models))
    } catch (error) { show(`连接已删除，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show(`已删除“${removed.name}”连接。历史对话和已开始的运行已保留。`)
  }) })
  get('[data-cancel-delete-key]').addEventListener('click', () => { get('[data-delete-confirm]').hidden = true })
  get('[data-confirm-delete-key]').addEventListener('click', () => { if (provider) void perform(async () => {
    const saved = await api<ProviderConnection>(`${connectionPath()}/key/delete`, { expectedRevision: provider!.revision })
    observeConnection(saved); key.value = ''; get('[data-delete-confirm]').hidden = true
    try { await refreshCurrent() } catch (error) { show(`Key 已删除，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show('Key 已删除。此连接的模型现已不可用。')
  }) })
  get('[data-retry-sync]').addEventListener('click', () => { if (provider) void perform(async () => {
    const retried = await api<ProviderConnection>(`${connectionPath()}/retry`, {}); observeConnection(retried)
    try { await refreshCurrent() } catch (error) { show(`已完成重试，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show(retried.sync?.state === 'failed' ? '模型准备仍未成功，请稍后重试。' : retried.sync?.state === 'pending' ? '模型仍在等待准备，请检查连接状态。' : '模型已准备，可在会话中选择。', retried.sync?.state === 'failed')
  }) })
  get('[data-check]').addEventListener('click', () => { if (provider) void perform(async () => { await api(`${connectionPath()}/check`, {}); show('已保存的连接检查成功。') }) })
  get('[data-discover]').addEventListener('click', () => { if (provider) void perform(async () => {
    candidates = await api<readonly DiscoveredModel[]>(`${connectionPath()}/discover`, {})
    select('candidates').replaceChildren(option('', '选择候选模型'), ...candidates.map((value, index) => option(String(index), `${value.name} · ${value.remoteModelId}`)))
    get('[data-candidates-label]').hidden = !candidates.length; show(candidates.length ? `找到 ${candidates.length} 个候选模型，请确认能力与参数后保存。` : '未返回候选模型，可添加自定义模型。')
  }) })
  select('candidates').addEventListener('change', () => {
    if (select('candidates').value === '') return
    captureModel(); if (resumeModelDraft()) return
    configurationDefinitionId = ''; variantDefaults = variantCapabilities = undefined; loadModel(undefined, candidates[Number(select('candidates').value)], false); modelEditor.hidden = false; modelEditor.open = true; renderState()
  })
  function readCapabilities(): DeclaredCapabilities {
    const support = (name: string) => get<HTMLSelectElement>(`[data-capability="${name}"]`).value as Support
    const strings = (name: string) => input(name).value.split(',').map(value => value.trim()).filter(Boolean)
    const efforts = strings('efforts'), modes = strings('modes'), budgetMin = input('budget-min').value, budgetMax = input('budget-max').value
    if (Boolean(budgetMin) !== Boolean(budgetMax)) throw new Error('请同时填写推理预算的最小值和最大值。')
    return { webSearch: { support: support('webSearch') }, tools: { support: support('tools') }, streaming: { support: support('streaming') }, imageInput: { support: support('imageInput') }, reasoning: { support: support('reasoning'), ...(efforts.length ? { efforts } : {}), ...(modes.length ? { modes } : {}), ...(budgetMin && budgetMax ? { budget: { min: Number(budgetMin), max: Number(budgetMax) } } : {}) } }
  }
  function readNativeParameters(): NativeObject {
    const values = Object.fromEntries([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-parameter]')].map(field => [field.dataset.parameter!, field.value]))
    const value = nativeParameterValues(parameterFields, values)
    if (!input('server-search').checked) return value
    if (readCapabilities().webSearch?.support !== 'supported') throw new Error('请先明确声明此模型支持网络搜索。')
    if (provider?.protocolId === 'responses') return { ...value, tools: [{ type: 'web_search' }] }
    if (provider?.protocolId === 'anthropic-messages') return { ...value, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }
    throw new Error('此协议尚未支持服务端网络搜索。')
  }
  get<HTMLSelectElement>('[data-capability="webSearch"]').addEventListener('change', renderState)
  get<HTMLFormElement>('[data-model-form]').addEventListener('submit', event => {
    event.preventDefault(); if (!provider) return
    void perform(async () => {
      const capabilities = readCapabilities()
      const defaults = readNativeParameters(), name = input('model-name').value.trim(), remoteModelId = input('remote-id').value.trim()
      if (!name || !remoteModelId) throw new Error('请填写模型名称和远端模型标识。')
      if (!model && !configurationDefinitionId) {
        const definition: ModelInput = { providerId: provider!.providerDefinitionId, name, remoteModelId, capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { baseUrl: provider!.baseUrl, protocolIds: [provider!.protocolId] } }
        const savedDefinition = await api<Model>('/models/definitions', definition); configurationDefinitionId = savedDefinition.id; input('remote-id').readOnly = true
      }
      const config: ModelConfigurationInput = { name, connectionId: provider!.id, modelDefinitionId: model?.modelDefinitionId ?? configurationDefinitionId, baseline: !variantDefaults, enabled: input('model-enabled').checked, capabilities, parameters: { protocolId: provider!.protocolId, formatVersion: 1, value: defaults } }
      const { connectionId: _connection, modelDefinitionId: _definition, baseline: _baseline, ...patch } = config
      const saved = model ? await api<ModelConfiguration>(modelPath(), { patch, expectedRevision: modelBaseRevision ?? model.revision }) : await api<ModelConfiguration>('/models/configurations', config)
      modelDrafts.delete(modelDraftKey)
      records = records.some(value => value.id === saved.id) ? records.map(value => value.id === saved.id ? saved : value) : [...records, saved]
      loadModel(saved, undefined, false)
      try { await refreshCurrent() }
      catch (error) { show(`模型已保存，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
      show('模型参数已保存，会话选择器已更新。')
    })
  })
  for (const kind of ['provider', 'model'] as const) get(`[data-${kind}-history]`).addEventListener('click', () => {
    if (kind === 'provider' ? !provider : !model) return
    void perform(async () => {
      const versions = await api<readonly (ProviderConnection | ModelConfiguration)[]>(`${kind === 'provider' ? connectionPath() : modelPath()}/history`)
      history.querySelector('ol')!.replaceChildren(...versions.map(value => {
        const item = document.createElement('li'), title = document.createElement('strong'), details = document.createElement('pre')
        title.textContent = `v${value.revision} · ${new Date(value.updatedAt).toLocaleString('zh-CN')}`; details.textContent = JSON.stringify(value, null, 2); item.append(title, details); return item
      }))
      history.hidden = false; history.open = true; history.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  })
  directory = setupModelsDirectory(get('.models-directory'), api, messageFor, {
    context: () => ({ connection: provider, connections: providers, providerDefinitionId, protocolId: protocolSelect.value, models: inventory, ready: loaded, busy }),
    selectProvider(value) { prepareDirectoryConnection(value, value.connections[0], false) },
    useConnection(value, recipe, focus = true) { prepareDirectoryConnection(value, recipe, focus) },
    async refreshConfigured() { await refreshCurrent() },
  })
  const dialog = document.getElementById('settings-dialog')!
  dialog.addEventListener('close', () => { captureConnection(); captureModel(); secretRevision++; key.value = ''; get('[data-delete-confirm]').hidden = true })
  void perform(async () => { if (await reload()) loadProvider(settingsConnectionSelection(providers, catalog.snapshot().models, preferredConnectionId)) })
  window.addEventListener('pagehide', event => { if (!event.persisted) directory?.dispose() })
  return { clearSecrets() { secretRevision++; key.value = ''; updateDraftStatus() } }
}

import type { CatalogProviderRef, DeclaredCapabilities, DiscoveredModel, FormField, GenerationOptions, JsonValue, ModelInput, ModelRecord, ModelSummary, ProtocolDescriptor, ProviderInput, ProviderTemplate, ProviderView, Support } from '@anybox/models'
import type { Api } from './client-types.js'
import type { DirectoryModel } from './client-types.js'
import { setupModelsDirectory } from './models-directory-client.js'

export interface ModelsCatalog {
  snapshot(): { readonly models: readonly ModelSummary[]; readonly providers: readonly ProviderView[]; readonly loading: boolean; readonly error?: string }
  refresh(): Promise<void>
  subscribe(listener: () => void): () => void
}

/** Shared by settings and all panes. A refresh never changes a session's selection. */
export function createModelsCatalog(api: Api, messageFor: (error: unknown) => string): ModelsCatalog {
  let models: readonly ModelSummary[] = [], providers: readonly ProviderView[] = [], loading = true, error: string | undefined
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
          api<readonly ModelSummary[]>('/models'), api<readonly ProviderView[]>('/models/providers'),
        ])
        if (read !== revision) return
        models = nextModels; providers = nextProviders; error = undefined
      } catch (cause) { if (read === revision) error = messageFor(cause) }
      if (read === revision) { loading = false; emit() }
    },
  }
}

/** Blank optional values remain omitted, including protocol-specific settings. */
export function generationOptions(fields: readonly FormField[], values: Readonly<Record<string, string>>): GenerationOptions {
  const common: Record<string, JsonValue> = {}, protocol: Record<string, JsonValue> = {}
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
    if (field.key.startsWith('protocol.')) protocol[field.key.slice(9)] = value
    else common[field.key] = value
  }
  return { ...common, ...(Object.keys(protocol).length ? { protocol } : {}) } as GenerationOptions
}

export function modelAvailability(model: ModelSummary): string {
  if (model.available && model.effectiveCapabilities?.tools) return '可用于 Agent · 支持工具'
  if (model.available) return '可用于 Agent · 仅文本调用'
  return { disabled: '模型已停用', 'provider-disabled': '提供方已停用', 'protocol-unavailable': '协议未安装',
    'credential-missing': '尚未配置 Key', 'invalid-configuration': '配置无效' }[model.unavailableReason ?? 'invalid-configuration']
}
export function canUseModel(model: ModelSummary | undefined): boolean { return Boolean(model?.available) }

const supportChoices: readonly [Support, string][] = [['unknown', '未知'], ['supported', '支持'], ['unsupported', '不支持']]
const unknownCapabilities = (): DeclaredCapabilities => ({ tools: { support: 'unknown' }, streaming: { support: 'unknown' }, imageInput: { support: 'unknown' }, reasoning: { support: 'unknown' } })
function option(value: string, text: string): HTMLOptionElement {
  const item = document.createElement('option'); item.value = value; item.textContent = text; return item
}
function fieldValue(defaults: GenerationOptions, key: string): JsonValue | undefined {
  return key.startsWith('protocol.') ? defaults.protocol?.[key.slice(9)] : (defaults as Readonly<Record<string, JsonValue>>)[key]
}

/** Only a new configuration receives descriptor defaults; saved omissions stay omitted. */
export function initialModelDefaults(fields: readonly FormField[], candidate?: Pick<DirectoryModel, 'limits'>): GenerationOptions {
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.defaultValue === undefined) continue
    let value = field.defaultValue
    if (field.key === 'maxOutputTokens' && typeof value === 'number' && candidate?.limits.output !== undefined) value = Math.min(value, candidate.limits.output)
    values[field.key] = field.type === 'enum' || field.type === 'boolean' ? JSON.stringify(value) : String(value)
  }
  // Required fields with no prefill are left for the user to enter in the form.
  return generationOptions(fields.map(field => ({ ...field, required: false })), values)
}

export function setupModelsSettings(api: Api, messageFor: (error: unknown) => string, catalog: ModelsCatalog) {
  const root = document.getElementById('models-settings')!
  root.innerHTML = `
    <header class="settings-panel-heading models-heading"><div><h3 id="models-settings-title">模型服务</h3><p>一个提供方可提供多个模型，保存后可在会话中选择。</p></div><button type="button" class="secondary-button" data-reload>重新读取</button></header>
    <p class="models-notice" role="status" aria-live="polite" hidden></p>
    <section class="settings-card models-directory" aria-label="公共模型目录"></section>
    <fieldset class="models-controls">
      <div class="models-workspace">
      <section class="settings-card models-provider-section" aria-labelledby="models-provider-title">
      <div class="models-card-heading"><h4 id="models-provider-title">提供方</h4><p>配置提供方的 API 地址与认证。</p></div>
      <div class="models-row"><label>选择提供方<select data-provider-select aria-label="提供方"></select></label><button type="button" data-new-provider class="secondary-button">添加提供方</button></div>
      <form data-provider-form autocomplete="off">
        <label data-template-label>提供方模板<select data-template></select></label>
        <div class="models-grid"><label>提供方名称<input data-provider-name required maxlength="200" placeholder="例如：OpenAI 工作账号"></label><label>API 协议<select data-protocol required></select></label></div>
        <label>API 地址<input data-base-url required type="url" placeholder="https://api.example.com/v1"></label>
        <details><summary>高级连接设置</summary><div class="models-grid"><label>认证方式<select data-auth><option value="api-key">API Key</option><option value="none">无需认证</option></select></label><label>请求超时（毫秒）<input data-timeout type="number" min="1" step="1" value="120000" required></label></div></details>
        <label class="models-check"><input data-provider-enabled type="checkbox" checked>启用此提供方</label>
        <div class="models-key"><label>API Key<input data-api-key type="password" autocomplete="new-password" placeholder="输入新的 API Key"></label><p data-key-status></p><div class="settings-actions" data-key-actions><button type="button" data-save-key>替换 Key</button><button type="button" data-delete-key class="secondary-button">删除 Key</button></div></div>
        <div class="settings-actions"><button type="submit" data-save-provider>保存提供方</button><button type="button" data-check class="secondary-button">检查连接</button><button type="button" data-provider-history class="secondary-button">提供方版本</button></div>
        <p class="settings-hint">配置修改只影响后续运行。API Key 保存在系统凭据库中，读取时仅显示是否已配置。</p>
      </form>
      </section>
      <section class="settings-card models-model-section" aria-labelledby="models-config-title">
        <div class="models-card-heading"><h4 id="models-config-title">此提供方的模型</h4><p>设置模型标识、能力与默认参数。</p></div>
        <div class="models-row"><label>选择模型<select data-model-select aria-label="模型配置"></select></label><button type="button" data-new-model class="secondary-button">添加模型</button></div><p data-model-status role="status"></p>
        <div class="settings-actions"><button type="button" data-discover class="secondary-button">获取远端模型列表</button></div>
        <label data-candidates-label hidden>连接返回的远端候选<select data-candidates></select><span class="settings-hint">选择后填写到下方，确认能力并保存才会添加。</span></label>
        <form data-model-form>
          <div class="models-grid"><label>显示名称<input data-model-name required maxlength="200" placeholder="例如：深入分析"></label><label>远端模型标识<input data-remote-id required placeholder="提供方要求的 model ID"></label></div>
          <label class="models-check"><input data-model-enabled type="checkbox" checked>启用此模型</label>
          <fieldset class="models-capabilities"><legend>模型能力声明</legend><p class="settings-hint">以所用模型文档为准。工具能力未知或不支持时，Agent 仅进行文本调用；未知能力不会被自动认定为支持。</p><div class="models-grid" data-capabilities></div>
            <label>支持的推理档位（可选，逗号分隔）<input data-efforts placeholder="例如：low, medium, high"></label>
            <details><summary>其他推理约束</summary><label>支持的推理模式（逗号分隔）<input data-modes></label><div class="models-grid"><label>最小推理预算<input data-budget-min type="number" min="0" step="1"></label><label>最大推理预算<input data-budget-max type="number" min="0" step="1"></label></div></details>
          </fieldset>
          <fieldset class="models-parameters"><legend>默认生成参数</legend><p class="settings-hint">未填写的参数使用服务端默认值。推理设置只适用于已声明支持的模型。</p><div class="models-grid" data-parameters></div></fieldset>
          <div class="settings-actions"><button type="submit" data-save-model>保存模型</button><button type="button" data-model-history class="secondary-button">模型版本</button></div>
        </form>
      </section>
      </div>
    </fieldset>
    <details class="models-history" hidden><summary>配置版本历史</summary><ol></ol></details>`
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const input = (name: string) => get<HTMLInputElement>(`[data-${name}]`)
  const select = (name: string) => get<HTMLSelectElement>(`[data-${name}]`)
  const providerSelect = select('provider-select'), modelSelect = select('model-select'), protocolSelect = select('protocol')
  const key = input('api-key'), controls = get<HTMLFieldSetElement>('.models-controls'), notice = get<HTMLElement>('.models-notice')
  let protocols: readonly ProtocolDescriptor[] = [], templates: readonly ProviderTemplate[] = []
  let providers: readonly ProviderView[] = [], records: readonly ModelRecord[] = [], candidates: readonly DiscoveredModel[] = []
  let provider: ProviderView | undefined, model: ModelRecord | undefined, busy = false, loaded = false
  let providerCatalogRef: CatalogProviderRef | null = null
  let directory: ReturnType<typeof setupModelsDirectory> | undefined
  let parameterFields: readonly FormField[] = []
  const show = (text = '', failed = false) => { notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', failed) }
  const errorText = (error: unknown) => error instanceof Error && !(error instanceof TypeError) && !('status' in error) ? error.message : messageFor(error)
  const currentProtocol = () => protocols.find(item => item.id === protocolSelect.value)
  const connectionPath = () => `/models/providers/${encodeURIComponent(provider!.id)}`
  const modelPath = () => `/models/configurations/${encodeURIComponent(model!.id)}`
  const history = get<HTMLDetailsElement>('.models-history')

  for (const [name, label] of [['tools', '工具调用'], ['streaming', '流式输出'], ['imageInput', '图片输入（仅记录）'], ['reasoning', '推理']] as const) {
    const wrapper = document.createElement('label'), field = document.createElement('select')
    wrapper.textContent = label; field.dataset.capability = name
    field.append(...supportChoices.map(([value, text]) => option(value, text))); wrapper.append(field); get('[data-capabilities]').append(wrapper)
  }
  function renderParameters(defaults: GenerationOptions = {}): void {
    parameterFields = currentProtocol()?.modelFields ?? []
    const fields = parameterFields.map(field => {
      const wrapper = document.createElement('label'); wrapper.textContent = field.label
      let control: HTMLInputElement | HTMLSelectElement
      if (field.type === 'enum' || field.type === 'boolean') {
        control = document.createElement('select')
        control.append(option('', '使用服务端默认值'), ...(field.values ?? [true, false]).map(value => option(JSON.stringify(value), String(value))))
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
      if (control instanceof HTMLSelectElement && savedValue && ![...control.options].some(item => item.value === savedValue)) {
        control.append(option(savedValue, `已保存：${String(value)}（需要修改）`))
      }
      control.value = savedValue
      if (field.description) control.title = field.description
      wrapper.append(control); return wrapper
    })
    get('[data-parameters]').replaceChildren(...fields)
  }
  function loadModel(value?: ModelRecord, candidate?: DiscoveredModel, directoryModel?: DirectoryModel): void {
    model = value; modelSelect.value = value?.id ?? ''
    input('model-name').value = value?.name ?? candidate?.name ?? ''
    input('remote-id').value = value?.remoteModelId ?? candidate?.remoteModelId ?? ''
    input('model-enabled').checked = value?.enabled ?? true
    const capabilities = value?.capabilities ?? { ...unknownCapabilities(), ...candidate?.suggestedCapabilities }
    for (const name of ['tools', 'streaming', 'imageInput', 'reasoning'] as const) get<HTMLSelectElement>(`[data-capability="${name}"]`).value = capabilities[name].support
    input('efforts').value = capabilities.reasoning.efforts?.join(', ') ?? ''
    input('modes').value = capabilities.reasoning.modes?.join(', ') ?? ''
    input('budget-min').value = capabilities.reasoning.budget ? String(capabilities.reasoning.budget.min) : ''
    input('budget-max').value = capabilities.reasoning.budget ? String(capabilities.reasoning.budget.max) : ''
    renderParameters(value ? value.defaults : initialModelDefaults(currentProtocol()?.modelFields ?? [], directoryModel))
    renderState()
  }
  function renderState(): void {
    controls.disabled = busy || !loaded
    get<HTMLButtonElement>('[data-reload]').disabled = busy
    get('[data-template-label]').hidden = Boolean(provider)
    protocolSelect.disabled = Boolean(provider)
    get('[data-key-actions]').hidden = !provider
    key.disabled = select('auth').value === 'none'
    get('.models-key').hidden = select('auth').value === 'none' && !provider?.credentialConfigured
    get('[data-key-status]').textContent = provider ? `${provider.credentialConfigured ? '已配置 Key' : '尚未配置 Key'}。填写后点击“替换 Key”；留空保持现有 Key。` : '新提供方的 Key 将与配置一起保存。无需认证的提供方可留空。'
    get<HTMLButtonElement>('[data-save-key]').disabled = !provider || select('auth').value === 'none'
    get<HTMLButtonElement>('[data-delete-key]').disabled = !provider?.credentialConfigured
    get<HTMLButtonElement>('[data-check]').disabled = !provider || !currentProtocol()?.supportsCheck
    get<HTMLButtonElement>('[data-provider-history]').disabled = !provider
    get<HTMLButtonElement>('[data-discover]').disabled = !provider || !currentProtocol()?.supportsDiscovery
    get<HTMLButtonElement>('[data-new-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-save-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-model-history]').disabled = !model
    get<HTMLButtonElement>('[data-save-provider]').disabled = !currentProtocol()
    const summary = catalog.snapshot().models.find(item => item.id === model?.id)
    get('[data-model-status]').textContent = !provider ? '先保存提供方，再添加模型。' : summary ?
      `${modelAvailability(summary)} · 版本 ${summary.revision}。图片输入当前仅记录能力。` : '可以手动填写模型标识，或获取远端候选列表。'
    directory?.sync()
  }
  function renderSelectors(): void {
    providerSelect.replaceChildren(option('', '新建提供方'), ...providers.map(item => option(item.id, `${item.name}${item.enabled ? '' : ' · 已停用'}`)))
    providerSelect.value = provider?.id ?? ''
    modelSelect.replaceChildren(option('', '新建模型配置'), ...records.filter(item => item.providerId === provider?.id).map(item => option(item.id, `${item.name}${item.enabled ? '' : ' · 已停用'}`)))
    modelSelect.value = model?.id ?? ''
  }
  function loadProvider(value?: ProviderView): void {
    provider = value; key.value = ''; candidates = []
    providerCatalogRef = value?.catalogRef ?? (value ? null : templates[0]?.values.catalogRef ?? null)
    get('[data-candidates-label]').hidden = true; history.hidden = true
    protocolSelect.replaceChildren(...protocols.map(item => option(item.id, item.name)))
    if (value && !protocols.some(item => item.id === value.protocolId)) protocolSelect.append(option(value.protocolId, `${value.protocolId} · 未安装`))
    input('provider-name').value = value?.name ?? ''
    protocolSelect.value = value?.protocolId ?? templates[0]?.values.protocolId ?? protocols[0]?.id ?? ''
    input('base-url').value = value?.baseUrl ?? templates[0]?.values.baseUrl ?? ''
    select('auth').value = value?.auth ?? templates[0]?.values.auth ?? 'api-key'
    input('timeout').value = String(value?.timeoutMs ?? templates[0]?.values.timeoutMs ?? 120000)
    input('provider-enabled').checked = value?.enabled ?? true
    select('template').value = value ? '' : templates[0]?.id ?? ''
    renderSelectors(); loadModel(records.find(item => item.providerId === value?.id))
  }
  async function reload(): Promise<void> {
    const result = await Promise.all([
      api<readonly ProtocolDescriptor[]>('/models/protocols'), api<readonly ProviderTemplate[]>('/models/templates'),
      api<readonly ProviderView[]>('/models/providers'), api<readonly ModelRecord[]>('/models/configurations'), catalog.refresh(),
    ])
    ;[protocols, templates, providers, records] = result
    templates = templates.filter(template => protocols.some(protocol => protocol.id === template.values.protocolId))
    loaded = true
    select('template').replaceChildren(option('', '自定义提供方'), ...templates.map(item => option(item.id, item.name)))
    renderSelectors()
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true; show(); renderState()
    try { await action() } catch (error) { show(errorText(error), true) }
    finally { busy = false; renderState() }
  }
  const providerForm = get<HTMLFormElement>('[data-provider-form]')
  providerForm.addEventListener('submit', event => {
    event.preventDefault()
    void perform(async () => {
      const values: ProviderInput = { name: input('provider-name').value.trim(), protocolId: protocolSelect.value,
        baseUrl: input('base-url').value.trim(), auth: select('auth').value as ProviderInput['auth'],
        timeoutMs: Number(input('timeout').value), enabled: input('provider-enabled').checked, catalogRef: providerCatalogRef }
      const previous = provider, savedKey = key.value
      if (previous && savedKey) throw new Error('请先点击“替换 Key”保存新密钥，或清空 Key 输入框后保存提供方。')
      const { protocolId: _protocol, ...patch } = values
      const saved = previous ? await api<ProviderView>(connectionPath(), { patch, expectedRevision: previous.revision }) :
        await api<ProviderView>('/models/providers', { ...values, ...(savedKey && values.auth === 'api-key' ? { apiKey: savedKey } : {}) })
      key.value = ''
      await reload(); loadProvider(providers.find(item => item.id === saved.id)); show('提供方已保存。接下来可配置模型。')
    })
  })
  select('template').addEventListener('change', () => {
    const value = templates.find(item => item.id === select('template').value)
    providerCatalogRef = value?.values.catalogRef ?? null
    if (!value) { renderState(); return }
    protocolSelect.value = value.values.protocolId; input('base-url').value = value.values.baseUrl
    select('auth').value = value.values.auth; input('timeout').value = String(value.values.timeoutMs)
    if (!input('provider-name').value) input('provider-name').value = value.name
    renderParameters(initialModelDefaults(currentProtocol()?.modelFields ?? [])); renderState()
  })
  protocolSelect.addEventListener('change', () => {
    const template = templates.find(item => item.id === select('template').value)
    if (template && template.values.protocolId !== protocolSelect.value) {
      select('template').value = ''; providerCatalogRef = null
    }
    renderParameters(initialModelDefaults(currentProtocol()?.modelFields ?? [])); renderState()
  })
  select('auth').addEventListener('change', () => { key.value = ''; renderState() })
  providerSelect.addEventListener('change', () => { show(); loadProvider(providers.find(item => item.id === providerSelect.value)) })
  modelSelect.addEventListener('change', () => { show(); loadModel(records.find(item => item.id === modelSelect.value)) })
  get('[data-new-provider]').addEventListener('click', () => { show(); loadProvider(); input('provider-name').focus() })
  get('[data-new-model]').addEventListener('click', () => { show(); loadModel(); input('model-name').focus() })
  get('[data-reload]').addEventListener('click', () => { void perform(async () => { const id = provider?.id; await reload(); loadProvider(providers.find(item => item.id === id) ?? providers[0]); show('已读取最新配置。') }) })
  for (const remove of [false, true]) get(remove ? '[data-delete-key]' : '[data-save-key]').addEventListener('click', () => {
    if (!provider) return
    void perform(async () => {
      if (!remove && !key.value.trim()) throw new Error('请输入新的 API Key。')
      const id = provider!.id, apiKey = key.value
      await api<ProviderView>(`${connectionPath()}/key${remove ? '/delete' : ''}`, { expectedRevision: provider!.revision, ...(!remove ? { apiKey } : {}) })
      key.value = ''; await reload(); loadProvider(providers.find(item => item.id === id))
      show(remove ? 'Key 已删除。新运行需要重新配置 Key。' : 'Key 已替换。后续运行使用新 Key。')
    })
  })
  get('[data-check]').addEventListener('click', () => { if (provider) void perform(async () => { await api(`${connectionPath()}/check`, {}); show('连接检查成功。') }) })
  get('[data-discover]').addEventListener('click', () => { if (provider) void perform(async () => {
    candidates = await api<readonly DiscoveredModel[]>(`${connectionPath()}/discover`, {})
    select('candidates').replaceChildren(option('', '选择候选模型'), ...candidates.map((value, index) => option(String(index), `${value.name} · ${value.remoteModelId}`)))
    get('[data-candidates-label]').hidden = !candidates.length
    show(candidates.length ? `找到 ${candidates.length} 个候选模型。选择后请确认能力与参数，再保存。` : '提供方未返回候选模型，可以手动填写标识。')
  }) })
  select('candidates').addEventListener('change', () => { if (select('candidates').value !== '') loadModel(undefined, candidates[Number(select('candidates').value)]) })
  get<HTMLFormElement>('[data-model-form]').addEventListener('submit', event => {
    event.preventDefault()
    if (!provider) return
    void perform(async () => {
      const support = (name: string) => get<HTMLSelectElement>(`[data-capability="${name}"]`).value as Support
      const strings = (name: string) => input(name).value.split(',').map(value => value.trim()).filter(Boolean)
      const efforts = strings('efforts'), modes = strings('modes')
      const budgetMin = input('budget-min').value, budgetMax = input('budget-max').value
      if (Boolean(budgetMin) !== Boolean(budgetMax)) throw new Error('请同时填写推理预算的最小值和最大值。')
      const capabilities: DeclaredCapabilities = { tools: { support: support('tools') }, streaming: { support: support('streaming') }, imageInput: { support: support('imageInput') },
        reasoning: { support: support('reasoning'), ...(efforts.length ? { efforts } : {}), ...(modes.length ? { modes } : {}),
          ...(budgetMin && budgetMax ? { budget: { min: Number(budgetMin), max: Number(budgetMax) } } : {}) } }
      const values = Object.fromEntries([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-parameter]')].map(field => [field.dataset.parameter!, field.value]))
      const config: ModelInput = { name: input('model-name').value.trim(), providerId: provider!.id,
        remoteModelId: input('remote-id').value.trim(), enabled: input('model-enabled').checked, capabilities, defaults: generationOptions(parameterFields, values) }
      const { providerId: _provider, ...patch } = config
      const saved = model ? await api<ModelRecord>(modelPath(), { patch, expectedRevision: model.revision }) : await api<ModelRecord>('/models/configurations', config)
      await reload(); renderSelectors(); loadModel(records.find(item => item.id === saved.id)); show('模型已保存，可在会话输入框中选择。')
    })
  })
  for (const kind of ['provider', 'model'] as const) get(`[data-${kind}-history]`).addEventListener('click', () => {
    if (kind === 'provider' ? !provider : !model) return
    void perform(async () => {
      const versions = await api<readonly (ProviderView | ModelRecord)[]>(`${kind === 'provider' ? connectionPath() : modelPath()}/history`)
      history.querySelector('ol')!.replaceChildren(...versions.map(value => {
        const item = document.createElement('li'), title = document.createElement('strong'), details = document.createElement('pre')
        title.textContent = `v${value.revision} · ${new Date(value.updatedAt).toLocaleString('zh-CN')}`
        details.textContent = JSON.stringify(value, null, 2); item.append(title, details); return item
      }))
      history.hidden = false; history.open = true; show(`已读取 ${versions.length} 个配置版本。`)
    })
  })
  const dialog = document.getElementById('settings-dialog')!
  dialog.addEventListener('close', () => { key.value = '' })
  directory = setupModelsDirectory(get('.models-directory'), api, messageFor, {
    context: () => ({ provider, ready: loaded, busy }),
    useConnection(value, recipe) {
      if (busy || !loaded) return
      show(); loadProvider()
      providerCatalogRef = { sourceId: value.sourceId, providerId: value.id }
      select('template').value = templates.some(template => template.id === recipe?.id) ? recipe!.id : ''
      protocolSelect.value = recipe?.values.protocolId ?? protocols[0]?.id ?? ''
      input('provider-name').value = value.name
      input('base-url').value = recipe?.values.baseUrl ?? value.connectionHints.baseUrl ?? ''
      select('auth').value = recipe?.values.auth ?? 'api-key'
      input('timeout').value = String(recipe?.values.timeoutMs ?? 120000)
      input('provider-enabled').checked = true
      loadModel(); input('provider-name').focus()
      show('已填写目录连接建议。请确认账号名称、地址和认证，然后保存提供方。')
    },
    useModel(value) {
      if (busy || !provider) return
      loadModel(undefined, { remoteModelId: value.remoteModelId, name: value.name, suggestedCapabilities: value.suggestedCapabilities }, value)
      input('model-name').focus(); show('已填写目录模型建议。请确认能力与默认参数，然后保存模型。')
    },
    associate(ref) {
      return perform(async () => {
        if (!provider) return
        const saved = await api<ProviderView>(connectionPath(), { patch: { catalogRef: ref }, expectedRevision: provider.revision })
        provider = saved; providerCatalogRef = saved.catalogRef ?? null
        providers = providers.map(item => item.id === saved.id ? saved : item)
        await catalog.refresh()
        show(ref ? '提供方已关联目录。连接地址、Key 和模型配置保持已保存的值。' : '已解除目录关联。')
      })
    },
  })
  void perform(async () => { await reload(); loadProvider(providers[0]) })
  window.addEventListener('pagehide', event => { if (!event.persisted) directory?.dispose() })
  return { clearSecrets() { key.value = '' } }
}

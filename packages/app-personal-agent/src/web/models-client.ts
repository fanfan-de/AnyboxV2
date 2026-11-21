import { createPageRequests } from './page-lifecycle.js'
import { providerLogo } from './vendor/provider-logos.js'
import type { HarnessClient } from './harness-client.js'
import type { CatalogStatus, ProviderModel, DeclaredCapabilities, DiscoveredModel, FormField, NativeObject, JsonValue, Model, ModelInput, ModelSettings, ModelSettingsInput, RunnableModelSummary, ProtocolDescriptor, ProviderSettingsInput, ProviderSettings, Support } from '@anybox/models'
import type { Api } from './client-types.js'
import type { DirectoryModel, DirectoryProvider } from './client-types.js'
import { directoryRefreshError, sourceLabel, providerModelAvailability } from './models-directory-client.js'

export interface ModelsCatalog {
  snapshot(): { readonly models: readonly RunnableModelSummary[]; readonly providers: readonly ProviderSettings[]; readonly loading: boolean; readonly error?: string }
  refresh(): Promise<void>
  subscribe(listener: () => void): () => void
  dispose(): void
}

/** Shared by settings and all panes. A refresh never changes a session's selection. */
export function createModelsCatalog(api: Api, messageFor: (error: unknown) => string): ModelsCatalog {
  let models: readonly RunnableModelSummary[] = [], providers: readonly ProviderSettings[] = [], loading = true, error: string | undefined
  let revision = 0, disposed = false
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const multi = api as Partial<HarnessClient>
  const unsubscribeModels = multi.subscribeList?.('/models', values => { if (!disposed) { models = values as readonly RunnableModelSummary[]; emit() } })
  const unsubscribeProviders = multi.subscribeList?.('/models/provider-settings', values => { if (!disposed) { providers = values as readonly ProviderSettings[]; emit() } })
  return {
    snapshot: () => ({ models, providers, loading, error }),
    dispose() { disposed = true; revision++; unsubscribeModels?.(); unsubscribeProviders?.(); listeners.clear() },
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    async refresh() {
      if (disposed) return
      const read = ++revision
      loading = true; emit()
      try {
        const [nextModels, nextProviders] = await Promise.all([
          api<readonly RunnableModelSummary[]>('/models'), api<readonly ProviderSettings[]>('/models/provider-settings'),
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

/** Refresh keeps an explicit selection only while that provider still exists. */
export function settingsProviderSelection(providers: readonly ProviderSettings[], selectedId?: string): ProviderSettings | undefined {
  return providers.find(value => value.id === selectedId)
}

/** Only new settings require a present models.dev provider. */
export function settingsProviderSourceAllowed(settings: ProviderSettings | undefined, provider: Pick<DirectoryProvider, 'source' | 'state'> | undefined): boolean {
  return Boolean(settings || provider?.state === 'present' && provider.source.kind === 'external' && provider.source.sourceId === 'models.dev')
}

interface ProviderListEntry {
  readonly id: string
  readonly name: string
  readonly settings?: ProviderSettings
  readonly definition?: DirectoryProvider
}

function providerConfigured(settings?: ProviderSettings): boolean {
  return Boolean(settings && (settings.auth === 'none' || settings.credentialConfigured))
}

export function settingsProviderGroups(providers: readonly ProviderSettings[], definitions: readonly DirectoryProvider[], search = '') {
  const query = search.trim().toLowerCase()
  const definitionsById = new Map(definitions.map(value => [value.id, value]))
  const configured: ProviderListEntry[] = [], other: ProviderListEntry[] = []
  const seen = new Set<string>()
  for (const settings of providers) {
    if (seen.has(settings.id)) continue
    const group = providerConfigured(settings) ? configured : other
    const definition = definitionsById.get(settings.id)
    group.push({ id: settings.id, name: settings.name, settings, ...(definition && { definition }) })
    seen.add(settings.id)
  }
  for (const definition of definitions) {
    if (!seen.has(definition.id) && settingsProviderSourceAllowed(undefined, definition)) {
      other.push({ id: definition.id, name: definition.name, definition })
      seen.add(definition.id)
    }
  }
  const byName = (a: ProviderListEntry, b: ProviderListEntry) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)
  const matches = ({ name, definition }: ProviderListEntry) => {
    if (!query) return true
    const source = definition?.source
    return [name, definition?.name, source?.kind === 'external' ? source.providerId : undefined]
      .some(value => value?.toLowerCase().includes(query))
  }
  return { configured: configured.filter(matches).sort(byName), other: other.filter(matches).sort(byName) }
}

export interface SettingsModelEditorState {
  readonly providerId: string
  readonly target: { readonly kind: 'model'; readonly id: string } | { readonly kind: 'draft' }
  readonly visible: boolean
  readonly expanded: boolean
}

/** A new draft remains an editing target even while its editor is collapsed. */
export function settingsModelEditorSelection(settings: readonly Pick<ModelSettings, 'id' | 'providerId'>[], providerId: string, remembered?: SettingsModelEditorState, hasDraft = false): SettingsModelEditorState | undefined {
  const own = settings.filter(value => value.providerId === providerId)
  const rememberedId = remembered?.target.kind === 'model' ? remembered.target.id : undefined
  if (remembered?.providerId === providerId && (remembered.target.kind === 'draft' ? hasDraft : own.some(value => value.id === rememberedId))) return remembered
  if (hasDraft) return { providerId, target: { kind: 'draft' }, visible: true, expanded: true }
  return own[0] ? { providerId, target: { kind: 'model', id: own[0].id }, visible: false, expanded: false } : undefined
}

const supportLabels: Readonly<Record<Support, string>> = { unknown: '未知', supported: '支持', unsupported: '不支持' }
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

/** Only new model settings receive descriptor defaults; saved omissions stay omitted. */
export function initialNativeParameters(fields: readonly FormField[], candidate?: { readonly limits?: DirectoryModel['limits']; readonly capabilities?: DeclaredCapabilities }): NativeObject {
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.defaultValue === undefined) continue
    if (field.key === 'generation_config.thinking_summaries' && candidate?.capabilities?.reasoning.support !== 'supported') continue
    let value = field.defaultValue
    if (['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'generation_config.max_output_tokens'].includes(field.key) && typeof value === 'number' && candidate?.limits?.output !== undefined) value = Math.min(value, candidate.limits.output)
    values[field.key] = field.type === 'enum' || field.type === 'boolean' ? JSON.stringify(value) : String(value)
  }
  // Required fields with no prefill are left for the user to enter in the form.
  return nativeParameterValues(fields.map(field => ({ ...field, required: false })), values)
}

export function setupModelsSettings(source: Api, messageFor: (error: unknown) => string, catalog: ModelsCatalog, container: HTMLElement) {
  const owned = createPageRequests(source), api = owned.api
  let disposed = false
  const root = container
  root.innerHTML = `
    <header class="settings-panel-heading"><h3 id="personal-agent--models-settings-title">模型管理</h3></header>
    <p class="models-notice" role="status" aria-live="polite" hidden></p>
    <fieldset class="models-controls">
      <div class="models-layout" data-management>
        <aside class="models-connections" aria-label="Provider 和模型">
          <div class="models-navigation" data-models-navigation data-view="providers">
            <div class="models-navigation-track">
              <section class="models-navigation-panel" data-provider-navigation aria-label="Provider 列表">
                <div class="models-pane-heading"><h4>Provider</h4><button type="button" class="models-quiet-button models-directory-refresh" data-directory-refresh aria-label="刷新目录" title="刷新目录">↻</button></div>
                <div class="models-provider-search">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
                  <input type="search" data-provider-search aria-label="按名称或目录 ID 搜索 Provider" placeholder="搜索" autocomplete="off">
                </div>
                <p data-provider-list-status class="settings-hint models-provider-list-status" role="status">正在读取…</p>
                <div class="models-connection-list" data-connections></div>
                <button type="button" class="models-quiet-button" data-reload-list hidden>刷新状态</button>
              </section>
              <section class="models-navigation-panel" data-model-navigation aria-label="模型列表" inert>
                <div class="models-pane-heading">
                  <button type="button" class="models-quiet-button" data-back-to-providers aria-label="返回 Provider 列表">‹ 返回</button>
                  <h4>模型</h4>
                  <button type="button" class="models-quiet-button" data-toggle-model-search aria-expanded="false" aria-controls="personal-agent--models-search">搜索</button>
                </div>
                <div class="models-model-toolbar" id="personal-agent--models-search" data-model-toolbar hidden><label>搜索模型<input type="search" data-model-search placeholder="名称或模型 ID"></label><label>可用状态<select data-model-filter><option value="all">全部模型</option><option value="available">可用模型</option><option value="unavailable">不可用模型</option></select></label></div>
                <div data-saved-model-navigation>
                  <p data-inventory-status class="settings-hint" role="status" hidden></p>
                  <ul data-connection-models class="models-model-list"></ul>
                </div>
              </section>
            </div>
          </div>
        </aside>
        <div class="models-main">
          <p class="models-empty-selection" data-provider-empty>请选择 Provider</p>
          <section class="models-provider-setup" data-provider-setup aria-labelledby="personal-agent--models-provider-setup-title" hidden>
            <div class="models-pane-heading">
              <h4 id="personal-agent--models-provider-setup-title" data-provider-setup-name></h4>
              <button type="button" class="models-quiet-button" data-cancel-provider-setup>取消</button>
            </div>
            <div data-setup-form-slot></div>
          </section>
          <section class="models-selected-provider models-model-section" data-selected-provider aria-labelledby="personal-agent--models-config-title" hidden>
            <div class="models-pane-heading">
              <h4 id="personal-agent--models-config-title" data-selected-provider-name></h4>
              <div class="models-pane-actions">
                <details class="models-management-actions">
                  <summary class="models-quiet-button">更多</summary>
                  <div class="models-action-menu">
                    <button type="button" data-open-provider-settings>API 设置</button>
                    <button type="button" data-new-model>添加自定义模型</button>
                    <button type="button" data-open-remote-models>获取远端模型</button>
                    <button type="button" data-reload>刷新状态</button>
                  </div>
                </details>
              </div>
            </div>
            <button type="button" class="models-quiet-button" data-provider-issue hidden></button>
            <details class="models-connection-editor" data-connection-editor hidden>
              <summary>API 设置</summary>
              <div data-manage-form-slot></div>
            </details>
            <details class="models-remote-models" data-remote-models hidden><summary>获取远端模型列表</summary><p class="settings-hint">目录中没有所需模型时，可从当前提供方获取候选，查看能力声明并配置生成参数。</p><button type="button" data-discover class="secondary-button">获取模型</button><label data-candidates-label hidden>远端候选<select data-candidates></select></label></details>
            <p class="models-empty-selection" data-model-empty>请选择模型</p>
            <details data-model-advanced class="models-model-editor" hidden><summary data-model-editor-title>模型参数</summary>
              <p data-model-status class="settings-hint" role="status"></p><div class="settings-actions"><button type="button" data-model-history class="secondary-button">模型设置版本</button></div>
              <form data-model-form>
                <div class="models-grid"><label>显示名称<input data-model-name required maxlength="200" placeholder="例如：深入分析"></label><label>远端模型标识<input data-remote-id required placeholder="提供方要求的 model ID"></label></div>
                <label class="models-check"><input data-model-enabled type="checkbox" checked>启用此模型</label>
                <fieldset class="models-parameters"><legend>生成参数</legend><p class="settings-hint">留空使用服务端默认值。</p><div class="models-grid" data-parameters></div><label data-server-search-label class="models-check" hidden><input type="checkbox" data-server-search>启用服务端网络搜索</label><p data-server-search-hint class="settings-hint" hidden>此模型尚未声明支持服务端网络搜索。</p></fieldset>
                <details class="models-capabilities"><summary>模型能力（只读）</summary><p class="settings-hint">以下为模型能力声明。实际推理开关、档位和预算在生成参数中设置。未知能力不会被认定为支持。</p><dl class="models-capability-list" data-capabilities></dl><p class="settings-hint">能力声明只读；如需调整，请修改执行设备上的模型配置 JSON 文件，停止并重新打开 Personal Agent 后生效。</p></details>
                <div class="settings-actions"><button type="submit" data-save-model>保存参数</button><button type="button" data-reset-model class="secondary-button">放弃修改</button><button type="button" data-close-model class="secondary-button">收起</button></div>
              </form>
            </details>
          </section>
          <details class="models-history" hidden><summary>配置版本历史</summary><ol></ol></details>
        </div>
      </div>
    </fieldset>
    <section data-provider-section class="models-provider-section" hidden>
      <form data-provider-form autocomplete="off">
        <label data-provider-recipe-row hidden>API 方案<select data-provider-recipe></select></label>
        <label>显示名称<input data-provider-name required maxlength="200" placeholder="例如：OpenAI"></label>
        <div class="models-grid"><label>API 协议<select data-protocol required></select></label><label>API 地址<input data-base-url required type="url" placeholder="https://api.example.com/v1"></label></div>
        <div class="models-key"><label>API Key<input data-api-key type="password" autocomplete="new-password" placeholder="填写 API Key"></label><p data-key-status class="settings-hint"></p><button type="button" data-delete-key class="secondary-button" hidden>删除 Key</button><div data-delete-confirm hidden><p>删除后，此提供方的模型将无法开始新运行。</p><div class="settings-actions"><button type="button" data-confirm-delete-key>确认删除</button><button type="button" data-cancel-delete-key class="secondary-button">取消</button></div></div></div>
        <details><summary>高级 API 设置</summary><p class="settings-hint" data-provider-origin></p><p class="settings-hint" data-provider-doc-row hidden><a data-provider-doc target="_blank" rel="noopener noreferrer">提供方文档</a></p><div class="models-grid"><label>认证方式<select data-auth><option value="api-key">API Key</option><option value="none">无需认证</option></select></label><label>无新内容超时（毫秒）<input data-timeout type="number" min="1" step="1" value="120000" required></label></div><label class="models-check"><input data-provider-enabled type="checkbox" checked>启用此提供方</label><div class="settings-actions"><button type="button" data-check class="secondary-button">检查已保存的 API 设置</button><button type="button" data-provider-history class="secondary-button">提供方设置版本</button></div></details>
        <p data-provider-draft class="models-draft-status" role="status"></p><div class="settings-actions"><button type="submit" data-save-provider>保存设置</button><button type="button" data-reset-provider class="secondary-button">放弃修改</button></div>
        <p data-sync-status class="settings-hint" role="status"></p><button type="button" data-retry-sync class="secondary-button" hidden>重试准备模型</button>
        <p class="settings-hint">API Key 保存在系统凭据库中，读取时仅显示配置状态。修改仅影响后续运行。</p>
      </form>
      <button type="button" data-delete-connection class="secondary-button models-danger-button">移除设置</button>
      <section class="settings-card models-delete-confirm" data-delete-connection-confirm aria-labelledby="personal-agent--models-delete-connection-title" hidden><h4 id="personal-agent--models-delete-connection-title">移除此提供方的设置？</h4><p data-delete-connection-description></p><p class="settings-hint">历史对话和已开始的运行会保留。如当前模型依赖此提供方，请选择其他可用模型后继续。</p><div class="settings-actions"><button type="button" data-confirm-delete-connection class="models-danger-button">确认移除设置</button><button type="button" data-cancel-delete-connection class="secondary-button">取消</button></div></section>
    </section>`
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const input = (name: string) => get<HTMLInputElement>(`[data-${name}]`)
  const select = (name: string) => get<HTMLSelectElement>(`[data-${name}]`)
  const protocolSelect = select('protocol'), key = input('api-key'), controls = get<HTMLFieldSetElement>('.models-controls')
  const notice = get<HTMLElement>('.models-notice'), providerSection = get('[data-provider-section]')
  const providerForm = get<HTMLFormElement>('[data-provider-form]'), modelEditor = get<HTMLDetailsElement>('[data-model-advanced]')
  const connectionEditor = get<HTMLDetailsElement>('[data-connection-editor]'), history = get<HTMLDetailsElement>('.models-history')
  const managementActions = get<HTMLDetailsElement>('.models-management-actions'), remoteModels = get<HTMLDetailsElement>('[data-remote-models]')
  const searchToolbar = get('[data-model-toolbar]'), searchButton = get<HTMLButtonElement>('[data-toggle-model-search]')
  const navigation = get('[data-models-navigation]'), providerNavigation = get('[data-provider-navigation]'), modelNavigation = get('[data-model-navigation]')
  const savedModelNavigation = get('[data-saved-model-navigation]'), providerSetup = get('[data-provider-setup]')
  const backToProviders = get<HTMLButtonElement>('[data-back-to-providers]')
  const providerSearch = input('provider-search'), providerList = get('[data-connections]')
  let protocols: readonly ProtocolDescriptor[] = []
  let providers: readonly ProviderSettings[] = [], records: readonly ModelSettings[] = [], candidates: readonly DiscoveredModel[] = []
  let definitions: readonly DirectoryProvider[] = [], inventory: readonly ProviderModel[] = []
  let inventoryRead = 0, reloadRead = 0, selectionRead = 0, secretRevision = 0, inventoryLoading = false, inventoryError = ''
  let provider: ProviderSettings | undefined, model: ModelSettings | undefined, busy = false, loaded = false, selectionResetPending = false
  let selectedProviderId = '', pendingModelId = ''
  let modelCapabilities = unknownCapabilities()
  let parameterFields: readonly FormField[] = [], draftKey = '', modelDraftKey = ''
  type Fields = Readonly<Record<string, string | boolean>>
  type Draft = { fields: Fields; baseFields: Fields; baseRevision?: number }
  const providerDrafts = new Map<string, Draft & { providerId: string }>(), preferredRecipes = new Map<string, string>()
  const modelEditors = new Map<string, SettingsModelEditorState>()
  const modelDrafts = new Map<string, Draft & { pendingModelId: string; capabilities: DeclaredCapabilities }>()
  let providerBaseFields: Fields = {}, modelBaseFields: Fields = {}, providerBaseRevision: number | undefined, modelBaseRevision: number | undefined
  const show = (text = '', failed = false) => { notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', failed) }
  const isConflict = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'conflict'
  const errorText = (error: unknown) => {
    if (isConflict(error)) return '配置已被其他页面修改，当前草稿仍在表单中。请先复制保留，再点击“放弃修改”加载最新配置。'
    return error instanceof Error && !(error instanceof TypeError) && !('status' in error) ? error.message : messageFor(error)
  }
  const currentProtocol = () => protocols.find(item => item.id === protocolSelect.value)
  const providerPath = (id = provider!.id) => `/models/provider-settings/${encodeURIComponent(id)}`
  const modelPath = () => `/models/settings/${encodeURIComponent(model!.id)}`
  const definition = () => definitions.find(value => value.id === selectedProviderId)
  const providerDraftKey = (id: string, recipeId: string | null = null) => JSON.stringify([id, recipeId])
  const providerFields = ['provider-name', 'base-url', 'timeout', 'provider-enabled'] as const
  const modelFields = ['model-name', 'remote-id', 'model-enabled', 'server-search'] as const
  function readFields(names: readonly string[]): Record<string, string | boolean> {
    return Object.fromEntries(names.map(name => [name, input(name).type === 'checkbox' ? input(name).checked : input(name).value]))
  }
  function writeFields(fields: Fields): void {
    for (const [name, value] of Object.entries(fields)) {
      const field = name.startsWith('parameter:') ? root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-parameter="${name.slice(10)}"]`) : input(name)
      if (!field) continue
      if (typeof value === 'boolean' && field instanceof HTMLInputElement) field.checked = value
      else field.value = String(value)
    }
  }
  function captureProvider(): void {
    if (!draftKey || !loaded) return
    const fields = readProviderFields()
    if (JSON.stringify(fields) === JSON.stringify(providerBaseFields)) providerDrafts.delete(draftKey)
    else providerDrafts.set(draftKey, { providerId: selectedProviderId, fields, baseFields: providerBaseFields, baseRevision: providerBaseRevision })
  }
  function discardProviderDrafts(id: string): void {
    for (const [key, draft] of providerDrafts) if (draft.providerId === id) providerDrafts.delete(key)
  }
  function readProviderFields(): Fields {
    return { ...readFields(providerFields), protocol: protocolSelect.value, auth: select('auth').value }
  }
  function readModelFields(): Record<string, string | boolean> {
    const fields = readFields(modelFields)
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-parameter]')) fields[`parameter:${field.dataset.parameter}`] = field.value
    return fields
  }
  function captureModel(): void {
    if (provider && modelDraftKey) modelEditors.set(provider.id, { providerId: provider.id,
      target: model ? { kind: 'model', id: model.id } : { kind: 'draft' }, visible: !modelEditor.hidden, expanded: modelEditor.open })
    if (!modelDraftKey || modelEditor.hidden) return
    const fields = readModelFields()
    if (model && JSON.stringify(fields) === JSON.stringify(modelBaseFields)) modelDrafts.delete(modelDraftKey)
    else modelDrafts.set(modelDraftKey, { fields, baseFields: modelBaseFields, baseRevision: modelBaseRevision, pendingModelId, capabilities: modelCapabilities })
  }
  function providerChanged(): boolean {
    return Boolean(selectedProviderId && (key.value || JSON.stringify(readProviderFields()) !== JSON.stringify(providerBaseFields)))
  }
  function updateDraftStatus(): void {
    const changed = providerChanged()
    get('[data-provider-draft]').textContent = changed ? provider?.revision !== providerBaseRevision ? '有未保存的修改；已保存配置有更新，保存时将检查版本。' : '有未保存的修改' : ''
    get('[data-provider-draft]').hidden = !changed
    get('[data-reset-provider]').hidden = !provider && !changed
  }
  function renderCapabilities(): void {
    const reasoning = modelCapabilities.reasoning
    const entries: readonly (readonly [string, string, string])[] = [
      ...([['tools', '工具调用'], ['streaming', '流式输出'], ['imageInput', '图片输入'], ['reasoning', '推理能力'], ['webSearch', '服务端网络搜索']] as const)
        .map(([name, label]) => [name, label, supportLabels[modelCapabilities[name]?.support ?? 'unknown']] as const),
      ['reasoning-efforts', '可用推理档位', reasoning.efforts?.join(', ') || '未声明'],
      ['reasoning-modes', '可用推理模式', reasoning.modes?.join(', ') || '未声明'],
      ['reasoning-budget', '推理预算范围', reasoning.budget ? `${reasoning.budget.min}–${reasoning.budget.max}` : '未声明'],
    ]
    get('[data-capabilities]').replaceChildren(...entries.map(([name, label, value]) => {
      const wrapper = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd')
      term.textContent = label; description.dataset.capability = name; description.textContent = value
      wrapper.append(term, description); return wrapper
    }))
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
  function loadModel(value?: ModelSettings, candidate?: DiscoveredModel, restore = true): void {
    model = value
    modelDraftKey = value?.id ?? (provider ? `new:${provider.id}` : '')
    const draft = restore ? modelDrafts.get(modelDraftKey) : undefined
    pendingModelId = value ? '' : draft?.pendingModelId ?? ''
    input('model-name').value = value?.name ?? candidate?.name ?? ''
    input('remote-id').value = value?.remoteModelId ?? candidate?.remoteModelId ?? ''
    input('remote-id').readOnly = Boolean(value || pendingModelId)
    input('model-enabled').checked = value?.enabled ?? true
    modelCapabilities = value?.capabilities ?? draft?.capabilities ?? { ...unknownCapabilities(), ...candidate?.suggestedCapabilities }
    renderParameters(value?.parameters.value ?? initialNativeParameters(currentProtocol()?.modelFields ?? [], { capabilities: modelCapabilities }))
    modelBaseFields = draft?.baseFields ?? readModelFields()
    modelBaseRevision = draft ? draft.baseRevision : value?.revision
    if (draft) writeFields(draft.fields)
    renderCapabilities()
    get('[data-model-editor-title]').textContent = value ? `模型参数 · ${value.name}` : '添加自定义模型'
    renderState()
  }
  function openModelEditor(value: ModelSettings): void {
    loadModel(value)
    modelEditor.hidden = false; modelEditor.open = true; renderState()
    modelEditor.querySelector('summary')?.focus()
  }
  function providerIssue(value: ProviderSettings): string | undefined {
    if (!value.enabled) return '已停用'
    if (!protocols.some(item => item.id === value.protocolId)) return '协议未安装'
    if (value.auth === 'api-key' && !value.credentialConfigured) return '待填写 Key'
    if (value.sync?.state === 'failed') return '模型准备失败'
    if (value.sync?.state === 'pending') return '等待准备'
  }

  function renderProviders(): void {
    const focus = document.activeElement
    const focusedId = focus instanceof HTMLButtonElement && providerList.contains(focus) ? focus.dataset.providerId : undefined
    const scrollTop = providerList.scrollTop
    const query = providerSearch.value.trim()
    const { configured, other } = settingsProviderGroups(providers, definitions, query)
    const hasResults = configured.length + other.length > 0
    const status = get('[data-provider-list-status]')
    status.hidden = hasResults || (!loaded && notice.classList.contains('error'))
    providerList.hidden = !hasResults
    status.textContent = !loaded ? '正在读取…' : query ? '没有匹配的 Provider' : '暂无 Provider'
    const buttons: HTMLButtonElement[] = []
    const providersWithDrafts = new Set([...providerDrafts.values()].map(value => value.providerId))
    const groups = [
      { key: 'configured', label: '已配置', entries: configured },
      { key: 'other', label: providers.some(providerConfigured) ? '其他 Provider' : '目录', entries: other },
    ].filter(group => group.entries.length)
    providerList.replaceChildren(...groups.map(({ key, label, entries }) => {
      const section = document.createElement('section')
      section.dataset.providerGroup = key
      const heading = document.createElement('h5')
      heading.className = 'models-provider-group-heading'; heading.textContent = label
      const rows = document.createElement('div')
      for (const entry of entries) {
        const button = providerButton(entry)
        buttons.push(button); rows.append(button)
      }
      section.append(heading, rows)
      return section
    }))
    providerList.scrollTop = scrollTop
    if (focusedId && !busy && !providerNavigation.inert) buttons.find(button => button.dataset.providerId === focusedId)?.focus({ preventScroll: true })

    function providerButton(value: ProviderListEntry): HTMLButtonElement {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'models-connection-item'
      button.dataset.providerId = value.id
      const selected = value.id === selectedProviderId && !selectionResetPending
      if (selected) button.setAttribute('aria-current', 'true')
      const icon = document.createElement('span')
      icon.className = 'models-provider-logo'
      icon.setAttribute('aria-hidden', 'true')
      const source = value.definition?.source
      const logo = source?.kind === 'external' && source.sourceId === 'models.dev' ? providerLogo(source.providerId) : undefined
      // Only the bundled and validated drawings go into SVG markup.
      if (logo) icon.innerHTML = logo
      else {
        icon.classList.add('models-provider-initial')
        icon.textContent = Array.from(value.name.trim())[0]?.toUpperCase() || '·'
      }
      const copy = document.createElement('span')
      const name = document.createElement('span')
      name.textContent = value.name
      copy.append(name)
      button.append(icon, copy)
      const issue = !selected && value.settings ? providerIssue(value.settings) : undefined
      const hasDraft = providersWithDrafts.has(value.id) || modelDrafts.has(`new:${value.id}`) ||
        records.some(record => record.providerId === value.id && modelDrafts.has(record.id))
      const label = issue ?? (hasDraft ? '有草稿' : '')
      if (label) {
        const status = document.createElement('span')
        status.className = 'models-provider-status'; status.textContent = label; copy.append(status)
      }
      button.addEventListener('click', () => {
        if (busy || providerNavigation.inert || value.id === selectedProviderId) return
        show(); captureProvider(); captureModel(); loadSelection(value.id)
        if (!modelNavigation.inert) backToProviders.focus({ preventScroll: true })
        else if (!providerSetup.hidden) (key.disabled ? input('provider-name') : key).focus({ preventScroll: true })
      })
      return button
    }
  }

  function renderModels(): void {
    // Keep the outgoing list intact until it has slid out of view.
    if (modelNavigation.inert || !provider) return
    const list = get('[data-connection-models]')
    const scrollTop = savedModelNavigation.scrollTop
    const summaries = catalog.snapshot().models
    const configured = records.filter(value => value.providerId === provider!.id)
    const providerUnavailable = !provider.enabled ? 'provider-disabled' : !currentProtocol() ? 'protocol-unavailable' :
      provider.auth === 'api-key' && !provider.credentialConfigured ? 'credential-missing' : undefined
    type ModelRow = { name: string; remoteId: string; settings?: ModelSettings; available: boolean; reason?: string }
    const rows: ModelRow[] = configured.map(settings => {
      const found = inventory.find(value => value.id === settings.id), summary = summaries.find(value => value.id === settings.runtimeModelId)
      const availability = summary ?? found
      const reason = availability?.unavailableReason === 'disabled' ? '已停用' :
        summary ? modelAvailability(summary) : found ? providerModelAvailability(found) : '状态未确认'
      return { name: settings.name, remoteId: settings.remoteModelId, settings, available: availability?.available ?? false,
        reason: providerUnavailable && availability?.unavailableReason === providerUnavailable ? undefined : reason }
    })
    for (const value of inventory) if (!configured.some(item => item.id === value.id)) rows.push({
      name: value.name, remoteId: value.remoteModelId, available: value.available,
      reason: providerUnavailable && value.unavailableReason === providerUnavailable ? undefined : value.unavailableReason === 'disabled' ? '已停用' : providerModelAvailability(value),
    })
    rows.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, 'zh-CN'))
    const search = input('model-search').value.trim().toLowerCase(), filter = select('model-filter').value
    const visible = rows.filter(value => `${value.name} ${value.remoteId}`.toLowerCase().includes(search) && (filter === 'all' || value.available === (filter === 'available')))
    const inventoryStatus = get('[data-inventory-status]')
    inventoryStatus.textContent = inventoryError || (inventoryLoading ? '正在读取模型…' : '')
    inventoryStatus.hidden = !inventoryStatus.textContent
    list.replaceChildren(...visible.map(value => {
      const row = document.createElement('li'); row.className = 'models-model-row'
      const settings = value.settings
      const name = document.createElement(settings && currentProtocol() ? 'button' : 'span')
      name.className = 'models-model-name'; name.textContent = value.name; row.append(name)
      if (name instanceof HTMLButtonElement && settings) {
        name.type = 'button'; name.dataset.modelSettingId = settings.id
        name.setAttribute('aria-label', `设置 ${value.name} 的参数`)
        if (model?.id === settings.id && !modelEditor.hidden && modelEditor.open) row.setAttribute('aria-current', 'true')
        name.addEventListener('click', () => { captureModel(); openModelEditor(settings) })
      }
      if (!value.available && value.reason) {
        const status = document.createElement('span')
        status.className = 'models-row-status'; status.textContent = value.reason; row.append(status)
      }
      return row
    }))
    if (!visible.length && !inventoryStatus.textContent) {
      const empty = document.createElement('li'); empty.className = 'models-list-empty'
      empty.textContent = search || filter !== 'all' ? '没有匹配的模型' : '暂无模型'; list.append(empty)
    }
    savedModelNavigation.scrollTop = scrollTop
  }

  function renderModelPrompt(): void {
    get('[data-model-empty]').hidden = !modelEditor.hidden || connectionEditor.open || remoteModels.open || !history.hidden && history.open
  }

  function renderState(): void {
    controls.disabled = busy
    const hasSelection = Boolean(selectedProviderId) && !selectionResetPending
    const browsingModels = hasSelection && providerConfigured(provider), settingUp = hasSelection && !browsingModels
    if (browsingModels && navigation.dataset.view !== 'models') {
      setSearchOpen(false)
      savedModelNavigation.scrollTop = 0
    }
    navigation.dataset.view = browsingModels ? 'models' : 'providers'
    providerNavigation.inert = browsingModels
    modelNavigation.inert = !browsingModels
    get('[data-provider-empty]').hidden = hasSelection
    get('[data-selected-provider]').hidden = !browsingModels
    providerSetup.hidden = !settingUp
    const catalogProvider = definition()
    get('[data-provider-setup-name]').textContent = provider?.name ?? catalogProvider?.name ?? ''
    get('[data-selected-provider-name]').textContent = provider?.name ?? ''
    get('[data-reload-list]').hidden = browsingModels || !notice.classList.contains('error')
    const slot = get(settingUp ? '[data-setup-form-slot]' : '[data-manage-form-slot]')
    if (providerSection.parentElement !== slot) slot.append(providerSection)
    providerSection.hidden = !hasSelection
    get('[data-provider-recipe-row]').hidden = Boolean(provider) || select('provider-recipe').options.length < 2
    protocolSelect.disabled = Boolean(provider)
    get('[data-provider-origin]').textContent = catalogProvider ? `来源：${sourceLabel(catalogProvider.source)}` : '提供方定义暂不可用'
    const documentationUrl = catalogProvider?.documentationUrl
    const documentLink = get<HTMLAnchorElement>('[data-provider-doc]')
    const documented = Boolean(documentationUrl && /^https?:\/\//i.test(documentationUrl))
    get('[data-provider-doc-row]').hidden = !documented
    if (documented && documentationUrl) documentLink.href = documentationUrl
    else documentLink.removeAttribute('href')
    const issue = provider && providerIssue(provider), issueButton = get('[data-provider-issue]')
    issueButton.hidden = !issue
    issueButton.textContent = issue ? `${issue} · API 设置` : ''
    get('[data-delete-connection]').hidden = !provider
    get('[data-delete-connection-description]').textContent = provider ? `将移除“${provider.name}”的 API 设置、Key 和 ${records.filter(value => value.providerId === provider!.id).length} 个模型的参数设置。目录中的提供方仍可重新添加。` : ''
    const sync = provider?.sync
    get('[data-sync-status]').textContent = sync?.state === 'failed' ? '提供方设置和 Key 已保存，模型准备失败。可重试，无需重新填写 Key。' : sync?.state === 'pending' ? '模型尚未准备；请确认提供方已启用、协议已安装并配置 Key。' : ''
    get<HTMLButtonElement>('[data-retry-sync]').hidden = !provider || sync?.state !== 'failed' && !(sync?.state === 'pending' && (provider.credentialConfigured || provider.auth === 'none'))
    key.disabled = select('auth').value === 'none'; get('.models-key').hidden = select('auth').value === 'none' && !provider?.credentialConfigured
    key.placeholder = provider?.credentialConfigured ? '留空保留现有 Key；填写新 Key 可替换' : '填写 API Key'
    get('[data-key-status]').textContent = provider?.credentialConfigured ? 'Key 已配置。填写新 Key 后，随设置一起保存。' : '填写并保存后，适用模型会自动加入模型选择器。'
    get<HTMLButtonElement>('[data-delete-key]').hidden = !provider?.credentialConfigured
    get<HTMLButtonElement>('[data-check]').disabled = !provider || !currentProtocol()?.supportsCheck
    get<HTMLButtonElement>('[data-provider-history]').disabled = !provider
    get<HTMLButtonElement>('[data-discover]').disabled = !provider || !currentProtocol()?.supportsDiscovery
    get<HTMLButtonElement>('[data-open-remote-models]').disabled = !provider || !currentProtocol()?.supportsDiscovery
    get<HTMLButtonElement>('[data-new-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-save-model]').disabled = !provider || !currentProtocol()
    get<HTMLButtonElement>('[data-model-history]').disabled = !model
    const searchable = ['responses', 'anthropic-messages'].includes(currentProtocol()?.id ?? '')
    const searchSupported = modelCapabilities.webSearch?.support === 'supported'
    get('[data-server-search-label]').hidden = !searchable
    get('[data-server-search-hint]').hidden = !searchable || searchSupported
    input('server-search').disabled = !searchable || !searchSupported
    // Configured providers can still edit neutral fields when their protocol is temporarily absent.
    get<HTMLButtonElement>('[data-save-provider]').disabled = !settingsProviderSourceAllowed(provider, catalogProvider) || !provider && !currentProtocol()
    get<HTMLButtonElement>('[data-save-provider]').textContent = busy ? '正在保存…' : settingUp ? '保存并查看模型' : '保存设置'
    const summary = catalog.snapshot().models.find(item => item.id === model?.runtimeModelId)
    get('[data-model-status]').textContent = summary ? `${modelAvailability(summary)} · ${sourceLabel(summary.source)}` : '保存后，此模型将加入当前提供方的列表。'
    updateDraftStatus(); renderProviders(); renderModels(); renderModelPrompt()
  }
  async function readInventory(id: string): Promise<void> {
    const read = ++inventoryRead
    const isCurrent = () => read === inventoryRead && selectedProviderId === id
    inventoryLoading = true; inventoryError = ''; renderModels()
    try {
      const next = await api<readonly ProviderModel[]>(`${providerPath(id)}/models`)
      if (isCurrent()) inventory = next
    } catch (error) { if (isCurrent()) inventoryError = errorText(error) }
    finally { if (isCurrent()) { inventoryLoading = false; renderState() } }
  }
  function setSearchOpen(open: boolean): void {
    searchToolbar.hidden = !open
    searchButton.setAttribute('aria-expanded', String(open))
    if (!open) { input('model-search').value = ''; select('model-filter').value = 'all' }
  }
  function openDetails(details: HTMLDetailsElement): void {
    managementActions.open = false
    details.hidden = false; details.open = true
    renderModelPrompt()
    details.querySelector('summary')?.focus()
  }
  function loadProvider(value?: ProviderSettings, {
    restore = true, fetchInventory = true, directoryProvider,
  }: { restore?: boolean; fetchInventory?: boolean; directoryProvider?: DirectoryProvider } = {}): void {
    const id = value?.id ?? directoryProvider?.id ?? ''
    selectionRead++
    if (id !== selectedProviderId || !providerConfigured(value)) {
      if (id && navigation.dataset.view === 'models') setSearchOpen(false)
      managementActions.open = false
      connectionEditor.open = false; connectionEditor.hidden = true
      remoteModels.open = false; remoteModels.hidden = true
    }
    provider = value; key.value = ''; candidates = []; inventory = []; inventoryError = ''; inventoryLoading = false; inventoryRead++
    pendingModelId = ''; modelDraftKey = ''
    selectedProviderId = id
    get('[data-candidates-label]').hidden = true; get('[data-delete-confirm]').hidden = true; get('[data-delete-connection-confirm]').hidden = true; history.hidden = true; modelEditor.hidden = true; modelEditor.open = false

    const recipes = directoryProvider?.connections ?? []
    const recipe = recipes.find(item => item.id === preferredRecipes.get(id)) ?? recipes[0]
    const recipeSelect = select('provider-recipe')
    recipeSelect.replaceChildren(...recipes.map(item => option(item.id, item.name)))
    recipeSelect.value = recipe?.id ?? ''
    draftKey = id ? providerDraftKey(id, value ? null : recipe?.id ?? '') : ''

    protocolSelect.replaceChildren(...protocols.map(item => option(item.id, item.name)))
    if (value && !protocols.some(item => item.id === value.protocolId)) protocolSelect.append(option(value.protocolId, `${value.protocolId} · 未安装`))
    const suggestedProtocol = directoryProvider?.connectionHints.protocolIds.find(id => protocols.some(item => item.id === id))
    protocolSelect.value = value?.protocolId ?? recipe?.values.protocolId ?? suggestedProtocol ?? protocols[0]?.id ?? ''
    input('provider-name').value = value?.name ?? directoryProvider?.name ?? ''
    input('base-url').value = value?.baseUrl ?? recipe?.values.baseUrl ?? directoryProvider?.connectionHints.baseUrl ?? ''
    select('auth').value = value?.auth ?? recipe?.values.auth ?? 'api-key'
    input('timeout').value = String(value?.timeoutMs ?? recipe?.values.timeoutMs ?? 120000)
    input('provider-enabled').checked = value?.enabled ?? true
    providerBaseFields = readProviderFields(); providerBaseRevision = value?.revision
    const draft = restore ? providerDrafts.get(draftKey) : undefined
    if (draft) {
      writeFields(Object.fromEntries(providerFields.map(name => [name, draft.fields[name]!])))
      select('auth').value = String(draft.fields.auth)
      if (!value) protocolSelect.value = String(draft.fields.protocol)
      providerBaseFields = draft.baseFields; providerBaseRevision = draft.baseRevision
    }
    const editor = value && providerConfigured(value) ? settingsModelEditorSelection(records, value.id, modelEditors.get(value.id), modelDrafts.has(`new:${value.id}`)) : undefined
    const editedId = editor?.target.kind === 'model' ? editor.target.id : undefined
    loadModel(editedId ? records.find(item => item.id === editedId) : undefined)
    modelEditor.hidden = !editor?.visible; modelEditor.open = Boolean(editor?.visible && editor.expanded)
    if (value && providerConfigured(value) && fetchInventory) void readInventory(value.id)
    renderState()
  }
  function loadSelection(id?: string, fetchInventory = true, restore = true): void {
    const current = settingsProviderSelection(providers, id)
    const candidate = current ? undefined : definitions.find(value => value.id === id)
    const directoryProvider = settingsProviderSourceAllowed(undefined, candidate) ? candidate : undefined
    loadProvider(current, { fetchInventory, restore, directoryProvider })
  }
  async function reload(): Promise<boolean> {
    const read = ++reloadRead
    const result = await Promise.all([
      api<readonly ProtocolDescriptor[]>('/models/protocols'),
      api<readonly ProviderSettings[]>('/models/provider-settings'), api<readonly ModelSettings[]>('/models/settings'),
      api<readonly DirectoryProvider[]>('/models/providers?includeMissing=true'), catalog.refresh(),
    ])
    if (read !== reloadRead) return false
    ;[protocols, providers, records, definitions] = result
    loaded = true
    return true
  }
  async function refreshCurrent(preserve = true): Promise<void> {
    const read = selectionRead, id = selectedProviderId
    const pendingKey = key.value, keyRead = secretRevision, pendingKeyDraft = draftKey
    if (preserve) { captureProvider(); captureModel() }
    if (!await reload() || read !== selectionRead) return
    if (id) {
      loadSelection(id, false, preserve)
      if (!disposed && draftKey === pendingKeyDraft && keyRead === secretRevision) key.value = pendingKey
      if (provider && providerConfigured(provider)) await readInventory(provider.id)
    }
    renderState()
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return
    busy = true; show(); renderState()
    try { await action() } catch (error) { if (!disposed) show(errorText(error), true) }
    finally {
      busy = false
      if (!disposed) {
        if (selectionResetPending) resetSelection()
        else renderState()
      }
    }
  }
  function resetSelection(): void {
    selectionResetPending = false
    captureProvider(); captureModel()
    show()
    loadProvider()
    providerList.scrollTop = 0
  }
  function resetView(): void {
    if (disposed) return
    const wasSearching = Boolean(providerSearch.value)
    providerSearch.value = ''
    if (!selectedProviderId) {
      providerList.scrollTop = 0
      if (wasSearching) renderProviders()
      return
    }
    secretRevision++; key.value = ''
    // A mutation already accepted by the page still owns its provider until it settles.
    if (busy) { selectionResetPending = true; renderState() }
    else resetSelection()
  }
  function returnToProviderList(): void {
    if (busy || !selectedProviderId) return
    const id = selectedProviderId
    captureProvider(); captureModel(); secretRevision++; show(); loadProvider()
    const rows = [...providerNavigation.querySelectorAll<HTMLButtonElement>('[data-provider-id]')]
    const next = rows.find(button => button.dataset.providerId === id) ?? providerSearch
    next.focus({ preventScroll: true })
  }
  providerForm.addEventListener('input', updateDraftStatus)
  providerForm.addEventListener('change', updateDraftStatus)
  function adoptProvider(value: ProviderSettings): void {
    selectionRead++; provider = value; selectedProviderId = value.id
    providers = providers.some(item => item.id === value.id) ? providers.map(item => item.id === value.id ? value : item) : [...providers, value]
    discardProviderDrafts(value.id); preferredRecipes.delete(value.id); draftKey = providerDraftKey(value.id)
    providerBaseRevision = value.revision; providerBaseFields = readProviderFields()
  }
  function observeProvider(value: ProviderSettings): void {
    // Key-only and sync operations keep configuration drafts; advance only our own revision.
    if (providerBaseRevision === provider?.revision) providerBaseRevision = value.revision
    selectionRead++; provider = value
    providers = providers.map(item => item.id === value.id ? value : item)
  }
  providerForm.addEventListener('submit', event => {
    event.preventDefault()
    const wasSettingUp = !providerConfigured(provider)
    void perform(async () => {
      captureModel()
      const name = input('provider-name').value.trim(), apiKey = key.value
      if (!name) throw new Error('请填写显示名称。')
      if (!settingsProviderSourceAllowed(provider, definition())) throw new Error('请先从 models.dev 目录选择提供方。')
      if (!provider?.credentialConfigured && select('auth').value === 'api-key' && !apiKey.trim()) throw new Error('请输入 API Key。')
      const values: ProviderSettingsInput = { name, protocolId: protocolSelect.value, baseUrl: input('base-url').value.trim(), auth: select('auth').value as ProviderSettingsInput['auth'], timeoutMs: Number(input('timeout').value), enabled: input('provider-enabled').checked }
      const { protocolId: _protocol, ...patch } = values
      const existing = Boolean(provider)
      let saved: ProviderSettings
      try {
        saved = provider
          ? await api<ProviderSettings>(providerPath(), { patch, expectedRevision: providerBaseRevision ?? provider.revision })
          : await api<ProviderSettings>('/models/provider-settings', { providerId: selectedProviderId, ...values, ...(apiKey && values.auth === 'api-key' ? { apiKey } : {}) })
      } catch (error) {
        if (existing || !isConflict(error)) throw error
        if (!await reload()) throw error
        const current = providers.find(value => value.id === selectedProviderId)
        if (!current) throw error
        discardProviderDrafts(current.id); preferredRecipes.delete(current.id)
        loadProvider(current)
        if (providerConfigured(current)) openDetails(connectionEditor)
        show('此提供方已在其他页面添加。请查看现有 API 设置。')
        return
      }
      adoptProvider(saved)
      if (existing && apiKey && values.auth === 'api-key') {
        // Keep the accepted revision if only the following Key operation fails.
        try { saved = await api<ProviderSettings>(`${providerPath()}/key`, { apiKey, expectedRevision: saved.revision }) }
        catch (error) { await catalog.refresh(); throw new Error(`提供方设置已保存，Key 保存失败：${errorText(error)}。可重试保存。`) }
        adoptProvider(saved)
      }
      key.value = ''
      try { await refreshCurrent() }
      catch (error) { show(`提供方设置已保存，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
      if (!selectionResetPending && wasSettingUp && providerConfigured(saved)) providerList.scrollTop = 0
      show(saved.sync?.state === 'failed' ? '提供方设置和 Key 已保存，模型准备失败，请点击重试。' : saved.sync?.state === 'pending' ? '提供方设置已保存，模型尚未准备；请检查 API 设置。' : '提供方设置已保存，可用模型已加入模型选择器。', saved.sync?.state === 'failed')
    }).then(() => {
      if (wasSettingUp && !modelNavigation.inert) backToProviders.focus({ preventScroll: true })
    })
  })
  const recipeSelect = select('provider-recipe')
  recipeSelect.addEventListener('change', () => {
    if (busy || provider) return
    const directoryProvider = definition()
    if (!directoryProvider?.connections.some(value => value.id === recipeSelect.value)) return
    captureProvider()
    preferredRecipes.set(directoryProvider.id, recipeSelect.value)
    secretRevision++
    loadProvider(undefined, { directoryProvider })
  })
  protocolSelect.addEventListener('change', () => { captureModel(); renderParameters(initialNativeParameters(currentProtocol()?.modelFields ?? [], { capabilities: modelCapabilities })); renderState() })
  select('auth').addEventListener('change', () => { secretRevision++; key.value = ''; renderState() })
  providerSearch.addEventListener('input', () => {
    providerList.scrollTop = 0
    renderProviders()
  })
  backToProviders.addEventListener('click', returnToProviderList)
  get('[data-cancel-provider-setup]').addEventListener('click', returnToProviderList)
  get('[data-directory-refresh]').addEventListener('click', () => { void perform(async () => {
    const status = await api<CatalogStatus>('/models/catalog/refresh', {})
    await refreshCurrent()
    const error = directoryRefreshError(status)
    show(error ?? '目录已刷新。', Boolean(error))
  }) })
  for (const selector of ['[data-open-provider-settings]', '[data-provider-issue]']) get(selector).addEventListener('click', () => openDetails(connectionEditor))
  get('[data-open-remote-models]').addEventListener('click', () => openDetails(remoteModels))
  for (const details of [connectionEditor, remoteModels]) details.addEventListener('toggle', () => {
    if (!details.open) {
      const restoreFocus = details.contains(document.activeElement)
      details.hidden = true
      if (restoreFocus) managementActions.querySelector('summary')?.focus()
    }
    renderModelPrompt()
  })
  history.addEventListener('toggle', renderModelPrompt)
  searchButton.addEventListener('click', () => {
    setSearchOpen(searchToolbar.hidden)
    if (searchToolbar.hidden) updateModelSearch()
    else input('model-search').focus()
  })
  get('[data-reset-provider]').addEventListener('click', () => {
    captureModel()
    discardProviderDrafts(selectedProviderId)
    loadSelection(selectedProviderId, true, false)
    show('已放弃未保存的修改。')
  })
  function resumeModelDraft(): boolean {
    if (!provider || !modelDrafts.has(`new:${provider.id}`)) return false
    loadModel()
    modelEditor.hidden = false; modelEditor.open = true; renderState(); input('model-name').focus()
    show('已恢复未保存的新模型。放弃修改后可重新创建。')
    return true
  }
  get('[data-new-model]').addEventListener('click', () => {
    managementActions.open = false
    captureModel(); if (resumeModelDraft()) return
    loadModel(undefined, undefined, false)
    modelEditor.hidden = false; modelEditor.open = true; renderState(); input('model-name').focus()
  })
  get('[data-close-model]').addEventListener('click', () => {
    modelEditor.open = false; captureModel(); renderState()
    const row = [...root.querySelectorAll<HTMLButtonElement>('[data-model-setting-id]')].find(button => button.dataset.modelSettingId === model?.id)
    const target = row ?? managementActions.querySelector('summary')
    target?.focus()
  })
  get('[data-reset-model]').addEventListener('click', () => {
    modelDrafts.delete(modelDraftKey)
    if (model) loadModel(model, undefined, false)
    else { pendingModelId = ''; modelEditor.hidden = true; modelEditor.open = false }
    renderState(); show('已放弃未保存的模型修改。')
  })
  function updateModelSearch(): void {
    savedModelNavigation.scrollTop = 0
    renderModels()
  }
  input('model-search').addEventListener('input', updateModelSearch); select('model-filter').addEventListener('change', updateModelSearch)
  for (const selector of ['[data-reload]', '[data-reload-list]']) get(selector).addEventListener('click', () => {
    managementActions.open = false
    void perform(async () => {
      await refreshCurrent()
      show('已刷新状态，未保存的修改已保留。')
    })
  })
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
    const own = records.filter(value => value.providerId === removed.id)
    await api(`${providerPath(removed.id)}/delete`, { expectedRevision: removed.revision })
    discardProviderDrafts(removed.id); preferredRecipes.delete(removed.id); modelEditors.delete(removed.id); modelDrafts.delete(`new:${removed.id}`)
    for (const value of own) modelDrafts.delete(value.id)
    providers = providers.filter(value => value.id !== removed.id); records = records.filter(value => value.providerId !== removed.id)
    secretRevision++
    loadProvider()
    try { await refreshCurrent() }
    catch (error) { show(`提供方已移除，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show(`已移除“${removed.name}”的设置。历史对话和已开始的运行已保留。`)
  }) })
  get('[data-cancel-delete-key]').addEventListener('click', () => { get('[data-delete-confirm]').hidden = true })
  get('[data-confirm-delete-key]').addEventListener('click', () => { if (provider) void perform(async () => {
    const saved = await api<ProviderSettings>(`${providerPath()}/key/delete`, { expectedRevision: provider!.revision })
    observeProvider(saved); key.value = ''; get('[data-delete-confirm]').hidden = true
    try { await refreshCurrent() } catch (error) { show(`Key 已删除，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show('Key 已删除。此提供方的模型现已不可用。')
  }) })
  get('[data-retry-sync]').addEventListener('click', () => { if (provider) void perform(async () => {
    const retried = await api<ProviderSettings>(`${providerPath()}/retry`, {}); observeProvider(retried)
    try { await refreshCurrent() } catch (error) { show(`已完成重试，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
    show(retried.sync?.state === 'failed' ? '模型准备仍未成功，请稍后重试。' : retried.sync?.state === 'pending' ? '模型仍在等待准备，请检查 API 设置。' : '模型已准备，可在输入框选择。', retried.sync?.state === 'failed')
  }) })
  get('[data-check]').addEventListener('click', () => { if (provider) void perform(async () => { await api(`${providerPath()}/check`, {}); show('已保存的 API 设置检查成功。') }) })
  get('[data-discover]').addEventListener('click', () => { if (provider) void perform(async () => {
    candidates = await api<readonly DiscoveredModel[]>(`${providerPath()}/discover`, {})
    select('candidates').replaceChildren(option('', '选择候选模型'), ...candidates.map((value, index) => option(String(index), `${value.name} · ${value.remoteModelId}`)))
    get('[data-candidates-label]').hidden = !candidates.length; show(candidates.length ? `找到 ${candidates.length} 个候选模型，请查看能力声明并配置生成参数后保存。` : '未返回候选模型，可添加自定义模型。')
  }) })
  select('candidates').addEventListener('change', () => {
    if (select('candidates').value === '') return
    captureModel(); if (resumeModelDraft()) return
    loadModel(undefined, candidates[Number(select('candidates').value)], false); modelEditor.hidden = false; modelEditor.open = true; renderState()
  })
  function readNativeParameters(): NativeObject {
    const values = Object.fromEntries([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-parameter]')].map(field => [field.dataset.parameter!, field.value]))
    const value = nativeParameterValues(parameterFields, values)
    if (!input('server-search').checked) return value
    if (modelCapabilities.webSearch?.support !== 'supported') throw new Error('此模型尚未声明支持服务端网络搜索。')
    if (provider?.protocolId === 'responses') return { ...value, tools: [{ type: 'web_search' }] }
    if (provider?.protocolId === 'anthropic-messages') return { ...value, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }
    throw new Error('此协议尚未支持服务端网络搜索。')
  }
  get<HTMLFormElement>('[data-model-form]').addEventListener('submit', event => {
    event.preventDefault()
    const selected = provider
    if (!selected) return
    void perform(async () => {
      const name = input('model-name').value.trim(), remoteModelId = input('remote-id').value.trim()
      if (!name || !remoteModelId) throw new Error('请填写模型名称和远端模型标识。')
      const definitionForRemoteId = () => inventory.find(value => value.remoteModelId === remoteModelId)
      const settingsForRemoteId = () => {
        const definitionId = definitionForRemoteId()?.id
        return records.find(value => value.providerId === selected.id && (value.remoteModelId === remoteModelId || value.id === definitionId))
      }
      const openExisting = (existing: ModelSettings) => {
        modelDrafts.delete(modelDraftKey)
        openModelEditor(existing)
        show('已打开该模型的现有参数设置。修改后可保存。')
      }
      if (!model) {
        const existing = settingsForRemoteId()
        if (existing) { openExisting(existing); return }
      }
      let capabilities = model?.capabilities ?? modelCapabilities
      const existingDefinition = model ? undefined : definitionForRemoteId()
      if (existingDefinition) {
        if (existingDefinition.source.kind !== 'user') throw new Error('该模型已在目录中，请在模型列表查看可用状态。')
        modelCapabilities = capabilities = existingDefinition.capabilities
      }
      const parameters: ModelSettingsInput['parameters'] = { protocolId: selected.protocolId, formatVersion: 1, value: readNativeParameters() }
      const patch = { name, enabled: input('model-enabled').checked, parameters }
      let saved: ModelSettings
      try {
        if (model) saved = await api<ModelSettings>(modelPath(), { patch, expectedRevision: modelBaseRevision ?? model.revision })
        else {
          if (!pendingModelId) {
            const definition: ModelInput = { providerId: selected.id, name, remoteModelId, capabilities, controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { baseUrl: selected.baseUrl, protocolIds: [selected.protocolId] } }
            pendingModelId = existingDefinition?.id ?? (await api<Model>('/models/definitions', definition)).id
            input('remote-id').readOnly = true
          }
          const settings: ModelSettingsInput = { ...patch, capabilities }
          saved = await api<ModelSettings>('/models/settings', { modelId: pendingModelId, ...settings })
        }
      } catch (error) {
        if (model || !isConflict(error)) throw error
        await refreshCurrent()
        const existing = settingsForRemoteId()
        if (!existing) throw error
        openExisting(existing)
        return
      }
      modelDrafts.delete(modelDraftKey)
      records = records.some(value => value.id === saved.id) ? records.map(value => value.id === saved.id ? saved : value) : [...records, saved]
      loadModel(saved, undefined, false)
      try { await refreshCurrent() }
      catch (error) { show(`模型已保存，状态刷新失败：${errorText(error)}。请点击“刷新状态”。`, true); return }
      show('模型参数已保存，模型选择器已更新。')
    })
  })
  for (const kind of ['provider', 'model'] as const) get(`[data-${kind}-history]`).addEventListener('click', () => {
    if (kind === 'provider' ? !provider : !model) return
    void perform(async () => {
      const versions = await api<readonly (ProviderSettings | ModelSettings)[]>(`${kind === 'provider' ? providerPath() : modelPath()}/history`)
      history.querySelector('ol')!.replaceChildren(...versions.map(value => {
        const item = document.createElement('li'), title = document.createElement('strong'), details = document.createElement('pre')
        title.textContent = `v${value.revision} · ${new Date(value.updatedAt).toLocaleString('zh-CN')}`; details.textContent = JSON.stringify(value, null, 2); item.append(title, details); return item
      }))
      history.hidden = false; history.open = true; history.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  })
  void perform(async () => { await reload() })
  return {
    resetView,
    canLeave() {
      if (owned.writing) { show('正在保存，请稍后切换。'); return false }
      captureProvider(); captureModel()
      const changed = key.value || [...providerDrafts.values(), ...modelDrafts.values()].some(draft => JSON.stringify(draft.fields) !== JSON.stringify(draft.baseFields))
      if (changed) { show('有尚未保存的修改。请先保存或放弃修改，再切换页面。'); return false }
      return true
    },
    async dispose() {
      disposed = true; secretRevision++; key.value = ''; reloadRead++; inventoryRead++; selectionRead++
      await owned.dispose()
    },
  }
}

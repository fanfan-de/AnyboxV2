import type { CatalogStatus, ConnectionModel, ProviderTemplate, ProviderConnection, SourceRef } from '@anybox/models'
import type { Api, DirectoryModel, DirectoryProvider } from './client-types.js'

export interface DirectoryState {
  readonly status?: CatalogStatus
  readonly providers: readonly DirectoryProvider[]
  readonly models: readonly DirectoryModel[]
  readonly providerId?: string
  readonly checking: boolean
  readonly errors: Readonly<Partial<Record<'status' | 'providers' | 'models' | 'refresh', string>>>
  readonly error?: string
}

/** Public reference data has its own reads and never writes a local model selection. */
export function createModelsDirectory(api: Api, messageFor: (error: unknown) => string) {
  let state: DirectoryState = { providers: [], models: [], checking: false, errors: {} }
  let statusRead = 0, providerRead = 0, modelRead = 0, refreshRead = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<DirectoryState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const result = (kind: keyof DirectoryState['errors'], patch: Partial<DirectoryState>, error?: string) => {
    const errors = { ...state.errors }
    if (error === undefined) delete errors[kind]
    else errors[kind] = error
    publish({ ...patch, errors, error: errors.refresh ?? errors.providers ?? errors.models ?? errors.status })
  }
  const failed = (kind: keyof DirectoryState['errors'], error: unknown, signal?: AbortSignal) => {
    if (!signal?.aborted) result(kind, {}, messageFor(error))
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    invalidate() { statusRead++; providerRead++; modelRead++; refreshRead++; publish({ checking: false }) },
    async readStatus(signal?: AbortSignal) {
      if (signal?.aborted) return
      const read = ++statusRead
      try {
        const status = await api<CatalogStatus>('/models/catalog', undefined, signal)
        if (read === statusRead && !signal?.aborted) result('status', { status })
      } catch (error) { if (read === statusRead) failed('status', error, signal) }
    },
    async readProviders(search = '', signal?: AbortSignal) {
      if (signal?.aborted) return
      const read = ++providerRead
      try {
        const providers = await api<readonly DirectoryProvider[]>(`/models/providers?${new URLSearchParams({ search })}`, undefined, signal)
        if (read === providerRead && !signal?.aborted) result('providers', { providers })
      } catch (error) { if (read === providerRead) failed('providers', error, signal) }
    },
    async readModels(providerId: string, search = '', includeDeprecated = false, signal?: AbortSignal) {
      if (signal?.aborted) return
      const read = ++modelRead
      if (providerId !== state.providerId) publish({ providerId, models: [] })
      if (!providerId) { result('models', { models: [] }); return }
      try {
        const models = await api<readonly DirectoryModel[]>(`/models/definitions?${new URLSearchParams({ providerId, search, includeDeprecated: String(includeDeprecated) })}`, undefined, signal)
        if (read === modelRead && !signal?.aborted) result('models', { models })
      } catch (error) { if (read === modelRead) failed('models', error, signal) }
    },
    async refresh(signal?: AbortSignal) {
      if (signal?.aborted || state.checking) return
      const read = ++refreshRead
      statusRead++
      publish({ checking: true })
      try {
        const status = await api<CatalogStatus>('/models/catalog/refresh', {}, signal)
        if (read === refreshRead && !signal?.aborted) { statusRead++; result('refresh', { status }) }
      } catch (error) { if (read === refreshRead) failed('refresh', error, signal) }
      finally { if (read === refreshRead) publish({ checking: false }) }
    },
  }
}

export function catalogSupportsText(model: DirectoryModel): boolean {
  return !['embedding', 'image', 'audio', 'video', 'rerank', 'reranker', 'decision'].includes(model.modelType ?? '') &&
    (!model.modalities.input.length || model.modalities.input.includes('text')) &&
    (!model.modalities.output.length || model.modalities.output.includes('text'))
}
export function catalogMatchesConnection(model: DirectoryModel, connection: ProviderConnection | undefined): boolean {
  return Boolean(connection && connection.providerDefinitionId === model.providerId &&
    (model.connectionHints.protocolIds.includes(connection.protocolId) ||
      model.source.kind === 'user' && !model.connectionHints.protocolIds.length ||
      model.connections.some(recipe => recipe.values.protocolId === connection.protocolId)))
}
export function sourceLabel(source: SourceRef): string {
  return source.kind === 'user' ? '用户自定义' : `${source.sourceId} / ${source.providerId}`
}
export function connectionModelAvailability(model: ConnectionModel): string {
  if (model.available) return '可用'
  return { disabled: '模型已停用', 'provider-disabled': '连接已停用', 'protocol-unavailable': '协议未安装',
    'credential-missing': '尚未配置 Key', 'invalid-configuration': '需要调整配置', 'protocol-unmapped': '当前协议不适用',
    'connection-mismatch': '需要另一连接地址', 'non-text': '当前不支持此模态', 'deprecated': '模型已弃用',
    missing: '来源已移除', unresolved: '来源尚未解析', 'definition-missing': '来源已移除', 'text-unsupported': '当前不支持此模态' }[model.unavailableReason ?? 'invalid-configuration'] ?? '当前不可用'
}
const statusErrors = {
  unavailable: '目录来源暂时不可用', 'invalid-response': '目录数据未通过校验',
  'storage-unavailable': '目录缓存无法持久保存', 'cleanup-failure': '目录请求资源未能正常退出', timeout: '目录检查超时',
}
const date = (value?: number) => value === undefined ? '尚未在线检查' : new Date(value).toLocaleString('zh-CN')
function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement('option'); item.value = value; item.textContent = label; return item
}

interface DirectoryActions {
  context(): { readonly connection?: ProviderConnection; readonly connections: readonly ProviderConnection[]; readonly models: readonly ConnectionModel[]; readonly ready: boolean; readonly busy: boolean; readonly providerDefinitionId?: string; readonly protocolId?: string }
  refreshConfigured(): Promise<void>
  selectProvider(provider: DirectoryProvider): void
  useConnection(provider: DirectoryProvider, recipe?: ProviderTemplate, focus?: boolean): void
}

export function setupModelsDirectory(root: HTMLElement, api: Api, messageFor: (error: unknown) => string, actions: DirectoryActions) {
  root.innerHTML = `
    <div class="models-card-heading models-directory-heading"><div><h4>选择提供方</h4><p>从目录填写连接信息。</p></div><button type="button" data-directory-refresh class="secondary-button">刷新目录</button></div>
    <p data-directory-status class="settings-hint" role="status" aria-live="polite">正在读取模型目录。</p>
    <p data-directory-error class="models-notice error" role="status" hidden></p>
    <div class="models-directory-grid">
      <div><label>搜索提供方<input type="search" data-directory-provider-search placeholder="名称或 ID"></label>
        <p data-directory-provider-count class="settings-hint" role="status" aria-live="polite"></p>
        <ul data-directory-providers class="models-provider-list" aria-label="提供方列表"></ul>
        <p data-directory-provider-empty class="settings-hint" hidden></p>
        <p data-directory-origin class="settings-hint"></p><p class="settings-hint"><a data-directory-doc target="_blank" rel="noopener noreferrer" hidden>提供方文档</a></p>
        <label>连接方案<select data-directory-connection aria-label="目录连接方案"></select></label>
        <div class="settings-actions"><button type="button" data-directory-new-connection class="secondary-button">填写 API Key</button></div>
        <p data-directory-guidance class="settings-hint">保存连接后，会自动准备该连接适用的模型。</p>
      </div>
    </div>
    <details class="models-provider-preview"><summary>查看模型目录</summary>
      <div><label>搜索模型<input type="search" data-directory-model-search placeholder="名称或远端模型 ID"></label><label>此提供方的模型<select data-directory-model aria-label="目录模型"></select></label>
        <label class="models-check"><input type="checkbox" data-directory-deprecated>显示已弃用模型</label>
        <p data-directory-metadata class="models-directory-metadata"></p>
      </div>
    </details>
    <details class="models-directory-provenance"><summary>目录信息</summary><p data-directory-provenance class="settings-hint models-directory-metadata"></p></details>`
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const providerList = get<HTMLUListElement>('[data-directory-providers]'), modelSelect = get<HTMLSelectElement>('[data-directory-model]')
  const connectionSelect = get<HTMLSelectElement>('[data-directory-connection]')
  const providerSearch = get<HTMLInputElement>('[data-directory-provider-search]'), modelSearch = get<HTMLInputElement>('[data-directory-model-search]')
  const deprecated = get<HTMLInputElement>('[data-directory-deprecated]')
  const directory = createModelsDirectory(api, messageFor)
  const dialog = root.closest<HTMLDialogElement>('dialog')
  let active = false, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let providerSearchTimer: ReturnType<typeof setTimeout> | undefined, modelSearchTimer: ReturnType<typeof setTimeout> | undefined
  let recipes: readonly ProviderTemplate[] = [], generation = 0
  let selectedProviderId = '', selectedModelId = '', selectedRecipeId = '', configuredRefreshError: string | undefined
  let providerRows: { id: string; row: HTMLLIElement; button: HTMLButtonElement; name: HTMLElement; source: HTMLElement; count: HTMLElement }[] = []
  const knownProviders = new Map<string, DirectoryProvider>()
  const selectedProvider = () => directory.snapshot().providers.find(item => item.id === selectedProviderId) ?? knownProviders.get(selectedProviderId)
  const selectedModel = () => directory.snapshot().models.find(item => item.id === selectedModelId && item.providerId === selectedProviderId)
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const visible = () => (dialog ? dialog.open : root.isConnected) && !root.closest('[hidden]')
  const current = (read: number, signal?: AbortSignal): signal is AbortSignal => Boolean(active && read === generation && signal && signal === controller?.signal && !signal.aborted)
  function render(): void {
    const state = directory.snapshot(), context = actions.context()
    for (const item of state.providers) knownProviders.set(item.id, item)
    const provider = selectedProvider(), model = selectedModel()
    const connection = context.connection?.providerDefinitionId === selectedProviderId ? context.connection : undefined
    const status = state.status
    get('[data-directory-status]').textContent = state.checking || status?.refreshing ? '正在更新目录…' : status ? `${status.stale ? '离线目录' : '目录已更新'} · ${date(status.checkedAt ?? status.fetchedAt)}` : '正在读取模型目录。'
    get('[data-directory-provenance]').textContent = status ? [
      `${status.sourceId} · ${status.origin === 'bundled' ? '内置离线快照' : status.origin === 'cache' ? '本地缓存' : status.origin === 'store' ? '已保存目录' : '在线快照'} · ${status.stale ? '待更新' : '已检查'}`,
      `快照：${date(status.fetchedAt)}；最近检查：${date(status.checkedAt)}`,
      `快照版本：${status.snapshotVersion}`,
      `缓存：${status.cache.persistence === 'memory' ? '仅内存' : '本地数据库'}${status.nextRefreshAt === undefined ? '' : `；下次检查：${date(status.nextRefreshAt)}`}`,
    ].join('\n') : '尚未读取目录来源。'
    const error = configuredRefreshError ?? state.error ?? (status?.error ? statusErrors[status.error] : status?.cache.error ? statusErrors[status.cache.error] : undefined)
    get('[data-directory-error]').textContent = error ? `${error}。可继续使用已保存连接和模型。` : ''
    get('[data-directory-error]').hidden = !error
    get<HTMLButtonElement>('[data-directory-refresh]').disabled = state.checking || Boolean(status?.refreshing)
    const candidates = state.providers
    if (providerRows.length !== candidates.length || providerRows.some((row, index) => row.id !== candidates[index].id)) {
      providerRows = candidates.map(item => {
        const row = document.createElement('li'), button = document.createElement('button'), heading = document.createElement('span')
        const name = document.createElement('strong'), source = document.createElement('span'), count = document.createElement('span')
        button.type = 'button'; button.className = 'models-directory-provider-item'; button.dataset.directoryProviderId = item.id
        heading.className = 'models-directory-provider-heading'; source.className = 'models-connection-meta'; count.className = 'models-status-badge'
        heading.append(name, count); button.append(heading, source); row.append(button)
        return { id: item.id, row, button, name, source, count }
      })
      providerList.replaceChildren(...providerRows.map(item => item.row))
    }
    providerRows.forEach((row, index) => {
      const item = candidates[index], count = context.connections.filter(value => value.providerDefinitionId === item.id).length
      row.name.textContent = item.name; row.source.textContent = sourceLabel(item.source); row.source.title = row.source.textContent
      row.count.textContent = count ? `${count} 个连接` : '未添加'; row.count.dataset.tone = count ? 'ready' : 'muted'
      row.button.setAttribute('aria-pressed', String(item.id === selectedProviderId)); row.button.disabled = !context.ready || context.busy
    })
    get('[data-directory-provider-count]').textContent = `${candidates.length} 个提供方`
    const empty = get('[data-directory-provider-empty]')
    empty.hidden = candidates.length > 0
    empty.textContent = providerSearch.value.trim() ? '没有匹配的提供方，请调整搜索。' : '暂时没有提供方，可刷新目录或添加自定义连接。'
    providerSearch.disabled = !context.ready || context.busy
    modelSelect.replaceChildren(option('', provider ? '查看模型详情' : '先选择提供方'), ...state.models.map(item => option(item.id, `${item.name} · ${item.remoteModelId}${item.status === 'deprecated' ? ' · 已弃用' : ''}`)))
    modelSelect.value = selectedModelId
    recipes = provider?.connections ?? []
    if (!recipes.some(recipe => recipe.id === selectedRecipeId)) {
      selectedRecipeId = recipes.find(recipe => context.providerDefinitionId === selectedProviderId && recipe.values.protocolId === context.protocolId)?.id ?? recipes[0]?.id ?? ''
    }
    connectionSelect.replaceChildren(...(recipes.length ? recipes.map(item => option(item.id, item.name)) : [option('', '手动选择协议与地址')]))
    connectionSelect.value = selectedRecipeId
    connectionSelect.disabled = !provider || context.busy
    const doc = get<HTMLAnchorElement>('[data-directory-doc]'); doc.hidden = !provider?.documentationUrl
    if (provider?.documentationUrl) doc.href = provider.documentationUrl
    get('[data-directory-origin]').textContent = provider ? `来源：${sourceLabel(provider.source)}` : ''
    get<HTMLButtonElement>('[data-directory-new-connection]').disabled = !provider || !context.ready || context.busy
    get('[data-directory-guidance]').textContent = connection ? `已有连接：${connection.name}。可为此提供方添加另一账号。` : provider ? '填写 API Key 并保存，适用模型会自动加入可用列表。' : '选择提供方后填写 API Key。'
    const metadata: string[] = []
    if (model) {
      metadata.push(`来源：${sourceLabel(model.source)}`, `远端 ID：${model.remoteModelId}`, `输入：${model.modalities.input.join('、') || '未知'}；输出：${model.modalities.output.join('、') || '未知'}`)
      metadata.push(`上下文：${model.limits.context?.toLocaleString('zh-CN') ?? '未知'}；最大输出：${model.limits.output?.toLocaleString('zh-CN') ?? '未知'}`)
      if (model.cost) metadata.push(`参考价格 USD / 百万 token：输入 ${model.cost.input ?? '未知'}；输出 ${model.cost.output ?? '未知'}${model.cost.cacheRead !== undefined ? `；缓存读取 ${model.cost.cacheRead}` : ''}${model.cost.cacheWrite !== undefined ? `；缓存写入 ${model.cost.cacheWrite}` : ''}`)
      if (model.status || model.releaseDate || model.lastUpdated) metadata.push(`状态：${model.status ?? '未标记'}；发布：${model.releaseDate ?? '未知'}；更新：${model.lastUpdated ?? '未知'}`)
      const reasoning = model.controls.reasoning?.map(control => control.kind === 'effort' ? `档位 ${control.values?.join(', ')}` : control.kind === 'budget' ? `预算 ${control.min ?? '未知'}–${control.max ?? '未知'}` : '推理开关').join('；')
      if (reasoning) metadata.push(`推理参考：${reasoning}`)
      if (model.description) metadata.push(model.description)
    }
    get('[data-directory-metadata]').textContent = metadata.join('\n')
  }
  async function readModels(read = generation, signal = controller?.signal): Promise<void> {
    if (!current(read, signal)) return
    await directory.readModels(selectedProviderId, modelSearch.value, deprecated.checked, signal)
  }
  function failConfigured(error: unknown, read: number, signal?: AbortSignal): void {
    if (!current(read, signal)) return
    configuredRefreshError = messageFor(error); render()
  }
  function poll(): void {
    clearTimer()
    const read = generation, signal = controller?.signal
    if (!current(read, signal) || !directory.snapshot().status?.refreshing && !directory.snapshot().checking) return
    timer = setTimeout(() => {
      timer = undefined
      void (async () => {
        if (!current(read, signal)) return
        await directory.readStatus(signal)
        if (!current(read, signal)) return
        if (!directory.snapshot().status?.refreshing && !directory.snapshot().checking) {
          await directory.readProviders(providerSearch.value, signal)
          if (!current(read, signal)) return
          await readModels(read, signal)
          if (!current(read, signal)) return
        }
        poll()
      })().catch(error => failConfigured(error, read, signal))
    }, 800)
  }
  function stop(): void {
    active = false; generation++; clearTimer()
    if (providerSearchTimer !== undefined) clearTimeout(providerSearchTimer)
    if (modelSearchTimer !== undefined) clearTimeout(modelSearchTimer)
    providerSearchTimer = modelSearchTimer = undefined
    controller?.abort(); controller = undefined; directory.invalidate()
  }
  async function open(): Promise<void> {
    if (active || !visible()) return
    const read = ++generation
    active = true; controller = new AbortController()
    const signal = controller.signal
    try {
      await Promise.all([directory.readStatus(signal), directory.readProviders(providerSearch.value, signal)])
      if (!current(read, signal)) return
      render(); await readModels(read, signal)
      if (!current(read, signal)) return
      poll()
    } catch (error) { failConfigured(error, read, signal) }
  }
  function sync(): void {
    if (visible()) { if (!active) void open() }
    else if (active) stop()
    render()
  }
  function select(providerId: string): void {
    if (selectedProviderId === providerId) {
      const context = actions.context(), provider = selectedProvider()
      selectedRecipeId = provider?.connections.find(recipe => context.providerDefinitionId === providerId && recipe.values.protocolId === context.protocolId)?.id ?? provider?.connections[0]?.id ?? ''
      render(); return
    }
    selectedProviderId = providerId; selectedModelId = ''; selectedRecipeId = ''; modelSearch.value = ''
    const provider = selectedProvider(), context = actions.context()
    selectedRecipeId = provider?.connections.find(recipe => context.providerDefinitionId === providerId && recipe.values.protocolId === context.protocolId)?.id ?? provider?.connections[0]?.id ?? ''
    if (providerId && !provider) providerSearch.value = ''
    render()
    const read = generation, signal = controller?.signal
    if (!current(read, signal)) return
    void (async () => {
      if (providerId && !provider) {
        await directory.readProviders(providerSearch.value, signal)
        if (!current(read, signal) || selectedProviderId !== providerId) return
      }
      await readModels(read, signal)
    })().catch(error => failConfigured(error, read, signal))
  }
  const unsubscribe = directory.subscribe(render)
  const observer = new MutationObserver(sync)
  if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
  observer.observe(root, { attributes: true, attributeFilter: ['hidden'] })
  const closed = () => { if (dialog && !dialog.open && active) stop() }
  dialog?.addEventListener('close', closed)
  providerList.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-directory-provider-id]') : null
    if (!button || button.disabled || !actions.context().ready || actions.context().busy || button.dataset.directoryProviderId === selectedProviderId) return
    selectedProviderId = button.dataset.directoryProviderId!; selectedModelId = ''; selectedRecipeId = ''; modelSearch.value = ''
    const provider = selectedProvider(); if (provider) actions.selectProvider(provider)
    render(); void readModels()
  })
  connectionSelect.addEventListener('change', () => {
    selectedRecipeId = connectionSelect.value
    const provider = selectedProvider()
    if (provider && actions.context().ready && !actions.context().busy) actions.useConnection(provider, recipes.find(recipe => recipe.id === selectedRecipeId), false)
    render()
  })
  modelSelect.addEventListener('change', () => { selectedModelId = modelSelect.value; render() })
  providerSearch.addEventListener('input', () => {
    if (providerSearchTimer !== undefined) clearTimeout(providerSearchTimer)
    const read = generation, signal = controller?.signal
    providerSearchTimer = setTimeout(() => {
      providerSearchTimer = undefined
      if (current(read, signal)) void directory.readProviders(providerSearch.value, signal)
    }, 200)
  })
  modelSearch.addEventListener('input', () => {
    if (modelSearchTimer !== undefined) clearTimeout(modelSearchTimer)
    const read = generation, signal = controller?.signal
    modelSearchTimer = setTimeout(() => { modelSearchTimer = undefined; if (current(read, signal)) void readModels(read, signal) }, 200)
  })
  deprecated.addEventListener('change', () => { void readModels() })
  get('[data-directory-refresh]').addEventListener('click', () => {
    const read = generation, signal = controller?.signal
    if (!current(read, signal)) return
    configuredRefreshError = undefined
    const work = directory.refresh(signal); poll()
    void (async () => {
      await work
      if (!current(read, signal)) return
      await directory.readStatus(signal)
      if (!current(read, signal)) return
      await directory.readProviders(providerSearch.value, signal)
      if (!current(read, signal)) return
      await readModels(read, signal)
      if (!current(read, signal)) return
      await actions.refreshConfigured()
      if (!current(read, signal)) return
      poll()
    })().catch(error => failConfigured(error, read, signal))
  })
  get('[data-directory-new-connection]').addEventListener('click', () => {
    const provider = selectedProvider(), context = actions.context()
    if (provider && context.ready && !context.busy) actions.useConnection(provider, recipes.find(recipe => recipe.id === selectedRecipeId), true)
  })
  sync()
  return { select, sync, dispose() { stop(); unsubscribe(); observer.disconnect(); dialog?.removeEventListener('close', closed) } }
}

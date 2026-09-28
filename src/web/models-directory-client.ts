import type { CatalogProviderRef, CatalogStatus, ProviderTemplate, ProviderView } from '@anybox/models'
import type { Api, DirectoryModel, DirectoryProvider } from './client-types.js'

export interface DirectoryState {
  readonly status?: CatalogStatus
  readonly providers: readonly DirectoryProvider[]
  readonly models: readonly DirectoryModel[]
  readonly providerId?: string
  readonly checking: boolean
  readonly error?: string
}

/** Public reference data has its own reads and never writes a local model selection. */
export function createModelsDirectory(api: Api, messageFor: (error: unknown) => string) {
  let state: DirectoryState = { providers: [], models: [], checking: false }
  let statusRead = 0, providerRead = 0, modelRead = 0, refreshRead = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<DirectoryState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const failed = (error: unknown, signal?: AbortSignal) => { if (!signal?.aborted) publish({ error: messageFor(error) }) }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    invalidate() { statusRead++; providerRead++; modelRead++; refreshRead++; publish({ checking: false }) },
    async readStatus(signal?: AbortSignal) {
      const read = ++statusRead
      try {
        const status = await api<CatalogStatus>('/models/catalog', undefined, signal)
        if (read === statusRead && !signal?.aborted) publish({ status, error: undefined })
      } catch (error) { if (read === statusRead) failed(error, signal) }
    },
    async readProviders(search = '', signal?: AbortSignal) {
      const read = ++providerRead
      try {
        const providers = await api<readonly DirectoryProvider[]>(`/models/catalog/providers?${new URLSearchParams({ search })}`, undefined, signal)
        if (read === providerRead && !signal?.aborted) publish({ providers, error: undefined })
      } catch (error) { if (read === providerRead) failed(error, signal) }
    },
    async readModels(providerId: string, search = '', includeDeprecated = false, signal?: AbortSignal) {
      const read = ++modelRead
      if (providerId !== state.providerId) publish({ providerId, models: [] })
      if (!providerId) { publish({ models: [] }); return }
      try {
        const models = await api<readonly DirectoryModel[]>(`/models/catalog/models?${new URLSearchParams({ providerId, search, includeDeprecated: String(includeDeprecated) })}`, undefined, signal)
        if (read === modelRead && !signal?.aborted) publish({ models, error: undefined })
      } catch (error) { if (read === modelRead) failed(error, signal) }
    },
    async refresh(signal?: AbortSignal) {
      if (state.checking) return
      const read = ++refreshRead
      statusRead++
      publish({ checking: true, error: undefined })
      try {
        const status = await api<CatalogStatus>('/models/catalog/refresh', {}, signal)
        if (read === refreshRead && !signal?.aborted) { statusRead++; publish({ status }) }
      } catch (error) { if (read === refreshRead) failed(error, signal) }
      finally { if (read === refreshRead) publish({ checking: false }) }
    },
  }
}

export function catalogSupportsText(model: DirectoryModel): boolean {
  return !['embedding', 'image', 'audio', 'video', 'rerank', 'reranker', 'decision'].includes(model.modelType ?? '') &&
    (!model.modalities.input.length || model.modalities.input.includes('text')) &&
    (!model.modalities.output.length || model.modalities.output.includes('text'))
}
export function catalogMatchesConnection(model: DirectoryModel, provider: ProviderView | undefined): boolean {
  return Boolean(provider?.catalogRef && provider.catalogRef.sourceId === model.sourceId &&
    provider.catalogRef.providerId === model.providerId &&
    (!model.connectionHints.protocolIds.length || model.connectionHints.protocolIds.includes(provider.protocolId) ||
      model.connections.some(connection => connection.values.protocolId === provider.protocolId)))
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
  context(): { readonly provider?: ProviderView; readonly ready: boolean; readonly busy: boolean }
  useConnection(provider: DirectoryProvider, recipe?: ProviderTemplate): void
  useModel(model: DirectoryModel): void
  associate(ref: CatalogProviderRef | null): Promise<void>
}

export function setupModelsDirectory(root: HTMLElement, api: Api, messageFor: (error: unknown) => string, actions: DirectoryActions) {
  root.innerHTML = `
    <div class="models-card-heading models-directory-heading"><div><h4>公共模型目录</h4><p>从 models.dev 选择参考配置，确认并保存后可供会话使用。</p></div><button type="button" data-directory-refresh class="secondary-button">刷新目录</button></div>
    <p data-directory-status class="settings-hint" role="status" aria-live="polite">正在读取本地目录。</p>
    <p data-directory-error class="models-notice error" role="status" hidden></p>
    <div class="models-directory-grid">
      <div><label>搜索目录提供方<input type="search" data-directory-provider-search placeholder="名称或 ID"></label><label>目录提供方<select data-directory-provider aria-label="目录提供方"></select></label>
        <p class="settings-hint"><a data-directory-doc target="_blank" rel="noopener noreferrer" hidden>提供方文档</a></p>
        <label>连接方案<select data-directory-connection aria-label="目录连接方案"></select></label>
        <div class="settings-actions"><button type="button" data-directory-new-connection>填写新提供方</button><button type="button" data-directory-associate class="secondary-button">关联当前提供方</button><button type="button" data-directory-unbind class="secondary-button">解除关联</button></div>
        <p data-directory-association class="settings-hint"></p>
      </div>
      <div><label>搜索目录模型<input type="search" data-directory-model-search placeholder="名称或远端模型 ID"></label><label>目录模型<select data-directory-model aria-label="目录模型"></select></label>
        <label class="models-check"><input type="checkbox" data-directory-deprecated>显示已弃用模型</label>
        <p data-directory-metadata class="models-directory-metadata"></p><p data-directory-guidance class="settings-hint"></p>
        <button type="button" data-directory-use-model>填写模型配置</button>
      </div>
    </div>`
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const providerSelect = get<HTMLSelectElement>('[data-directory-provider]'), modelSelect = get<HTMLSelectElement>('[data-directory-model]')
  const connectionSelect = get<HTMLSelectElement>('[data-directory-connection]')
  const providerSearch = get<HTMLInputElement>('[data-directory-provider-search]'), modelSearch = get<HTMLInputElement>('[data-directory-model-search]')
  const deprecated = get<HTMLInputElement>('[data-directory-deprecated]')
  const directory = createModelsDirectory(api, messageFor)
  const dialog = document.getElementById('settings-dialog') as HTMLDialogElement
  let active = false, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let providerSearchTimer: ReturnType<typeof setTimeout> | undefined, modelSearchTimer: ReturnType<typeof setTimeout> | undefined
  let recipes: readonly ProviderTemplate[] = [], generation = 0
  let selectedProviderId = '', selectedModelId = ''
  const selectedProvider = () => directory.snapshot().providers.find(item => item.id === selectedProviderId)
  const selectedModel = () => directory.snapshot().models.find(item => item.remoteModelId === selectedModelId && item.providerId === selectedProviderId)
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  function render(): void {
    const state = directory.snapshot(), context = actions.context(), provider = selectedProvider(), model = selectedModel()
    const status = state.status
    get('[data-directory-status]').textContent = status ? `${status.sourceId} · ${status.origin === 'bundled' ? '内置离线快照' : status.origin === 'cache' ? '本地缓存' : '在线快照'} · ${status.stale ? '待更新' : '已检查'} · 快照 ${date(status.fetchedAt)} · 最近检查 ${date(status.checkedAt)}${status.refreshing || state.checking ? ' · 正在检查更新' : ''}${status.cache.persistence === 'memory' ? ' · 仅内存缓存' : ''}` : '正在读取本地目录。'
    const error = state.error ?? (status?.error ? statusErrors[status.error] : status?.cache.error ? statusErrors[status.cache.error] : undefined)
    get('[data-directory-error]').textContent = error ? `${error}。可继续使用现有连接和最近有效目录。` : ''
    get('[data-directory-error]').hidden = !error
    get<HTMLButtonElement>('[data-directory-refresh]').disabled = state.checking || Boolean(status?.refreshing)
    providerSelect.replaceChildren(option('', '选择目录提供方'), ...state.providers.map(item => option(item.id, `${item.name} · ${item.id}`)))
    providerSelect.value = selectedProviderId
    modelSelect.replaceChildren(option('', provider ? '选择目录模型' : '先选择目录提供方'), ...state.models.map(item => option(item.remoteModelId, `${item.name} · ${item.remoteModelId}${item.status === 'deprecated' ? ' · 已弃用' : ''}`)))
    modelSelect.value = selectedModelId
    const previousRecipe = connectionSelect.value
    recipes = model?.connections ?? provider?.connections ?? []
    connectionSelect.replaceChildren(...(recipes.length ? recipes.map((item, index) => option(String(index), item.name)) : [option('', '手动选择已安装协议与地址')]))
    if (previousRecipe !== '' && recipes[Number(previousRecipe)]) connectionSelect.value = previousRecipe
    const doc = get<HTMLAnchorElement>('[data-directory-doc]'); doc.hidden = !provider?.documentationUrl
    if (provider?.documentationUrl) doc.href = provider.documentationUrl
    get<HTMLButtonElement>('[data-directory-new-connection]').disabled = !provider || !context.ready || context.busy
    get<HTMLButtonElement>('[data-directory-associate]').disabled = !provider || !context.provider || context.busy ||
      context.provider.catalogRef?.sourceId === provider.sourceId && context.provider.catalogRef.providerId === provider.id
    get<HTMLButtonElement>('[data-directory-unbind]').disabled = !context.provider?.catalogRef || context.busy
    const ref = context.provider?.catalogRef
    get('[data-directory-association]').textContent = context.provider ? `${context.provider.name}：${ref ? `已关联 ${ref.sourceId} / ${ref.providerId}` : '未关联目录'}。关联仅保存来源引用，连接设置仍由下方表单管理。` : '填写新提供方会预填连接方案；可调整账号名称和代理地址后保存。'
    const metadata: string[] = []
    if (model) {
      metadata.push(`远端 ID：${model.remoteModelId}`, `输入：${model.modalities.input.join('、') || '未知'}；输出：${model.modalities.output.join('、') || '未知'}`)
      metadata.push(`上下文：${model.limits.context?.toLocaleString('zh-CN') ?? '未知'}；最大输出：${model.limits.output?.toLocaleString('zh-CN') ?? '未知'}`)
      if (model.cost) metadata.push(`参考价格 USD / 百万 token：输入 ${model.cost.input ?? '未知'}；输出 ${model.cost.output ?? '未知'}${model.cost.cacheRead !== undefined ? `；缓存读取 ${model.cost.cacheRead}` : ''}${model.cost.cacheWrite !== undefined ? `；缓存写入 ${model.cost.cacheWrite}` : ''}${model.cost.tiers?.length ? `；另有 ${model.cost.tiers.length} 个价格档位` : ''}`)
      if (model.status || model.releaseDate || model.lastUpdated) metadata.push(`状态：${model.status ?? '未标记'}；发布：${model.releaseDate ?? '未知'}；更新：${model.lastUpdated ?? '未知'}`)
      const reasoning = model.controls.reasoning?.map(control => control.kind === 'effort' ? `档位 ${control.values?.join(', ')}` : control.kind === 'budget' ? `预算 ${control.min ?? '未知'}–${control.max ?? '未知'}` : '推理开关').join('；')
      if (reasoning) metadata.push(`推理参考：${reasoning}`)
      if (model.description) metadata.push(model.description)
    }
    get('[data-directory-metadata]').textContent = metadata.join('\n')
    const text = model ? catalogSupportsText(model) : false, matches = model ? catalogMatchesConnection(model, context.provider) : false
    get<HTMLButtonElement>('[data-directory-use-model]').disabled = !model || !text || !matches || context.busy
    get('[data-directory-guidance]').textContent = !model ? '目录候选与连接返回的远端候选分别展示。' : !text ? '此模型用于其他模态；当前执行接口支持文本与函数工具，可浏览参考信息。' : !context.provider ? '先填写并保存提供方，再填写此模型。' : !matches ? '当前提供方未关联此目录，或协议不适用。请显式关联，或按此模型的连接方案新建提供方。' : '填写后请确认能力与默认参数，再保存。目录价格和能力均为参考信息。'
  }
  async function readModels(): Promise<void> {
    await directory.readModels(selectedProviderId, modelSearch.value, deprecated.checked, controller?.signal)
  }
  function poll(): void {
    clearTimer()
    if (!active || !directory.snapshot().status?.refreshing && !directory.snapshot().checking) return
    const current = generation
    timer = setTimeout(() => { timer = undefined; void directory.readStatus(controller?.signal).then(async () => {
      if (!active || current !== generation) return
      if (!directory.snapshot().status?.refreshing && !directory.snapshot().checking) {
        await directory.readProviders(providerSearch.value, controller?.signal); await readModels()
      }
      poll()
    }) }, 800)
  }
  function stop(): void {
    active = false; generation++; clearTimer()
    if (providerSearchTimer !== undefined) clearTimeout(providerSearchTimer)
    if (modelSearchTimer !== undefined) clearTimeout(modelSearchTimer)
    providerSearchTimer = modelSearchTimer = undefined
    controller?.abort(); controller = undefined; directory.invalidate()
  }
  async function open(): Promise<void> {
    if (active) return
    const current = ++generation
    active = true; controller = new AbortController()
    await Promise.all([directory.readStatus(controller.signal), directory.readProviders(providerSearch.value, controller.signal)])
    if (!active || current !== generation) return
    if (!selectedProviderId && !providerSearch.value) selectedProviderId = actions.context().provider?.catalogRef?.providerId ?? ''
    render(); await readModels(); poll()
  }
  const unsubscribe = directory.subscribe(render)
  const observer = new MutationObserver(() => { if (dialog.open) void open(); else stop() })
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
  const closed = () => { if (!dialog.open) stop() }
  dialog.addEventListener('close', closed)
  providerSelect.addEventListener('change', () => { selectedProviderId = providerSelect.value; selectedModelId = ''; modelSearch.value = ''; render(); void readModels() })
  modelSelect.addEventListener('change', () => { selectedModelId = modelSelect.value; render() })
  providerSearch.addEventListener('input', () => {
    if (providerSearchTimer !== undefined) clearTimeout(providerSearchTimer)
    providerSearchTimer = setTimeout(() => { providerSearchTimer = undefined; void directory.readProviders(providerSearch.value, controller?.signal) }, 200)
  })
  modelSearch.addEventListener('input', () => {
    if (modelSearchTimer !== undefined) clearTimeout(modelSearchTimer)
    modelSearchTimer = setTimeout(() => { modelSearchTimer = undefined; void readModels() }, 200)
  })
  deprecated.addEventListener('change', () => { void readModels() })
  get('[data-directory-refresh]').addEventListener('click', () => {
    if (!active) return
    const work = directory.refresh(controller?.signal); poll()
    void work.then(async () => {
      if (!active) return
      // Failed refreshes reject the POST; read its persisted check state as well.
      await directory.readStatus(controller?.signal)
      if (!active) return
      await directory.readProviders(providerSearch.value, controller?.signal); await readModels(); poll()
    })
  })
  get('[data-directory-new-connection]').addEventListener('click', () => { const provider = selectedProvider(); if (provider) actions.useConnection(provider, recipes[Number(connectionSelect.value)]) })
  get('[data-directory-use-model]').addEventListener('click', () => { const model = selectedModel(); if (model && catalogSupportsText(model) && catalogMatchesConnection(model, actions.context().provider)) actions.useModel(model) })
  for (const unbind of [false, true]) get(unbind ? '[data-directory-unbind]' : '[data-directory-associate]').addEventListener('click', () => {
    const provider = selectedProvider()
    if (!unbind && !provider) return
    void actions.associate(unbind ? null : { sourceId: provider!.sourceId, providerId: provider!.id })
  })
  render(); if (dialog.open) void open()
  return { sync: render, dispose() { stop(); unsubscribe(); observer.disconnect(); dialog.removeEventListener('close', closed) } }
}

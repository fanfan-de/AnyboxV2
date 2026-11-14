import type { RunnableModelSummary } from '@anybox/models'
import type { RunView } from './client-types.js'
import type { SessionSnapshot } from './session-client.js'

export interface ContextUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly used?: number
  readonly limit?: number
  readonly percent?: number
  readonly tone: 'unknown' | 'normal' | 'warning' | 'danger'
  readonly label: string
  readonly detail: string
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positive = (value: unknown): value is number => count(value) && value > 0
const number = (value: number): string => value.toLocaleString('zh-CN')
const active = (run: RunView): boolean => run.status === 'running' || run.status === 'cancelling'

/** A pane observes its branch, never a newer sibling or a session-wide billing total. */
export function contextUsage(state: Pick<SessionSnapshot, 'session' | 'position' | 'path' | 'runs' | 'views' | 'loading'>,
  models: readonly RunnableModelSummary[] = []): ContextUsage {
  const model = models.find(value => value.id === state.session?.modelId)
  let limit = positive(model?.limits?.context) ? model.limits.context : undefined
  const unknown = (detail: string): ContextUsage => ({ limit, tone: 'unknown', label: '上下文用量未知', detail })
  if (state.loading) return unknown('正在读取当前分支的上下文统计。')
  if (state.session?.historyMode === 'dialogue-v1') return unknown('旧版会话没有可用的上下文统计。')
  const atPosition = state.runs.filter(run => run.history.kind === 'tree' && run.history.parentNodeId === state.position.viewNodeId)
  const running = atPosition.filter(active)
  const followed = atPosition.find(run => run.id === state.position.follow?.runId)
  const focused = running.find(run => run.id === state.position.focusedRunId)
  if (running.length > 1 && !followed && !focused) return unknown('当前分支有多个运行；请在轨迹中关注一个运行后查看。')
  const sourceId = state.path.at(-1)?.sourceRunId
  const run = followed ?? focused ?? running[0] ?? state.runs.find(run => run.id === sourceId)
  if (!run) return unknown('尚无模型返回的用量统计；首次响应后更新。')
  if (state.session?.modelId && run.modelId !== state.session.modelId) return unknown('模型已切换，等待所选模型返回新的用量统计。')
  const snapshot = run.modelSnapshot?.schemaVersion === 3 ? run.modelSnapshot : undefined
  // A recorded limit wins. An old snapshot may use the exact pinned definition from the catalog.
  limit = positive(snapshot?.limits?.context) ? snapshot.limits.context :
    snapshot && snapshot.modelDefinitionVersionId === model?.modelDefinitionVersionId && positive(model?.limits?.context) ? model.limits.context : undefined
  const view = state.views.get(run.id)
  const usage = view?.exchanges.at(-1)?.usage
  if (!usage) return unknown(active(run) ? '本次运行尚未返回用量统计；模型报告后更新。' : '模型未报告用量；无法计算当前分支的上下文占用。')
  const inputTokens = count(usage.inputTokens) ? usage.inputTokens : undefined
  const outputTokens = count(usage.outputTokens) ? usage.outputTokens : undefined
  const total = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  const used = count(total) ? total : undefined
  const percent = used !== undefined && limit !== undefined ? used / limit * 100 : undefined
  const displayedPercent = percent === undefined ? undefined : percent > 0 && percent < 1 ? '<1' : String(Math.round(percent))
  const label = percent !== undefined ? `上下文已用约 ${displayedPercent}%` : used !== undefined ? `上下文已统计 ${number(used)} tokens，上限未知` : '上下文统计尚不完整'
  return { inputTokens, outputTokens, used, limit, percent,
    tone: percent === undefined ? 'unknown' : percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'normal', label,
    detail: `${active(run) ? '本次运行' : '当前分支'}最近一次模型返回的统计。输入 + 输出用于估算占用，不累加历次请求；不含未发送草稿或下一次请求新增的内容。${used === undefined ? '模型尚未报告完整的输入与输出用量。' : ''}${limit === undefined ? '此模型的上下文上限未知。' : '上限来自此运行固定的模型定义。'}` }
}

/** Local, read-only UI. Its listeners share the panel lifetime and create no requests or timers. */
export function createContextUsageView(container: HTMLElement, id: string, signal: AbortSignal): { render(value: ContextUsage): void; close(): void; position(): void } {
  const root = document.createElement('div')
  root.className = 'context-usage'
  root.innerHTML = `<button class="context-usage-button" type="button" aria-expanded="false" aria-label="上下文用量未知">
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle class="context-usage-track" cx="10" cy="10" r="7"/><circle class="context-usage-fill" cx="10" cy="10" r="7" pathLength="100" stroke-dasharray="0 100"/></svg>
    </button><div class="context-usage-popover" role="tooltip"><strong>上下文用量</strong><p class="context-usage-headline"></p>
    <dl><div><dt>已用（估算）</dt><dd data-context-used></dd></div><div><dt>上下文上限</dt><dd data-context-limit></dd></div><div><dt>输入 tokens</dt><dd data-context-input></dd></div><div><dt>输出 tokens</dt><dd data-context-output></dd></div></dl>
    <p class="context-usage-detail"></p></div>`
  const get = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
  const button = get<HTMLButtonElement>('button'), popup = get<HTMLElement>('.context-usage-popover')
  popup.id = id
  popup.setAttribute('popover', 'manual')
  button.setAttribute('aria-describedby', id)
  let open = false, pinned = false
  const position = (): void => {
    if (!open) return
    const bounds = container.getBoundingClientRect(), anchor = button.getBoundingClientRect()
    if (!container.isConnected || !bounds.width || !bounds.height) { close(); return }
    const width = globalThis.innerWidth || bounds.right, height = globalThis.innerHeight || bounds.bottom
    const popupWidth = Math.max(0, Math.min(270, bounds.width - 24, width - 24))
    popup.style.width = `${popupWidth}px`
    popup.style.left = `${Math.max(12, Math.min(anchor.left, bounds.right - popupWidth - 12, width - popupWidth - 12))}px`
    const above = anchor.top - 12, below = height - anchor.bottom - 12
    const upwards = above >= Math.min(300, below)
    root.dataset.side = upwards ? 'above' : 'below'
    popup.style.maxHeight = `${Math.max(0, upwards ? above : below)}px`
    const popupHeight = popup.getBoundingClientRect().height
    popup.style.top = `${upwards ? Math.max(12, anchor.top - popupHeight - 8) : anchor.bottom + 8}px`
  }
  const show = (): void => {
    open = true; root.dataset.open = 'true'; button.setAttribute('aria-expanded', 'true')
    // The top layer escapes the split pane's size containment and overflow clipping.
    if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover()
    position()
  }
  const close = (): void => {
    open = false; pinned = false; root.dataset.open = 'false'; button.setAttribute('aria-expanded', 'false')
    if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover()
  }
  button.addEventListener('click', () => {
    pinned = !pinned
    if (pinned) show(); else close()
  }, { signal })
  root.addEventListener('pointerenter', show, { signal })
  root.addEventListener('pointerleave', () => { if (!pinned && !root.contains(document.activeElement)) close() }, { signal })
  root.addEventListener('focusin', show, { signal })
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget as Node | null)) close() }, { signal })
  document.body.addEventListener('pointerdown', event => { if (!root.contains(event.target as Node | null)) close() }, { signal })
  document.body.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
  }, { signal })
  globalThis.window?.addEventListener('resize', position, { signal })
  signal.addEventListener('abort', close, { once: true })
  container.querySelector('.composer-model-row')!.prepend(root)
  return { close, position, render(value) {
    root.dataset.tone = value.tone
    button.setAttribute('aria-label', value.label)
    get('.context-usage-fill').setAttribute('stroke-dasharray', `${Math.min(100, Math.max(0, value.percent ?? 0))} 100`)
    get('.context-usage-headline').textContent = value.percent === undefined ? value.label : `${value.label} · 剩余约 ${Math.max(0, 100 - Math.round(value.percent))}%`
    get('[data-context-used]').textContent = value.used === undefined ? '未知' : `${number(value.used)} tokens`
    get('[data-context-limit]').textContent = value.limit === undefined ? '未知' : `${number(value.limit)} tokens`
    get('[data-context-input]').textContent = value.inputTokens === undefined ? '未报告' : number(value.inputTokens)
    get('[data-context-output]').textContent = value.outputTokens === undefined ? '未报告' : number(value.outputTokens)
    get('.context-usage-detail').textContent = value.detail
    position()
  } }
}

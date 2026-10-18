import type { AccountUsageView, QuotaWindow } from '../core/account.js'
import { el } from './view.js'

export interface AccountTarget { readonly key: string; readonly path: string; readonly label: string }
export function resetCountdown(resetsAt: string | null, now = Date.now()): string {
  const reset = resetsAt === null ? NaN : Date.parse(resetsAt)
  if (!Number.isFinite(reset)) return '未提供重置时间'
  const seconds = Math.ceil((reset - now) / 1000)
  if (seconds <= 0) return '已到重置时间，请刷新额度'
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60)
  return days ? `${days} 天 ${hours} 小时 ${minutes} 分钟后重置` : hours ? `${hours} 小时 ${minutes} 分钟后重置` : `${minutes} 分 ${seconds % 60} 秒后重置`
}
const planName = (plan: string | null) => plan ? ({ pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' }[plan.toLowerCase()] ?? plan) : 'Claude 未提供套餐信息'
const percentage = (value: number) => `${Number(value.toFixed(1))}%`
/** A read-only inspector. Snapshots are scoped to one device/project/run and never persisted in browser storage. */
export function createAccountPanel(domId: (value: string) => string, options: {
  target(): AccountTarget | undefined
  request<T>(path: string, signal: AbortSignal): Promise<T>
}) {
  const closeButton = el('button', { type: 'button', text: '×', 'aria-label': '关闭账号与额度' })
  const refresh = el('button', { type: 'button', class: 'ca-account-refresh', text: '刷新额度' })
  const subtitle = el('p', { class: 'ca-account-subtitle' })
  const status = el('p', { class: 'ca-account-status', role: 'status' })
  const error = el('p', { class: 'ca-account-error', role: 'alert', hidden: true })
  const body = el('div', { class: 'ca-account-content' })
  const checked = el('p', { class: 'ca-account-checked' })
  const element = el('dialog', { class: 'ca-account-dialog', 'aria-labelledby': domId('account-title') },
    el('header', { class: 'ca-account-head' }, el('div', {}, el('h2', { id: domId('account-title'), text: '账号与额度' }), subtitle), closeButton),
    status, error, body, el('footer', { class: 'ca-account-foot' }, checked, refresh))
  let reads = new AbortController(), version = 0, destroyed = false, loading = false, key: string | undefined, returnFocus: HTMLElement | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let clocks: { element: HTMLElement; resetsAt: string | null }[] = []
  const stop = () => { reads.abort(); version++; loading = false; if (timer) clearInterval(timer); timer = undefined; clocks = [] }
  const close = () => { stop(); element.close(); returnFocus?.focus() }
  const tick = () => { for (const clock of clocks) clock.element.textContent = resetCountdown(clock.resetsAt) }
  const quota = (title: string, window: QuotaWindow | null) => {
    const used = window?.usedPercent ?? null
    const value = el('strong', { class: 'ca-quota-value', text: used === null ? '暂不可用' : `已用 ${percentage(used)}` })
    const remaining = el('span', { class: 'ca-quota-remaining', text: used === null ? 'Claude 未返回此项额度' : `剩余 ${percentage(100 - used)}` })
    const progress = el('progress', { max: '100', 'aria-label': title, hidden: used === null, ...(used === null ? {} : { value: String(used) }) })
    const countdown = el('p', { class: 'ca-quota-countdown', 'aria-live': 'off' })
    clocks.push({ element: countdown, resetsAt: window?.resetsAt ?? null })
    const at = window?.resetsAt ? new Date(window.resetsAt) : undefined
    return el('section', { class: 'ca-quota-card' }, el('div', { class: 'ca-quota-head' }, el('h3', { text: title }), value), progress, remaining, countdown,
      ...(at ? [el('small', { class: 'ca-quota-reset', text: `重置于 ${at.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`, title: at.toLocaleString() })] : []))
  }
  const render = (view: AccountUsageView) => {
    clocks = []
    const account = el('section', { class: 'ca-account-identity' }, el('strong', { class: 'ca-account-email', text: view.account.email ?? 'Claude 未返回账号名称' }),
      el('span', { class: 'ca-account-plan', text: planName(view.account.subscription) }), ...(view.account.organization ? [el('small', { text: `组织：${view.account.organization}` })] : []))
    const messages = [view.accountError, view.quotas.reason].filter(Boolean)
    error.hidden = !messages.length; error.textContent = messages.join(' ')
    body.replaceChildren(account, quota('5 小时额度', view.quotas.fiveHour), quota('每周额度', view.quotas.weekly),
      el('p', { class: 'ca-account-help', text: '额度来自当前执行设备实际使用的 Claude 账号，与该账号的其他使用入口共享。百分比不是剩余消息条数。' }))
    checked.textContent = `查询于 ${new Date(view.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    tick()
  }
  const load = async () => {
    const target = options.target()
    if (!target || destroyed || !element.open || loading) return
    stop(); reads = new AbortController(); const signal = reads.signal, current = ++version
    key = target.key; loading = true; refresh.disabled = true; subtitle.textContent = target.label
    status.textContent = '正在读取当前账号与额度…'; error.hidden = true; body.replaceChildren(); checked.textContent = ''; body.setAttribute('aria-busy', 'true')
    try {
      const view = await options.request<AccountUsageView>(target.path, signal)
      if (signal.aborted || version !== current || options.target()?.key !== key || !element.open) return
      render(view); status.textContent = ''
      timer = setInterval(tick, 1000)
    } catch {
      if (signal.aborted || version !== current || options.target()?.key !== key || !element.open) return
      status.textContent = ''; error.hidden = false; error.textContent = '账号与额度读取失败，请检查当前执行设备的 Claude 登录状态、网络及应用运行状态，然后点击“刷新额度”重试。'
    } finally { if (version === current) { loading = false; refresh.disabled = false; body.setAttribute('aria-busy', 'false') } }
  }
  refresh.addEventListener('click', () => { void load() })
  closeButton.addEventListener('click', close)
  element.addEventListener('cancel', event => { event.preventDefault(); close() })
  element.addEventListener('close', stop)
  return {
    element,
    open(opener?: HTMLElement) { if (!options.target() || destroyed) return; returnFocus = opener; if (!element.open) element.showModal(); void load() },
    update() { if (element.open && options.target()?.key !== key) close() },
    close,
    dispose() { destroyed = true; stop(); if (element.open) element.close(); body.replaceChildren() },
  }
}

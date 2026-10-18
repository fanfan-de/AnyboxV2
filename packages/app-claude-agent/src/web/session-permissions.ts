import type { SessionPermissionsView } from '../core/view.js'
import { el } from './view.js'
import { messageFor } from './state.js'

export function createSessionPermissionsPanel(domId: (value: string) => string, options: {
  target(): { readonly key: string; readonly threadId: string } | undefined
  request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T>
  report(message: string): void
}) {
  const closeButton = el('button', { type: 'button', text: '关闭', 'aria-label': '关闭会话授权' })
  const refresh = el('button', { type: 'button', text: '刷新授权' })
  const status = el('p', { role: 'status', class: 'ca-session-permissions-status' }), list = el('div', { class: 'ca-session-permissions-list' })
  const element = el('dialog', { class: 'ca-session-permissions-dialog', 'aria-labelledby': domId('session-permissions-title') },
    el('header', {}, el('h2', { id: domId('session-permissions-title'), text: '会话授权' }), closeButton),
    el('p', { text: '这里的规则覆盖本次会话的后续消息，重新打开会话仍然有效，不会应用到其他会话。权限模式、管理员规则和 Claude 强制确认要求仍然生效。' }), refresh, status, list)
  let controller = new AbortController(), version = 0, destroyed = false, busy = false, origin: HTMLElement | undefined
  let target: ReturnType<typeof options.target>, view: SessionPermissionsView | undefined
  const relevant = () => !destroyed && element.open && !!target && options.target()?.key === target.key
  const close = () => { version++; controller.abort(); element.close(); origin?.focus() }
  const render = () => {
    if (!relevant()) return
    refresh.disabled = busy
    const entries = (view?.grants ?? []).map(grant => {
      const revoke = el('button', { type: 'button', text: '撤销此授权', disabled: busy || !view?.canRevoke })
      revoke.addEventListener('click', () => { void remove(grant.id) })
      return el('section', { class: 'ca-session-permission-entry' }, el('ul', {}, ...grant.rules.map(rule => el('li', {}, el('code', { text: rule })))), revoke)
    })
    list.replaceChildren(...(view && !view.canRevoke ? [el('p', { text: '当前任务尚未结束。请等待结束后刷新，即可撤销授权；撤销后后续消息不再沿用该规则。' })] : []), ...entries)
    if (view && !view.grants.length) list.append(el('p', { text: '尚未保存会话授权。在审批卡选择“本次会话始终允许”后，已授权的规则会显示在这里。' }))
  }
  const load = async () => {
    if (!relevant()) return
    controller.abort(); controller = new AbortController()
    const signal = controller.signal, currentVersion = ++version, selected = target!
    status.textContent = '正在读取会话授权…'
    try {
      const next = await options.request<SessionPermissionsView>(`/apps/claude-agent/threads/${encodeURIComponent(selected.threadId)}/permissions`, undefined, signal)
      if (relevant() && !signal.aborted && currentVersion === version) { view = next; status.textContent = ''; render() }
    } catch (error) { if (relevant() && !signal.aborted && currentVersion === version) status.textContent = messageFor(error) }
  }
  const remove = async (id: string) => {
    if (busy || !view?.canRevoke || !relevant()) return
    const selected = target!
    busy = true; status.textContent = '正在撤销授权…'; render()
    try {
      const next = await options.request<SessionPermissionsView>(`/apps/claude-agent/threads/${encodeURIComponent(selected.threadId)}/permissions/${encodeURIComponent(id)}/revoke`, {})
      if (relevant() && target?.key === selected.key) { view = next; status.textContent = '已撤销，后续消息不再沿用此授权。' }
    } catch (error) {
      const message = `撤销未确认：${messageFor(error)}。请刷新授权列表核对。`
      if (relevant() && target?.key === selected.key) status.textContent = message; else options.report(message)
    } finally { busy = false; render() }
  }
  closeButton.addEventListener('click', close)
  element.addEventListener('cancel', event => { event.preventDefault(); close() })
  refresh.addEventListener('click', () => { void load() })
  return { element,
    open(focus: HTMLElement) { const selected = options.target(); if (!selected) return; target = selected; origin = focus; view = undefined; list.replaceChildren(); element.showModal(); closeButton.focus(); void load() },
    update() { if (element.open && !relevant()) close() },
    close,
    dispose() { destroyed = true; close() },
  }
}

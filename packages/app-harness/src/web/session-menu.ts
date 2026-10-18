import type { SessionRef } from './workspace-layout.js'

export type SessionMenuAction = 'right' | 'bottom' | 'archive'

/** One temporary menu stays inside the sidebar's focus boundary and uses the browser top layer. */
export function createSessionMenu(root: HTMLElement, options: {
  available(ref: SessionRef, action: SessionMenuAction): boolean
  select(ref: SessionRef, action: SessionMenuAction): void
}) {
  const document = root.ownerDocument, window = document.defaultView!
  const listeners = new AbortController(), listening = { signal: listeners.signal }
  const menu = document.createElement('div')
  menu.id = 'agent--session-menu'; menu.className = 'session-menu'; menu.popover = 'manual'
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '会话操作'); menu.tabIndex = -1
  const actions: readonly [SessionMenuAction, string, string][] = [
    ['right', '在右侧打开', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16m3-11 3 3-3 3"/>'],
    ['bottom', '在下方打开', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18m-12 3 3 3 3-3"/>'],
    ['archive', '归档', '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>'],
  ]
  const buttons = actions.map(([action, label, path]) => {
    const button = document.createElement('button')
    button.type = 'button'; button.tabIndex = -1; button.dataset.sessionMenuAction = action
    button.title = action === 'archive' ? label : `在活动面板${action === 'right' ? '右侧' : '下方'}打开`
    button.setAttribute('role', 'menuitem')
    button.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`
    const text = document.createElement('span'); text.textContent = label; button.append(text)
    menu.append(button)
    return button
  })
  root.append(menu)
  let current: { trigger: HTMLButtonElement; ref: SessionRef } | undefined, disposed = false

  const release = () => { current?.trigger.setAttribute('aria-expanded', 'false'); current = undefined }
  const close = (restoreFocus = false) => {
    const trigger = current?.trigger
    if (menu.matches(':popover-open')) menu.hidePopover()
    release()
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  const enabled = () => buttons.filter(button => !button.disabled)
  const refresh = () => {
    if (!current) return
    for (const button of buttons) button.disabled = !options.available(current.ref, button.dataset.sessionMenuAction as SessionMenuAction)
    if (buttons.some(button => button === document.activeElement && button.disabled)) (enabled()[0] ?? menu).focus({ preventScroll: true })
  }
  const position = () => {
    if (!current) return
    const anchor = current.trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect(), margin = 8, gap = 4
    const left = Math.max(margin, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin))
    const below = anchor.bottom + gap
    const top = Math.max(margin, Math.min(below + bounds.height <= window.innerHeight - margin ? below : anchor.top - bounds.height - gap,
      window.innerHeight - bounds.height - margin))
    menu.style.left = `${left}px`; menu.style.top = `${top}px`
  }
  const toggle = (trigger: HTMLButtonElement, ref: SessionRef, focusLast = false) => {
    if (disposed || !trigger.isConnected || !root.contains(trigger)) return
    if (current?.trigger === trigger) { close(true); return }
    close()
    current = { trigger, ref }
    trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'true')
    refresh()
    menu.showPopover()
    position()
    const targets = enabled()
    ;(targets[focusLast ? targets.length - 1 : 0] ?? menu).focus({ preventScroll: true })
  }
  menu.addEventListener('keydown', event => {
    if (!current) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const targets = enabled(), index = targets.findIndex(button => button === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % targets.length : (index - 1 + targets.length) % targets.length
    targets[next]?.focus({ preventScroll: true })
  }, listening)
  menu.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-session-menu-action]') : null
    if (!button || !buttons.includes(button) || button.disabled || !current) return
    const ref = current.ref, action = button.dataset.sessionMenuAction as SessionMenuAction
    if (!options.available(ref, action)) { refresh(); return }
    close(true)
    options.select(ref, action)
  }, listening)
  const outside = (event: Event) => {
    if (current && event.target instanceof Node && !menu.contains(event.target) && !current.trigger.contains(event.target)) close()
  }
  document.addEventListener('pointerdown', outside, { ...listening, capture: true })
  document.addEventListener('focusin', outside, listening)
  document.addEventListener('scroll', event => { if (event.target instanceof Node && !menu.contains(event.target)) close() }, { ...listening, capture: true })
  document.addEventListener('visibilitychange', () => { if (document.hidden) close() }, listening)
  window.addEventListener('resize', () => close(), listening)
  menu.addEventListener('toggle', () => { if (!menu.matches(':popover-open')) release() }, listening)
  return {
    id: menu.id, reference: () => current?.ref, toggle, refresh, close,
    dispose() { if (disposed) return; disposed = true; close(); listeners.abort(); menu.remove() },
  }
}

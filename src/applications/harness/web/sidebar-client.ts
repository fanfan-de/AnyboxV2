import { clampSidebarWidth, createSidebarStateStore, fitSidebars, sidebarBounds, sidebarSeparatorSize } from './sidebar-layout.js'
import type { SidebarFit, SidebarSide, SidebarStateStore } from './sidebar-layout.js'

/** DOM ownership of the two outer sidebars; session views retain their own lifecycle. */
export function setupSidebarLayout(root: HTMLElement, options: {
  storageKey: string
  stateStore?: SidebarStateStore
  isActive?(): boolean
  onVisibilityChange?(rightVisible: boolean): void
}) {
  function required<T extends HTMLElement>(id: string): T {
    const element = root.querySelector<T>(`#${id}`)
    if (!element) throw new Error(`missing element ${id}`)
    return element
  }
  const left = required<HTMLElement>('agent--workspace-sidebar')
  const right = required<HTMLElement>('agent--file-sidebar')
  const center = required<HTMLElement>('agent--session-workspace')
  const shell = left.closest<HTMLElement>('.workspace')!
  const backdrop = required<HTMLButtonElement>('agent--sidebar-backdrop')
  const leftToggle = required<HTMLButtonElement>('agent--toggle-sidebar')
  const rightToggle = required<HTMLButtonElement>('agent--toggle-files')
  const leftLabel = required<HTMLElement>('agent--sidebar-toggle-label')
  const separators = { left: required<HTMLElement>('agent--left-sidebar-separator'), right: required<HTMLElement>('agent--right-sidebar-separator') }
  const panels = { left, right }, toggles = { left: leftToggle, right: rightToggle }
  const stateStore = options.stateStore ?? createSidebarStateStore(options.storageKey)
  const doc = root.ownerDocument
  const lifetime = new AbortController()
  const listeners = new Set<(rightVisible: boolean) => void>()
  let active = options.isActive?.() !== false, disposed = false, width = 0
  let fit: SidebarFit = fitSidebars(0, stateStore.read())
  let drawer: SidebarSide | null = null, returnFocus: HTMLElement | null = null, rightVisible = false
  let drag: { side: SidebarSide; pointerId: number; origin: number; width: number } | null = null
  const listen = (target: EventTarget, type: string, listener: EventListener) => target.addEventListener(type, listener, { signal: lifetime.signal })

  function focusTargets(panel: HTMLElement): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0)
  }
  function focusDrawer(): void {
    if (drawer) (focusTargets(panels[drawer])[0] ?? panels[drawer]).focus()
  }
  function notify(): void {
    const next = active && (fit.rightDocked || drawer === 'right')
    if (next === rightVisible) return
    rightVisible = next
    options.onVisibilityChange?.(next)
    for (const listener of listeners) listener(next)
  }
  function render(): void {
    if (disposed) return
    if (active) {
      const measured = shell.getBoundingClientRect().width
      if (measured > 0) {
        width = measured; fit = fitSidebars(width, stateStore.read())
        shell.style.gridTemplateColumns = `${fit.leftWidth}px ${fit.leftDocked ? sidebarSeparatorSize : 0}px minmax(0, 1fr) ${fit.rightDocked ? sidebarSeparatorSize : 0}px ${fit.rightWidth}px`
        shell.style.setProperty('--left-sidebar-drawer-width', `${Math.min(stateStore.read().leftWidth, Math.max(0, width - 24))}px`)
        shell.style.setProperty('--right-sidebar-drawer-width', `${Math.min(stateStore.read().rightWidth, Math.max(0, width - 24))}px`)
      }
    }
    if (drawer && (!active || !fit[`${drawer}Drawer`])) drawer = null
    shell.dataset.leftMode = fit.leftDrawer ? 'drawer' : 'docked'
    shell.dataset.rightMode = fit.rightDrawer ? 'drawer' : 'docked'
    shell.dataset.drawer = drawer ?? ''
    for (const side of ['left', 'right'] as const) {
      const visible = active && (fit[`${side}Docked`] || drawer === side)
      const panel = panels[side]
      panel.hidden = !visible; panel.inert = !visible || (!!drawer && drawer !== side)
      panel.setAttribute('aria-hidden', String(!visible))
      if (drawer === side) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true') }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal') }
      toggles[side].setAttribute('aria-expanded', String(visible))
      const label = side === 'left' ? `${visible ? '收起' : '展开'}项目与会话` : `${visible ? '收起' : '展开'}文件侧栏`
      toggles[side].title = label; toggles[side].setAttribute('aria-label', label)
      if (side === 'left') leftLabel.textContent = label
      separators[side].hidden = !active || !fit[`${side}Docked`]
      separators[side].setAttribute('aria-valuenow', String(Math.round(stateStore.read()[`${side}Width`])))
    }
    backdrop.hidden = !drawer
    backdrop.setAttribute('aria-label', drawer === 'right' ? '关闭文件侧栏' : '关闭项目与会话')
    center.inert = !!drawer
    notify()
  }
  function closeDrawers(restoreFocus = true): void {
    const was = drawer
    drawer = null; render()
    if (restoreFocus && was && active) {
      const target = returnFocus?.isConnected && !returnFocus.closest('[inert]') && returnFocus.getClientRects().length ? returnFocus : toggles[was]
      target.focus()
    }
    returnFocus = null
  }
  function open(side: SidebarSide, focus = false): void {
    if (!active || disposed) return
    render()
    if (fit[`${side}Drawer`]) {
      returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : toggles[side]
      drawer = side
    } else stateStore.update(state => ({ ...state, [`${side}Expanded`]: true }))
    render()
    if (focus || drawer === side) (drawer ? focusDrawer() : (focusTargets(panels[side])[0] ?? panels[side]).focus())
  }
  function toggle(side: SidebarSide): void {
    if (!active) return
    render()
    if (fit[`${side}Drawer`]) {
      if (drawer === side) closeDrawers()
      else open(side)
    } else {
      if (drawer) closeDrawers(false)
      stateStore.update(state => ({ ...state, [`${side}Expanded`]: !state[`${side}Expanded`] }))
      if (panels[side].hidden) toggles[side].focus()
    }
  }
  function resize(side: SidebarSide, value: number): void {
    stateStore.update(state => ({ ...state, [`${side}Width`]: clampSidebarWidth(side, value) }))
  }
  function stopDrag(): void {
    if (drag) { try { separators[drag.side].releasePointerCapture(drag.pointerId) } catch { /* Capture may already have been released. */ } }
    drag = null
  }
  left.tabIndex = -1; right.tabIndex = -1
  listen(leftToggle, 'click', () => toggle('left'))
  listen(rightToggle, 'click', () => toggle('right'))
  listen(required('agent--show-workspace'), 'click', () => open('left', true))
  listen(required('agent--close-sidebar'), 'click', () => closeDrawers())
  listen(required('agent--close-files'), 'click', () => fit.rightDrawer ? closeDrawers() : toggle('right'))
  listen(backdrop, 'click', () => closeDrawers())
  for (const side of ['left', 'right'] as const) {
    const separator = separators[side], [minimum, maximum] = sidebarBounds[side]
    separator.setAttribute('aria-valuemin', String(minimum)); separator.setAttribute('aria-valuemax', String(maximum))
    listen(separator, 'keydown', event => {
      const key = event as KeyboardEvent
      if (!active || !fit[`${side}Docked`]) return
      let value = stateStore.read()[`${side}Width`]
      if (key.key === 'ArrowLeft') value += side === 'left' ? -10 : 10
      else if (key.key === 'ArrowRight') value += side === 'left' ? 10 : -10
      else if (key.key === 'Home') value = minimum
      else if (key.key === 'End') value = maximum
      else return
      key.preventDefault(); resize(side, value)
    })
    listen(separator, 'pointerdown', event => {
      const pointer = event as PointerEvent
      if (!active || !fit[`${side}Docked`] || pointer.button !== 0) return
      pointer.preventDefault(); separator.focus(); separator.setPointerCapture(pointer.pointerId)
      drag = { side, pointerId: pointer.pointerId, origin: pointer.clientX, width: fit[`${side}Width`] }
    })
    listen(separator, 'pointermove', event => {
      const pointer = event as PointerEvent
      if (!active || !drag || drag.side !== side || pointer.pointerId !== drag.pointerId) return
      resize(side, drag.width + (pointer.clientX - drag.origin) * (side === 'left' ? 1 : -1))
    })
    listen(separator, 'pointerup', () => stopDrag())
    listen(separator, 'pointercancel', () => stopDrag())
    listen(separator, 'lostpointercapture', () => { drag = null })
  }
  listen(doc, 'keydown', event => {
    if (!active || !drawer || root.querySelector('dialog[open]')) return
    const key = event as KeyboardEvent
    if (key.key === 'Escape') { key.preventDefault(); closeDrawers() }
    else if (key.key === 'Tab') {
      const panel = panels[drawer], targets = focusTargets(panel), first = targets[0], last = targets.at(-1)
      if (!first || !panel.contains(doc.activeElement) || (key.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
        key.preventDefault(); (key.shiftKey ? last ?? panel : first ?? panel).focus()
      }
    }
  })
  listen(doc, 'focusin', event => {
    if (active && drawer && !root.querySelector('dialog[open]') && event.target instanceof Node && !panels[drawer].contains(event.target)) focusDrawer()
  })
  listen(doc, 'visibilitychange', () => { if (doc.hidden) stopDrag() })
  const unsubscribe = stateStore.subscribe(render)
  const observer = new ResizeObserver(() => {
    if (!active || disposed || shell.getBoundingClientRect().width <= 0) return
    const focused = doc.activeElement
    const focusedSide = focused instanceof Node ? (left.contains(focused) ? 'left' : right.contains(focused) ? 'right' : null) : null
    render()
    if (focusedSide && panels[focusedSide].hidden) toggles[focusedSide].focus()
  })
  observer.observe(shell)
  render()
  return {
    stateStore,
    rightVisible: () => rightVisible,
    subscribe(listener: (visible: boolean) => void) { listeners.add(listener); listener(rightVisible); return () => { listeners.delete(listener) } },
    openRight: () => open('right'),
    toggleRight: () => toggle('right'),
    openLeft: () => open('left', true),
    closeLeft: () => { if (drawer === 'left') closeDrawers() },
    closeDrawers: () => closeDrawers(),
    requestLayout: render,
    setActive(value: boolean) { active = value; if (!value) { stopDrag(); drawer = null; returnFocus = null } render() },
    dispose() { active = false; drawer = null; stopDrag(); render(); disposed = true; lifetime.abort(); observer.disconnect(); unsubscribe(); listeners.clear() },
  }
}

const positionStorageKey = 'anybox.apps.launcher-position.v1'
const edgeMargin = 8, menuGap = 6, dragThreshold = 5
interface Position { readonly left: number; readonly top: number }
interface Drag {
  readonly pointerId: number; readonly startX: number; readonly startY: number; readonly origin: Position
  moved: boolean
}
const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

/** Owns only the launcher position and menu geometry, never application controls or workspace state. */
export function setupFloatingApplicationMenu(button: HTMLButtonElement, menu: HTMLElement, options: { signal: AbortSignal }): void {
  if (options.signal.aborted) return
  let closed = false, drag: Drag | undefined, suppressClick: number | undefined, observer: ResizeObserver | undefined
  const listeners: { target: EventTarget; type: string; listener: EventListener; options?: AddEventListenerOptions | boolean }[] = []
  function listen(target: EventTarget, type: string, listener: EventListener, listenerOptions?: AddEventListenerOptions | boolean) {
    target.addEventListener(type, listener, listenerOptions); listeners.push({ target, type, listener, options: listenerOptions })
  }
  function persist() {
    const rect = button.getBoundingClientRect()
    try { sessionStorage.setItem(positionStorageKey, JSON.stringify({ left: rect.left, top: rect.top })) } catch { /* Position storage is optional. */ }
  }
  function position(left: number, top: number, force = true) {
    const rect = button.getBoundingClientRect(), width = Math.max(0, window.innerWidth), height = Math.max(0, window.innerHeight)
    const marginX = Math.min(edgeMargin, Math.max(0, (width - rect.width) / 2)), marginY = Math.min(edgeMargin, Math.max(0, (height - rect.height) / 2))
    const next = { left: clamp(left, marginX, width - marginX - rect.width), top: clamp(top, marginY, height - marginY - rect.height) }
    if (force || next.left !== rect.left || next.top !== rect.top) { button.style.left = `${next.left}px`; button.style.top = `${next.top}px` }
  }
  function reposition() {
    if (closed || !menu.matches(':popover-open')) return
    const width = Math.max(0, window.innerWidth), height = Math.max(0, window.innerHeight)
    const marginX = Math.min(edgeMargin, width / 2), marginY = Math.min(edgeMargin, height / 2)
    menu.style.maxWidth = `${Math.max(0, width - 2 * marginX)}px`; menu.style.maxHeight = `${Math.max(0, height - 2 * marginY)}px`
    const anchor = button.getBoundingClientRect(), initial = menu.getBoundingClientRect()
    const below = Math.max(0, height - marginY - anchor.bottom - menuGap), above = Math.max(0, anchor.top - menuGap - marginY)
    const opensBelow = initial.height <= below || initial.height > above && below >= above
    menu.style.maxHeight = `${opensBelow ? below : above}px`
    const rect = menu.getBoundingClientRect()
    const left = anchor.left + rect.width <= width - marginX ? anchor.left : anchor.right - rect.width
    menu.style.left = `${clamp(left, marginX, width - marginX - rect.width)}px`
    menu.style.top = `${clamp(opensBelow ? anchor.bottom + menuGap : anchor.top - menuGap - rect.height, marginY, height - marginY - rect.height)}px`
  }
  function finish(suppress: boolean) {
    const current = drag
    if (!current) return
    drag = undefined; delete button.dataset.dragging
    suppressClick = current.moved && suppress ? current.pointerId : undefined
    try { button.releasePointerCapture(current.pointerId) } catch { /* A cancelled pointer may already have lost capture. */ }
    if (current.moved && !closed) persist()
  }
  function move(event: PointerEvent) {
    const current = drag
    if (!current || event.pointerId !== current.pointerId) return
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY
    if (!current.moved && Math.hypot(dx, dy) < dragThreshold) return
    current.moved = true; button.dataset.dragging = 'true'; event.preventDefault()
    position(current.origin.left + dx, current.origin.top + dy); reposition()
  }
  function resize() {
    if (closed) return
    const rect = button.getBoundingClientRect()
    position(rect.left, rect.top, false); reposition()
    if (button.style.left || button.style.top) persist()
  }
  function dispose() {
    if (closed) return
    closed = true; finish(false); suppressClick = undefined; observer?.disconnect()
    for (const item of listeners) item.target.removeEventListener(item.type, item.listener, item.options)
    options.signal.removeEventListener('abort', dispose)
  }
  try {
    const raw = sessionStorage.getItem(positionStorageKey), saved: unknown = raw ? JSON.parse(raw) : undefined
    if (saved && typeof saved === 'object' && 'left' in saved && 'top' in saved && typeof saved.left === 'number' && Number.isFinite(saved.left) && typeof saved.top === 'number' && Number.isFinite(saved.top)) position(saved.left, saved.top)
  } catch { /* Invalid or unavailable storage keeps the default CSS position. */ }
  listen(button, 'pointerdown', event => {
    const pointer = event as PointerEvent
    if (closed || drag || pointer.button !== 0 || pointer.isPrimary === false) return
    suppressClick = undefined
    const rect = button.getBoundingClientRect()
    drag = { pointerId: pointer.pointerId, startX: pointer.clientX, startY: pointer.clientY, origin: { left: rect.left, top: rect.top }, moved: false }
    try { button.setPointerCapture(pointer.pointerId) } catch { /* Keep normal clicks usable if this pointer cannot be captured. */ }
  })
  listen(button, 'pointermove', event => move(event as PointerEvent), { passive: false })
  listen(button, 'pointerup', event => { const pointer = event as PointerEvent; if (drag?.pointerId === pointer.pointerId) { move(pointer); finish(true) } })
  listen(button, 'pointercancel', event => { if (drag?.pointerId === (event as PointerEvent).pointerId) finish(false) })
  listen(button, 'lostpointercapture', event => { if (drag?.pointerId === (event as PointerEvent).pointerId) finish(false) })
  listen(button, 'click', event => {
    if (suppressClick === undefined) return
    const click = event as MouseEvent
    suppressClick = undefined
    if (click.detail === 0) return
    event.preventDefault(); event.stopImmediatePropagation()
  }, true)
  listen(window, 'blur', () => { finish(false); suppressClick = undefined })
  listen(window, 'resize', resize)
  listen(menu, 'toggle', reposition)
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(resize); observer.observe(button); observer.observe(menu)
  }
  options.signal.addEventListener('abort', dispose, { once: true })
}

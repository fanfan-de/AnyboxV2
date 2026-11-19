export interface ModelPickerChoice {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly group: string
  readonly groupLabel: string
  readonly disabled: boolean
}

export interface ModelPickerState {
  readonly choices: readonly ModelPickerChoice[]
  readonly selectedId: string
  readonly defaultId?: string | null
  readonly disabled: boolean
  readonly busy: boolean
  readonly savingDefault: boolean
}

/** Keep choices mounted across selection writes so the second click can reach the same option. */
export function createModelPicker(container: HTMLElement, id: string, signal: AbortSignal, actions: {
  select(id: string): void
  setDefault(id: string): void
  opened(): void
}) {
  const root = document.createElement('div')
  root.className = 'model-picker'
  root.innerHTML = `<button type="button" class="composer-model" aria-haspopup="listbox" aria-expanded="false"><span class="model-picker-label">选择模型</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button>
    <div class="model-picker-popover" hidden><div class="model-picker-list" role="listbox" aria-label="当前模型" tabindex="-1"></div><p class="model-picker-help">单击选择，双击设为默认<span class="sr-only">；键盘使用方向键导航，Enter 选择，Shift + Enter 设为默认，Escape 关闭</span></p></div>`
  const button = root.querySelector<HTMLButtonElement>('.composer-model')!
  const label = root.querySelector<HTMLElement>('.model-picker-label')!
  const popup = root.querySelector<HTMLElement>('.model-picker-popover')!
  const list = root.querySelector<HTMLElement>('.model-picker-list')!
  const help = root.querySelector<HTMLElement>('.model-picker-help')!
  list.id = id; help.id = `${id}-help`
  button.setAttribute('aria-controls', id)
  list.setAttribute('aria-describedby', help.id)
  popup.setAttribute('popover', 'manual')
  container.append(root)
  let state: ModelPickerState = { choices: [], selectedId: '', disabled: true, busy: false, savingDefault: false }
  let open = false, activeId = '', choicesKey = ''
  const options = new Map<string, HTMLButtonElement>()
  const available = () => state.choices.filter(choice => !choice.disabled)
  const position = (): void => {
    if (!open) return
    const anchor = button.getBoundingClientRect()
    if (!root.isConnected || !anchor.width || !anchor.height) { close(); return }
    const width = globalThis.innerWidth || anchor.right, height = globalThis.innerHeight || anchor.bottom
    const popupWidth = Math.max(0, Math.min(380, width - 24))
    popup.style.width = `${popupWidth}px`
    popup.style.left = `${Math.max(12, Math.min(anchor.left, width - popupWidth - 12))}px`
    const above = anchor.top - 12, below = height - anchor.bottom - 12
    const upwards = above >= Math.min(320, below)
    popup.style.maxHeight = `${Math.max(0, upwards ? above : below)}px`
    const popupHeight = popup.getBoundingClientRect().height
    popup.style.top = `${upwards ? Math.max(12, anchor.top - popupHeight - 6) : anchor.bottom + 6}px`
  }
  const markActive = (next: string, scroll = false): void => {
    activeId = next
    for (const [choiceId, option] of options) option.dataset.active = String(choiceId === next)
    const option = options.get(next)
    if (option) {
      list.setAttribute('aria-activedescendant', option.id)
      if (scroll) option.scrollIntoView?.({ block: 'nearest' })
    } else list.removeAttribute('aria-activedescendant')
  }
  const close = (restoreFocus = false): void => {
    open = false; root.dataset.open = 'false'; button.setAttribute('aria-expanded', 'false')
    if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover()
    popup.hidden = true
    if (restoreFocus && !button.disabled) button.focus({ preventScroll: true })
  }
  const show = (last = false): void => {
    if (state.disabled || state.busy || state.savingDefault) return
    open = true; root.dataset.open = 'true'; button.setAttribute('aria-expanded', 'true'); popup.hidden = false
    if (popup.showPopover && !popup.matches(':popover-open')) popup.showPopover()
    const choices = available()
    markActive(choices.find(choice => choice.id === state.selectedId)?.id ?? (last ? choices.at(-1)?.id : choices[0]?.id) ?? '', true)
    position(); list.focus({ preventScroll: true }); actions.opened()
  }
  const choiceAt = (target: EventTarget | null) => {
    const option = (target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-model-id]')
    return option && list.contains(option) ? state.choices.find(choice => choice.id === option.dataset.modelId) : undefined
  }
  const select = (choice: ModelPickerChoice): void => {
    if (choice.disabled || state.disabled || state.busy || state.savingDefault) return
    markActive(choice.id)
    if (choice.id !== state.selectedId) actions.select(choice.id)
  }
  button.addEventListener('click', () => { if (open) close(); else show() }, { signal })
  button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault(); show(event.key === 'ArrowUp')
  }, { signal })
  list.addEventListener('click', event => {
    const choice = choiceAt(event.target)
    if (!choice) return
    list.focus({ preventScroll: true })
    if (event.detail > 1) return
    select(choice)
  }, { signal })
  list.addEventListener('dblclick', event => {
    const choice = choiceAt(event.target)
    if (!choice || choice.disabled || state.disabled || state.savingDefault) return
    event.preventDefault(); list.focus({ preventScroll: true }); markActive(choice.id); actions.setDefault(choice.id)
  }, { signal })
  list.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(); return }
    const choices = available(), index = choices.findIndex(choice => choice.id === activeId)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
      markActive(choices[next]?.id ?? '', true)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const choice = choices.find(value => value.id === activeId)
      if (!choice) return
      if (event.shiftKey && event.key === 'Enter') {
        if (!state.disabled && !state.savingDefault) actions.setDefault(choice.id)
      } else select(choice)
    }
  }, { signal })
  document.body.addEventListener('pointerdown', event => { if (open && !root.contains(event.target as Node | null)) close() }, { signal })
  root.addEventListener('focusout', event => { if (open && !root.contains(event.relatedTarget as Node | null)) close() }, { signal })
  globalThis.window?.addEventListener('resize', position, { signal })
  signal.addEventListener('abort', () => close(), { once: true })
  return {
    close, position,
    render(next: ModelPickerState): void {
      state = next
      const key = JSON.stringify(state.choices)
      if (key !== choicesKey) {
        choicesKey = key; options.clear(); list.replaceChildren()
        const groups = new Map<string, HTMLElement>()
        for (const choice of state.choices) {
          let group = groups.get(choice.group)
          if (!group) {
            group = document.createElement('div'); group.className = 'model-picker-group'; group.setAttribute('role', 'group')
            const heading = document.createElement('div'); heading.className = 'model-picker-group-label'; heading.id = `${id}-group-${groups.size}`; heading.textContent = choice.groupLabel
            group.setAttribute('aria-labelledby', heading.id); group.append(heading); groups.set(choice.group, group); list.append(group)
          }
          const option = document.createElement('button'); option.type = 'button'; option.className = 'model-picker-option'; option.tabIndex = -1
          option.id = `${id}-option-${options.size}`; option.dataset.modelId = choice.id; option.setAttribute('role', 'option')
          const text = document.createElement('span'); text.className = 'model-picker-option-label'; text.textContent = choice.label
          const badge = document.createElement('span'); badge.className = 'model-picker-default'; badge.textContent = '默认'
          option.append(text, badge); group.append(option); options.set(choice.id, option)
        }
        if (!state.choices.length) {
          const empty = document.createElement('p'); empty.className = 'model-picker-empty'; empty.textContent = '暂无可用模型'; list.append(empty)
        }
      }
      for (const choice of state.choices) {
        const option = options.get(choice.id)!
        const isDefault = choice.id === state.defaultId
        option.setAttribute('aria-selected', String(choice.id === state.selectedId))
        option.setAttribute('aria-disabled', String(choice.disabled || state.disabled || state.busy || state.savingDefault))
        option.disabled = choice.disabled || state.disabled || state.savingDefault
        option.title = `${choice.label}${isDefault ? ' · Agent 默认模型' : ''}`
        option.querySelector<HTMLElement>('.model-picker-default')!.hidden = !isDefault
      }
      const selected = state.choices.find(choice => choice.id === state.selectedId)
      label.textContent = selected?.name ?? (state.selectedId ? '原模型已不可用' : '选择模型')
      button.title = `${label.textContent} · 单击选择，双击设为默认`
      button.setAttribute('aria-label', `当前模型：${label.textContent}`)
      button.disabled = state.disabled
      button.setAttribute('aria-disabled', String(state.disabled || state.busy || state.savingDefault))
      list.setAttribute('aria-busy', String(state.busy || state.savingDefault))
      if (state.disabled) close()
      else if (open) {
        if (!available().some(choice => choice.id === activeId)) markActive(available()[0]?.id ?? '')
        else markActive(activeId)
        position()
      }
    },
  }
}

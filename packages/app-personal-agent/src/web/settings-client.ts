export type SettingsSection = 'general' | 'agents' | 'connections' | 'archive' | 'models' | 'tools' | 'units'
export interface SettingsViewState { section: SettingsSection; open: boolean; focusDevice: boolean }

/** The current device remains fixed until its owner accepts a guarded page replacement. */
export function setupSettingsNavigation(root: HTMLElement, options: {
  devices: readonly { id: string; name: string }[]
  selectedId?: string
  selectedName?: string
  initialState?: SettingsViewState
  isActive(): boolean
  selectDevice(id: string): boolean
  refreshArchive(): void
  refreshTools?(): void
  resetModelsView?(): void
  refreshAgents(): void
  leaveAgents?(): void
}) {
  const required = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector)
    if (!element) throw new Error(`missing element ${selector}`)
    return element
  }
  const lifetime = new AbortController()
  const dialog = required<HTMLDialogElement>('#personal-agent--settings-dialog')
  const content = required<HTMLElement>('#personal-agent--settings-content')
  const scope = required<HTMLElement>('#personal-agent--settings-scope')
  const device = required<HTMLSelectElement>('#personal-agent--settings-device')
  const deviceLabel = required<HTMLLabelElement>('label[for="personal-agent--settings-device"]')
  const defaultDeviceLabel = deviceLabel.textContent
  const modelDeviceSlot = required<HTMLElement>('[data-models-device-slot]')
  const allDevices = required<HTMLElement>('#personal-agent--settings-all-devices')
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-settings-section]')]
  const panels = [...dialog.querySelectorAll<HTMLElement>('[data-settings-panel]')]
  const selected = options.selectedId ?? options.devices[0]?.id ?? ''
  const name = options.selectedName ?? options.devices.find(item => item.id === selected)?.name ?? '所选设备'
  const descriptions: Record<Exclude<SettingsSection, 'models' | 'units'>, string> = {
    general: `设置${name}上所选 Agent 的默认模型。未手动指定模型时，后续运行使用此设置。`,
    agents: `在${name}上创建 Agent，或编辑已有 Agent 的资料、Prompt 和默认模型。`,
    tools: `为${name}上所选 Agent 管理工具授权与偏好。撤权会阻止新的调用。`,
    connections: '连接执行设备并管理访问凭据。Agent、模型配置和会话保存在对应设备上。',
    archive: '查看已连接设备上的旧版对话及已归档记录。',
  }
  device.replaceChildren(...options.devices.map(item => {
    const option = document.createElement('option')
    option.value = item.id; option.textContent = item.name
    return option
  }))
  if (!options.devices.length) {
    const option = document.createElement('option')
    option.value = ''; option.textContent = '未选择设备'; device.append(option)
  }
  device.value = selected
  device.disabled = options.devices.length < 2
  const blocked = document.createElement('p')
  blocked.className = 'notice settings-device-status'; blocked.hidden = true
  blocked.setAttribute('role', 'status'); blocked.setAttribute('aria-live', 'polite')
  let disposed = false
  let section: SettingsSection = 'general'
  const panelFor = (value: SettingsSection) => panels.find(panel => panel.dataset.settingsPanel === value)
  const headingFor = (value: SettingsSection) => panelFor(value)?.querySelector<HTMLElement>('.settings-panel-heading')
  const selectSection = (value: SettingsSection) => {
    if (disposed || !panelFor(value)) return
    if (section === 'models' && value !== 'models') options.resetModelsView?.()
    if (section === 'agents' && value !== 'agents') options.leaveAgents?.()
    blocked.hidden = true
    section = value
    for (const button of buttons) {
      if (button.dataset.settingsSection === section) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== section
    const heading = headingFor(section)
    const title = heading?.querySelector<HTMLHeadingElement>('h3')
    modelDeviceSlot.hidden = section !== 'models'
    deviceLabel.textContent = section === 'models' ? '设备' : section === 'units' ? '执行设备' : defaultDeviceLabel
    if (section === 'models') {
      title?.classList.add('sr-only')
      modelDeviceSlot.append(scope)
    } else if (heading && title) {
      let row = heading.querySelector<HTMLElement>('.settings-title-row')
      if (!row) {
        row = document.createElement('div'); row.className = 'settings-title-row'
        const originalGroup = title.parentElement
        row.append(title); heading.prepend(row)
        if (originalGroup && originalGroup !== heading) {
          for (const child of [...originalGroup.children]) heading.insertBefore(child, originalGroup)
          originalGroup.remove()
        }
      }
      row.append(scope)
      if (section !== 'units') {
        let description = heading.querySelector<HTMLElement>('.settings-scope-description')
        if (!description) {
          // Reuse the scope line in general and global panels.
          description = section === 'general' || section === 'connections' || section === 'archive' ? heading.querySelector<HTMLElement>('p') : null
          if (!description) { description = document.createElement('p'); heading.append(description) }
          description.className = `${description.className} settings-scope-description`.trim()
        }
        description.textContent = descriptions[section]
      }
    }
    const global = section === 'connections' || section === 'archive'
    device.hidden = deviceLabel.hidden = global
    allDevices.hidden = !global
    content.scrollTop = 0
    if (section === 'tools') options.refreshTools?.()
    if (section === 'archive') options.refreshArchive()
    if (section === 'agents') options.refreshAgents()
  }
  const showBlocked = () => {
    if (disposed) return
    blocked.textContent = '请先保存或放弃尚未保存的修改，等待进行中的操作完成后再切换设备。'
    blocked.hidden = false
    const container = headingFor(section) ?? panelFor(section) ?? content
    container.append(blocked)
  }
  for (const button of buttons) button.addEventListener('click', () => {
    selectSection(button.dataset.settingsSection as SettingsSection)
  }, { signal: lifetime.signal })
  dialog.addEventListener('close', () => {
    if (!dialog.open && section === 'models') options.resetModelsView?.()
  }, { signal: lifetime.signal })
  dialog.addEventListener('input', () => { blocked.hidden = true }, { signal: lifetime.signal })
  dialog.addEventListener('click', event => {
    if ((event.target as HTMLElement | null)?.closest?.('.settings-panel button')) blocked.hidden = true
  }, { signal: lifetime.signal })
  device.addEventListener('change', () => {
    const next = device.value
    device.value = selected
    if (disposed || !options.devices.some(item => item.id === next) || next === selected) return
    blocked.hidden = true
    if (!options.selectDevice(next)) showBlocked()
  }, { signal: lifetime.signal })
  const open = (value?: SettingsSection) => {
    if (disposed) return
    if (value) selectSection(value)
    if (options.isActive() && !dialog.open) {
      if (section === 'models') options.resetModelsView?.()
      dialog.showModal()
      if (section === 'tools') options.refreshTools?.()
      if (section === 'archive') options.refreshArchive()
    }
  }
  selectSection(options.initialState?.section ?? 'general')
  return {
    selectSection, open, showBlocked,
    snapshot(): SettingsViewState { return { section, open: dialog.open, focusDevice: document.activeElement === device } },
    restore() {
      if (disposed || !options.initialState?.open || !options.isActive()) return
      open()
      if (options.initialState.focusDevice && !device.hidden && !device.disabled) device.focus()
    },
    dispose() { disposed = true; lifetime.abort() },
  }
}

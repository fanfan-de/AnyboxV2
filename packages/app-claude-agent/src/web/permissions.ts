import type { PermissionModeView } from '../core/view.js'
import { sourceI18n } from './i18n.js'
import type { ClaudeI18n } from './i18n.js'

const optionKeys = [
  { value: 'default', label: 'permission.ask', description: 'permission.askHelp' },
  { value: 'acceptEdits', label: 'permission.acceptEdits', description: 'permission.acceptEditsHelp' },
  { value: 'plan', label: 'permission.plan', description: 'permission.planHelp' },
  { value: 'auto', label: 'permission.auto', description: 'permission.autoHelp' },
  { value: 'dontAsk', label: 'permission.dontAsk', description: 'permission.dontAskHelp' },
] as const
/** Source-language compatibility projection; UI labels use the owning mount's instance. */
export const permissionModeOptions: readonly { value: PermissionModeView; label: string; description: string }[] = optionKeys.map(option => ({ value: option.value, label: sourceI18n.t(option.label), description: sourceI18n.t(option.description) }))
export function createPermissionPicker(change: (mode: PermissionModeView) => Promise<void>, manage?: () => void, i18n: ClaudeI18n = sourceI18n) {
  const { t, element: el } = i18n
  let mode = 'default', active = false, busy = false, available = false
  const summary = el('summary', { class: 'ca-permission-summary', 'aria-label': () => t('permission.mode'), text: () => { const key = optionKeys.find(option => option.value === mode)?.label; return key ? t(key) : mode } })
  const hint = el('p', { class: 'ca-permission-scope', text: () => active ? t('permission.activeHint') : t('permission.nextHint') })
  const buttons = optionKeys.map(option => {
    const button = el('button', { type: 'button', class: 'ca-permission-option', 'data-permission-mode': option.value }, el('strong', { text: () => t(option.label) }), el('span', { text: () => t(option.description) }))
    button.addEventListener('click', () => {
      if (button.disabled || busy) return
      busy = true; for (const item of buttons) item.disabled = true
      void change(option.value).finally(() => { busy = false; for (const item of buttons) item.disabled = !available; element.open = false; summary.focus() })
    })
    return button
  })
  const manageButton = el('button', { type: 'button', class: 'ca-session-permissions-open', text: () => t('permission.manage'), 'aria-haspopup': 'dialog', hidden: true })
  manageButton.addEventListener('click', () => { element.open = false; manage?.() })
  const element = el('details', { class: 'ca-permission-picker' }, summary, el('div', { class: 'ca-permission-popover' }, el('strong', { text: () => t('permission.mode') }), hint, ...buttons, manageButton,
    el('p', { class: 'ca-permission-footnote', text: () => t('permission.footnote') })))
  element.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); element.open = false; summary.focus() } })
  return { element, summary,
    update(nextMode: string, nextActive: boolean, enabled: boolean, hasThread = false) {
      mode = nextMode; active = nextActive; available = enabled
      manageButton.hidden = !manage || !hasThread
      const key = optionKeys.find(option => option.value === mode)?.label
      summary.textContent = key ? t(key) : mode
      hint.textContent = active ? t('permission.activeHint') : t('permission.nextHint')
      for (const button of buttons) { button.disabled = busy || !available; button.setAttribute('aria-pressed', String(button.dataset.permissionMode === mode)) }
    },
    close() { element.open = false },
  }
}

import type { PermissionModeView } from '../core/view.js'
import { el } from './view.js'

export const permissionModeOptions: readonly { value: PermissionModeView; label: string; description: string }[] = [
  { value: 'default', label: '询问', description: '需要授权的编辑与命令先询问你，沿用 Claude 的已有规则。' },
  { value: 'acceptEdits', label: '自动接受编辑', description: '自动接受文件编辑；其他需要授权的终端操作仍会询问。' },
  { value: 'plan', label: '规划', description: '先分析与制定计划，按 Claude 的规划模式限制改动。' },
  { value: 'auto', label: '自动审批', description: '由 Claude 的安全分类器判断操作；可用性取决于执行设备的版本与账户。' },
  { value: 'dontAsk', label: '仅已批准操作', description: '没有规则预先允许的操作直接拒绝，不再弹出审批。' },
]
export function createPermissionPicker(change: (mode: PermissionModeView) => Promise<void>, manage?: () => void) {
  const summary = el('summary', { class: 'ca-permission-summary', 'aria-label': '权限模式', text: '询问' })
  const hint = el('p', { class: 'ca-permission-scope' })
  let busy = false, available = false
  const buttons = permissionModeOptions.map(option => {
    const button = el('button', { type: 'button', class: 'ca-permission-option', 'data-permission-mode': option.value }, el('strong', { text: option.label }), el('span', { text: option.description }))
    button.addEventListener('click', () => {
      if (button.disabled || busy) return
      busy = true; for (const item of buttons) item.disabled = true
      void change(option.value).finally(() => { busy = false; for (const item of buttons) item.disabled = !available; element.open = false; summary.focus() })
    })
    return button
  })
  const manageButton = el('button', { type: 'button', class: 'ca-session-permissions-open', text: '查看会话授权', 'aria-haspopup': 'dialog', hidden: true })
  manageButton.addEventListener('click', () => { element.open = false; manage?.() })
  const element = el('details', { class: 'ca-permission-picker' }, summary, el('div', { class: 'ca-permission-popover' }, el('strong', { text: '权限模式' }), hint, ...buttons, manageButton,
    el('p', { class: 'ca-permission-footnote', text: '权限由 Claude 执行。项目目录不是文件系统沙箱，管理员规则仍然生效。' })))
  element.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); element.open = false; summary.focus() } })
  return { element, summary,
    update(mode: string, active: boolean, enabled: boolean, hasThread = false) {
      available = enabled
      manageButton.hidden = !manage || !hasThread
      summary.textContent = permissionModeOptions.find(option => option.value === mode)?.label ?? mode
      hint.textContent = active ? '切换后应用于当前任务及此会话后续任务；已发出的审批仍需处理。' : '发送时应用于下一次任务，并记住此会话的选择。'
      for (const button of buttons) { button.disabled = busy || !available; button.setAttribute('aria-pressed', String(button.dataset.permissionMode === mode)) }
    },
    close() { element.open = false },
  }
}

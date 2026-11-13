import type { RunStatus, WorkStatus } from '../contracts.js'

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
export const append = <T extends HTMLElement>(node: T, ...children: (Node | string)[]): T => { node.append(...children); return node }
export function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
export function workStatus(status: WorkStatus): string {
  return { open: '待推进', running: '执行中', waiting: '等待中', completed: '已完成', cancelled: '已取消' }[status]
}
export function runStatus(status: RunStatus): string {
  return { running: '正在思考', succeeded: '执行完成', cancelled: '已取消', failed: '执行失败', interrupted: '执行中断' }[status]
}
export function errorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    conflict: '内容已在其他页面更新。请刷新后重新编辑。',
    'context-capacity': '上下文容量不足，任务已暂停。请显式开始新的上下文段后继续。',
    'context-capacity-exceeded': '上下文容量不足，任务已暂停。请显式开始新的上下文段后继续。',
    'credential-unavailable': '系统凭据服务不可用。已保存的模型元数据仍可查看，Key 请在凭据服务恢复后补充。',
    'credential-missing': '此模型尚未配置 Key，请打开模型设置。',
    'invalid-input': '请检查必填内容和输入长度。',
    'invalid-config': '模型配置有误，请检查协议、地址和模型 ID。',
    'not-found': '内容已不存在，请重新选择。',
    'work-busy': '这个任务正在执行，请等待本轮退出或显式取消。',
    'run-active': '这个任务正在执行，请等待本轮退出或显式取消。',
    'work-closed': '请先重新打开这个任务，再继续推进。',
    'model-unavailable': '所选模型不可用，请检查模型配置和 Key。',
    'model-required': '请先在 Agent 配置中选择一个可用模型。',
    'unavailable': '应用暂时不可用，请稍后重试。',
    'product-unavailable': '应用尚未运行或正在关闭。',
    'cleanup-failure': '执行资源退出未确认，暂时无法继续。请保留现场并检查应用状态。',
  }
  return messages[code] ?? `操作未完成${code ? `（${code}）` : ''}。请保留输入并重试。`
}
export function formattedTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
export function downloadText(title: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = element('a')
  link.href = url
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || '成果'}.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

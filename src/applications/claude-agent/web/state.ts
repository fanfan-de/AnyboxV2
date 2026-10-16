import type { HistoryMessageView, LiveItemView, RunLiveView, RunResultView, TranscriptBlockView } from '../core/view.js'

/** Application-local route: which execution device and thread the browser is looking at. */
export interface ClaudeAgentRoute { readonly hostId?: string; readonly threadId?: string }
const segmentPattern = /^[A-Za-z0-9._:-]{1,128}$/
export function parseRoute(route: string): ClaudeAgentRoute {
  const match = /^host\/([^/]+)(?:\/thread\/([^/]+))?$/.exec(route.replace(/^\/+/, ''))
  if (!match) return {}
  try {
    const hostId = decodeURIComponent(match[1]), threadId = match[2] === undefined ? undefined : decodeURIComponent(match[2])
    if (!segmentPattern.test(hostId) || threadId !== undefined && !segmentPattern.test(threadId)) return {}
    return threadId === undefined ? { hostId } : { hostId, threadId }
  } catch { return {} }
}
export function formatRoute(route: ClaudeAgentRoute): string {
  if (!route.hostId) return ''
  return `host/${encodeURIComponent(route.hostId)}${route.threadId ? `/thread/${encodeURIComponent(route.threadId)}` : ''}`
}
export interface DeviceSummary { readonly id: string; readonly name: string; readonly instanceId: string }
export function deviceLabel(device: DeviceSummary, localInstanceId: string | null): string {
  return device.instanceId === localInstanceId ? `本地 · ${device.name}` : device.name
}
/** Picks the device from the route, then the remembered choice, then this machine, then the first registered device. */
export function selectDevice<Device extends DeviceSummary>(devices: readonly Device[], route: ClaudeAgentRoute, remembered: string | null, localInstanceId: string | null = null): Device | undefined {
  return devices.find(device => device.instanceId === route.hostId) ?? devices.find(device => device.id === remembered)
    ?? devices.find(device => localInstanceId !== null && device.instanceId === localInstanceId) ?? devices[0]
}
export interface ApiError extends Error { readonly status: number; readonly code: string }
export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && 'status' in error && 'code' in error
}
const copy: Record<string, string> = {
  'claude-binary-missing': '执行设备上没有可用的 `claude` 命令。请在那台设备上安装 Claude 并运行 `claude auth login`，或用 ANYBOX_CLAUDE_AGENT_BINARY 指定可执行文件。',
  'claude-binary-shim': '执行设备上的 `claude` 只是启动脚本，无法直接运行；请用 ANYBOX_CLAUDE_AGENT_BINARY 指定真正的可执行文件。',
  'run-active': '这个线程已有正在执行的任务，请等待完成或先取消。',
  'idempotency-conflict': '相同的提交编号对应了不同内容，请重新发送。',
  'thread-not-found': '线程不存在，请刷新列表。',
  'run-not-found': '任务不存在，请刷新。',
  'view-unavailable': '这次任务的实时记录已不在内存中；历史请从线程转录查看。',
  'approval-resolved': '这个请求已经被回答或不再等待。',
  'project-path-invalid': '项目目录必须是执行设备上的绝对路径。',
  'project-path-missing': '执行设备上没有这个目录，请检查路径。',
  'history-unavailable': '暂时无法读取会话转录，请稍后重试。',
  'history-too-large': '会话转录过大，无法在这里完整显示。',
  'invalid-input': '输入无效，请检查后重试。',
  'request-too-large': '提示词过长，请缩短后重试。',
  'service-unavailable': '服务暂时不可用，请稍后重试。',
  'product-unavailable': '所选设备上的 Claude Agent 尚未启动。',
  'product-busy': 'Claude Agent 仍有正在执行的任务。',
  'product-startup-failed': '所选设备上的 Claude Agent 未能启动，请在那台设备上检查状态。',
  'product-not-found': '所选设备上没有 Claude Agent 应用，请先把那台设备升级到包含它的版本。',
  'authentication-failed': '访问令牌无效或已撤销，请在“管理连接”中更新凭据。',
  'credential-unavailable': '系统凭据库不可用；连接配置仍保留。',
  'instance-mismatch': '此地址对应的实例已改变，已阻止请求。请为新实例添加连接。',
  'connection-changed': '此连接已被修改，请刷新页面。',
  'connection-unavailable': '无法连接执行设备。已有任务可能仍在继续。',
  'not-found': '未找到请求的资源。',
  'too-many-streams': '订阅数量已达上限，请关闭其他页面后重试。',
}
/** Server messages are the product's own safe strings; they take precedence over generic copy. */
export function messageFor(error: unknown): string {
  if (!isApiError(error)) return error instanceof Error && error.name === 'AbortError' ? '请求已取消。' : '无法连接执行设备，请检查连接状态后重试。'
  const own = error.message && error.message !== error.code ? error.message : ''
  return own || copy[error.code] || `请求未能完成（${error.code}）。`
}
export interface DisplayItem { readonly id: string; readonly role: 'user' | 'assistant'; readonly blocks: readonly TranscriptBlockView[]; readonly streaming: boolean }
const liveItem = (item: LiveItemView): DisplayItem => ({ id: `live:${item.id}`, role: item.role, blocks: item.blocks.map(entry => entry.block), streaming: item.blocks.some(entry => entry.state === 'streaming') })
/** Transcript history followed by the running Run's prompt and live projection; finished Runs are read back from the transcript. */
export function displayItems(history: readonly HistoryMessageView[], live: RunLiveView | undefined, prompt: string | undefined): DisplayItem[] {
  const items: DisplayItem[] = history.map(message => ({ id: message.id, role: message.role, blocks: message.blocks, streaming: false }))
  if (!live) return items
  if (prompt) items.push({ id: `live:${live.runId}:prompt`, role: 'user', blocks: [{ kind: 'text', text: prompt, truncated: false }], streaming: false })
  return [...items, ...live.items.map(liveItem)]
}
const money = (value: number) => `$${value.toFixed(value < 0.01 && value > 0 ? 4 : 2)}`
export function formatUsage(result: RunResultView): string {
  const tokens = `${result.usage.inputTokens + result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens} 输入 / ${result.usage.outputTokens} 输出`
  return `${result.numTurns} 轮 · ${(result.durationMs / 1000).toFixed(1)} 秒 · ${tokens} tokens · 约 ${money(result.totalCostUsd)}${result.isError ? ' · 出错' : ''}`
}
export const runStatusLabels: Readonly<Record<string, string>> = Object.freeze({ running: '正在执行', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })
export interface ThreadLike { readonly id: string; readonly projectPath: string; readonly title: string; readonly updatedAt: string; readonly lastRun: { readonly status: string } | null; readonly pendingApprovals: number }
export interface ThreadGroup<Thread extends ThreadLike> { readonly path: string; readonly name: string; readonly updatedAt: string; readonly threads: readonly Thread[] }
const lastSegment = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
/** Threads grouped by project directory: newest thread first inside a group, groups ordered by their newest thread. */
export function groupThreads<Thread extends ThreadLike>(threads: readonly Thread[]): ThreadGroup<Thread>[] {
  const groups = new Map<string, Thread[]>()
  for (const thread of threads) { const list = groups.get(thread.projectPath); if (list) list.push(thread); else groups.set(thread.projectPath, [thread]) }
  return [...groups].map(([path, list]) => {
    const sorted = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)))
    return { path, name: lastSegment(path), updatedAt: sorted[0].updatedAt, threads: sorted }
  }).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.path.localeCompare(b.path)))
}
export type ThreadIndicator = 'approval' | 'running' | 'failed' | null
/** A waiting approval outranks the running state; failed and interrupted Runs share one indicator. */
export function threadIndicator(thread: Pick<ThreadLike, 'lastRun' | 'pendingApprovals'>): ThreadIndicator {
  const status = thread.lastRun?.status
  if (status === 'running' || status === 'cancelling') return thread.pendingApprovals > 0 ? 'approval' : 'running'
  return status === 'failed' || status === 'interrupted' ? 'failed' : null
}
export const threadIndicatorLabels: Readonly<Record<Exclude<ThreadIndicator, null>, string>> = Object.freeze({ approval: '等待审批', running: '正在执行', failed: '失败或中断' })
/** Coarse relative time in Chinese; `now` is explicit so rendering stays pure. Invalid input returns an empty string. */
export function relativeTime(iso: string, now: number): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

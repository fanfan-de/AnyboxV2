import { sourceI18n } from './i18n.js'
import type { ClaudeI18n } from './i18n.js'
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
export function deviceLabel(device: DeviceSummary, localInstanceId: string | null, i18n: ClaudeI18n = sourceI18n): string {
  return device.instanceId === localInstanceId ? i18n.t('device.local', { name: device.name }) : device.name
}
/** Picks the device from the route, then this machine, then the remembered choice, then the first qualified device. */
export function selectDevice<Device extends DeviceSummary>(devices: readonly Device[], route: ClaudeAgentRoute, remembered: string | null, localInstanceId: string | null = null): Device | undefined {
  return devices.find(device => device.instanceId === route.hostId) ?? devices.find(device => localInstanceId !== null && device.instanceId === localInstanceId)
    ?? devices.find(device => device.id === remembered) ?? devices[0]
}
export const claudeAgentCapability = 'claude-agent.v1'
/** What a device's `/instance` answered; `undefined` means it could not be reached through the gateway. */
export interface DeviceProbe { readonly capabilities: readonly string[] }
export interface DevicePartition<Device extends DeviceSummary> { readonly qualified: Device[]; readonly unreachable: Device[]; readonly unsupported: Device[] }
/** Only devices whose instance advertises the Claude Agent capability are offered; the rest are counted for a hint, never selected. */
export function filterDevices<Device extends DeviceSummary>(devices: readonly Device[], probes: ReadonlyMap<string, DeviceProbe | undefined>): DevicePartition<Device> {
  const partition: DevicePartition<Device> = { qualified: [], unreachable: [], unsupported: [] }
  for (const device of devices) {
    const probe = probes.get(device.id)
    if (!probe) partition.unreachable.push(device)
    else if (probe.capabilities.includes(claudeAgentCapability)) partition.qualified.push(device)
    else partition.unsupported.push(device)
  }
  return partition
}
export type ComposerBlock = 'no-device' | 'not-running' | 'no-target' | 'running' | 'submitting' | null
export interface ComposerInput { readonly hasDevice: boolean; readonly productRunning: boolean; readonly hasTarget: boolean; readonly runActive: boolean; readonly submitting: boolean }
/** The single reason the composer cannot send right now, in the order a user would resolve them. */
export function composerBlock(input: ComposerInput): ComposerBlock {
  if (!input.hasDevice) return 'no-device'
  if (!input.productRunning) return 'not-running'
  if (!input.hasTarget) return 'no-target'
  if (input.runActive) return 'running'
  if (input.submitting) return 'submitting'
  return null
}
export interface ApiError extends Error { readonly status: number; readonly code: string }
export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && 'status' in error && 'code' in error
}
const errorKeys = {
  'claude-binary-missing': 'error.claude-binary-missing',
  'claude-binary-shim': 'error.claude-binary-shim',
  'run-active': 'error.run-active',
  'idempotency-conflict': 'error.idempotency-conflict',
  'thread-not-found': 'error.thread-not-found',
  'run-not-found': 'error.run-not-found',
  'view-unavailable': 'error.view-unavailable',
  'approval-resolved': 'error.approval-resolved',
  'permissions-active': 'error.permissions-active',
  'permissions-changing': 'error.permissions-changing',
  'permissions-invalid': 'error.permissions-invalid',
  'permissions-limit': 'error.permissions-limit',
  'permission-not-found': 'error.permission-not-found',
  'project-path-invalid': 'error.project-path-invalid',
  'project-path-missing': 'error.project-path-missing',
  'models-unavailable': 'error.models-unavailable',
  'models-timeout': 'error.models-timeout',
  'models-too-large': 'error.models-too-large',
  'history-unavailable': 'error.history-unavailable',
  'history-too-large': 'error.history-too-large',
  'invalid-input': 'error.invalid-input',
  'request-too-large': 'error.request-too-large',
  'service-unavailable': 'error.service-unavailable',
  'product-unavailable': 'error.product-unavailable',
  'product-busy': 'error.product-busy',
  'product-startup-failed': 'error.product-startup-failed',
  'product-not-found': 'error.product-not-found',
  'authentication-failed': 'error.authentication-failed',
  'credential-unavailable': 'error.credential-unavailable',
  'instance-mismatch': 'error.instance-mismatch',
  'connection-changed': 'error.connection-changed',
  'connection-unavailable': 'error.connection-unavailable',
  'local-execution-unavailable': 'error.local-execution-unavailable',
  'not-found': 'error.not-found',
  'too-many-streams': 'error.too-many-streams',
  'picker-busy': 'error.picker-busy',
  'picker-unsupported': 'error.picker-unsupported',
  'picker-unavailable': 'error.picker-unavailable',
} as const
/** Original product/SDK diagnostic messages remain verbatim; only the app-owned code mapping is translated. */
export function messageFor(error: unknown, i18n: ClaudeI18n = sourceI18n): string {
  if (!isApiError(error)) return error instanceof Error && error.name === 'AbortError' ? i18n.t('error.cancelled') : i18n.t('error.connection')
  const own = error.message && error.message !== error.code ? error.message : ''
  if (own) return own
  const key = Object.hasOwn(errorKeys, error.code) ? errorKeys[error.code as keyof typeof errorKeys] : undefined
  return key ? i18n.t(key) : i18n.t('error.unknown', { code: error.code })
}
export interface DisplayItem { readonly id: string; readonly role: 'user' | 'assistant'; readonly blocks: readonly TranscriptBlockView[]; readonly streaming: boolean }
const liveItem = (item: LiveItemView): DisplayItem => ({ id: `live:${item.id}`, role: item.role, blocks: item.blocks.map(entry => entry.block), streaming: item.blocks.some(entry => entry.state === 'streaming') })
/** Transcript history followed by the running Run's prompt and live projection; finished Runs are read back from the transcript. */
export function displayItems(history: readonly HistoryMessageView[], live: RunLiveView | undefined, prompt: string | undefined, attachments: readonly {readonly name:string;readonly mime:string}[] = []): DisplayItem[] {
  const items: DisplayItem[] = history.map(message => ({ id: message.id, role: message.role, blocks: message.blocks, streaming: false }))
  if (!live) return items
  if (prompt || attachments.length) items.push({ id: `live:${live.runId}:prompt`, role: 'user', blocks: [...(prompt?[{ kind: 'text' as const, text: prompt, truncated: false }]:[]),...attachments.map(a=>({kind:'attachment' as const,name:a.name,mime:a.mime}))], streaming: false })
  return [...items, ...live.items.map(liveItem)]
}
export function formatUsage(result: RunResultView, i18n: ClaudeI18n = sourceI18n): string {
  return i18n.t('usage.summary', { turns: i18n.number(result.numTurns), seconds: i18n.number(result.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), input: i18n.number(result.usage.inputTokens + result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens), output: i18n.number(result.usage.outputTokens), cost: i18n.money(result.totalCostUsd), error: result.isError ? i18n.t('usage.error') : '' })
}
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
/** Coarse relative time in the presentation locale; explicit now makes rendering deterministic. */
export function relativeTime(iso: string, now: number, i18n: ClaudeI18n = sourceI18n): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return i18n.t('time.justNow')
  const minutes = Math.round(seconds / 60), hours = Math.round(minutes / 60), days = Math.round(hours / 24)
  return minutes < 60 ? i18n.relative(-minutes, 'minute') : hours < 24 ? i18n.relative(-hours, 'hour') : days < 30 ? i18n.relative(-days, 'day') : i18n.date(time)
}

const statusKeys = { running: 'status.running', cancelling: 'status.cancelling', completed: 'status.completed', failed: 'status.failed', cancelled: 'status.cancelled', interrupted: 'status.interrupted' } as const
export function runStatusLabel(status: string, i18n: ClaudeI18n): string { return Object.hasOwn(statusKeys, status) ? i18n.t(statusKeys[status as keyof typeof statusKeys]) : status }
export function indicatorLabel(indicator: Exclude<ThreadIndicator, null>, i18n: ClaudeI18n): string { return i18n.t(({ approval: 'status.approval', running: 'status.running', failed: 'status.failedIndicator' } as const)[indicator]) }
export function composerBlockLabel(block: Exclude<ComposerBlock, null>, i18n: ClaudeI18n): string { return i18n.t(({ 'no-device': 'block.noDevice', 'not-running': 'block.notRunning', 'no-target': 'block.noTarget', running: 'block.running', submitting: 'block.submitting' } as const)[block]) }

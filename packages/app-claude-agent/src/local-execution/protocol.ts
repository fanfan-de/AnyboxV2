import { failure } from '@anybox/application-api/node'

/** Private to the two Claude Agent roles. The host transports these values without interpreting them. */
export interface LocalExecutionDescription { readonly instanceId: string; readonly name: string; readonly capabilities: readonly string[] }
export interface LocalExecutionRequest {
  readonly type: 'request'
  /** The client can close an accepted request even when its opening reply is lost. */
  readonly requestId?: string
  readonly reserved?: true
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
  readonly instanceId?: string
}
export interface LocalExecutionResponse {
  readonly requestId: string
  readonly instanceId: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** Base64, so a frame boundary never changes UTF-8 bytes. */
  readonly chunk: string
  readonly done: boolean
}
export interface LocalExecutionChunk { readonly instanceId: string; readonly chunk: string; readonly done: boolean }
export interface LocalExecutionClosed { readonly instanceId: string; readonly closed: true }
export interface LocalExecutionReserved { readonly instanceId: string; readonly requestId: string; readonly reserved: true }
export type LocalExecutionCommand = { readonly type: 'describe' } | LocalExecutionRequest |
  { readonly type: 'reserve'; readonly requestId: string; readonly instanceId: string } |
  { readonly type: 'read'; readonly requestId: string; readonly instanceId: string } |
  { readonly type: 'close'; readonly requestId: string; readonly instanceId: string } |
  { readonly type: 'watch'; readonly requestId: string; readonly instanceId: string }
export const localExecutionLimits = Object.freeze({ frameBytes: 64 * 1024, bodyBytes: 512 * 1024, bufferedBytes: 8 * 1024 * 1024, sessions: 64, idleMs: 30_000 })

export function localExecutionCommand(value: unknown): LocalExecutionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, 'invalid-input')
  const input = value as Record<string, unknown>
  const keys = input.type === 'describe' ? ['type'] : input.type === 'request' ? ['type', 'requestId', 'reserved', 'method', 'path', 'body', 'instanceId'] : ['type', 'requestId', 'instanceId']
  if (Object.keys(input).some(key => !keys.includes(key))) throw failure(400, 'invalid-input')
  if (input.type === 'describe') return { type: 'describe' }
  if (input.type === 'read' || input.type === 'close' || input.type === 'watch' || input.type === 'reserve') {
    if (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.requestId) || typeof input.instanceId !== 'string') throw failure(400, 'invalid-input')
    return { type: input.type, requestId: input.requestId, instanceId: input.instanceId }
  }
  if (input.type !== 'request' || !['GET', 'POST'].includes(String(input.method)) || typeof input.path !== 'string' ||
    input.path.length > 8192 || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\\0#]/.test(input.path) ||
    input.instanceId !== undefined && typeof input.instanceId !== 'string' || input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.requestId)) ||
    input.reserved !== undefined && input.reserved !== true || input.reserved === true && input.requestId === undefined ||
    input.method === 'GET' && input.body !== undefined) throw failure(400, 'invalid-input')
  const url = new URL(input.path, 'http://claude-agent.local')
  if (url.origin !== 'http://claude-agent.local' || url.pathname + url.search !== input.path || url.pathname.split('/').some(part => {
    try { return /[\\/\0]/.test(decodeURIComponent(part)) } catch { return true }
  })) throw failure(400, 'invalid-input')
  if (url.pathname !== '/instance' && !/^\/products\/claude-agent(?:\/(?:open|stop|retry))?$/.test(url.pathname) && !url.pathname.startsWith('/apps/claude-agent/')) throw failure(404, 'not-found')
  return { type: 'request', method: input.method as 'GET' | 'POST', path: input.path,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId as string }),
    ...(input.reserved === true ? { reserved: true } : {}),
    ...(input.body === undefined ? {} : { body: input.body }), ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId as string }) }
}

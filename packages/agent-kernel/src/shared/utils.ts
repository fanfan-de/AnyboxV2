import { fault } from './errors.js'
import type { AgentDefinition, RunLimits, RunResult, RunSnapshot, TextPart } from '@anybox/agent-contracts'

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
export function terminal(run: RunSnapshot): run is RunResult {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted'
}
export function string(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024) {
    throw fault('INVALID_ARGUMENT', `${name} must be a non-empty string of at most 1024 bytes`)
  }
}
export function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw fault('INVALID_ARGUMENT', 'revision must be a positive safe integer')
}
export function textBytes(parts: readonly TextPart[]): number {
  return parts.reduce((total, part) => total + Buffer.byteLength(part.text), 0)
}
export function textParts(value: unknown): asserts value is readonly TextPart[] {
  if (!Array.isArray(value) || !value.length || value.some(part => !part || part.type !== 'text' || typeof part.text !== 'string')) {
    throw fault('INVALID_ARGUMENT', 'content must be a non-empty array of text parts')
  }
}
export const defaultLimits: RunLimits = Object.freeze({
  maxConcurrent: 2, maxQueued: 32, runTimeoutMs: 30_000,
  maxInputBytes: 32 * 1024, maxOutputBytes: 32 * 1024, maxContextBytes: 256 * 1024,
  maxSessions: 100, maxRuns: 1000,
  maxSteps: 16, maxToolCalls: 32, maxToolResultBytes: 32 * 1024,
})
export function limits(input: Partial<RunLimits> = {}): RunLimits {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_ARGUMENT', 'limits must be an object')
  const result = { ...defaultLimits, ...input }
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(defaultLimits, key) || !Number.isSafeInteger(value) || value < (key === 'maxQueued' ? 0 : 1)) {
      throw fault('INVALID_ARGUMENT', `invalid limit: ${key}`)
    }
  }
  if (result.runTimeoutMs > 2_147_483_647) throw fault('INVALID_ARGUMENT', 'runTimeoutMs exceeds timer range')
  return Object.freeze(result)
}
export function definition(value: AgentDefinition): AgentDefinition {
  if (!value || !value.model) throw fault('INVALID_ARGUMENT', 'definition and model are required')
  string(value.id, 'definition.id'); revision(value.revision)
  if (typeof value.instructions !== 'string') throw fault('INVALID_ARGUMENT', 'instructions must be text')
  const model = value.model
  string(model.protocolId, 'protocolId'); string(model.providerId, 'providerId'); string(model.modelId, 'modelId')
  revision(model.configRevision)
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 128) throw fault('INVALID_ARGUMENT', 'tools must be an array of at most 128 references')
    const ids = new Set<string>()
    for (const tool of value.tools) {
      string(tool?.id, 'tool.id'); revision(tool.revision)
      if (ids.has(tool.id)) throw fault('INVALID_ARGUMENT', 'duplicate tool reference')
      ids.add(tool.id)
    }
  }
  // 只复制已定义的字段，拒绝将客户端或隐藏配置写入状态。
  return { id: value.id, revision: value.revision, instructions: value.instructions,
    model: { protocolId: model.protocolId, providerId: model.providerId, modelId: model.modelId, configRevision: model.configRevision },
    ...(value.tools ? { tools: value.tools.map(tool => ({ id: tool.id, revision: tool.revision })) } : {}) }
}
export function observe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(fault('CANCELLED', 'wait cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fault('CANCELLED', 'wait cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

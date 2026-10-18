import { rpcFailure } from '../desktop/rpc.js'

const maximumBytes = 1024 * 1024
/** Capture only bounded JSON data; accessors, prototypes and native handles never cross the role channel. */
export function captureApplicationChannelPayload(value: unknown): unknown {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > 100_000) throw rpcFailure('application-channel-invalid-payload')
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || seen.has(input) || Object.getOwnPropertySymbols(input).length) throw rpcFailure('application-channel-invalid-payload')
    const prototype = Object.getPrototypeOf(input)
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw rpcFailure('application-channel-invalid-payload')
    seen.add(input)
    let result: unknown
    if (Array.isArray(input)) {
      if (Object.keys(input).length !== input.length || Object.getOwnPropertyNames(input).length !== input.length + 1) throw rpcFailure('application-channel-invalid-payload')
      result = Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw rpcFailure('application-channel-invalid-payload')
        return visit(descriptor.value, depth + 1)
      })
    } else {
      const entries = Object.entries(Object.getOwnPropertyDescriptors(input)).map(([key, descriptor]) => {
        if (!('value' in descriptor) || !descriptor.enumerable) throw rpcFailure('application-channel-invalid-payload')
        return [key, visit(descriptor.value, depth + 1)] as const
      })
      result = Object.fromEntries(entries)
    }
    seen.delete(input)
    return result
  }
  const result = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes) throw rpcFailure('application-channel-invalid-payload')
  return result
}

import type { KernelErrorCode } from '@anybox/agent-contracts'
import { KernelFault } from '@anybox/agent-contracts/api'

export { KernelFault } from '@anybox/agent-contracts/api'

export function fault(code: KernelErrorCode, message: string): KernelFault {
  return new KernelFault({ code, message })
}
/** 未知实现错误只保存在 cause，不进入公共记录或消息。 */
export function wrap(code: KernelErrorCode, message: string, cause: unknown): KernelFault {
  return new KernelFault({ code, message }, { cause })
}
export function throwCollected(errors: readonly unknown[], message: string): void {
  const unique = [...new Set(errors)]
  if (unique.length === 1) throw unique[0]
  if (unique.length > 1) throw new AggregateError(unique, message)
}

import type { KernelError } from './errors.js'

/** 公共异常类；所有实现和兼容入口共享同一个构造器。 */
export class KernelFault extends Error {
  readonly error: KernelError
  constructor(error: KernelError, options?: ErrorOptions) {
    super(error.message, options)
    this.name = 'KernelFault'
    this.error = structuredClone(error)
  }
}

import { computerError, computerIdentity } from '../../packages/app-harness/dist/core/computer/domain.js'
import { computerInstanceProviderServiceKey } from '../../packages/app-harness/dist/core/computer/port.js'

/** A deterministic fixed resource for resource/Authority tests; production uses the independent worker. */
export function createLocalComputerProvider(options = {}) {
  const providerId = computerIdentity(options.providerId ?? 'local')
  const providerRef = computerIdentity(options.providerRef ?? 'controlled-local:controlled-boot')
  const platform = computerIdentity(options.platform ?? process.platform)
  const architecture = computerIdentity(options.architecture ?? process.arch)
  return Object.freeze({ providerId, activate({ resource, previousInstance }) {
    let cancelled = false
    const result = Promise.resolve().then(() => {
      if (cancelled) throw computerError('computer-cancelled')
      if (resource.spec.providerId !== providerId || resource.spec.platform !== platform || resource.spec.architecture !== architecture) throw computerError('computer-unavailable')
      // `previousExited: true` stands for a worker that answered with a new boot: the previous instance can never run again.
      return Object.freeze({ providerRef, platform, architecture, ...(options.previousExited && previousInstance ? { previousExited: true } : {}) })
    })
    return { result, done: result.then(() => {}, () => {}), cancel() { cancelled = true } }
  } })
}
export function createLocalComputerProviderComponent(options = {}) {
  return { name: 'test-fixed-computer-provider', apply(ctx) {
    ctx.provide(computerInstanceProviderServiceKey, createLocalComputerProvider(options))
  } }
}

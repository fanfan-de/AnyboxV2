import { computerError, computerIdentity } from '../../dist/applications/harness/core/computer/domain.js'
import { computerInstanceProviderServiceKey } from '../../dist/applications/harness/core/computer/port.js'

/** A deterministic fixed resource for resource/Authority tests; production uses the independent worker. */
export function createLocalComputerProvider(options = {}) {
  const providerId = computerIdentity(options.providerId ?? 'local')
  const providerRef = computerIdentity(options.providerRef ?? 'controlled-local:controlled-boot')
  const platform = computerIdentity(options.platform ?? process.platform)
  const architecture = computerIdentity(options.architecture ?? process.arch)
  return Object.freeze({ providerId, activate({ resource }) {
    let cancelled = false
    const result = Promise.resolve().then(() => {
      if (cancelled) throw computerError('computer-cancelled')
      if (resource.spec.providerId !== providerId || resource.spec.platform !== platform || resource.spec.architecture !== architecture) throw computerError('computer-unavailable')
      return Object.freeze({ providerRef, platform, architecture })
    })
    return { result, done: result.then(() => {}, () => {}), cancel() { cancelled = true } }
  } })
}
export function createLocalComputerProviderComponent(options = {}) {
  return { name: 'test-fixed-computer-provider', apply(ctx) {
    ctx.provide(computerInstanceProviderServiceKey, createLocalComputerProvider(options))
  } }
}

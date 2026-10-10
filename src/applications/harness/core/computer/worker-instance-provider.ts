import type { Component } from '@nya/core'
import { computerError } from './domain.js'
import { computerInstanceProviderServiceKey } from './port.js'
import { computerWorkerServiceKey } from './worker-port.js'
import type { ComputerWorkerPort } from './worker-port.js'

export function createWorkerInstanceProviderComponent(): Component.Object<void, { [computerWorkerServiceKey]: ComputerWorkerPort }> {
  return { name: 'computer-local-instance-provider', inject: [computerWorkerServiceKey], apply(ctx, _config, deps) {
    ctx.provide(computerInstanceProviderServiceKey, { providerId: 'local', activate({ resource }: import('./port.js').ComputerActivationInput) {
      let cancelled = false
      const result = deps[computerWorkerServiceKey].info().then(info => {
        if (cancelled) throw computerError('computer-cancelled')
        if (resource.spec.platform !== info.platform || resource.spec.architecture !== info.architecture) throw computerError('computer-unavailable')
        return { providerRef: `${info.workerId}:${info.bootId}`, platform: info.platform, architecture: info.architecture }
      }).catch(error => { if (error instanceof Error && error.name === 'ComputerError') throw error; throw computerError('computer-unavailable') })
      return { result, done: result.then(() => {}, () => {}), cancel() { cancelled = true } }
    } })
  } }
}

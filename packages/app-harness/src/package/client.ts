import { harnessClientApplication } from '../client/registration.js'
import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import type { HarnessClientRuntimeOptions } from '../client/runtime.js'

/** Pure package preparation; application resources belong to the later runtime. */
export function createRegistration(context?: ApplicationPackageRuntimeContext, config: HarnessClientRuntimeOptions = {}) {
  const startRole = context?.phase === 'runtime' ? context.startRole : undefined
  return harnessClientApplication(startRole ? { ...config, computer: { directory: './data/harness.sqlite.computer-worker', ...config.computer, launch: directory => startRole('computer-worker', { ownership: 'independent', args: ['serve', directory] }) } } : config)
}

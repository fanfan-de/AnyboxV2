import { harnessServerApplication } from '../registration.js'
import { parseHarnessServerConfig } from '../server-config.js'
import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import type { HarnessServerConfig } from '../server-config.js'

/** Defaults are deterministic construction data; preparation never reads the environment. */
export function createRegistration(context?: ApplicationPackageRuntimeContext, config: HarnessServerConfig = parseHarnessServerConfig({})) {
  const startRole = context?.phase === 'runtime' ? context.startRole : undefined
  return harnessServerApplication(config, startRole ? { localWorkerLaunch: directory => startRole('computer-worker', { ownership: 'independent', args: ['serve', directory] }) } : {})
}

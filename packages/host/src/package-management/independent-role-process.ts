/** Fixed independent role bootstrap. All worker business remains in its signed main. */
import { createPrivateRpc, rpcFailure } from '../desktop/rpc.js'
import { captureCommand } from './domain.js'
import { loadInstalledComputerWorkerEntry } from './loader.js'
import { readApplicationTrustPolicy, currentApplicationRuntimeProfile } from './policy.js'
import type { IndependentInstalledRoleOptions } from './independent-role.js'
import type { PackageRegistryPort } from './port.js'

let started = false, independent = false, ending = false
const rpc = createPrivateRpc(message => { if (!process.connected) throw rpcFailure('worker-unavailable'); process.send?.(message) })
process.on('message', message => rpc.receive(message))
function cancelStartup(): void {
  rpc.disconnect()
  if (independent || ending) return
  ending = true
  // This bootstrap is its own Unix group leader. The application handles TERM
  // through its own root close; a stalled startup cannot outlive the group guard.
  const force = setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } }, 1_000)
  force.unref()
  process.kill(process.pid, 'SIGTERM')
}
process.once('disconnect', cancelStartup)
if (!process.connected) cancelStartup()
rpc.handle('start', async raw => {
  if (started) throw rpcFailure('package-role-already-started')
  started = true
  const input = captureCommand(raw) as Omit<IndependentInstalledRoleOptions, 'registry'>
  const policy = input.trustPolicyPath ? await readApplicationTrustPolicy(input.trustPolicyPath) : undefined
  const verification = { ...input.verification, ...(policy ? { trustedPublishers: policy.trustedPublishers } : {}), target: { os: process.platform, arch: process.arch }, runtimeProfiles: { computerWorker: currentApplicationRuntimeProfile() } }
  const registry: Pick<PackageRegistryPort, 'claim' | 'ready'> = {
    claim: credential => rpc.call('registry', { method: 'claim', credential }),
    ready: credential => rpc.call('registry', { method: 'ready', credential }),
  }
  const loaded = await loadInstalledComputerWorkerEntry({ directory: input.directory, credential: input.credential, verification, registry })
  await loaded.main(input.args)
  await loaded.ready()
  if (!process.connected || ending) throw rpcFailure('worker-unavailable')
  independent = true
  return { usageId: input.credential.usageId, pid: process.pid }
})

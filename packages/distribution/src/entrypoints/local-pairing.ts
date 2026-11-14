import type { HostAccessPort } from '@anybox/host/access'
import type { DesktopLocalPairingOptions } from '@anybox/app-harness/client/connections'

/** Same-process callbacks retain the existing per-application managed token ownership. */
export function createLocalPairingOptions(access: () => HostAccessPort,
  target: { readonly endpoint: string; readonly instanceId: string }, appId: 'agent' | 'claude-agent'): DesktopLocalPairingOptions {
  const owner = appId === 'agent' ? 'anybox.web.local' : 'anybox.web.local.claude-agent'
  return {
    async getLocal(signal) { signal.throwIfAborted(); return target },
    async issue(signal) {
      signal.throwIfAborted()
      const result = await access().issueManaged(owner, 'Anybox Web 本机连接')
      signal.throwIfAborted()
      return result.token
    },
    async reconcile(token, signal) {
      signal.throwIfAborted()
      await access().reconcileManaged(owner, token)
      signal.throwIfAborted()
    },
  }
}

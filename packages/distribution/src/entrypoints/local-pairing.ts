import { createPrivateRpc, rpcFailure } from '@anybox/host/desktop/rpc'
import type { HostAccessPort } from '@anybox/host/access'
import type { DesktopLocalPairingOptions } from '@anybox/app-harness/client/connections'

export const webLocalPairingEnvironment = 'ANYBOX_WEB_LOCAL_PAIRING'
export type LocalPairingRpc = ReturnType<typeof createPrivateRpc>
export type LocalPairingAppId = 'agent' | 'claude-agent'
export interface LocalPairingTarget { readonly endpoint: string; readonly instanceId: string }

function managedOwner(value: unknown): string {
  const appId = (value as { appId?: unknown } | undefined)?.appId
  if (appId !== 'agent' && appId !== 'claude-agent') throw rpcFailure('invalid-input')
  return appId === 'agent' ? 'anybox.web.local' : 'anybox.web.local.claude-agent'
}

/** Only the combined launcher supplies these callbacks; each application owns its Vault and connection. */
export function createLocalPairingOptions(rpc: Pick<LocalPairingRpc, 'call'>, appId: LocalPairingAppId): DesktopLocalPairingOptions {
  return {
    getLocal: signal => rpc.call('local.get', undefined, signal),
    issue: signal => rpc.call('local.issue', { appId }, signal),
    reconcile: (token, signal) => rpc.call('local.reconcile', { appId, token }, signal),
  }
}

/** Private launcher relay. Reading the target never starts an application or a Computer worker. */
export function installLocalPairingBridge(client: Pick<LocalPairingRpc, 'handle'>, execution: Pick<LocalPairingRpc, 'call'>,
  getLocal: (signal: AbortSignal) => Promise<LocalPairingTarget | undefined>): void {
  client.handle('local.get', (_value, signal) => getLocal(signal))
  for (const method of ['issue', 'reconcile']) client.handle(`local.${method}`, (value, signal) => {
    managedOwner(value)
    return execution.call(method, value, signal)
  })
}

/** The execution role looks up the current access service for every private request. */
export function installLocalPairingAccess(rpc: Pick<LocalPairingRpc, 'handle'>, access: () => HostAccessPort): void {
  rpc.handle('issue', async (value, signal) => {
    signal.throwIfAborted()
    const result = await access().issueManaged(managedOwner(value), 'Anybox Web 本机连接')
    signal.throwIfAborted()
    return result.token
  })
  rpc.handle('reconcile', async (value, signal) => {
    signal.throwIfAborted()
    const owner = managedOwner(value)
    const token = (value as { token?: unknown }).token
    if (token !== undefined && typeof token !== 'string') throw rpcFailure('invalid-input')
    await access().reconcileManaged(owner, token)
    signal.throwIfAborted()
  })
}

/** No token enters environment variables or public HTTP; only an explicitly enabled inherited IPC is used. */
export function createProcessPairingTransport() {
  if (process.env[webLocalPairingEnvironment] !== '1') return undefined
  let disconnected = !process.connected, onDisconnect: (() => void) | undefined
  const lost = () => {
    if (disconnected) return
    disconnected = true
    rpc.disconnect()
    onDisconnect?.()
  }
  const rpc = createPrivateRpc(message => {
    if (!process.connected || !process.send) throw rpcFailure('worker-unavailable')
    process.send(message, error => { if (error) lost() })
  })
  if (disconnected) rpc.disconnect()
  const receive = (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'anybox-role-stop') lost()
    else rpc.receive(message)
  }
  // Register before asynchronous host startup so shutdown cannot be lost while opening storage.
  process.on('message', receive)
  process.once('disconnect', lost)
  process.once('SIGINT', lost)
  process.once('SIGTERM', lost)
  return {
    rpc,
    get disconnected() { return disconnected },
    onDisconnect(handler: () => void) { onDisconnect = handler; if (disconnected) handler() },
    async close() {
      rpc.disconnect()
      await rpc.drain()
      process.off('message', receive)
      process.off('disconnect', lost)
      process.off('SIGINT', lost)
      process.off('SIGTERM', lost)
      onDisconnect = undefined
    },
  }
}

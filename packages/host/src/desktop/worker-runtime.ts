import { createPrivateRpc, rpcFailure } from './rpc.js'
import type { DesktopWorkerStart, DesktopWorkerReady } from './contracts.js'
import type { ParentPort } from 'electron'
import type { ActivityFreeze, ProductActivityPort } from '@anybox/application-api'

export type DesktopRpc = ReturnType<typeof createPrivateRpc>
export interface DesktopRoleHost {
  readonly ready: DesktopWorkerReady
  prepareClose(): Promise<void>
  close(): Promise<void>
  inspect?(): { busy: boolean }
  inspectForQuit?(): Promise<{ busy: boolean }>
  releaseQuit?(): void
}
/** Desktop shutdown consumes only application lifecycle protection, never application business services. */
export function createDesktopApplicationLifecycle(activity: () => ProductActivityPort, applicationIds: () => readonly string[]): Required<Pick<DesktopRoleHost, 'inspect' | 'inspectForQuit' | 'releaseQuit'>> {
  let quitFreeze: ActivityFreeze | undefined
  const acquire = () => activity().freeze(applicationIds())
  const isBusy = (error: unknown) => error && typeof error === 'object' && 'code' in error && error.code === 'product-busy'
  return {
    inspect() {
      if (quitFreeze) return { busy: false }
      let freeze: ActivityFreeze
      try { freeze = acquire() }
      catch (error) { if (isBusy(error)) return { busy: true }; throw error }
      freeze.release()
      return { busy: false }
    },
    async inspectForQuit() {
      try { quitFreeze ??= acquire(); return { busy: false } }
      catch (error) { if (isBusy(error)) return { busy: true }; throw error }
    },
    releaseQuit() {
      const freeze = quitFreeze
      quitFreeze = undefined
      freeze?.release()
    },
  }
}
type StartRole = (options: DesktopWorkerStart, rpc: DesktopRpc) => Promise<DesktopRoleHost>

/** Shared private transport only; each entry imports exactly one role's composition. */
export function installDesktopWorkerRpc(rpc: DesktopRpc, kind: DesktopWorkerStart['kind'], start: StartRole, exit: () => void, nativeSmoke?: (keyring: boolean) => Promise<unknown>) {
  let host: DesktopRoleHost | undefined, startTask: Promise<DesktopWorkerReady> | undefined, stopping = false
  rpc.handle('start', value => {
    if (stopping) throw rpcFailure('service-unavailable')
    if (startTask) throw rpcFailure('already-started')
    const options = value as DesktopWorkerStart | undefined
    if (!options || options.kind !== kind || typeof options.userData !== 'string' || !options.userData ||
        typeof options.namespace !== 'string' || !options.namespace ||
        (kind === 'client' && (typeof options.transportSecret !== 'string' || !options.transportSecret))) throw rpcFailure('invalid-startup')
    return startTask = start(options, rpc).then(value => { host = value; return value.ready })
  })
  rpc.handle('inspect', () => host?.inspect?.() ?? { busy: false })
  rpc.handle('inspectForQuit', async () => {
    await startTask?.catch(() => {})
    return host?.inspectForQuit?.() ?? { busy: false }
  })
  rpc.handle('releaseQuit', () => host?.releaseQuit?.())
  rpc.handle('prepareClose', async () => {
    stopping = true
    await startTask?.catch(() => {})
    await host?.prepareClose()
  })
  rpc.handle('close', async () => {
    stopping = true
    await startTask?.catch(() => {})
    await host?.close()
    setImmediate(exit)
  })
  // Image and native QA dependencies are not part of normal client startup.
  if (nativeSmoke) rpc.handle('nativeSmoke', value => nativeSmoke((value as { keyring: boolean }).keyring))
}

export function runDesktopWorker(kind: DesktopWorkerStart['kind'], start: StartRole, nativeSmoke?: (keyring: boolean) => Promise<unknown>) {
  const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!parent) throw new Error('Desktop worker requires a private utility port')
  const rpc = createPrivateRpc(message => parent.postMessage(message))
  installDesktopWorkerRpc(rpc, kind, start, () => process.exit(0), nativeSmoke)
  parent.on('message', event => rpc.receive(event.data))
}
